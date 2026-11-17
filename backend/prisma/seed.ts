/**
 * Demo data matching the Figma designs: categories, 7 approved stores and 12 products.
 * Run with `npm run db:seed`. Safe to run again (upserts by email / slug / SKU).
 * Seller accounts have no password yet — sign-in arrives in milestone 3.
 * Product photos point at /images/products/*.png until Cloudinary (milestone 4).
 */
import { existsSync } from "node:fs";
import { createPrisma } from "../src/lib/prisma.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
const prisma = createPrisma(url);

const CATEGORIES: [slug: string, name: string, parent?: string][] = [
  ["electronics", "Electronics"], ["headphones", "Headphones", "electronics"], ["speakers", "Speakers", "electronics"], ["wearables", "Wearables", "electronics"],
  ["fashion", "Fashion"], ["shoes", "Shoes", "fashion"], ["accessories", "Accessories", "fashion"],
  ["bags-travel", "Bags & Travel"],
  ["home-kitchen", "Home & Kitchen"], ["lighting", "Lighting", "home-kitchen"], ["kitchen", "Kitchen", "home-kitchen"],
  ["beauty", "Beauty"], ["skincare", "Skincare", "beauty"], ["fragrance", "Fragrance", "beauty"],
  ["sports-fitness", "Sports & Fitness"]
];

const STORES = [
  { slug: "soundcraft-audio", name: "SoundCraft Audio", email: "soundcraft@example.com", shipsFrom: "Manila", rating: 4.9 },
  { slug: "nova-wearables", name: "Nova Wearables", email: "nova@example.com", shipsFrom: "Pasig City", rating: 4.6 },
  { slug: "peak-outdoors", name: "Peak Outdoors", email: "peak@example.com", shipsFrom: "Quezon City", rating: 4.8 },
  { slug: "hearth-home", name: "Hearth & Home", email: "hearth@example.com", shipsFrom: "Makati City", rating: 4.9 },
  { slug: "glow-lab", name: "Glow Lab", email: "glowlab@example.com", shipsFrom: "Taguig City", rating: 4.8 },
  { slug: "northbound-goods", name: "Northbound Goods", email: "northbound@example.com", shipsFrom: "Cebu City", rating: 4.8 },
  { slug: "sol-co", name: "Sol & Co.", email: "solco@example.com", shipsFrom: "Davao City", rating: 4.6 }
];

type V = [sku: string, name: string, price: number, compareAt: number | null, stock: number];
const PRODUCTS: { store: string; category: string; slug: string; title: string; image: string; sold: number; variants: V[] }[] = [
  { store: "soundcraft-audio", category: "headphones", slug: "aurasound-pro", title: "AuraSound Pro Wireless Noise-Cancelling Headphones", image: "headphones", sold: 318,
    variants: [["SC-AURA-PRO-BLK", "Midnight Black", 749_900, 999_900, 42], ["SC-AURA-PRO-SND", "Sand", 749_900, 999_900, 9], ["SC-AURA-PRO-SLV", "Silver", 749_900, 999_900, 0]] },
  { store: "soundcraft-audio", category: "speakers", slug: "boom-mini", title: "Boom Mini Waterproof Portable Speaker", image: "speaker", sold: 241,
    variants: [["SC-BOOM-MINI-BLU", "Dusty Blue", 249_900, 299_900, 6], ["SC-BOOM-MINI-CRL", "Coral", 249_900, 299_900, 28]] },
  { store: "soundcraft-audio", category: "headphones", slug: "quietwave-travel", title: "QuietWave Travel ANC Headphones", image: "headphones-detail", sold: 56,
    variants: [["SC-QW-TRAVEL", "Graphite", 599_900, null, 0]] },
  { store: "nova-wearables", category: "wearables", slug: "pulse-fit-5", title: "Pulse Fit Smartwatch Series 5 · 41mm Sage Band", image: "smartwatch", sold: 412,
    variants: [["NW-PULSE5-41-SAGE", "41mm · Sage", 649_900, 899_900, 35]] },
  { store: "peak-outdoors", category: "shoes", slug: "stride-air-knit", title: "Stride Air Knit Running Shoes, Lightweight", image: "sneakers", sold: 903,
    variants: [["PO-STRIDE-W-38", "White/Orange · 38", 339_900, 469_900, 14], ["PO-STRIDE-W-42", "White/Orange · 42", 339_900, 469_900, 20]] },
  { store: "peak-outdoors", category: "sports-fitness", slug: "hydra-steel-750", title: "Hydra Steel Insulated Bottle 750ml", image: "water-bottle", sold: 1_620,
    variants: [["PO-HYDRA-750-NVY", "Navy", 109_900, null, 120]] },
  { store: "peak-outdoors", category: "sports-fitness", slug: "flow-grip-yoga-set", title: "Flow Grip Yoga Mat + Cork Block Set", image: "yoga-mat", sold: 488,
    variants: [["PO-FLOW-SAGE", "Sage", 209_900, 279_900, 40]] },
  { store: "hearth-home", category: "lighting", slug: "clay-linen-lamp", title: "Clay & Linen Ceramic Table Lamp", image: "table-lamp", sold: 97,
    variants: [["HH-LAMP-TERRA", "Terracotta", 269_900, 359_900, 18]] },
  { store: "hearth-home", category: "kitchen", slug: "brewline-pour-over", title: "Brewline Ceramic Pour-Over Coffee Set", image: "pour-over-set", sold: 615,
    variants: [["HH-BREW-CREAM", "Cream", 189_900, null, 50]] },
  { store: "glow-lab", category: "skincare", slug: "vitamin-c-serum-30", title: "Glow Lab Vitamin C Brightening Serum 30ml", image: "serum", sold: 2_104,
    variants: [["GL-VITC-30", "30 ml", 89_900, 119_900, 200]] },
  { store: "glow-lab", category: "fragrance", slug: "rose-veil-edp-50", title: "Rose Veil Eau de Parfum 50ml", image: "perfume", sold: 233,
    variants: [["GL-ROSE-50", "50 ml", 319_900, null, 60]] },
  { store: "northbound-goods", category: "bags-travel", slug: "trailmate-backpack-20l", title: "Trailmate Full-Grain Leather Backpack 20L", image: "backpack", sold: 876,
    variants: [["NB-TRAIL-20-TAN", "Tan", 449_900, null, 25]] },
  { store: "sol-co", category: "accessories", slug: "riviera-tortoise", title: "Riviera Polarized Tortoise Sunglasses", image: "sunglasses", sold: 354,
    variants: [["SOL-RIV-TORT", "Tortoise · Green lens", 219_900, null, 3]] }
];

