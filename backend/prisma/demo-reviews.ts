/**
 * Demo reviews that are REAL rows, not typed-in numbers: 40 demo shoppers each "bought"
 * products (a delivered order behind every review, so every review is a verified
 * purchase), and the product and store ratings are then recomputed from them.
 *
 * Deterministic: the same products get the same reviews on every run (only the dates
 * move with `now`). Re-running replaces the demo shoppers' orders and reviews; nobody
 * else's are touched. Demo shoppers have no password, so nobody can sign in as them.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { DELIVERY } from "../src/lib/delivery.js";
import { earningsAvailableAt } from "../src/modules/orders/deadlines.js";
import { recomputeRatings } from "../src/modules/reviews/ratings.js";
import type { DemoProduct } from "./demo-data.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Reviews go back at most this far. */
const HISTORY_DAYS = 540;

export const SHOPPERS = [
  "Andrea Reyes", "Paolo Cruz", "Bea Mendoza", "Carlo Garcia", "Jasmine Torres", "Miguel Ramos", "Patricia Flores", "Rafael Navarro",
  "Kristine Bautista", "Joshua Villanueva", "Camille Aquino", "Gabriel Castillo", "Nicole Dela Cruz", "Mark Fernandez", "Angelica Lim",
  "Jerome Tan", "Sofia Gonzales", "Ken Domingo", "Trisha Pascual", "Daniel Mercado", "Isabel Salazar", "Renz Manalo", "Aira Valdez",
  "Vincent Sy", "Clarisse Ocampo", "Luis Rivera", "Hannah Javier", "Adrian Soriano", "Mika Santiago", "Enzo Del Rosario", "Kim Aguilar",
  "Jodi Lopez", "Arvin Panganiban", "Lea Robles", "Marco Ignacio", "Diane Cabrera", "Franco Uy", "Ella Marquez", "Rico Tolentino", "Joy Fajardo"
].map((name) => ({ name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com` }));

const ADDRESSES = [
  { region: "NCR", province: null, city: "Quezon City", barangay: "Diliman", street: "12 Maginhawa St.", postalCode: "1101" },
  { region: "NCR", province: null, city: "Makati City", barangay: "Poblacion", street: "45 Kalayaan Ave.", postalCode: "1210" },
  { region: "NCR", province: null, city: "Pasig City", barangay: "Kapitolyo", street: "8 East Capitol Dr.", postalCode: "1603" },
  { region: "Central Visayas", province: "Cebu", city: "Cebu City", barangay: "Lahug", street: "21 Salinas Dr.", postalCode: "6000" },
  { region: "Davao Region", province: "Davao del Sur", city: "Davao City", barangay: "Poblacion", street: "17 San Pedro St.", postalCode: "8000" },
  { region: "CALABARZON", province: "Laguna", city: "Santa Rosa", barangay: "Balibago", street: "3 Mabini St.", postalCode: "4026" },
  { region: "Central Luzon", province: "Pampanga", city: "Angeles City", barangay: "Balibago", street: "9 Fields Ave.", postalCode: "2009" },
  { region: "Western Visayas", province: "Iloilo", city: "Iloilo City", barangay: "Jaro", street: "30 Lopez Jaena St.", postalCode: "5000" }
];

const COURIERS = ["J&T Express", "LBC", "Ninja Van", "Flash Express"];
const PAYMENT_METHODS = ["GCASH", "MAYA", "CARD", "COD"] as const;
/** Hours from order to shipping: SoundCraft is the fast one in the designs ("Ships within 24 hours"). */
const HANDLING_HOURS: Record<string, [min: number, max: number]> = { "soundcraft-audio": [3, 20] };
const DEFAULT_HANDLING: [number, number] = [8, 44];

// --- review text --------------------------------------------------------------

type Band = "great" | "good" | "mixed" | "poor";
type Texts = Record<Band, { titles: string[]; bodies: string[] }>;

const KIND_OF_CATEGORY: Record<string, string> = {
  headphones: "audio", speakers: "audio", wearables: "wearable", shoes: "shoes", accessories: "eyewear", "bags-travel": "bag",
  lighting: "lamp", kitchen: "coffee", skincare: "skincare", fragrance: "fragrance", "sports-fitness": "fitness"
};

const TEXTS: Record<string, Texts> = {
  audio: {
    great: { titles: ["Worth every peso", "Great sound for the price", "Battery lasts forever"], bodies: [
      "Bass is punchy without drowning the vocals. I use it every day on the MRT and it still has battery left by Friday.",
      "Pairing was instant with my phone and laptop. Calls sound clear; my officemates said I didn't sound like I was on a jeep.",
      "Blocks most of the aircon hum at the office, and it's comfortable even after a full day.",
      "Clear highs, warm lows. I switched from a much pricier brand and honestly don't miss it."] },
    good: { titles: ["Very good, small nitpicks", "Solid for daily use"], bodies: [
      "Sound is great. I only wish the buttons felt a bit more premium.",
      "Good battery and easy to pair. Gets a little warm after two hours, but nothing serious.",
      "Does everything I need. The app could use more EQ presets."] },
    mixed: { titles: ["Decent but not amazing"], bodies: [
      "Sound is fine, but the connection drops once in a while when my phone is in my back pocket.",
      "Average sound for the price. Comfortable, though."] },
    poor: { titles: ["Not for me"], bodies: [
      "One side became quieter after three weeks. Requested a replacement under warranty.",
      "Too tight for my head, and the bass is weaker than I expected."] }
  },
  wearable: {
    great: { titles: ["Accurate and comfy", "Battery is amazing"], bodies: [
      "Step and heart-rate readings match my gym's treadmill closely. I barely notice it on my wrist when sleeping.",
      "Lasts more than a week on one charge with notifications on. The screen is readable even under the noon sun.",
      "Bought it for my mom and she figured it out on her own. She loves the reminders to stand up and drink water.",
      "Sleep tracking is surprisingly detailed. The strap is soft and doesn't irritate my skin."] },
    good: { titles: ["Great value", "Almost perfect"], bodies: [
      "Does everything I need. The app takes a few seconds to sync, but it's reliable.",
      "Very good tracker. I wish there were more watch faces.",
      "Comfortable and accurate. The charging cable is a bit short."] },
    mixed: { titles: ["It's okay"], bodies: [
      "Heart rate jumps around during HIIT workouts, but it's fine for walking and sleep.",
      "Good features, but notifications sometimes arrive late."] },
    poor: { titles: ["Stopped working well"], bodies: [
      "Stopped syncing after an app update. Hoping a fix comes soon.",
      "The strap broke after a month. Expected more."] }
  },
  shoes: {
    great: { titles: ["Super comfy", "True to size"], bodies: [
      "Wore them all day on a mall tour and my feet didn't hurt. True to size for me.",
      "Light, breathable and easy to clean. Perfect for our weather.",
      "Great grip even on wet tiles. I bought a second pair in another color.",
      "Looks even better in person. The cushioning is soft but still supportive."] },
    good: { titles: ["Comfortable, runs slightly small", "Good pair"], bodies: [
      "Very comfortable, but I'd go half a size up if you have wide feet.",
      "Nice quality for the price. Took a few days to break in.",
      "Good for daily walking. The insole could be thicker."] },
    mixed: { titles: ["Just okay"], bodies: [
      "Comfortable, but the color is a bit different from the photos.",
      "Okay for short walks. My feet get tired after a few hours."] },
    poor: { titles: ["Didn't last"], bodies: [
      "The sole started peeling after two months of daily use.",
      "Too narrow for me, and I had to return them."] }
  },
  eyewear: {
    great: { titles: ["Stylish and sturdy", "Love these shades"], bodies: [
      "The polarized lenses really cut the glare when driving. The frame feels solid, not cheap at all.",
      "Got compliments the first day I wore them. Comes with a nice case and cleaning cloth.",
      "Light enough to wear all day at the beach, and they fit my face well.",
      "Lenses are clear with no distortion. Great for road trips up north."] },
    good: { titles: ["Nice pair", "Good quality"], bodies: [
      "They look great, but they slide down a little when I sweat.",
      "Nice quality. The case is a bit bulky for my bag.",
      "Good lenses, slightly tight at the temples at first."] },
    mixed: { titles: ["Fine for the price"], bodies: [
      "They're fine, but the tint is lighter than I hoped.",
      "Decent, but the hinge feels a bit loose."] },
    poor: { titles: ["Not what I expected"], bodies: [
      "Scratched easily within the first week.",
      "Too big for my face. I should have checked the measurements."] }
  },
  bag: {
    great: { titles: ["Built to last", "Fits everything"], bodies: [
      "Fits my 15-inch laptop, charger, lunch box and an umbrella. The stitching is very neat.",
      "Survived a week of rainy-season commuting with everything inside still dry.",
      "The straps are well padded, so it doesn't hurt my shoulders even when full.",
      "Lots of pockets, and the hidden back pocket is perfect for my wallet when commuting."] },
    good: { titles: ["Great bag", "Roomy and well made"], bodies: [
      "Great bag. The zipper is a little stiff at first.",
      "Good quality and roomy. A bit heavier than I expected.",
      "Very useful compartments. I wish it came in more colors."] },
    mixed: { titles: ["Okay for school"], bodies: [
      "Nice design, but the bottle pocket is too small for my tumbler.",
      "Okay for school, but the material creases easily."] },
    poor: { titles: ["Strap came loose"], bodies: [
      "One strap's stitching came loose after a month.",
      "Smaller than I expected from the photos."] }
  },
  lamp: {
    great: { titles: ["Makes the room so cozy", "Beautiful craftsmanship"], bodies: [
      "The light is warm and soft, perfect for reading at night. You can tell it was made with care.",
      "Looks like something from a hotel. It arrived well wrapped, without a single scratch.",
      "Bright enough for my desk, and the dimmer is smooth. Very happy.",
      "Gave it as a housewarming gift and my friend loved it."] },
    good: { titles: ["Lovely lamp", "Beautiful, small nitpick"], bodies: [
      "Lovely lamp. The cord could be a little longer.",
      "Beautiful, but the bulb isn't included, so buy one with it.",
      "Great quality. Slightly smaller than I imagined."] },
    mixed: { titles: ["Pretty, but dim"], bodies: [
      "Pretty, but the light is dimmer than I wanted for working.",
      "Nice design, but the switch feels a bit flimsy."] },
    poor: { titles: ["Arrived damaged"], bodies: [
      "Arrived with a small chip on the base, so I asked for a replacement.",
      "The light flickers sometimes. Not what I expected for the price."] }
  },
  coffee: {
    great: { titles: ["Better coffee at home", "Quality you can feel"], bodies: [
      "My morning coffee tastes like the café's now. Everything feels solid in the hand.",
      "Well made and easy to clean. Perfect for barako beans.",
      "A great gift for coffee lovers. Even the packaging looks premium.",
      "Precise and consistent. I've stopped buying coffee outside, so it paid for itself."] },
    good: { titles: ["Very good", "Nice quality"], bodies: [
      "Very good, it just takes some practice to get the brew right.",
      "Nice quality. The handle gets a little warm.",
      "Solid build. I wish it came with a small cleaning brush."] },
    mixed: { titles: ["Works, but slow"], bodies: [
      "Works fine, but it's slower than I expected.",
      "Decent, but smaller than it looks in the photos."] },
    poor: { titles: ["Not for me"], bodies: [
      "One piece arrived cracked, so I asked for a replacement.",
      "Hard to clean properly. Not for me."] }
  },
  skincare: {
    great: { titles: ["Holy grail!", "Visible results"], bodies: [
      "My dark spots faded after about a month. It absorbs quickly and doesn't feel sticky in this humidity.",
      "No breakouts at all, and my skin feels hydrated without being oily.",
      "Gentle on my sensitive skin. I'm already on my second bottle.",
      "Lightweight and works well under makeup. No white cast, no greasiness."] },
    good: { titles: ["Works well", "Nice texture"], bodies: [
      "Works well, it just takes a few weeks to see results.",
      "Nice texture. The scent was a bit strong for me at first.",
      "Good product. The dropper could be better."] },
    mixed: { titles: ["Didn't see much change"], bodies: [
      "It's okay. I didn't see much difference after three weeks.",
      "Feels nice, but a little sticky by the afternoon."] },
    poor: { titles: ["Broke me out"], bodies: [
      "It caused small bumps on my cheeks, so I had to stop using it.",
      "Didn't work for my skin type, unfortunately."] }
  },
  fragrance: {
    great: { titles: ["Smells amazing", "Long-lasting"], bodies: [
      "Lasts the whole day, even in the heat. People always ask what I'm wearing.",
      "Fresh but not too strong. Perfect for the office.",
      "A beautiful bottle, and the scent is even better. Great gift.",
      "Smells expensive. Still noticeable on my clothes the next morning."] },
    good: { titles: ["Lovely scent", "Great for daytime"], bodies: [
      "Lovely scent, though it fades a bit after six hours.",
      "Very nice, but the sprayer is a bit stiff.",
      "Great scent for daytime. A little sweeter than I expected."] },
    mixed: { titles: ["Doesn't last long"], bodies: [
      "Nice, but it doesn't last as long as I hoped.",
      "The scent is pleasant but not very unique."] },
    poor: { titles: ["Not as described"], bodies: [
      "It smelled different from what the description suggested.",
      "Too strong for me. It gave me a headache."] }
  },
  fitness: {
    great: { titles: ["Exactly what I needed", "Great for workouts"], bodies: [
      "Keeps water ice-cold the whole day, even left in the car. No leaks in my bag.",
      "Non-slip even during sweaty sessions, and thick enough to protect my knees.",
      "Sturdy and easy to clean. I use it every day at the gym.",
      "Great quality, and the color is even nicer in person."] },
    good: { titles: ["Very good", "Does the job well"], bodies: [
      "Very good. Slightly heavier than I expected.",
      "Works great, but the smell took a few days to go away.",
      "Good product. The strap could be stronger."] },
    mixed: { titles: ["It's fine"], bodies: [
      "It's fine, but the lid is a bit hard to open.",
      "Okay quality for the price, nothing special."] },
    poor: { titles: ["Started leaking"], bodies: [
      "Started leaking after a few weeks.",
      "Too slippery for hot yoga."] }
  }
};

/** Reviews that fit any product, mixed in so a product's reviews rarely repeat. */
const GENERIC: Texts = {
  great: { titles: ["Sulit!", "Highly recommended", "Exactly as described", "Legit seller", "Will buy again"], bodies: [
    "Exactly as described and works perfectly. Will order again from this shop.",
    "100% legit and well packed. Sulit na sulit.",
    "Fast delivery, and it's even better in person. Thank you, seller!",
    "Bought this after reading the reviews, and they were right. Very happy.",
    "Great quality for the price. Highly recommended."] },
  good: { titles: ["Good buy", "Happy with it", "Recommended"], bodies: [
    "Good quality and works as expected. Delivery took a bit longer than estimated.",
    "Satisfied with my purchase. The box had minor scratches, but the item is fine.",
    "Value for money. Would recommend."] },
  mixed: { titles: ["Okay lang", "Average"], bodies: ["It's okay for the price. Nothing special.", "Does the job, but I expected a bit more."] },
  poor: { titles: ["Disappointed", "Wouldn't buy again"], bodies: ["Not as described, so I'm returning it.", "The quality isn't what I expected for the price."] }
};

const DELIVERY_NOTES = [
  "Arrived in two days, very well packed.",
  "Delivery to Cebu took four days, but everything arrived safe.",
  "Packed with bubble wrap and a thank-you note.",
  "Got it during a deal, so even better value.",
  "Tracking updates were accurate the whole way."
];

/** The i-th item, wrapping around (lists here are never empty). */
function pick<T>(list: readonly T[], i: number): T {
  const item = list[i % list.length];
  if (item === undefined) throw new Error("demo data: empty list");
  return item;
}

const bandOf = (stars: number): Band => (stars === 5 ? "great" : stars === 4 ? "good" : stars === 3 ? "mixed" : "poor");

// --- deterministic randomness ------------------------------------------------------

/** A small seeded random generator (mulberry32 over an FNV-1a hash), so every run makes the same reviews. */
function randomFrom(seed: string) {
  let a = 2166136261;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** How many reviews a product gets: more for popular products, 3 to 20. */
export const reviewCountFor = (popularity: number) => Math.min(20, Math.max(3, Math.round(Math.sqrt(popularity) / 2)));

/**
 * Star ratings drawn around `target`, the way real shops look: mostly 5★ and 4★, plus a
 * few 3★, 2★ and 1★ that grow as the target drops (a 4.3 product has more unhappy
 * buyers than a 4.8 one). The expected average equals the target.
 */
function ratingsFor(target: number, n: number, random: () => number): number[] {
  const gap = Math.max(0, 5 - target);
  const [p1, p2, p3] = [0.04 * gap, 0.04 * gap, 0.1 * gap];
  // Expected value = 4 + p5 - p3 - 2*p2 - 3*p1, solved for p5 so it equals the target.
  const p5 = Math.min(1 - p1 - p2 - p3, Math.max(0, target - 4 + p3 + 2 * p2 + 3 * p1));
  const shares: [stars: number, share: number][] = [[1, p1], [2, p2], [3, p3], [5, p5]];
  return Array.from({ length: n }, () => {
    const x = random();
    let sum = 0;
    for (const [stars, share] of shares) if (x < (sum += share)) return stars;
    return 4;
  });
}

// --- seeding -------------------------------------------------------------------

export async function seedDemoReviews(prisma: PrismaClient, products: DemoProduct[], now: Date) {
  await prisma.user.createMany({
    data: SHOPPERS.map((s) => ({ email: s.email, name: s.name, emailVerifiedAt: new Date(now.getTime() - 600 * DAY) })),
    skipDuplicates: true
  });
  const shoppers = await prisma.user.findMany({ where: { email: { in: SHOPPERS.map((s) => s.email) } }, select: { id: true, name: true, email: true }, orderBy: { email: "asc" } });
  const shopperIds = shoppers.map((s) => s.id);

  const rows = await prisma.product.findMany({
    where: { status: "ACTIVE", slug: { in: products.map((p) => p.slug) } },
    include: { store: { select: { slug: true } }, variants: { orderBy: { sortOrder: "asc" } }, images: { orderBy: { sortOrder: "asc" }, take: 1 } }
  });

  const orders: Prisma.OrderCreateManyInput[] = [];
  const sellerOrders: Prisma.SellerOrderCreateManyInput[] = [];
  const items: Prisma.OrderItemCreateManyInput[] = [];
  const reviews: Prisma.ReviewCreateManyInput[] = [];
  const ledger: { orderId: string; line: Prisma.LedgerEntryCreateManyInput }[] = [];

  for (const demo of products) {
    const product = rows.find((r) => r.slug === demo.slug && r.store.slug === demo.store);
    if (!product?.publishedAt || product.variants.length === 0) continue;
    const random = randomFrom(`reviews:${demo.store}/${demo.slug}`);
    const texts = TEXTS[KIND_OF_CATEGORY[demo.category] ?? ""] ?? GENERIC;
    const [minHandling, maxHandling] = HANDLING_HOURS[demo.store] ?? DEFAULT_HANDLING;

    const publishedAt = product.publishedAt.getTime();
    const start = Math.max(publishedAt + 3 * DAY, now.getTime() - HISTORY_DAYS * DAY);
    const end = now.getTime() - 2 * HOUR;
    if (start >= end) continue;

    const n = reviewCountFor(demo.rating[1]);
    const stars = ratingsFor(demo.rating[0], n, random);
    const reviewers = shuffled(shoppers, random).slice(0, n);
    const pools = Object.fromEntries(
      (["great", "good", "mixed", "poor"] as Band[]).map((b) => [b, { titles: shuffled([...texts[b].titles, ...GENERIC[b].titles], random), bodies: shuffled([...texts[b].bodies, ...GENERIC[b].bodies], random), used: 0 }])
    ) as Record<Band, { titles: string[]; bodies: string[]; used: number }>;

    reviewers.forEach((shopper, i) => {
      const rating = pick(stars, i);
      const shopperNo = shoppers.indexOf(shopper);
      const pool = pools[bandOf(rating)];
      const k = pool.used++;
      const note = rating >= 4 && random() < 0.35 ? ` ${pick(DELIVERY_NOTES, Math.floor(random() * DELIVERY_NOTES.length))}` : "";
      const variant = pick(product.variants, Math.floor(random() * product.variants.length));

      // The purchase behind the review: placed → shipped → delivered → reviewed, in that order.
      const reviewedAt = start + random() * (end - start);
      const span = Math.min((3 + random() * 7) * DAY, reviewedAt - publishedAt - HOUR);
      const placedAt = reviewedAt - span;
      const shippedAt = placedAt + Math.min((minHandling + random() * (maxHandling - minHandling)) * HOUR, span * 0.3);
      const deliveredAt = shippedAt + (reviewedAt - shippedAt) * 0.6;

      const subtotal = variant.priceCentavos;
      const fee = Math.round(subtotal * 0.05);
      const delivery = subtotal >= DELIVERY.freeThresholdCentavos ? 0 : DELIVERY.standardFeeCentavos;
      const address = pick(ADDRESSES, shopperNo);
      const orderId = randomUUID();
      const sellerOrderId = randomUUID();
      const orderItemId = randomUUID();
      const at = (ms: number) => new Date(Math.round(ms));

      orders.push({
        id: orderId, userId: shopper.id, status: "COMPLETED", paymentMethod: pick(PAYMENT_METHODS, Math.floor(random() * PAYMENT_METHODS.length)),
        subtotalCentavos: subtotal, deliveryCentavos: delivery, totalCentavos: subtotal + delivery,
        shippingAddress: { fullName: shopper.name, phone: `+63917555${String(1000 + shopperNo).slice(-4)}`, ...address },
        placedAt: at(placedAt), createdAt: at(placedAt), updatedAt: at(deliveredAt)
      });
      sellerOrders.push({
        id: sellerOrderId, orderId, storeId: product.storeId, status: "DELIVERED", subtotalCentavos: subtotal, deliveryCentavos: delivery,
        platformFeeCentavos: fee, courier: pick(COURIERS, Math.floor(random() * COURIERS.length)),
        trackingNumber: `VD${String(Math.floor(random() * 1e10)).padStart(10, "0")}`, shipBy: at(placedAt + 2 * DAY),
        shippedAt: at(shippedAt), deliveredAt: at(deliveredAt), deliveryConfirmedBy: "BUYER", createdAt: at(placedAt), updatedAt: at(deliveredAt)
      });
      // What the store earned from it (see src/modules/seller/ledger.ts): the sale and Vendora's fee
      // (the order's number is only known once it's saved, so the descriptions are added then).
      const availableAt = earningsAvailableAt(at(deliveredAt));
      ledger.push({ orderId, line: { storeId: product.storeId, sellerOrderId, type: "SALE", amountCentavos: subtotal, description: "Sale", availableAt, createdAt: at(deliveredAt) } });
      if (fee > 0) ledger.push({ orderId, line: { storeId: product.storeId, sellerOrderId, type: "FEE", amountCentavos: -fee, description: "Vendora fee", availableAt, createdAt: at(deliveredAt) } });
      items.push({
        id: orderItemId, sellerOrderId, variantId: variant.id, productId: product.id, productTitle: product.title, variantName: variant.name,
        imageUrl: product.images[0]?.url ?? null, unitPriceCentavos: subtotal, quantity: 1, createdAt: at(placedAt)
      });
      reviews.push({
        id: randomUUID(), productId: product.id, userId: shopper.id, orderItemId, rating,
        title: random() < 0.85 ? pick(pool.titles, k) : null,
        body: `${pick(pool.bodies, k)}${note}`,
        status: "PUBLISHED", createdAt: at(reviewedAt), updatedAt: at(reviewedAt)
      });
    });
  }

  await prisma.$transaction(
    async (tx) => {
      // Replace the demo shoppers' previous run (their order items go with their seller orders).
      await tx.review.deleteMany({ where: { userId: { in: shopperIds } } });
      // The demo stores' payouts go too (demo-payouts.ts makes them again from the new history).
      const demoStores = [...new Set(rows.map((r) => r.storeId))];
      await tx.ledgerEntry.deleteMany({ where: { storeId: { in: demoStores }, type: "PAYOUT" } });
      await tx.ledgerEntry.updateMany({ where: { storeId: { in: demoStores }, payoutId: { not: null } }, data: { payoutId: null } });
      await tx.payout.deleteMany({ where: { storeId: { in: demoStores } } });
      await tx.ledgerEntry.deleteMany({ where: { sellerOrder: { order: { userId: { in: shopperIds } } } } });
      await tx.sellerOrder.deleteMany({ where: { order: { userId: { in: shopperIds } } } });
      await tx.order.deleteMany({ where: { userId: { in: shopperIds } } });
      await tx.order.createMany({ data: orders });
      await tx.sellerOrder.createMany({ data: sellerOrders });
      await tx.orderItem.createMany({ data: items });
      const numbers = new Map((await tx.order.findMany({ where: { id: { in: orders.map((o) => o.id ?? "") } }, select: { id: true, orderNumber: true } })).map((o) => [o.id, o.orderNumber]));
      await tx.ledgerEntry.createMany({ data: ledger.map(({ orderId, line }) => ({ ...line, description: `${line.description} · VD-${numbers.get(orderId) ?? "?"}` })) });
      await tx.review.createMany({ data: reviews });
      await recomputeRatings(tx, "all");
    },
    { timeout: 120_000, maxWait: 20_000 }
  );
  return { shoppers: shoppers.length, orders: orders.length, reviews: reviews.length };
}
