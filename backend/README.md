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
| `npm run store:approve -- <web-address>` | Approve a store waiting for review (until the admin screens of milestone 7) |
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
| `GET /api/v1/products` | Search and browse: `q`, `category` and `store` (both repeatable), `minPrice`/`maxPrice` (centavos), `rating` (4 = "4★ & up"), `freeDelivery`, `deal`, `sort`, `page`, `pageSize` |
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

Demo data: `npm run db:seed` adds 15 categories, 7 stores and 63 products (62 on sale and 1 draft, which must stay hidden), with 99 variants, specifications and a few running deals, plus demo shoppers whose reviews give every rating (see below). The 14 product photos from the designs are reused.

Measured against Neon from a PC in the Philippines: searches and filters 0.26–0.37 s, a product page 0.22 s, the cached category list 0.10 s (the first request after starting takes about 1 s while connections open).

## Stores and reviews (milestone 4b)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/stores/{slug}` | Store page: banner, logo, "Verified seller", ★ rating, "98% positive", followers, ships from, "On Vendora since", category chips, deal count, "Ships within 24 hours", returns. Its products are the normal search with `store=` (and `deal=true` for the Deals chip). |
| `GET /api/v1/stores/{slug}/reviews` | The store's Reviews tab: every review of its products, each naming the product |
| `GET /api/v1/products/{id}/reviews` | A product's Reviews tab: average, "2,341 global ratings", star bars, filter by stars, newest/highest/lowest, 10 per page |
| `GET` / `PUT` / `DELETE /api/v1/stores/{slug}/follow` | Signed in: do I follow it, follow, unfollow |

How it works:
- **Every rating comes from real reviews.** A review can only exist for an item someone bought (the database requires an order item, so every review is a "Verified purchase"). Product and store ratings are stored, because search filters and sorts by them, but they're always recomputed from the published reviews (`modules/reviews/ratings.ts`), never typed in.
- **"98% positive"** is the share of 4★ and 5★ reviews in the last 12 months, rounded down, so 100% only shows when every review is positive. A store's rating counts all its products' reviews except products removed by moderation.
- **"Top rated" uses a weighted rating.** Each product starts with 5 imaginary 4★ reviews, so three 5★ reviews can't outrank a 4.8 from hundreds (a Bayesian average, the usual fix). The "4★ & up" filter still uses the plain average shown on the card.
- **"Ships within 24 hours"** is measured: 90% of the store's orders in the last 90 days shipped within that many hours (null with fewer than 5 orders).
- **Follow can't be double counted.** The follow row is inserted only if missing, and the follower counter moves only when a row was really added, in the same transaction, so double clicks or two tabs count once. Your own store can't be followed. Unfollow always works, even for a store that's since been suspended.
- **Public pages stay public.** The store page is the same for everyone and cacheable; "am I following?" is a separate signed-in request answered with `Cache-Control: private, no-store`, so a shared cache can never show one person's state to someone else.
- **Privacy.** Reviewers appear as "Maria S.": never their full name, email or id.

Demo reviews: the seed adds 40 demo shoppers (no password, so nobody can sign in as them) with 623 delivered orders and one review each, written to fit the product (headphones talk about battery life, serums about skin). Stars are drawn around each product's target, so the shop has the usual mix: mostly 5★ and 4★, a few 1–3★. The same products get the same reviews on every run.

Measured against Neon: store page 0.21 s (about 1 s on the first request after starting), reviews 0.25 s, follow/unfollow 0.3–0.4 s.

## Home and wishlist (milestone 4c)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/home` | Home's data sections: Shop by category, Today's deals (one "Ends in" countdown), Best sellers, Top-rated stores. The same for everyone, cached for a minute. |
| `GET /api/v1/products/cards?ids=…` | "Recently viewed": up to 20 product cards in the order given (the browser remembers what was viewed) |
| `GET /api/v1/wishlist` | Signed in: saved products, newest first, with price drops and the "Price drop on 2 saved items · Deals end in 08h 42m" banner |
| `GET /api/v1/wishlist/ids` | Signed in: which products are saved, to fill the hearts on cards |
| `PUT` / `DELETE /api/v1/wishlist/{id}` | Signed in: save (the heart) / remove |

How it works:
- **One Home answer for everyone.** Home is the busiest page, so its sections are built once, cached in Redis for 60 seconds and marked cacheable for browsers. Prices there can be a minute old; checkout always re-reads them. If Redis is down it's simply built each time. The hero, trust strip, AI band and "Start selling" card are fixed text in the frontend.
- **Today's deals** are deals with a running countdown, soonest first; the section's "Ends in" is the soonest. Deals without a countdown show under "See all deals" (`/products?deal=true`).
- **Best sellers** rank by total sold ("Most-loved across Vendora"); "this week" needs real orders, so it comes after checkout (milestone 5).
- **Top-rated stores** use the same weighted rating as "Top rated" products, so one 5★ review can't put a store on top. Each shows its real "% positive" and the top-level category most of its products are in.
- **A price drop is measured from the price when saved.** The saved row keeps that price; saving again keeps the first one. Today's price follows the usual rules (cheapest variant, ended deals don't count), so a deal that ends simply stops being a drop. Emails about drops come in milestone 6.
- **Products that stop being sold stay on the wishlist** as "No longer available" (and never count as a drop) until the shopper removes them; they come back if the product does. At most 200 items.
- **Cards say "Only 3 left"** when 1–5 units remain across the variants on sale; bigger stock numbers stay private.
- **Personal data stays out of shared caches.** Wishlist answers are `private, no-store`; Home and product cards are the same for everyone.

