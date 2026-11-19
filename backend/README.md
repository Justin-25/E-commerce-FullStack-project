# Vendora API

Backend for Vendora, a multi-vendor marketplace (Philippines, ₱).
Built with Express 5 + TypeScript, PostgreSQL + Prisma 7 (Neon) and Redis (Upstash).
The API contract lives in [`openapi/openapi.yaml`](openapi/openapi.yaml).

## Run it

```bash
cd backend
npm install
cp .env.example .env   # then fill in DATABASE_URL + DIRECT_URL (Neon) and REDIS_URL (Upstash)
npm run secrets        # creates the secret keys in .env (never shown, never committed)
npm run db:migrate     # create/upgrade the tables
npm run dev            # http://localhost:4000/health
```

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm run check` | Generate the Prisma client, type check, lint, test (run before every commit) |
| `npm test` | Tests only (Vitest + Supertest) |
| `npm run secrets` | Add any missing secret keys to `.env` (keeps existing ones) |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |

## Database (PostgreSQL on Neon + Prisma 7)

1. Create a free project at neon.tech, then go to **Connect**:
   - **Connection pooling ON** → copy that string into `DATABASE_URL`, and change `sslmode=require` to `sslmode=verify-full`.
   - **Connection pooling OFF** → copy that string into `DIRECT_URL`.
2. Run the setup commands:

```bash
npm run db:migrate   # create/upgrade the tables (prisma migrate deploy)
npm run db:seed      # demo stores and products from the designs (safe to run again)
npm run db:status    # which migrations are applied
```

Design and reasoning: [`docs/database-design.md`](docs/database-design.md).

## Sign-in, passwords and two-step verification (milestone 3a–3c)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/auth/csrf` | CSRF token for this browser (the app calls it once on load) |
| `POST /api/v1/auth/register` | Create a shopper account and email a 6-digit code |
| `POST /api/v1/auth/verify-email` | Code → email verified → signed in |
| `POST /api/v1/auth/resend-verification` | "Didn't get the code?" (max one per minute) |
| `POST /api/v1/auth/login` | Sign in; 5 wrong passwords pause sign-in for 15 minutes |
| `POST /api/v1/auth/refresh` | Swap the refresh pass for new passes (the frontend calls this after a 401) |
| `POST /api/v1/auth/logout` | Sign out this device, effective immediately |
| `GET /api/v1/auth/me` | Who's signed in |
| `POST /api/v1/auth/forgot-password` | Email a reset link (30 minutes, single use); same answer for unknown emails |
| `POST /api/v1/auth/reset-password` | New password from the link → every other device signed out, this one signed in |
| `POST /api/v1/auth/change-password` | Current + new password → other devices signed out, this one stays signed in |
| `POST /api/v1/auth/2fa/verify` | After `two_factor_required`: the authenticator code or a backup code (+ "trust this device") |
| `GET /api/v1/auth/2fa` | Two-step verification status, whether it's required, backup codes left |
| `POST /api/v1/auth/2fa/setup` | Start turning it on: QR link + key to type in |
| `POST /api/v1/auth/2fa/enable` | First app code → it's on; returns 10 backup codes (shown once) |
| `POST /api/v1/auth/2fa/disable` | Shoppers only; needs an app or backup code |
| `POST /api/v1/auth/2fa/backup-codes` | A new set of 10 backup codes (needs an app code) |

How it works:
- **Two passes in httpOnly cookies.** A 15-minute access pass (JWT, `vd_at`) and a refresh pass (random, `vd_rt`, sent only to `/api/v1/auth`). Page JavaScript can't read either, so an XSS bug can't steal them.
- **Refresh-token rotation.** Each refresh pass works once. If an old one is used again, someone copied it, so every device in that sign-in chain is signed out.
- **Instant sign-out.** Checking an access pass costs no database query: the signature, plus one Redis lookup for "signed out", "chain revoked" or "password changed".
- **Two-step verification.** After a correct password (or a reset link), people with 2FA get `two_factor_required` and a 5-minute httpOnly step cookie; no session exists until the authenticator code (or a backup code) is right. Codes can't be replayed, wrong ones count toward the lockout, and "Trust this device for 30 days" skips the code on that browser only. Sellers and admins must have it: without it they get `two_factor_setup_required` and set it up before getting in. If someone loses their phone and backup codes, support resets it after checking who they are (admin screen in milestone 7).
- **Password changes end other sign-ins.** A reset or change revokes every other sign-in chain and sets an "invalid before" time, so passes issued earlier stop working at once. The owner gets a "your password was changed" email.
- **Emails.** Sent in the background, so response times don't reveal whether an account exists. In development they're printed in the API terminal (look for `DEV OUTBOX`) so you can copy the code or link. A real email provider is added before deploying (milestone 9); production refuses to start with the outbox.

## If Redis (Upstash) goes down

Redis commands give up after 1 second instead of waiting, and each part of the API then does what's safest for it:

| Part | While Redis is down |
|---|---|
| Browsing, the general rate limit | Keeps working without the limit (logged) |
| `/ready` | 503 with `"redis": "error"` within ~3 seconds, so monitoring sees the real cause |
| Sign-in, sign-up, codes, passwords | **503 `SERVICE_UNAVAILABLE`** with `Retry-After: 30`, before touching the database. Brute-force protection is never silently switched off. |
| Already signed-in shoppers | Keep working: their pass is accepted without the sign-out check (logged) |
| Refresh, sign-out | Keep working: they only need the database. The known trade-off: a pass signed out during the outage stays valid until it expires (at most 15 minutes), but it can't be renewed. |

