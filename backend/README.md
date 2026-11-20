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
npm run db:seed      # demo categories, stores and 63 products from the designs (safe to run again)
npm run db:status    # which migrations are applied
```

Design and reasoning: [`docs/database-design.md`](docs/database-design.md).

## Sign-in and account security (milestone 3a–3e)

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
| `GET /api/v1/auth/security` | The Security page summary: email, password last changed, 2FA, which "Confirm it's you" proof |
| `GET` / `POST /api/v1/auth/confirm` | "Confirm it's you": app code, password or emailed code (`/confirm/send-code`); lasts 10 min on this device |
| `GET /api/v1/auth/sessions` | Where you're signed in ("Chrome on Windows · Manila, PH · this device") |
| `POST /api/v1/auth/sessions/{id}/sign-out` · `/sessions/sign-out-others` | Sign out one device, or all others, immediately |
| `GET /api/v1/auth/activity` | Recent security activity, newest first, page by page |
| `POST /api/v1/auth/email/change` · `/email/change/confirm` | Change email: after "Confirm it's you", a code to the new address; the old one is told |
| `GET /api/v1/auth/google/start` → Google → `/google/callback` | "Continue with Google" (page loads that end in a redirect to the frontend) |
| `POST /api/v1/auth/google/link` | "Sign in with your password to connect Google" (existing password accounts) |
| `POST /api/v1/auth/google/disconnect` | Security settings (needs "Confirm it's you" and a password on the account) |

How it works:
- **Two passes in httpOnly cookies.** A 15-minute access pass (JWT, `vd_at`) and a refresh pass (random, `vd_rt`, sent only to `/api/v1/auth`). Page JavaScript can't read either, so an XSS bug can't steal them.
- **Refresh-token rotation.** Each refresh pass works once. If an old one is used again, someone copied it, so every device in that sign-in chain is signed out.
- **Instant sign-out.** Checking an access pass costs no database query: the signature, plus one Redis lookup for "signed out", "chain revoked" or "password changed".
- **Two-step verification.** After a correct password (or a reset link), people with 2FA get `two_factor_required` and a 5-minute httpOnly step cookie; no session exists until the authenticator code (or a backup code) is right. Codes can't be replayed, wrong ones count toward the lockout, and "Trust this device for 30 days" skips the code on that browser only. Sellers and admins must have it: without it they get `two_factor_setup_required` and set it up before getting in. If someone loses their phone and backup codes, support resets it after checking who they are (admin screen in milestone 7).
- **"Confirm it's you" before sensitive changes.** The strongest proof the account has: the authenticator code if 2FA is on, else the password, else a code by email (accounts without a password). It lasts 10 minutes and only on the sign-in where it was done, so a stolen session can't borrow it. Sensitive endpoints answer `REAUTH_REQUIRED` until then.
- **Devices and activity.** Each sign-in chain is one device, named from its User-Agent with a small built-in reader. The location comes from the hosting provider's headers (`GEO_HEADERS`), none locally. "Sign out of all other devices" also ends their 2FA trust.
- **Google sign-in** is the server-side OAuth 2.0 authorization-code flow with PKCE (`openid-client`, a certified OpenID Connect library). State, nonce and PKCE verifier live in an encrypted httpOnly cookie for 10 minutes; Google's ID token signature, issuer, audience and nonce are checked. Google replaces the password, not 2FA. Matching rules:
  - Already connected: sign in.
  - New email: a shopper account with no password.
  - Never-verified account with that email: taken over, and its unknown password erased.
  - Verified account with a password: asked for that password once, then connected.
- **Password changes end other sign-ins.** A reset or change revokes every other sign-in chain and sets an "invalid before" time, so passes issued earlier stop working at once. The owner gets a "your password was changed" email.
- **Emails.** Sent in the background, so response times don't reveal whether an account exists. In development they're printed in the API terminal (look for `DEV OUTBOX`) so you can copy the code or link. A real email provider is added before deploying (milestone 9); production refuses to start with the outbox.

## Catalog: browse and search (milestone 4a)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/categories` | The category tree, with how many products each one has (cached 5 minutes) |
| `GET /api/v1/products` | Search and browse: `q`, `category` and `store` (both repeatable), `minPrice`/`maxPrice` (centavos), `rating` (4 = "4★ & up"), `freeDelivery`, `sort`, `page`, `pageSize` |
| `GET /api/v1/products/{id}` | Product page: variants with price, stock and deal countdown, specifications, breadcrumbs, store card, delivery and returns |
| `GET /api/v1/products/{id}/related` | "You may also like": best sellers from the same category (up to 8) |

How it works:
- **Search runs inside PostgreSQL**, so there's no extra search service to pay for or keep in sync. Each product has a search column that PostgreSQL keeps up to date itself (a generated `tsvector`; title words weigh more than description words), with a GIN index. People can type the way they do on Google: `"exact phrase"`, or `-word` to leave something out (`websearch_to_tsquery`). Word stems match, so "headphone" finds "Headphones".
- **Typos.** Only when the words match nothing does it retry on title similarity (`pg_trgm`), so "hedphones" still finds headphones. Mixing both on every search let near-misses into good results, which is why it's a fallback. The response says which one ran (`matchMode`: `words` or `similar`) so the page can say "Showing similar results". The 0.45 cut-off was measured on the demo titles: typos scored 0.50–0.80 against the right product, wrong products at most 0.31.
- **Filters with counts (facets).** Each filter's counts ignore that filter itself, so after ticking "Glow Lab" the other stores still show how many products they'd add.
- **Deal countdown.** A variant can have a `saleEndsAt`. After that moment it sells at its regular price again. This is worked out every time the price is read, by one rule written in TypeScript and SQL (`modules/catalog/pricing.ts`; checkout will use the same rule), so no background job has to remember to end a deal.
- **What's visible.** Only `ACTIVE` products from `APPROVED` stores with at least one variant on sale. Anything else answers 404, exactly like an id that never existed.
- **Safe by construction.** Every filter and sort is checked against an allow-list (zod). What people type reaches PostgreSQL only as a query parameter, never as SQL, and the sort orders come from a fixed list. Pages stop at 50, which nobody browses but bots would make the database work for.
- **Cached category list.** Kept in Redis for 5 minutes (browsers may keep it too, `Cache-Control`). If Redis is down it's loaded from the database instead.

