import { Router, type Express } from "express";
import type { Config } from "../../src/config/env.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import type { EmailSender } from "../../src/lib/email.js";
import type { KeyValueStore } from "../../src/lib/kv.js";
import type { Logger } from "../../src/lib/logger.js";
import type { AuthGuards } from "../../src/middleware/auth.js";
import { Secret, TOTP } from "otpauth";
import { pino } from "pino";
import { expect } from "vitest";
import { createApp } from "../../src/app.js";
import { DevOutbox } from "../../src/lib/email.js";
import { MemoryKv } from "../../src/lib/kv.js";
import { createAuthGuards } from "../../src/middleware/auth.js";
import { createCsrf } from "../../src/middleware/csrf.js";
import { authRouter } from "../../src/modules/auth/auth.routes.js";
import { authKeys } from "../../src/modules/auth/keys.js";
import { AuthService } from "../../src/modules/auth/auth.service.js";
import { GoogleService } from "../../src/modules/auth/google.service.js";
import { SecurityService } from "../../src/modules/auth/security.service.js";
import type { GoogleProfile } from "../../src/lib/google.js";
import { FakeGoogle } from "./fakeGoogle.js";
import { TokenService } from "../../src/modules/auth/tokens.js";
import { silentLogger, testConfig } from "../helpers.js";
import { Browser } from "./browser.js";
import { FlakyKv, FlakyStore, type RedisSwitch } from "./flaky.js";
import { createTestDb, type TestDb } from "./testDb.js";

export const AUTH = {
  register: "/api/v1/auth/register",
  verifyEmail: "/api/v1/auth/verify-email",
  resend: "/api/v1/auth/resend-verification",
  login: "/api/v1/auth/login",
  refresh: "/api/v1/auth/refresh",
  logout: "/api/v1/auth/logout",
  me: "/api/v1/auth/me",
  forgot: "/api/v1/auth/forgot-password",
  reset: "/api/v1/auth/reset-password",
  change: "/api/v1/auth/change-password",
  twoFactor: "/api/v1/auth/2fa",
  twoFactorVerify: "/api/v1/auth/2fa/verify",
  twoFactorSetup: "/api/v1/auth/2fa/setup",
  twoFactorEnable: "/api/v1/auth/2fa/enable",
  twoFactorDisable: "/api/v1/auth/2fa/disable",
  backupCodes: "/api/v1/auth/2fa/backup-codes",
  security: "/api/v1/auth/security",
  confirm: "/api/v1/auth/confirm",
  confirmSendCode: "/api/v1/auth/confirm/send-code",
  sessions: "/api/v1/auth/sessions",
  signOutOthers: "/api/v1/auth/sessions/sign-out-others",
  signOutDevice: (id: string) => `/api/v1/auth/sessions/${id}/sign-out`,
  activity: "/api/v1/auth/activity",
  emailChange: "/api/v1/auth/email/change",
  emailChangeConfirm: "/api/v1/auth/email/change/confirm"
} as const;

/** What the phone's authenticator app would show right now for this key (±1 window to pick another code). */
export const totpCode = (manualKey: string, windowOffset = 0): string =>
  TOTP.generate({ secret: Secret.fromBase32(manualKey.replace(/\s/g, "")), timestamp: Date.now() + windowOffset * 30_000 });

export const GOOD_PASSWORD = "correct horse battery staple";
/** Passwords the fake breach checker treats as leaked. */
export const BREACHED_PASSWORDS = ["password123", "iloveyou2024"];

/**
 * The real sign-in stack (routes, service, guards, CSRF) on a fresh PGlite
 * database, with fakes only at the edges: in-memory Redis (with a clock we can
 * move forward and a switch to make it "go down"), an email outbox we can read,
 * an offline breach checker, and captured warning/error logs.
 */
export interface HarnessOptions {
  /** More routers on the same app (e.g. the catalog), sharing its database, Redis stand-in and sign-in guards. */
  routers?: (deps: HarnessDeps) => Router[];
  /** Webhook routers (mounted before the JSON parser and CSRF check, like in the real app). */
  webhooks?: (deps: HarnessDeps) => Router[];
}

export interface HarnessDeps {
  prisma: PrismaClient;
  kv: KeyValueStore;
  guards: AuthGuards;
  logger: Logger;
  email: EmailSender;
  config: Config;
}