async function main(): Promise<void> {
  const categoryIds = new Map<string, string>();
  for (const [i, [slug, name, parent]] of CATEGORIES.entries()) {
    const parentId = parent ? categoryIds.get(parent) ?? null : null;
    const c = await prisma.category.upsert({ where: { slug }, update: { name, parentId, sortOrder: i }, create: { slug, name, parentId, sortOrder: i } });
    categoryIds.set(slug, c.id);
  }

  const storeIds = new Map<string, string>();
  for (const s of STORES) {
    const owner = await prisma.user.upsert({ where: { email: s.email }, update: {}, create: { email: s.email, name: s.name, role: "SELLER", emailVerifiedAt: new Date() } });
    const store = await prisma.store.upsert({
      where: { slug: s.slug },
      update: { name: s.name, shipsFrom: s.shipsFrom, ratingAvg: s.rating },
      create: { slug: s.slug, name: s.name, ownerId: owner.id, businessType: "REGISTERED_BUSINESS", status: "APPROVED", approvedAt: new Date(), shipsFrom: s.shipsFrom, ratingAvg: s.rating }
    });
    storeIds.set(s.slug, store.id);
  }

  for (const p of PRODUCTS) {
    const storeId = storeIds.get(p.store)!;
    const categoryId = categoryIds.get(p.category)!;
    const product = await prisma.product.upsert({
      where: { storeId_slug: { storeId, slug: p.slug } },
      update: { title: p.title, categoryId, soldCount: p.sold },
      create: { storeId, categoryId, slug: p.slug, title: p.title, description: `${p.title}. Sold by a verified Vendora seller.`, status: "ACTIVE", publishedAt: new Date(), soldCount: p.sold }
    });
    for (const [i, [sku, name, price, compareAt, stock]] of p.variants.entries()) {
      await prisma.productVariant.upsert({
        where: { storeId_sku: { storeId, sku } },
        update: { name, priceCentavos: price, compareAtCentavos: compareAt, stock, sortOrder: i },
        create: { productId: product.id, storeId, sku, name, priceCentavos: price, compareAtCentavos: compareAt, stock, sortOrder: i }
      });
    }
    await prisma.productImage.deleteMany({ where: { productId: product.id } });
    await prisma.productImage.create({ data: { productId: product.id, url: `/images/products/${p.image}.png`, alt: p.title, sortOrder: 0 } });
  }

  await prisma.user.upsert({ where: { email: "maria.santos@example.com" }, update: {}, create: { email: "maria.santos@example.com", name: "Maria Santos", phone: "+639175550142", emailVerifiedAt: new Date() } });

  const counts = await Promise.all([prisma.category.count(), prisma.store.count(), prisma.product.count(), prisma.productVariant.count(), prisma.user.count()]);
  console.log(`Seeded: ${counts[0]} categories, ${counts[1]} stores, ${counts[2]} products, ${counts[3]} variants, ${counts[4]} users`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