Measured with Redis pointed at an unreachable address: before this, every API request failed with a 500 after 25–32 seconds.

## How it's tested

- `tests/auth/*` drive the real routes, service and middleware with a pretend browser that keeps cookies and sends the CSRF token. Redis is faked in memory with a clock the tests can move forward.
- **On your PC** the database is PGlite (Postgres inside Node): a fresh copy of the real migrations for each test file, with no internet needed. **In CI** (`TEST_DATABASE_URL`) the same tests run on a real PostgreSQL 18 server, each file in its own throwaway schema.
- `tests/auth/outage.test.ts` and `tests/resilience.test.ts` switch the Redis stand-in off and check the table above, including a real Redis client timing out against an unreachable address.
- `tests/openapi.test.ts` checks the contract matches the code: every route is documented (and every documented route exists), the error codes match, and no `$ref` is broken.
- `tests/db/migration.test.ts` checks that every table, index, foreign key and safety rule really exists. CI also migrates and seeds a real PostgreSQL 18 server, the same major version as Neon.

## Structure

```
src/
  app.ts                 builds the Express app (no server), so tests use the real app
  server.ts              starts the server, wires Redis/Prisma/sign-in, shuts down gracefully
  config/env.ts          validates environment variables at startup
  lib/                   logger, Redis/Prisma clients, key-value store, password hashing, crypto helpers,
                         email outbox, breached-password check, money helpers, error types, query parser
  middleware/            security headers + CORS, rate limit, CSRF + Origin check, auth guards, request IDs, errors
  modules/health/        GET /health (alive) and GET /ready (dependencies OK)
  modules/auth/          sign-in: routes → service (rules) → tokens, lockout, one-time codes, emails
  generated/prisma/      Prisma client (generated by `npm run db:generate`, not committed)
prisma/
  schema.prisma          the 30 tables
  migrations/            SQL applied to the database, in order
  seed.ts                demo data
scripts/                 npm run secrets
tests/                   API, database and unit tests (tests/support: test database, browser, harness)
openapi/openapi.yaml     the API contract
```

## Security checklist: what's in place

| Checklist item | How it's done |
|---|---|
| Compromised database | Passwords hashed with **Argon2id** (memory-hard, salted; OWASP's first choice). Refresh passes stored as SHA-256 hashes; 6-digit codes as keyed hashes (HMAC), so even a million-option code can't be reversed from a stolen copy. |
| Brute force | Global and stricter `/auth` rate limits per IP (shared in Redis). **Lockout:** 5 wrong passwords per account + network → 15-minute pause; 20 from anywhere → pause. Codes allow 5 tries and at most 10 codes a day. |
| XSS | Passes live in **httpOnly** cookies JavaScript can't read; `helmet` security headers; inputs validated with allow-lists (zod). |
| CSRF | Three layers: SameSite cookies, an **Origin check**, and a signed double-submit token (`csrf-csrf`, the maintained successor of `csurf`) tied to an id that changes at sign-in and sign-out. |
| Refresh tokens | Rotation on every use; reuse of an old one signs out the whole chain. Sign-ins end after 30 days ("keep me signed in") or 1 day at most, and refreshing never extends that. |
| JWT blacklist | Signed-out passes and revoked chains are denied in Redis until they would have expired. |
| Deny JWTs issued before a password change | Reset and change set a per-user "invalid before" time in Redis and revoke every other sign-in chain, so older passes stop working at once. |
| Password reset tokens | 256 random bits, stored only as a keyed hash, 30-minute expiry, single use, a newer link cancels older ones; at most 1 email a minute and 5 a day. The token sits after `#` in the link, so it never reaches server logs or other sites. |
| Notify on security changes | Emails after a password reset or change, turning 2FA on or off, and every backup-code sign-in, each with a way out if it wasn't them. |
| Two-factor authentication | Authenticator app (TOTP, `otpauth`) + 10 single-use backup codes; required for sellers and admins; also asked after a password reset; replay-proof; wrong codes count toward the lockout. |
| Encrypt sensitive data | The 2FA secret is encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`), bound to its user, so a copy pasted into another account fails to decrypt. Backup codes are keyed hashes. |
| Confirm email after sign-up | 6-digit code, 10 minutes, required before the first sign-in. |
| Account enumeration | Sign-up, sign-in and code endpoints answer the same whether or not the email has an account, and sign-in always runs one Argon2 check so the timing matches too. |
| Weak passwords | At least 8 characters, and passwords found in known breaches are refused (Have I Been Pwned; only 5 characters of a hash leave the server). |
| Rate limiting, DoS | `express-rate-limit` counts the real visitor IP behind proxies (`TRUST_PROXY_HOPS`), IPv6 grouped by /56. JSON bodies ≤ 10 KB (413 otherwise); passwords ≤ 128 characters. |
| Special HTTP headers | `helmet` (HSTS, nosniff, frame protection…); `X-Powered-By` removed. |
| Parameter pollution, operator injection | Custom query parser: last value wins for repeated keys; never builds nested objects, so `?price[$gt]=0` stays plain text and `__proto__` can't pollute objects. SQL goes through Prisma (parameterized). |
| No error details to clients | One error format. Users see safe messages; stack traces go to the log under the same request ID. Logs redact cookies, passwords and tokens. |
| Evil regular expressions | Only simple, linear patterns. |
| No secrets in git | `.env` is git-ignored; `npm run secrets` writes keys without printing them; config errors name a variable but never its value. |
| HTTPS | Production requires https origins and `APP_URL`, sets HSTS, and uses `__Host-`/`__Secure-` Secure cookies. |

Coming next: "Confirm it's you", signed-in devices and security activity (3d); Google sign-in (3e).