export async function createAuthHarness(env: Record<string, string> = {}, options: HarnessOptions = {}) {
  const db: TestDb = await createTestDb();
  const clock = { offsetMs: 0 };
  const redis: RedisSwitch = { down: false };
  const memory = new MemoryKv(() => Date.now() + clock.offsetMs);
  const kv = new FlakyKv(memory, redis);
  const outbox = new DevOutbox();
  const breached = new Set(BREACHED_PASSWORDS);
  const fakeGoogle = new FakeGoogle();
  const logs: { level: number; msg: string }[] = [];
  const logger = pino({ level: "warn" }, { write: (line: string) => void logs.push(JSON.parse(line)) });

  const build = (overrides: Record<string, string> = {}): Express => {
    // High limits by default so tests aren't throttled; rate-limit tests lower them.
    const config = testConfig({ RATE_LIMIT_MAX: "100000", AUTH_RATE_LIMIT_MAX: "100000", ...env, ...overrides });
    const tokens = new TokenService(config);
    const csrf = createCsrf(config);
    const guards = createAuthGuards({ tokens, kv, logger });
    const service = new AuthService({ prisma: db.prisma, kv, email: outbox, tokens, config, isBreached: async (p) => breached.has(p), logger });
    const testRoutes = Router()
      .get("/test/admin-only", ...guards.requireAuth, guards.requireRole("ADMIN"), (_req, res) => {
        res.json({ ok: true });
      })
      .get("/test/whoami", guards.authenticate, (req, res) => {
        res.json({ userId: req.auth?.userId ?? null });
      });
    const security = new SecurityService({ prisma: db.prisma, kv, email: outbox, config, logger });
    const google = new GoogleService({ prisma: db.prisma, kv, auth: service, identity: fakeGoogle, email: outbox, config, logger });
    const auth = authRouter({ service, security, google, tokens, csrf, guards, config, logger, rateLimitStore: new FlakyStore(redis) });
    const deps: HarnessDeps = { prisma: db.prisma, kv, guards, logger, email: outbox, config };
    const extra = options.routers?.(deps) ?? [];
    return createApp({ config, logger: silentLogger, csrf, routers: [auth, testRoutes, ...extra], webhooks: options.webhooks?.(deps) ?? [] });
  };

  const app = build();

  /** The 6-digit code in the newest email to this address. */
  const codeFor = (email: string): string => {
    const code = /\b(\d{6})\b/.exec(outbox.lastTo(email)?.text ?? "")?.[1];
    if (!code) throw new Error(`no code emailed to ${email}`);
    return code;
  };

  const h = {
    app,
    db,
    /** The in-memory Redis stand-in (works even while `redis.down`, for setting up tests). */
    kv: memory,
    /** Set `redis.down = true` to simulate an outage. */
    redis,
    /** Warnings and errors logged by the sign-in code. */
    logs,
    outbox,
    breached,
    /** Same database and Redis, different settings (e.g. a low rate limit). */
    buildApp: build,
    /** Moves the fake Redis clock forward (lockouts, cooldowns). */
    advance: (seconds: number) => {
      clock.offsetMs += seconds * 1000;
    },
    codeFor,
    /** The token from the newest reset link emailed to this address. */
    resetTokenFor: (email: string): string => {
      const token = /\/reset-password#token=([A-Za-z0-9_-]{43})\b/.exec(outbox.lastTo(email)?.text ?? "")?.[1];
      if (!token) throw new Error(`no reset link emailed to ${email}`);
      return token;
    },
    browser: (headers: Record<string, string> = {}) => Browser.open(app, headers),

    fakeGoogle,

    /**
     * "Continue with Google" like a browser: start (→ Google), pick this Google account,
     * come back to the callback. Returns the callback response (a redirect to the frontend).
     */
    async googleSignIn(browser: Browser, profile: GoogleProfile, query: Record<string, string> = {}) {
      const start = await browser.get(`/api/v1/auth/google/start?${new URLSearchParams(query)}`);
      expect(start.status).toBe(302);
      const google = new URL(String(start.headers.location));
      const state = google.searchParams.get("state") ?? "";
      const code = fakeGoogle.choose(state, profile);
      return browser.get(`/api/v1/auth/google/callback?${new URLSearchParams({ code, state, scope: "openid email profile" })}`);
    },

    /** Forget which app codes this user already used, so a test can sign in again within the same 30 seconds. */
    allowCodeReuse: async (userId: string) => {
      const counter = Math.floor(Date.now() / 30_000);
      await memory.delete(...[-2, -1, 0, 1, 2].map((d) => authKeys.totpUsed(userId, counter + d)));
    },

    /** Turns 2FA on for the signed-in browser, like a person scanning the QR code. */
    async enableTwoFactor(browser: Browser) {
      const setup = await browser.post(AUTH.twoFactorSetup);
      expect(setup.status).toBe(200);
      const manualKey = String(setup.body.manualKey);
      const res = await browser.post(AUTH.twoFactorEnable, { code: totpCode(manualKey) });
      expect(res.status).toBe(200);
      return { manualKey, otpauthUri: String(setup.body.otpauthUri), backupCodes: res.body.backupCodes as string[] };
    },

    /** Full sign-up: register, read the emailed code, verify. Returns the signed-in browser and response. */
    async signUp({ email, name = "Maria Santos", password = GOOD_PASSWORD, keepSignedIn = false }: { email: string; name?: string; password?: string; keepSignedIn?: boolean }) {
      const browser = await Browser.open(app);
      const reg = await browser.post(AUTH.register, { name, email, password });
      expect(reg.status).toBe(202);
      const res = await browser.post(AUTH.verifyEmail, { email, code: codeFor(email), keepSignedIn });
      expect(res.status).toBe(200);
      return { browser, res, user: res.body.user as { id: string; email: string; role: string } };
    },

    close: () => db.close()
  };
  return h;
}

export type AuthHarness = Awaited<ReturnType<typeof createAuthHarness>>;