Demo data: `npm run db:seed` adds 15 categories, 7 stores and 63 products (62 on sale and 1 draft, which must stay hidden), with 99 variants, specifications and a few running deals. The 14 product photos from the designs are reused.

Measured against Neon from a PC in the Philippines: searches and filters 0.26–0.37 s, a product page 0.22 s, the cached category list 0.10 s (the first request after starting takes about 1 s while connections open).

## If Redis (Upstash) goes down

Redis commands give up after 1 second instead of waiting, and each part of the API then does what's safest for it:

| Part | While Redis is down |
|---|---|
| Browsing and search, the general rate limit | Keep working: no limit, and the category list loads from the database instead of the cache (both logged) |
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
- `tests/catalog/catalog.test.ts` seeds the 63 demo products and checks search (words, typos, `-excluded` words, an injection attempt), every filter with its counts, every sort, deal prices before and after the countdown, stock labels, hidden products (draft, suspended store, no variant on sale) and the category cache with Redis down.
- `tests/db/migration.test.ts` checks that every table, index, foreign key and safety rule really exists. CI also migrates and seeds a real PostgreSQL 18 server, the same major version as Neon.

## Structure

```
src/
  app.ts                 builds the Express app (no server), so tests use the real app
  server.ts              starts the server, wires Redis/Prisma/sign-in, shuts down gracefully
  config/env.ts          validates environment variables at startup
  lib/                   logger, Redis/Prisma clients, key-value store, password hashing, crypto helpers,
                         email outbox, breached-password check, money helpers, error types, query parser,
                         cache (fails open), delivery rules (free over ₱999)
  middleware/            security headers + CORS, rate limit, CSRF + Origin check, auth guards, request IDs, errors
  modules/health/        GET /health (alive) and GET /ready (dependencies OK)
  modules/auth/          sign-in: routes → service (rules) → tokens, lockout, one-time codes, emails
  modules/catalog/       categories, search, product page: routes → service → search SQL + one pricing rule
  generated/prisma/      Prisma client (generated by `npm run db:generate`, not committed)
prisma/
  schema.prisma          the 31 tables
  migrations/            SQL applied to the database, in order
  seed.ts, demo-data.ts  demo categories, stores, products and accounts (safe to run again)
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
| Re-authenticate before high-value actions | "Confirm it's you" (app code → password → email code), 10 minutes, per device; changing the email needs it, plus a code from the new inbox. |
| Social sign-in (OAuth) safely | Authorization code + PKCE, state and nonce checked, ID token verified; code exchanged server to server; existing password accounts connect only after their password; unverified Google emails refused. |
| Two-factor authentication | Authenticator app (TOTP, `otpauth`) + 10 single-use backup codes; required for sellers and admins; also asked after a password reset; replay-proof; wrong codes count toward the lockout. |
| Encrypt sensitive data | The 2FA secret is encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`), bound to its user, so a copy pasted into another account fails to decrypt. Backup codes are keyed hashes. |
| Confirm email after sign-up | 6-digit code, 10 minutes, required before the first sign-in. |
| Account enumeration | Sign-up, sign-in and code endpoints answer the same whether or not the email has an account, and sign-in always runs one Argon2 check so the timing matches too. |
| Weak passwords | At least 8 characters, and passwords found in known breaches are refused (Have I Been Pwned; only 5 characters of a hash leave the server). |
| Rate limiting, DoS | `express-rate-limit` counts the real visitor IP behind proxies (`TRUST_PROXY_HOPS`), IPv6 grouped by /56. JSON bodies ≤ 10 KB (413 otherwise); passwords ≤ 128 characters. Search is bounded: at most 100 characters, 50 pages of 12, 24 or 48 products, and 50 query parameters; the text and typo searches use GIN indexes. |
| Special HTTP headers | `helmet` (HSTS, nosniff, frame protection…); `X-Powered-By` removed. |
| Parameter pollution, operator injection | Custom query parser: last value wins for repeated keys, except the filters meant to repeat (`category`, `store`), which become lists of at most 10 or 20 checked slugs; never builds nested objects, so `?price[$gt]=0` stays plain text and `__proto__` can't pollute objects. SQL goes through Prisma (parameterized); the hand-written search SQL passes what people type as parameters, and its sort orders come from a fixed list. |
| No error details to clients | One error format. Users see safe messages; stack traces go to the log under the same request ID. Logs redact cookies, passwords and tokens, and hide one-time values in URLs (e.g. Google's `code` and `state`). |
| Evil regular expressions | Only simple, linear patterns. |
| No secrets in git | `.env` is git-ignored; `npm run secrets` writes keys without printing them; config errors name a variable but never its value. |
| HTTPS | Production requires https origins and `APP_URL`, sets HSTS, and uses `__Host-`/`__Secure-` Secure cookies. |

Milestone 3 (sign-in & security) is complete. "Delete account" comes once orders exist (it must keep order records).