Measured against Neon: Home 0.10 s from the cache (1.7 s for the very first request after starting), Recently viewed 0.16 s, wishlist 0.15–0.4 s.

## Cart and addresses (milestone 5a)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/cart` | Signed in: the cart, one package per store, with today's prices, stock warnings, delivery per store and "You saved ₱…" |
| `POST /api/v1/cart/items` | Add to cart (adds to what's there) |
| `PATCH` / `DELETE /api/v1/cart/items/{variantId}` | Change a line's quantity / remove it |
| `GET /api/v1/cart/preview?items=…` | A guest's cart (kept in the browser), shown with the same rules; nothing is saved |
| `POST /api/v1/cart/merge` | At sign-in: the guest's cart joins the account cart |
| `GET` / `POST /api/v1/addresses` | Saved addresses (default first) / add one |
| `PUT` / `DELETE /api/v1/addresses/{id}` · `POST /api/v1/addresses/{id}/default` | Edit / delete / "Set as default" |

How it works:
- **Stock isn't held in the cart.** It's taken when the order is placed (milestone 5b). The cart just tells the truth about today's prices and stock: each line can carry an `issue` (`unavailable`, `out_of_stock`, `not_enough_stock`), and checkout needs `canCheckout`.
- **One package per store,** each with its own delivery: free from ₱999 of that store's items, otherwise ₱49, plus the "Add ₱X more for free delivery" nudge. A package whose items are all unavailable costs nothing.
- **"Price changed since you added it."** Each line remembers the price the shopper last saw (`priceAtAddCentavos`), so an ended deal or a seller's price change shows as a note until the quantity is changed.
- **Guests shop first, sign in at checkout.** A guest's cart lives in their browser; `GET /cart/preview` shows it with the same rules, and `POST /cart/merge` joins it to the account at sign-in: quantities add up, capped by stock and 99, and anything that can't be bought is skipped and reported, never an error, so signing in always works.
- **Two tabs can't race.** Every change to one shopper's cart (and addresses) runs in a transaction that first locks that shopper's row (`SELECT … FOR UPDATE`). Proven on real PostgreSQL: with the locks removed, four simultaneous "Add to cart" clicks lost updates, and two simultaneous first addresses both became the default.
- **Philippine addresses.** Any common mobile format ("0917 123 4567", "+63 917…") is stored as `+639XXXXXXXXX`; the region comes from the 18 regions; Metro Manila (NCR) has no province, every other region needs one; 4-digit postal code. The database enforces the formats and allows one default per shopper (a partial unique index). Up to 10 addresses; deleting the default passes it to the newest one left. Past orders keep their own copy, so editing an address never changes them.
- **Limits:** 50 different items, 99 of one item, only known fields accepted (`strict` schemas), and someone else's address answers 404, exactly like one that doesn't exist.

Measured against Neon from this PC: the guest preview 1.1 s on first use, cart changes 0.4–1.1 s (about ten round trips to Singapore inside one locked transaction), addresses 0.1–0.45 s. Next to the database (milestone 9) each round trip is about a millisecond.

## Checkout and payments (milestone 5b)

| Endpoint | What it does |
|---|---|
| `POST /api/v1/checkout/summary` | The checkout page: one package per store with Standard/Express, the address, payment methods (and why one isn't available), totals. Saves nothing. |
| `POST /api/v1/orders` | Place order (header `Idempotency-Key`). Online: returns PayMongo's page to send the shopper to. Cash on delivery: placed right away. |
| `GET /api/v1/orders/{id}` | The waiting, failed and confirmation pages (poll it while waiting) |
| `POST /api/v1/orders/{id}/payment` | "Try again", with the same or another method, within the 15 minutes |
| `POST /api/v1/orders/{id}/cancel` | Give up on an unpaid order ("Back to cart"); the stock is returned |
| `POST /api/v1/webhooks/paymongo` | PayMongo → Vendora (signed; not called by the frontend) |

How it works:
- **PayMongo Hosted Checkout.** "Pay ₱13,144 with GCash" sends the shopper to PayMongo's own page for that method; card numbers never touch Vendora. The amounts PayMongo charges are built on the server from the order (items plus each store's delivery) and must add up to the order total exactly.
- **Placing an order takes the stock: all of it or none.** The variant rows are locked in a fixed order (so two checkouts can't deadlock), checked, then reduced, in the same transaction that creates the order, one package per store (`seller_orders`) with a 5% platform fee (0% in a store's first 30 days). Prices, item names and the address are copied into the order, so later edits never change it. Proven on real PostgreSQL: without the row lock, two shoppers both saw "1 left" and the second checkout crashed instead of getting a clean "Only 0 left".
- **Shoppers are never charged a total they didn't see.** The page sends the total it showed; if a deal ended or a price changed meanwhile, nothing is ordered and the new total comes back (409 `total_changed`).
- **Double clicks give one order.** The browser sends one `Idempotency-Key` per checkout; a unique index on `(user, key)` makes the database refuse a second order, even for simultaneous requests (tested on real PostgreSQL), and the repeat gets the same order back.
- **Two ways to learn about a payment, one way to count it.** When the shopper comes back from PayMongo, the order page asks PayMongo (at most every 5 seconds); PayMongo's webhook says the same independently. Both run one `settle` step that locks the order and is idempotent: reported three times at once, a payment still counts once (one order, one email, sold counts raised once).
- **Webhooks are verified, not trusted.** `Paymongo-Signature` is an HMAC-SHA256 of "timestamp.raw body" with the webhook's secret, compared in constant time and refused if older than 5 minutes. The route sits before the JSON parser (the raw bytes are needed) and is the one place without the CSRF check (PayMongo can't send our token; the signature is the proof). Each event is stored once in `webhook_events`; both payload shapes in PayMongo's docs are read.
- **The 15-minute window.** An unpaid online order holds its stock for 15 minutes, with "Try again" (same or another method, including cash on delivery). A background check runs every minute: it stops PayMongo's page (sessions never expire on their own), then cancels the order and returns the stock; the cart is untouched. If PayMongo is mid-payment it refuses to stop, so the window stretches by 5 minutes, up to 45 minutes in total. A payment that went through but wasn't reported is found and settled instead of cancelled.
- **Late and double payments.** Paid after the order was cancelled: the stock is taken again if it's all still there and the order goes through; otherwise the full amount is refunded automatically through PayMongo and the shopper is emailed. A second payment for an already-paid order is refunded the same way. A payment for the wrong amount is never accepted (logged for a person to check).
- **If PayMongo can't be reached** when placing an order, the order is undone and the stock returned: nothing was charged. Without a PayMongo key, the checkout simply offers cash on delivery only.
- **Cash on delivery:** up to ₱5,000 per order and at most 2 not-yet-delivered COD orders per shopper, so fake orders can't tie up sellers' stock.
- **After payment** (or a COD order), each package goes to its seller as "Preparing" (ship within 2 days), the bought items leave the cart, the products' "sold" counts go up, and a confirmation email goes out. Sellers ship and mark deliveries in milestone 6.

