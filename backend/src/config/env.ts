import { existsSync } from "node:fs";
import { z } from "zod";

// Empty values in .env (e.g. "DATABASE_URL=") mean "not set".
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

// A random key of at least 32 bytes, base64url-encoded. `npm run secrets` creates them in .env.
const secret = () =>
  z
    .string({ error: 'is missing (run "npm run secrets" to create it in .env)' })
    .regex(/^[A-Za-z0-9_-]{43,}$/, 'must be at least 32 random bytes in base64url (run "npm run secrets")');

export const SECRET_KEYS = ["ACCESS_TOKEN_SECRET", "CSRF_SECRET", "CODE_HASH_SECRET", "DATA_ENCRYPTION_KEY"] as const;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:5173")
      .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    JSON_BODY_LIMIT: z.string().regex(/^\d{1,4}(kb|mb)$/, "use a size like 10kb").default("10kb"),
    DATABASE_URL: optional(z.url()), // pooled (app)
    DIRECT_URL: optional(z.url()), // direct (migrations only)
    REDIS_URL: optional(z.url()),

    // --- Sign-in (milestone 3) ---
    /** The frontend's address, used in links inside emails. */
    APP_URL: z.url().default("http://localhost:5173"),
    ACCESS_TOKEN_SECRET: secret(), // signs the 15-minute access pass (JWT)
    CSRF_SECRET: secret(), // signs CSRF tokens
    CODE_HASH_SECRET: secret(), // keyed hash for one-time codes, so a stolen database can't reveal them
    DATA_ENCRYPTION_KEY: secret(), // encrypts 2FA secrets (later: tax IDs, payout account numbers) in the database
    /** Stricter per-IP limit for sign-in, sign-up and code endpoints (per 15 minutes). */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    /** "outbox" prints emails in the API terminal (development only). A real provider comes in milestone 9. */
    EMAIL_PROVIDER: z.enum(["outbox"]).default("outbox"),
    /**
     * Which hosting provider's location headers to trust for "Manila, PH" in the device and activity lists.
     * Only set this when the API really runs behind that provider; otherwise visitors could fake the headers.
     */
    GEO_HEADERS: z.enum(["none", "vercel", "cloudflare"]).default("none"),

    // --- Google sign-in (3e). Off when the client id/secret are empty. ---
    GOOGLE_CLIENT_ID: optional(z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, "must be the client ID from Google Cloud (…apps.googleusercontent.com)")),
    GOOGLE_CLIENT_SECRET: optional(z.string().min(10, "looks too short")),
    /** Where Google sends people back. Must match one registered in Google Cloud. Default: APP_URL + /api/v1/auth/google/callback. */
    GOOGLE_REDIRECT_URI: optional(z.url()),

    // --- PayMongo (5b). Online payments are off when the secret key is empty; cash on delivery still works. ---
    PAYMONGO_SECRET_KEY: optional(z.string().regex(/^sk_(test|live)_[A-Za-z0-9]{10,}$/, "must be a PayMongo secret key (sk_test_… or sk_live_…)")),
    /** The webhook's own secret (whsk_…), shown when the webhook is created (at deploy). Webhooks are refused until it's set. */
    PAYMONGO_WEBHOOK_SECRET: optional(z.string().regex(/^whsk_[A-Za-z0-9]{10,}$/, "must be a PayMongo webhook secret (whsk_…)")),

    // --- Cloudinary (6a): store logos, product photos, private verification documents. Uploads are off when empty. ---
    /** The "API environment variable" from the Cloudinary dashboard: cloudinary://<api key>:<api secret>@<cloud name>. */
    CLOUDINARY_URL: optional(z.string().regex(/^cloudinary:\/\/\d{6,20}:[A-Za-z0-9_-]{16,64}@[a-z0-9_-]{1,64}$/, "must be the API environment variable from Cloudinary (cloudinary://<key>:<secret>@<cloud name>)"))
  })
  .superRefine((env, ctx) => {
    if (new Set(SECRET_KEYS.map((k) => env[k])).size !== SECRET_KEYS.length) {
      ctx.addIssue({ code: "custom", path: ["ACCESS_TOKEN_SECRET"], message: "each secret key must be different" });
    }
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({ code: "custom", path: ["GOOGLE_CLIENT_SECRET"], message: "set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither" });
    }
    if (env.NODE_ENV !== "production") return;
    for (const key of ["DATABASE_URL", "REDIS_URL"] as const) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required in production" });
    }
    if (env.CORS_ORIGINS.some((o) => !o.startsWith("https://"))) {
      ctx.addIssue({ code: "custom", path: ["CORS_ORIGINS"], message: "must use https:// origins in production" });
    }
    if (!env.APP_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "must use https:// in production" });
    }
    if (env.GOOGLE_REDIRECT_URI && !env.GOOGLE_REDIRECT_URI.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["GOOGLE_REDIRECT_URI"], message: "must use https:// in production" });
    }
    if (env.EMAIL_PROVIDER === "outbox") {
      ctx.addIssue({ code: "custom", path: ["EMAIL_PROVIDER"], message: "the dev outbox prints codes in the log; use a real provider in production" });
    }
  });

export type Config = z.infer<typeof schema>;

/**
 * Validates environment variables once at startup. Fails fast with a list of
 * the problems — it names the variables but never prints their values (secrets).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Loads backend/.env into process.env if it exists (real env vars win). */
export function loadEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