Tested against a fake PayMongo that behaves like the real one (pay, fail, mid-payment refusals, outages, refunds, correctly signed webhooks in both shapes); the real HTTP client is tested separately with the network stubbed (exact URLs, auth header, request body, amounts).

## Your orders, tracking and reviews (milestone 5c)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/orders?tab=&q=&page=` | "Your orders": newest first, 10 per page; tabs All / To ship / On the way / Delivered with their counts; search by order number or product name |
| `GET /api/v1/orders/{id}` | The order page and package tracking (the same endpoint as the waiting and confirmation pages) |
| `POST /api/v1/orders/{id}/buy-again` | "Buy again": the order's items go back into the cart |
| `POST /api/v1/reviews` | "Write a review" for an item you bought, once its package is delivered |
| `PATCH` / `DELETE /api/v1/reviews/{id}` | Edit or delete your review, any time |
| `GET /api/v1/cart/recommendations` | "Recommended for you" on the cart page (signed in or guest) |

How it works:
- **Tabs follow the packages.** An order is "To ship" when at least one of its packages is still being prepared, "On the way" when one is shipped, so an order with two packages can be in both tabs at once (that's how a shopper thinks about it). The tab counts ignore the search.
- **Search** takes "VD-21458", "#VD-21458" or "21458", or words from a product's name. Prisma's `contains` becomes SQL `ILIKE '%…%'` without escaping `%` and `_`, so a "%" typed in the box matched every order until they were escaped (a test caught it).
- **Tracking in 4 real steps: Ordered → Preparing → Shipped → Delivered**, each with the moment it was reached. Sellers only mark "shipped" (with courier and tracking number) and "delivered" (milestone 6), and there's no courier connection, so the design's "Packed" and "Out for delivery" would be steps that never light up. The timeline is built from the same facts (paid with GCash, shipped with LBC · tracking 8841 2201, delivered), plus any extra courier updates in `shipment_events`.
- **Arrival is a date range, not a promise to the hour:** the "2–5 days" from checkout (Express 1–2), counted from when the order was paid, shown only while the package is on its way.
- **Buy again** reuses the sign-in cart merge: same quantities, capped by stock and 99; sold-out or removed items are skipped and reported, never an error. Not for an order still waiting for payment (its items are still held for it).
- **Reviews are for things you received.** One per order item (a unique index), only once that package is delivered, only by the buyer. Stars are required; the title and text are optional. Edit or delete any time; a review hidden by moderation stays hidden when edited.
- **Ratings stay true under load.** Every write recomputes the product's and the store's rating from the reviews in the same transaction, with the store row locked first. Without the lock, two reviews written at the same moment could each recompute from a count that's missing the other one (tested with simultaneous reviews).
- **Recommended for you** (5 cards): best sellers from the cart's categories first ("Based on your cart"); signed in, then the wishlist's categories and followed stores; topped up with best sellers (signed in) or top rated (guests). Never what's in the cart, never sold out. "See all" searches the category most of the cart is in.

## Becoming a seller (milestone 6a)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/seller/store` | "Open your store": what's done, what's `missing`, whether it can be submitted |
| `PUT /api/v1/seller/store` | Step 1, store details (creates the draft store) |
| `PUT` / `DELETE /api/v1/seller/store/logo` | The store logo |
| `PUT /api/v1/seller/store/verification` | Step 2, business verification (individual or registered business, TIN) |
| `POST /api/v1/seller/store/documents`, `DELETE …/documents/{id}` | ID and DTI/SEC documents |
| `PUT /api/v1/seller/store/payout-account` | Step 3, GCash or bank |
| `POST /api/v1/seller/store/submit` | "Submit for review" |
| `POST /api/v1/seller/uploads` | A one-time upload ticket (logo or document) |

How it works:
- **Two-step verification first.** Sellers handle other people's money, so an account needs 2FA before it can save any step (403 `two_factor_required`); sellers can't turn it off. Admin accounts can't open stores.
- **Drafts, then review.** Every step is saved as it goes ("Save and exit"): the store is a `DRAFT` nobody else sees. "Submit for review" checks every step, makes the store `PENDING` and the account a `SELLER` (one `POST /auth/refresh` puts the new role in the access pass), and emails a confirmation. Products can be added while it's reviewed (6b); shoppers see the store once an admin approves it (milestone 7; until then `npm run store:approve -- <web-address>`).
- **One name per store.** The name becomes the store's web address (`hearth-home`), so names are unique however they're written ("Glow-Lab" = "Glow Lab"), a few are reserved (anything with "vendora", "admin", "support"…), and the name is locked once submitted. Two sellers claiming a name at the same moment: the database's unique index decides.
- **Sensitive numbers are encrypted.** The TIN (required for everyone) and the payout account number are stored with AES-256-GCM, bound to their store; only "TIN ending in 000" and "•••• 4567" ever come back. Business details and documents are locked once submitted.
- **Changing where the money goes is guarded.** After submitting, a new payout account needs "Confirm it's you", is recorded in security activity, emails the owner (so a stolen session can't quietly redirect payouts), and is verified again.
- **Uploads go straight to Cloudinary**, not through our server. `POST /seller/uploads` returns a ticket signed with the API secret (which never leaves the server) for ONE file, at a place our server chose (`vendora/store-documents/<account>/<random>`), in the allowed formats, and it can never replace a file that's already there (`overwrite=false` is signed in; a live test showed a ticket could otherwise swap a file after our check). ID and business documents are `authenticated` (private) files that only admins will open, through expiring links (milestone 7). When the browser hands back the upload, the server checks it with Cloudinary's Admin API: it must be in this account's folder, really exist, and have an allowed type and size (logos 5 MB, documents 10 MB). Anything else is refused and deleted. Links and file sizes come from Cloudinary, never from the browser. A replaced or removed logo is deleted from Cloudinary. Without `CLOUDINARY_URL`, uploads are simply off.

## Products in Seller Center (milestone 6b)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/seller/products` | The products list: one row per variant, tabs All / Active / Drafts / Out of stock, search by name or SKU, category, 20 a page |
| `POST /api/v1/seller/products` | Add product: Save draft or Publish |
| `GET` / `PUT /api/v1/seller/products/{id}` | The Edit product form, and saving it |
| `DELETE /api/v1/seller/products/{id}` | Delete a product that never sold |
| `POST /api/v1/seller/uploads` (`product_photo`) | A one-time upload ticket for a product photo (120 an hour) |
| `GET` / `PUT /api/v1/notifications/preferences` | Email settings: price-drop emails on or off |
| `POST /api/v1/notifications/unsubscribe?token=…` | One-click unsubscribe from a price-drop email (no sign-in) |

How it works:
- **Sellers only.** An account whose store was submitted for review (role `SELLER`, checked in the database on every request, with 2FA on). Products can be prepared while the store is reviewed; shoppers see a product once it's published, active and the store is approved. A suspended store can look but not change anything; a product Vendora removed can't be changed.
- **Save draft or Publish.** A draft needs only a title and a category. Publish checks everything a shopper will see (a description, at least one photo and one variant, a sub-category, compare-at above the price, a deal end within 90 days), each problem next to its field. The Active toggle hides a published product; it never goes back to being a draft.
- **Variants:** one option per product that the seller names ("Color", "Size", "Model"); the product page shows "Size: XL". An empty SKU is made up ("AURA-SOUN-7KQ2XD"); SKUs are unique in the store.
- **Deals:** an optional "Deal ends" time puts the countdown on the product page and the product in Today's deals; afterwards the variants sell at their compare-at price again (the same pricing rule as everywhere, so nothing has to "end" it).
- **Two sellers' tabs, or a sale while editing, can't overwrite each other.** The form sends back the `version` it was loaded with; a product changed since is refused (409 `stale`, reload). Stock is applied as a **difference**: the form says "9 → 42", and those +33 are added to what's there now, so units sold meanwhile still count (going below 0 is refused with the real number left). The rows are locked in the same order checkout uses (store, variants by id, product), so a save and a sale wait for each other instead of deadlocking. Orders and reviews change the product row too (sold count, rating) but not its version, so they never block an edit.
- **Orders keep their history.** A variant that sold is hidden, not deleted; a product that sold can't be deleted (turn it off instead). A removed photo is deleted from Cloudinary unless a past order still shows it.
- **Express delivery** is a per-product setting: a store's package can go Express only if every item in it allows it. Checkout shows Standard for the others, and "Place order" refuses an Express choice that isn't possible (409 `express_unavailable`).
- **The product form may be up to 64 KB** (a 5,000-character description, 30 variants, 30 specifications); every other request keeps the 10 KB limit.

**Price-drop emails.** A job runs every 15 minutes and looks at the data, not at events: a saved item whose price today (cheapest variant, ended deals don't count) is below the price when it was saved AND below the price we last emailed about. So it doesn't matter what caused the drop (a seller's edit, a deal starting), and a missed run catches up on the next one. At most one email a day per shopper (later drops wait and come together, biggest saving first); a drop that's over (the price went back up) makes the next one news again. Only active, visible products, and only shoppers with a verified email who haven't turned them off. Each shopper's email is "claimed" with a conditional update on their own row, so two runs or two servers at once still send one. Every email has an unsubscribe link and the `List-Unsubscribe` / `List-Unsubscribe-Post` headers mail apps use for their own one-click button (RFC 8058); the link carries a signed token (HMAC with the server's code key and its own purpose prefix), so it needs no sign-in or CSRF token and can't be forged for another account.

## Orders in Seller Center (milestone 6c)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/seller/orders?tab=&q=&page=` | The orders list: tabs To ship / Shipped / Delivered / All with counts, 20 a page, "3 orders are due to ship today by 6:00 PM" |
| `GET /api/v1/seller/orders/export?tab=&q=` | Export CSV (up to 5,000 orders) |
| `GET /api/v1/seller/orders/{id}` | One order: items, Ship to, the timeline, what the seller earns (also the packing slip's data) |
| `PUT /api/v1/seller/orders/{id}/shipment` | "Mark as shipped" with courier and tracking number (and fixing a typo until delivery) |
| `POST /api/v1/seller/orders/{id}/cancel` | "Cancel order" with a reason, while it's still to ship |
| `POST /api/v1/orders/{id}/packages/{packageId}/received` | The buyer's "Order received" |
| `POST /api/v1/orders/{id}/cancel` | The buyer's "Cancel order": unpaid, or paid less than an hour ago |

How it works:
- **A seller sees only what's theirs to ship:** their own store's packages, once paid (or placed with cash on delivery), never another store's items or the buyer's whole total. "To ship" lists the most urgent first.
- **Ship by 6:00 PM (Manila), 2 days after payment**, like a courier's daily pickup cutoff, so "due today by 6:00 PM" is one time for every order. Late ones are marked late.
- **Mark as shipped** takes a courier from a list and the tracking number, kept as letters and digits only ("7720 1934-5512" → "772019345512"). A tracking number is unique per courier (a database index), so a package can't be "shipped" with another package's number. The change only happens if the package is still "to ship", checked in the same statement, so a double click or two tabs ship it once and the buyer gets one email. Until delivery, a typo can be fixed (the buyer gets the new number). A suspended store can still ship orders that are already paid.
- **Delivery is confirmed by the buyer** ("Order received" on the tracking page), or automatically 7 days after shipping by a job every 15 minutes (how Shopee and Lazada work: sellers can't mark their own packages delivered, and there's no courier connection to ask).
- **Confirming is one transaction:** the package becomes delivered (only if it's still shipped, so the buyer's tap and the job at the same moment count once), the seller is credited in the **ledger**, and once no package of the order is on its way the order is completed and a cash-on-delivery payment counts as paid. The order row is locked first, as in checkout, so two packages of one order delivered at the same moment still complete it exactly once.
- **The ledger** holds the seller's money as lines, never as one balance that's overwritten: a sale (+ the items) and Vendora's fee (−5%, none in a store's first 30 days), both available 7 days after delivery. The delivery fee isn't the seller's (Vendora pays the couriers). A partial unique index allows one sale and one fee per package, so a package can't be credited twice. Packages delivered before this milestone got their lines from the migration. Payouts come in 6d.
- **Buyers' privacy:** the list and the CSV show "Maria S." and the city. The full address and phone are on the order page only while the package still has to reach the buyer; after delivery, only the name and city. Search finds order numbers and product names, not customers.
- **The CSV** is UTF-8 with a byte-order mark (so Excel reads ₱ and ñ), times in Philippine time, amounts in pesos. A cell that starts with `=`, `+`, `-` or `@` gets a leading apostrophe: otherwise a buyer could put a formula in their name (`=HYPERLINK(…)`) and it would run when the seller opens the file (CSV injection, tested).
- **Emails:** the seller gets "New order VD-21458: ship by Nov 25, 6:00 PM" once the order is paid (right away for cash on delivery), exactly once even when the payment is reported twice; the buyer gets the courier and tracking number when it ships.
- **Low-stock emails** (the product form's stock alert): a job every 15 minutes finds active variants below 10 the seller hasn't been told about, and sends one email per store (lowest stock first, sold-out included). Each variant is announced once, until it's restocked to 10 or more. A low number the seller typed in the form isn't news. Variants are "claimed" with a conditional update, so two runs at once send one email.

### Cancellations and refunds (milestone 6c-2)

- **Who can cancel a paid package that hasn't shipped:** the seller (with a reason: out of stock, can't ship to this address, the buyer asked), the buyer within an hour of paying (every package not shipped yet), or nobody: a job every 15 minutes cancels packages still not shipped 3 days after their ship-by time. Before that, the seller is emailed twice: when the order becomes late, and the day before. Every cancellation records who and why (no automatic penalty; the dashboard and admins see the rate).
- **One transaction per package:** cancelled only if it's still "to ship" (checked in the same statement, so a cancel and a "Mark as shipped" at the same moment can't both win); the stock goes back, except for "out of stock", which sets it to 0 (the seller just said it isn't there); the refund is recorded; and the order closes once nothing's left on its way (cancelled if nothing was delivered). Cash on delivery has nothing to refund: the amount the courier collects goes down.
- **Refunds are saved before they're sent.** Every refund (cancelled packages, and the second-payment and late-payment refunds from checkout) is a row in `refunds`, written in the same transaction as the change that causes it, after checking the payment's refunds never add up to more than was paid. It's then sent to PayMongo with our id in the refund's `metadata`.
- **Never twice, never lost.** Sending first "claims" the refund with a conditional update that also moves its next try an hour ahead, so two runs can't send it at once and a crash mid-send just means a retry later. A retry first lists the payment's refunds at PayMongo and looks for our id: if an earlier try went through and only the answer was lost, it's recorded as sent instead of sent again. PayMongo refusing (an outage, or a test account's "available balance insufficient") is retried every hour for 3 days; then the refund is FAILED, "needs a manual refund" (admins, milestone 7), and the buyer is told it's delayed.
- **PayMongo's reference was wrong about one thing:** it documents the refunds filter as `data.attributes.payment_id`, but the live API refuses that (400 `parameter_invalid`); plain `?payment_id=` works (checked read-only on the test account).
- **The buyer sees** "Cancelled by the seller · out of stock" and "Refund of ₱549 sent to your GCash" on the tracking page, and gets an email for the cancellation and another when the refund is sent. A payment for an order that was paid and later cancelled is never used to revive it: it's refunded as a duplicate.

## If Redis (Upstash) goes down

Redis commands give up after 1 second instead of waiting, and each part of the API then does what's safest for it:

| Part | While Redis is down |
|---|---|
| Browsing and search, the general rate limit | Keep working: no limit, and the category list and Home load from the database instead of the cache (both logged) |
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
- `tests/catalog/stores.test.ts` and `reviews.test.ts` check the store page against the database ("98% positive", shipping time, chips), Follow with real cookies and CSRF tokens (double clicks, four clicks at once, own store, suspended store), reviews (star bars, filters, sorts, paging, hidden and removed reviews, no personal data) and that every demo review sits on a delivered order of that product by that reviewer.
- `tests/catalog/home.test.ts` and `wishlist.test.ts` check Home's sections against the search and store pages (countdowns only, weighted store ranking, suspended stores left out, the Redis cache), Recently viewed (order, hidden products, limits) and the wishlist (price drops from the saved price, deals that end, unavailable products, other shoppers' lists, simultaneous saves, the 200 limit).
- `tests/checkout/cart.test.ts` and `addresses.test.ts` check the cart (delivery per store from exactly ₱999, stock and price notes, sold out and hidden items, the guest preview and the merge, limits, simultaneous clicks, other shoppers' carts) and addresses (formats, one default, the whole-form edit, deleting the default, limits, privacy).
- `tests/checkout/orders.test.ts` drives checkout end to end against a fake PayMongo: placing orders (stock, snapshots, amounts), one order per Idempotency-Key, changed totals, the last unit, PayMongo down, payment by return and by signed webhook, bad signatures, wrong amounts, simultaneous reports, retries, the 15-minute window, late and duplicate payments with refunds, cash-on-delivery limits and privacy. `paymongo.test.ts` checks the real PayMongo client (requests, responses, signatures).
- `tests/checkout/my-orders.test.ts` checks "Your orders" (tabs and counts, packages in two tabs, search by number and product name with `%` and `_` as plain text, pages, unpaid and cancelled orders, privacy), tracking (the 4 steps, arrival dates for Standard and Express, the timeline with courier updates) and Buy again (stock, sold-out and removed items). `recommendations.test.ts` checks the cart's "Recommended for you" (cart categories first, never cart items, sold-out or draft products, the wishlist and followed stores, top-ups, "See all"). `tests/catalog/write-reviews.test.ts` checks writing, editing and deleting reviews (only after delivery, one per item even when sent twice at once, only your own, field rules) and that the stored ratings always equal what the reviews say, also when several shoppers review one store at the same moment.
- `tests/seller/onboarding.test.ts` walks through becoming a seller against a fake Cloudinary: 2FA first, drafts, submit and approval, encrypted TIN and payout number, registered businesses, unique and reserved names (also claimed at the same moment), locked details after submitting, re-auth and an email for payout changes, uploads (someone else's file, missing, too big, wrong type, the same file twice, limits, outages) and privacy. `media.test.ts` checks the real Cloudinary client (signatures against Cloudinary's documented example, requests, outages).
- `tests/seller/products.test.ts` checks Seller Center products: who may sell (shoppers, draft stores, missing 2FA, suspended stores, admins), Save draft and every Publish rule, photos (someone else's, missing, too big, one file per photo, the 120-an-hour allowance), SKUs, the 64 KB form, out-of-date forms, stock as a difference while orders come in, variants and photos that past orders still use, the Active toggle (carts too), deals before and after they end, delete, the list (tabs that add up, search with `%` and `_` as plain text, categories, sold in 30 days, low stock, pages) and Express delivery at checkout. `tests/notifications/price-drops.test.ts` checks price-drop emails: once per price, at most one a day, drops that end, deals, hidden products, opted-out and unverified shoppers, the unsubscribe link (forged and tampered tokens) and simultaneous runs.
- `tests/seller/orders.test.ts` checks Seller Center orders: only my paid packages, To ship by urgency, today's 6:00 PM deadline and late ones, search, the order page (my items only, address while it needs shipping, earnings, what's next), Mark as shipped (every field rule, the tracking number format, two clicks at once, fixing a typo, someone else's tracking number, after delivery, suspended stores), the new-order email (cash on delivery and online, a payment reported twice), privacy after delivery and Export CSV (formula injection from a buyer's name). `tests/checkout/delivery.test.ts` checks "Order received" (ledger lines and dates, the order completing, cash collected, pressing twice, not shipped yet, someone else's), the automatic confirmation after 7 days, and the buyer and the job at the same moment. `tests/checkout/cancellations.test.ts` checks cancellations and refunds: the seller's Cancel order (every rule, stock back or to 0, the refund amount with the delivery fee, emails, a cancel and a ship at the same moment), two-store orders, cash on delivery, the buyer's cancel within the hour (and after it), the warnings and the automatic cancel, refunds PayMongo refuses (hourly retries, given up after 3 days), a lost answer found by our id, two runs at once, and a late payment for a cancelled order. `tests/notifications/low-stock.test.ts` checks low-stock emails (once until restocked, typed-in numbers, the alert off, one email per store, simultaneous runs). `tests/deadlines.test.ts` checks ship-by times in Manila, CSV escaping and "Maria S.".
- `tests/db/migration.test.ts` checks that every table, index, foreign key and safety rule really exists. CI also migrates and seeds a real PostgreSQL 18 server, the same major version as Neon.

## Structure

```
src/
  app.ts                 builds the Express app (no server), so tests use the real app
  server.ts              starts the server, wires Redis/Prisma/sign-in, shuts down gracefully
  config/env.ts          validates environment variables at startup
  lib/                   logger, Redis/Prisma clients, key-value store, password hashing, crypto helpers,
                         email outbox, breached-password check, money helpers, error types, query parser,
                         cache (fails open), delivery rules (free over ₱999), CSV files (formula-safe)
  middleware/            security headers + CORS, rate limit, CSRF + Origin check, auth guards, request IDs, errors
  modules/health/        GET /health (alive) and GET /ready (dependencies OK)
  modules/auth/          sign-in: routes → service (rules) → tokens, lockout, one-time codes, emails
  modules/catalog/       categories, search, product page: routes → service → search SQL + one pricing rule + one visibility rule
  modules/stores/        store page, follow
  modules/reviews/       product and store reviews, writing your own; ratings.ts recomputes ratings from reviews
  modules/home/          Home's sections (cached for a minute)
  modules/wishlist/      saved products and price drops
  modules/cart/          the cart (signed in and guest), merged at sign-in; Recommended for you
  lib/media.ts           file storage (Cloudinary): upload tickets, checking and deleting files
  modules/addresses/     saved Philippine delivery addresses
  modules/orders/        checkout, orders, PayMongo payments and webhooks, the 15-minute window; your orders, tracking, buy again;
                         delivery ("Order received", automatic after 7 days), cancellations, refunds (with retries)
                         and the order deadlines
  modules/seller/        Seller Center: becoming a seller (onboarding, documents, payout account), products, uploads,
                         orders (ship, CSV), the earnings ledger
  modules/notifications/ price-drop and low-stock emails (15-minute jobs), email settings, one-click unsubscribe
  generated/prisma/      Prisma client (generated by `npm run db:generate`, not committed)
prisma/
  schema.prisma          the 32 tables
  migrations/            SQL applied to the database, in order
  seed.ts, demo-data.ts  demo categories, stores, products and accounts (safe to run again)
  demo-reviews.ts        demo shoppers, their delivered orders and reviews
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
| CSRF | Three layers: SameSite cookies, an **Origin check**, and a signed double-submit token (`csrf-csrf`, the maintained successor of `csurf`) tied to an id that changes at sign-in and sign-out. The two exceptions need no cookies: the PayMongo webhook is verified by its HMAC signature, and the one-click unsubscribe link by its signed token. |
| Refresh tokens | Rotation on every use; reuse of an old one signs out the whole chain. Sign-ins end after 30 days ("keep me signed in") or 1 day at most, and refreshing never extends that. |
| JWT blacklist | Signed-out passes and revoked chains are denied in Redis until they would have expired. |
| Deny JWTs issued before a password change | Reset and change set a per-user "invalid before" time in Redis and revoke every other sign-in chain, so older passes stop working at once. |
| Password reset tokens | 256 random bits, stored only as a keyed hash, 30-minute expiry, single use, a newer link cancels older ones; at most 1 email a minute and 5 a day. The token sits after `#` in the link, so it never reaches server logs or other sites. |
| Notify on security changes | Emails after a password reset or change, turning 2FA on or off, every backup-code sign-in, and a changed payout account, each with a way out if it wasn't them. |
| Re-authenticate before high-value actions | "Confirm it's you" (app code → password → email code), 10 minutes, per device; changing the email needs it, plus a code from the new inbox; so does changing a store's payout account. |
| Social sign-in (OAuth) safely | Authorization code + PKCE, state and nonce checked, ID token verified; code exchanged server to server; existing password accounts connect only after their password; unverified Google emails refused. |
| Two-factor authentication | Authenticator app (TOTP, `otpauth`) + 10 single-use backup codes; required for sellers and admins; also asked after a password reset; replay-proof; wrong codes count toward the lockout. |
| Encrypt sensitive data | The 2FA secret is encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`), bound to its user, so a copy pasted into another account fails to decrypt. Sellers' TINs and payout account numbers are encrypted the same way, bound to their store; only the last digits are ever shown. Backup codes are keyed hashes. |
| Confirm email after sign-up | 6-digit code, 10 minutes, required before the first sign-in. |
| Account enumeration | Sign-up, sign-in and code endpoints answer the same whether or not the email has an account, and sign-in always runs one Argon2 check so the timing matches too. |
| Weak passwords | At least 8 characters, and passwords found in known breaches are refused (Have I Been Pwned; only 5 characters of a hash leave the server). |
| Rate limiting, DoS | `express-rate-limit` counts the real visitor IP behind proxies (`TRUST_PROXY_HOPS`), IPv6 grouped by /56. JSON bodies ≤ 10 KB (the product form ≤ 64 KB; 413 otherwise); passwords ≤ 128 characters. Search is bounded: at most 100 characters, 50 pages of 12, 24 or 48 products, and 50 query parameters; the text and typo searches use GIN indexes. |
| Special HTTP headers | `helmet` (HSTS, nosniff, frame protection…); `X-Powered-By` removed. |
| Parameter pollution, operator injection | Custom query parser: last value wins for repeated keys, except the filters meant to repeat (`category`, `store`), which become lists of at most 10 or 20 checked slugs; never builds nested objects, so `?price[$gt]=0` stays plain text and `__proto__` can't pollute objects. SQL goes through Prisma (parameterized); the hand-written search SQL passes what people type as parameters, and its sort orders come from a fixed list. |
| No error details to clients | One error format. Users see safe messages; stack traces go to the log under the same request ID. Logs redact cookies, passwords and tokens, and hide one-time values in URLs (e.g. Google's `code` and `state`). |
| File uploads | Files go straight to Cloudinary with a one-time signed ticket for a place the server chose, which can never replace an existing file; the server then checks the owner's folder, type and size with Cloudinary before using a file (and deletes rejected ones). ID documents are private (`authenticated`) files. File names and links come only from the server; one stored file is one photo (a unique index). Files nobody uses any more (replaced logos, removed photos) are deleted. |
| Evil regular expressions | Only simple, linear patterns. |
| CSV injection | Exported CSV cells that start with `=`, `+`, `-`, `@` (or a tab / carriage return) get a leading apostrophe, so a formula in a buyer's name or city shows as text in Excel instead of running. |
| Data minimisation | Sellers see a buyer's full address and phone only while the package still has to reach them; lists, exports and delivered orders show "Maria S." and the city. |
| No secrets in git | `.env` is git-ignored; `npm run secrets` writes keys without printing them; config errors name a variable but never its value. |
| HTTPS | Production requires https origins and `APP_URL`, sets HSTS, and uses `__Host-`/`__Secure-` Secure cookies. |

Milestone 3 (sign-in & security) is complete. "Delete account" comes once orders exist (it must keep order records).
