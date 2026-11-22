/**
 * Demo catalog matching the Figma designs: 15 categories, 7 approved stores and
 * 63 products (62 on sale + 1 draft) reusing the 14 product photos, plus demo
 * shoppers whose delivered orders and reviews give every rating (see demo-reviews.ts).
 * Used by `npm run db:seed` AND by the tests, so tests run on the real demo data.
 * Safe to run again: everything is upserted by email / slug / SKU.
 */
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { seedDemoReviews } from "./demo-reviews.js";

export const CATEGORIES: [slug: string, name: string, parent?: string][] = [
  ["electronics", "Electronics"], ["headphones", "Headphones", "electronics"], ["speakers", "Speakers", "electronics"], ["wearables", "Wearables", "electronics"],
  ["fashion", "Fashion"], ["shoes", "Shoes", "fashion"], ["accessories", "Accessories", "fashion"],
  ["bags-travel", "Bags & Travel"],
  ["home-kitchen", "Home & Kitchen"], ["lighting", "Lighting", "home-kitchen"], ["kitchen", "Kitchen", "home-kitchen"],
  ["beauty", "Beauty"], ["skincare", "Skincare", "beauty"], ["fragrance", "Fragrance", "beauty"],
  ["sports-fitness", "Sports & Fitness"]
];

export const STORES = [
  { slug: "soundcraft-audio", category: "electronics", name: "SoundCraft Audio", email: "soundcraft@example.com", shipsFrom: "Manila", followers: 12_400, about: "Headphones and speakers tuned in Manila since 2019." },
  { slug: "nova-wearables", category: "electronics", name: "Nova Wearables", email: "nova@example.com", shipsFrom: "Pasig City", followers: 4_100, about: "Smartwatches and trackers for the whole family." },
  { slug: "peak-outdoors", category: "sports-fitness", name: "Peak Outdoors", email: "peak@example.com", shipsFrom: "Quezon City", followers: 9_800, about: "Gear for runners, hikers and weekend athletes." },
  { slug: "hearth-home", category: "home-kitchen", name: "Hearth & Home", email: "hearth@example.com", shipsFrom: "Makati City", followers: 6_300, about: "Handmade lamps and coffee gear from Filipino makers." },
  { slug: "glow-lab", category: "beauty", name: "Glow Lab", email: "glowlab@example.com", shipsFrom: "Taguig City", followers: 21_000, about: "Skincare and fragrance made for humid weather." },
  { slug: "northbound-goods", category: "bags-travel", name: "Northbound Goods", email: "northbound@example.com", shipsFrom: "Cebu City", followers: 3_500, about: "Leather and canvas bags built to last." },
  { slug: "sol-co", category: "fashion", name: "Sol & Co.", email: "solco@example.com", shipsFrom: "Davao City", followers: 5_200, about: "Sunglasses, sneakers and summer essentials." }
];

/** [sku, name, priceCentavos, compareAtCentavos, stock, dealEndsInHours] */
type V = [sku: string, name: string, price: number, compareAt: number | null, stock: number, dealHours?: number];

export interface DemoProduct {
  store: string;
  category: string;
  slug: string;
  title: string;
  image: string;
  sold: number;
  /**
   * What the generated reviews aim for: about this average, and more reviews for a
   * bigger popularity number. The stored rating is then COMPUTED from the reviews.
   */
  rating: [targetAvg: number, popularity: number];
  /** Published this many days ago ("New" badge under 30). */
  days: number;
  description: string;
  specs: [label: string, value: string][];
  variants: V[];
  status?: "ACTIVE" | "DRAFT";
}

const P = (
  store: string, category: string, slug: string, title: string, image: string, sold: number, rating: [number, number], days: number,
  description: string, specs: [string, string][], variants: V[], status: "ACTIVE" | "DRAFT" = "ACTIVE"
): DemoProduct => ({ store, category, slug, title, image, sold, rating, days, description, specs, variants, status });

export const PRODUCTS: DemoProduct[] = [
  // --- Headphones ---
  P("soundcraft-audio", "headphones", "aurasound-pro", "AuraSound Pro Wireless Noise-Cancelling Headphones", "headphones", 318, [4.8, 2_341], 120,
    "Hybrid active noise cancelling, a 30-hour battery and a soft protein-leather headband for long flights and commutes.",
    [["Battery life", "30 hours (ANC on)"], ["Charging", "USB-C, 10 min = 5 hours"], ["Bluetooth", "5.3 with multipoint"], ["Weight", "250 g"], ["Warranty", "1 year"]],
    [["SC-AURA-PRO-BLK", "Midnight Black", 749_900, 999_900, 42, 30], ["SC-AURA-PRO-SND", "Sand", 749_900, 999_900, 9, 30], ["SC-AURA-PRO-SLV", "Silver", 749_900, 999_900, 0, 30]]),
  P("soundcraft-audio", "headphones", "quietwave-travel", "QuietWave Travel ANC Headphones", "headphones-detail", 56, [4.5, 88], 200,
    "Foldable noise-cancelling headphones with a hard travel case and an airplane adapter.",
    [["Battery life", "24 hours"], ["Foldable", "Yes, with hard case"], ["Bluetooth", "5.2"], ["Weight", "230 g"]],
    [["SC-QW-TRAVEL", "Graphite", 599_900, null, 0]]),
  P("soundcraft-audio", "headphones", "aurasound-lite", "AuraSound Lite On-Ear Bluetooth Headphones", "headphones-lifestyle", 742, [4.6, 512], 90,
    "Light on-ear headphones with a 40-hour battery and a built-in mic for calls and online classes.",
    [["Battery life", "40 hours"], ["Microphone", "Built-in, noise-reducing"], ["Bluetooth", "5.3"], ["Weight", "160 g"]],
    [["SC-AURA-LITE-PNK", "Blush Pink", 299_900, 349_900, 25], ["SC-AURA-LITE-CRM", "Cream", 299_900, 349_900, 31], ["SC-AURA-LITE-BLK", "Black", 299_900, 349_900, 50]]),
  P("soundcraft-audio", "headphones", "studio-monitor-m50", "SoundCraft Studio Monitor Headphones M50", "headphones-detail", 205, [4.7, 190], 400,
    "Closed-back studio headphones with a detachable cable, tuned flat for mixing and podcasting.",
    [["Type", "Closed-back, wired"], ["Driver", "45 mm"], ["Cable", "3 m, detachable"], ["Impedance", "38 Ω"]],
    [["SC-M50-BLK", "Black", 449_900, null, 18]]),
  P("nova-wearables", "headphones", "tiny-tunes-kids", "Tiny Tunes Kids Headphones with Safe Volume", "headphones-lifestyle", 1_120, [4.5, 860], 60,
    "Volume limited to 85 dB to protect young ears, with a bendable headband that survives school bags.",
    [["Volume limit", "85 dB"], ["Battery life", "30 hours"], ["Ages", "3–12"], ["Weight", "140 g"]],
    [["NW-TINY-PNK", "Pink", 89_900, null, 75], ["NW-TINY-BLU", "Blue", 89_900, null, 64]]),
  P("soundcraft-audio", "headphones", "raptor-gaming-headset", "Raptor 7.1 Gaming Headset with Detachable Mic", "headphones", 640, [4.4, 410], 150,
    "Virtual 7.1 surround, cooling gel ear cushions and a detachable boom mic for PC, PS5 and Switch.",
    [["Sound", "Virtual 7.1 surround"], ["Microphone", "Detachable boom"], ["Connection", "USB + 3.5 mm"], ["Platforms", "PC, PS5, Switch"]],
    [["SC-RAPTOR-71", "Black/Red", 229_900, 279_900, 40, 72]]),
  P("peak-outdoors", "headphones", "runfree-neckband", "RunFree Sport Neckband Earphones", "headphones-lifestyle", 980, [4.3, 720], 30,
    "Sweat-proof neckband earphones with magnetic earbuds that click together when you're not listening.",
    [["Water resistance", "IPX5"], ["Battery life", "18 hours"], ["Bluetooth", "5.2"], ["Weight", "28 g"]],
    [["PO-RUNFREE-BLK", "Black", 109_900, null, 90], ["PO-RUNFREE-VLT", "Volt Green", 109_900, null, 35]]),
  P("soundcraft-audio", "headphones", "aurasound-pro-2", "AuraSound Pro 2 Headphones with Spatial Audio", "headphones", 34, [4.9, 27], 5,
    "The new AuraSound with spatial audio, adaptive noise cancelling and a 40-hour battery.",
    [["Battery life", "40 hours"], ["Spatial audio", "Yes, with head tracking"], ["Bluetooth", "5.4 LE Audio"], ["Weight", "245 g"]],
    [["SC-AURA-PRO2-BLK", "Midnight Black", 1_199_900, null, 20], ["SC-AURA-PRO2-ICE", "Ice Blue", 1_199_900, null, 12]]),

  // --- Speakers ---
  P("soundcraft-audio", "speakers", "boom-mini", "Boom Mini Waterproof Portable Speaker", "speaker", 241, [4.7, 198], 150,
    "A waterproof pocket speaker with a strap, made for the beach and the shower.",
    [["Water resistance", "IP67"], ["Battery life", "12 hours"], ["Output", "10 W"], ["Weight", "280 g"]],
    [["SC-BOOM-MINI-BLU", "Dusty Blue", 249_900, 299_900, 6, 48], ["SC-BOOM-MINI-CRL", "Coral", 249_900, 299_900, 28, 48]]),
  P("soundcraft-audio", "speakers", "boom-max", "Boom Max 40W Party Speaker with Lights", "speaker", 188, [4.7, 150], 75,
    "40 W of sound with deep bass and a light show, plus a mic input for videoke nights.",
    [["Output", "40 W"], ["Battery life", "20 hours"], ["Inputs", "Bluetooth, mic, USB"], ["Water resistance", "IPX6"]],
    [["SC-BOOM-MAX-BLK", "Black", 699_900, 849_900, 14, 20]]),
  P("soundcraft-audio", "speakers", "pocket-pal", "Pocket Pal Mini Clip Speaker", "speaker", 1_540, [4.4, 1_020], 300,
    "Clip it to your bag: a tiny speaker with a loud voice and a 10-hour battery.",
    [["Output", "5 W"], ["Battery life", "10 hours"], ["Water resistance", "IPX5"], ["Weight", "150 g"]],
    [["SC-POCKET-BLK", "Black", 79_900, null, 120], ["SC-POCKET-MNT", "Mint", 79_900, null, 80], ["SC-POCKET-LIL", "Lilac", 79_900, null, 66]]),
  P("soundcraft-audio", "speakers", "homestage-soundbar", "HomeStage 2.1 Soundbar with Wireless Subwoofer", "speaker", 96, [4.6, 74], 220,
    "A 2.1 soundbar with a wireless subwoofer and HDMI ARC, easy to set up with any TV.",
    [["Output", "160 W"], ["Channels", "2.1"], ["Connections", "HDMI ARC, optical, Bluetooth"], ["Subwoofer", "Wireless"]],
    [["SC-HOMESTAGE", "Black", 899_900, 1_099_900, 9]]),
  P("northbound-goods", "speakers", "kasama-smart-speaker", "Kasama Smart Speaker with Voice Assistant", "speaker", 310, [4.3, 205], 40,
    "A smart speaker that understands English and Tagalog: play music, set timers and control smart plugs.",
    [["Voice languages", "English, Tagalog"], ["Wi-Fi", "2.4 / 5 GHz"], ["Output", "15 W"], ["Smart home", "Works with Matter"]],
    [["NB-KASAMA-CHR", "Charcoal", 329_900, null, 22], ["NB-KASAMA-CHK", "Chalk", 329_900, null, 17]]),
  P("peak-outdoors", "speakers", "trail-lantern-speaker", "Trail Lantern Speaker for Camping", "speaker", 142, [4.5, 98], 18,
    "A camping lantern and a speaker in one, with a power bank to charge your phone.",
    [["Light", "3 modes, 400 lumens"], ["Battery", "5,200 mAh power bank"], ["Output", "8 W"], ["Water resistance", "IPX4"]],
    [["PO-LANTERN-OLV", "Olive", 189_900, null, 30]]),

  // --- Wearables ---
  P("nova-wearables", "wearables", "pulse-fit-5", "Pulse Fit Smartwatch Series 5 · 41mm Sage Band", "smartwatch", 412, [4.6, 356], 100,
    "A health-first smartwatch with heart rate, SpO2, sleep tracking and a 10-day battery.",
    [["Display", "1.8\" AMOLED"], ["Battery life", "Up to 10 days"], ["Water resistance", "5 ATM"], ["Sensors", "Heart rate, SpO2, GPS"]],
    [["NW-PULSE5-41-SAGE", "41mm · Sage", 649_900, 899_900, 35, 30]]),
  P("nova-wearables", "wearables", "pulse-fit-5-45", "Pulse Fit Smartwatch Series 5 · 45mm Graphite", "smartwatch", 270, [4.7, 198], 100,
    "The bigger Series 5 with a larger screen and a few more days of battery.",
    [["Display", "2.0\" AMOLED"], ["Battery life", "Up to 12 days"], ["Water resistance", "5 ATM"], ["Sensors", "Heart rate, SpO2, GPS"]],
    [["NW-PULSE5-45-GRA", "45mm · Graphite", 699_900, null, 26]]),
  P("nova-wearables", "wearables", "pulse-fit-lite", "Pulse Fit Lite Fitness Band", "smartwatch", 3_210, [4.5, 2_640], 250,
    "A slim fitness band with steps, sleep and heart rate, and a 14-day battery.",
    [["Display", "1.1\" AMOLED"], ["Battery life", "14 days"], ["Water resistance", "5 ATM"], ["Sensors", "Heart rate, steps, sleep"]],
    [["NW-LITE-BLK", "Black", 149_900, 199_900, 120], ["NW-LITE-LAV", "Lavender", 149_900, 199_900, 48]]),
  P("nova-wearables", "wearables", "bantay-kids-gps", "Bantay Kids GPS Smartwatch with SOS", "smartwatch", 450, [4.2, 330], 70,
    "Know where your child is: GPS tracking, video calls with parents and an SOS button.",
    [["Tracking", "GPS + Wi-Fi"], ["Calls", "Video and voice (SIM required)"], ["SOS", "One-button alert"], ["Battery life", "2 days"]],
    [["NW-BANTAY-BLU", "Blue", 249_900, null, 33], ["NW-BANTAY-PNK", "Pink", 249_900, null, 29]]),
  P("nova-wearables", "wearables", "nova-ring", "Nova Ring Sleep & Health Tracker", "smartwatch", 64, [4.4, 41], 12,
    "A titanium smart ring that tracks sleep, heart rate and readiness without a screen.",
    [["Material", "Titanium"], ["Battery life", "6 days"], ["Water resistance", "10 ATM"], ["Sizes", "7–11"]],
    [["NW-RING-7", "Size 7", 949_900, null, 4], ["NW-RING-8", "Size 8", 949_900, null, 6], ["NW-RING-9", "Size 9", 949_900, null, 0]]),
  P("nova-wearables", "wearables", "pulse-fit-kids", "Pulse Fit Kids Activity Tracker Watch", "smartwatch", 380, [4.4, 260], 45,
    "Fun activity goals, chore reminders and a swim-proof design for kids 6 and up.",
    [["Water resistance", "5 ATM"], ["Battery life", "7 days"], ["Ages", "6+"], ["Parental app", "Yes"]],
    [["NW-KIDS-CRL", "Coral", 179_900, 219_900, 40]]),

  // --- Shoes ---
  P("peak-outdoors", "shoes", "stride-air-knit", "Stride Air Knit Running Shoes, Lightweight", "sneakers", 903, [4.7, 744], 130,
    "Breathable knit running shoes with a springy foam midsole for daily runs.",
    [["Upper", "Engineered knit"], ["Midsole", "Responsive foam"], ["Drop", "8 mm"], ["Weight", "240 g (size 42)"]],
    [["PO-STRIDE-W-38", "White/Orange · 38", 339_900, 469_900, 14, 50], ["PO-STRIDE-W-40", "White/Orange · 40", 339_900, 469_900, 0, 50], ["PO-STRIDE-W-42", "White/Orange · 42", 339_900, 469_900, 20, 50]]),
  P("peak-outdoors", "shoes", "stride-trail-wp", "Stride Trail Waterproof Hiking Shoes", "sneakers", 312, [4.7, 260], 85,
    "Waterproof hiking shoes with a grippy lug sole for trails and rainy-season commutes.",
    [["Waterproof", "Yes, membrane"], ["Sole", "Rubber, 5 mm lugs"], ["Weight", "360 g"], ["Use", "Hiking, wet streets"]],
    [["PO-TRAIL-GRY-40", "Grey · 40", 499_900, null, 10], ["PO-TRAIL-GRY-42", "Grey · 42", 499_900, null, 12], ["PO-TRAIL-GRY-44", "Grey · 44", 499_900, null, 6]]),
  P("sol-co", "shoes", "lakad-canvas", "Lakad Classic Canvas Sneakers", "sneakers", 2_890, [4.5, 2_100], 330,
    "Everyday canvas sneakers with a cushioned insole, made for walking all day.",
    [["Upper", "Cotton canvas"], ["Sole", "Vulcanized rubber"], ["Insole", "Cushioned"], ["Made in", "Marikina, PH"]],
    [["SOL-LAKAD-WHT-38", "White · 38", 129_900, null, 60], ["SOL-LAKAD-WHT-41", "White · 41", 129_900, null, 55], ["SOL-LAKAD-BLK-41", "Black · 41", 129_900, null, 40]]),
  P("peak-outdoors", "shoes", "court-pro", "Court Pro Basketball Shoes", "sneakers", 410, [4.5, 290], 110,
    "High-top basketball shoes with ankle support and a herringbone outsole for indoor courts.",
    [["Cut", "High-top"], ["Outsole", "Herringbone rubber"], ["Cushioning", "Forefoot air unit"], ["Weight", "410 g"]],
    [["PO-COURT-BG-42", "Black/Gold · 42", 449_900, 529_900, 15], ["PO-COURT-BG-44", "Black/Gold · 44", 449_900, 529_900, 9]]),
  P("sol-co", "shoes", "kidlit-light-up", "Kidlit Light-Up Kids Sneakers", "sneakers", 860, [4.4, 510], 25,
    "Sneakers with LED soles that light up with every step, and easy hook-and-loop straps.",
    [["Lights", "LED, USB rechargeable"], ["Closure", "Hook-and-loop"], ["Sizes", "Kids 28–35"], ["Battery", "6 hours of lights"]],
    [["SOL-KIDLIT-PNK-30", "Pink · 30", 119_900, null, 22], ["SOL-KIDLIT-BLU-30", "Blue · 30", 119_900, null, 26]]),
  P("peak-outdoors", "shoes", "swift-racer", "Swift Racer Carbon Running Shoes", "sneakers", 75, [4.8, 52], 8,
    "Race-day shoes with a carbon plate and lightweight foam for your next 10K or marathon.",
    [["Plate", "Full-length carbon"], ["Drop", "8 mm"], ["Weight", "210 g"], ["Use", "Race day"]],
    [["PO-SWIFT-VLT-41", "Volt · 41", 899_900, null, 8], ["PO-SWIFT-VLT-43", "Volt · 43", 899_900, null, 5]]),

  // --- Accessories (sunglasses) ---
  P("sol-co", "accessories", "riviera-tortoise", "Riviera Polarized Tortoise Sunglasses", "sunglasses", 354, [4.6, 240], 140,
    "Polarized sunglasses in a tortoise acetate frame that cut glare at the beach and on the road.",
    [["Lens", "Polarized, UV400"], ["Frame", "Acetate"], ["Lens width", "52 mm"], ["Includes", "Hard case, cloth"]],
    [["SOL-RIV-TORT", "Tortoise · Green lens", 219_900, null, 3]]),
  P("sol-co", "accessories", "coastline-aviator", "Coastline Polarized Aviator Sunglasses", "sunglasses", 520, [4.6, 380], 95,
    "Classic metal aviators with polarized lenses and adjustable nose pads.",
    [["Lens", "Polarized, UV400"], ["Frame", "Stainless steel"], ["Lens width", "58 mm"], ["Weight", "26 g"]],
    [["SOL-AVI-GLD", "Gold · Brown lens", 189_900, 249_900, 30, 70], ["SOL-AVI-SLV", "Silver · Grey lens", 189_900, 249_900, 18, 70]]),
  P("peak-outdoors", "accessories", "velo-sport-wrap", "Velo Sport Wrap Cycling Sunglasses", "sunglasses", 230, [4.5, 170], 55,
    "Wraparound sport sunglasses with interchangeable lenses for cycling and running.",
    [["Lenses", "3 interchangeable"], ["Frame", "TR90, flexible"], ["Protection", "UV400"], ["Weight", "24 g"]],
    [["PO-VELO-BLK", "Matte Black", 159_900, null, 35]]),
  P("sol-co", "accessories", "retro-round", "Retro Round Sunglasses", "sunglasses", 410, [4.4, 300], 200,
    "Round metal frames with a vintage look and UV400 protection.",
    [["Lens", "UV400"], ["Frame", "Metal"], ["Lens width", "49 mm"], ["Includes", "Pouch"]],
    [["SOL-RETRO-GLD", "Gold · Green lens", 99_900, null, 44], ["SOL-RETRO-BLK", "Black · Grey lens", 99_900, null, 38]]),
  P("sol-co", "accessories", "mini-shades-kids", "Mini Shades Kids Polarized Sunglasses", "sunglasses", 280, [4.7, 190], 20,
    "Bendable, unbreakable sunglasses for kids with polarized UV400 lenses.",
    [["Lens", "Polarized, UV400"], ["Frame", "Flexible silicone"], ["Ages", "3–10"], ["Includes", "Strap"]],
    [["SOL-MINI-PNK", "Pink", 69_900, null, 50], ["SOL-MINI-BLU", "Blue", 69_900, null, 46]]),

  // --- Bags & Travel ---
  P("northbound-goods", "bags-travel", "trailmate-backpack-20l", "Trailmate Full-Grain Leather Backpack 20L", "backpack", 876, [4.8, 690], 180,
    "A full-grain leather backpack with a padded 15\" laptop sleeve that gets better with age.",
    [["Material", "Full-grain leather"], ["Capacity", "20 L"], ["Laptop sleeve", "Up to 15\""], ["Weight", "1.3 kg"]],
    [["NB-TRAIL-20-TAN", "Tan", 449_900, null, 25]]),
  P("northbound-goods", "bags-travel", "commuter-tech-pack", "Commuter Tech Backpack 25L, Water-Resistant", "backpack", 1_240, [4.7, 980], 120,
    "A slim, water-resistant commuter backpack with a USB charging port and an anti-theft back pocket.",
    [["Capacity", "25 L"], ["Laptop sleeve", "Up to 16\""], ["Water resistance", "Water-repellent fabric"], ["Extras", "USB port, hidden pocket"]],
    [["NB-COMMUTER-BLK", "Black", 249_900, 299_900, 64], ["NB-COMMUTER-GRY", "Grey", 249_900, 299_900, 30]]),
  P("peak-outdoors", "bags-travel", "trailhead-hiking-35", "Trailhead Hiking Backpack 35L with Rain Cover", "backpack", 330, [4.7, 250], 65,
    "A ventilated hiking pack with a hip belt, a hydration sleeve and a built-in rain cover.",
    [["Capacity", "35 L"], ["Back", "Ventilated mesh"], ["Rain cover", "Built-in"], ["Weight", "1.1 kg"]],
    [["PO-TRAILHEAD-GRN", "Forest Green", 389_900, null, 18], ["PO-TRAILHEAD-ORG", "Burnt Orange", 389_900, null, 12]]),
  P("northbound-goods", "bags-travel", "canvas-daypack", "Northbound Waxed Canvas Daypack 18L", "backpack", 210, [4.6, 150], 35,
    "Waxed canvas and leather straps: a rugged everyday daypack for the city.",
    [["Material", "Waxed canvas, leather trim"], ["Capacity", "18 L"], ["Laptop sleeve", "Up to 14\""], ["Weight", "0.9 kg"]],
    [["NB-DAYPACK-OLV", "Olive", 299_900, null, 20], ["NB-DAYPACK-NVY", "Navy", 299_900, null, 14]]),
  P("sol-co", "bags-travel", "school-pack-kids", "Sol School Backpack for Kids", "backpack", 690, [4.5, 480], 15,
    "A light school backpack with a chest strap, reflective strips and a lunch pocket.",
    [["Capacity", "16 L"], ["Ages", "6–12"], ["Safety", "Reflective strips"], ["Weight", "0.6 kg"]],
    [["SOL-SCHOOL-SKY", "Sky Blue", 119_900, 149_900, 55, 36], ["SOL-SCHOOL-LIL", "Lilac", 119_900, 149_900, 41, 36]]),
  P("northbound-goods", "bags-travel", "voyage-carry-on-40l", "Voyage 40L Carry-On Travel Backpack", "backpack", 150, [4.8, 110], 50,
    "Fits airline carry-on limits and opens like a suitcase for easy packing.",
    [["Capacity", "40 L"], ["Carry-on", "Fits most airlines"], ["Opening", "Clamshell, lockable zips"], ["Weight", "1.4 kg"]],
    [["NB-VOYAGE-BLK", "Black", 549_900, 649_900, 16]]),

  // --- Lighting ---
  P("hearth-home", "lighting", "clay-linen-lamp", "Clay & Linen Ceramic Table Lamp", "table-lamp", 97, [4.9, 76], 160,
    "A handmade terracotta ceramic lamp with a linen shade that gives a warm, soft light.",
    [["Material", "Ceramic, linen shade"], ["Height", "45 cm"], ["Bulb", "E27, not included"], ["Cable", "1.8 m with switch"]],
    [["HH-LAMP-TERRA", "Terracotta", 269_900, 359_900, 18, 60]]),
  P("hearth-home", "lighting", "capiz-table-lamp", "Capiz Shell Table Lamp", "table-lamp", 140, [4.8, 95], 40,
    "A Capiz shell lamp made by artisans in Pampanga, with a natural pearly glow.",
    [["Material", "Capiz shell, wood base"], ["Height", "40 cm"], ["Made in", "Pampanga, PH"], ["Bulb", "E27, LED included"]],
    [["HH-CAPIZ-NAT", "Natural", 329_900, null, 10]]),
  P("hearth-home", "lighting", "lumen-desk-lamp", "Lumen Dimmable LED Desk Lamp", "table-lamp", 860, [4.6, 640], 210,
    "An LED desk lamp with 5 brightness levels and a USB charging port for late study nights.",
    [["Brightness", "5 levels"], ["Colour temperature", "3000–6000 K"], ["Extras", "USB charging port"], ["Power", "10 W"]],
    [["HH-LUMEN-WHT", "White", 149_900, null, 70], ["HH-LUMEN-BLK", "Black", 149_900, null, 52]]),
  P("hearth-home", "lighting", "stone-bedside-lamp", "Stone Bedside Touch Lamp", "table-lamp", 260, [4.7, 180], 10,
    "A bedside lamp with a stone-look base that turns on with a touch.",
    [["Control", "Touch, 3 levels"], ["Height", "32 cm"], ["Bulb", "LED included"], ["Cable", "1.5 m"]],
    [["HH-STONE-SND", "Sand", 179_900, 219_900, 26]]),

  // --- Kitchen ---
  P("hearth-home", "kitchen", "brewline-pour-over", "Brewline Ceramic Pour-Over Coffee Set", "pour-over-set", 615, [4.8, 480], 250,
    "A ceramic pour-over dripper, server and two cups for slow, flavourful coffee at home.",
    [["Includes", "Dripper, server, 2 cups"], ["Material", "Ceramic"], ["Server capacity", "600 ml"], ["Filter size", "02"]],
    [["HH-BREW-CREAM", "Cream", 189_900, null, 50]]),
  P("hearth-home", "kitchen", "barako-brew-kit", "Barako Brew Kit with Local Beans", "pour-over-set", 520, [4.8, 410], 30,
    "Everything to brew Batangas barako at home: a dripper, filters and 250 g of freshly roasted beans.",
    [["Includes", "Dripper, 40 filters, 250 g beans"], ["Beans", "Batangas barako, medium-dark"], ["Material", "Ceramic"]],
    [["HH-BARAKO-KIT", "Brown", 159_900, 199_900, 38, 26]]),
  P("hearth-home", "kitchen", "gooseneck-kettle", "Gooseneck Electric Pour-Over Kettle", "pour-over-set", 330, [4.7, 260], 140,
    "Precise pouring and temperature control from 40 to 100 °C for better coffee and tea.",
    [["Capacity", "0.8 L"], ["Temperature", "40–100 °C"], ["Power", "1,000 W"], ["Material", "Stainless steel"]],
    [["HH-KETTLE-BLK", "Matte Black", 249_900, null, 24]]),
  P("hearth-home", "kitchen", "burr-hand-grinder", "Burr Hand Coffee Grinder", "pour-over-set", 280, [4.6, 200], 90,
    "A stainless steel burr grinder with 30 settings, from espresso to French press.",
    [["Burr", "Stainless steel, conical"], ["Settings", "30"], ["Capacity", "30 g"], ["Weight", "480 g"]],
    [["HH-GRINDER-SLV", "Silver", 169_900, null, 20]]),
  P("hearth-home", "kitchen", "stoneware-mug-set", "Stoneware Mug Set of 4", "pour-over-set", 710, [4.7, 520], 60,
    "Hand-glazed stoneware mugs that keep coffee warm longer; microwave and dishwasher safe.",
    [["Includes", "4 mugs"], ["Capacity", "350 ml each"], ["Material", "Stoneware"], ["Care", "Microwave and dishwasher safe"]],
    [["HH-MUGS-SEA", "Sea Glaze", 129_900, null, 45]]),

  // --- Skincare ---
  P("glow-lab", "skincare", "vitamin-c-serum-30", "Glow Lab Vitamin C Brightening Serum 30ml", "serum", 2_104, [4.8, 1_820], 300,
    "A 15% vitamin C serum that brightens dull skin and fades dark spots in 4–6 weeks.",
    [["Size", "30 ml"], ["Key ingredient", "15% vitamin C"], ["Skin type", "All"], ["Free from", "Fragrance, parabens"]],
    [["GL-VITC-30", "30 ml", 89_900, 119_900, 200, 40]]),
  P("glow-lab", "skincare", "niacinamide-serum", "Glow Lab 10% Niacinamide Pore Serum", "serum", 1_680, [4.7, 1_350], 200,
    "Helps control oil and minimise the look of pores; lightweight and non-sticky in humid weather.",
    [["Size", "30 ml"], ["Key ingredient", "10% niacinamide, 1% zinc"], ["Skin type", "Oily, combination"], ["Finish", "Non-sticky"]],
    [["GL-NIA-30", "30 ml", 69_900, null, 150]]),
  P("glow-lab", "skincare", "hyaluronic-toner", "Glow Lab Hyaluronic Hydrating Toner", "serum", 940, [4.6, 720], 90,
    "A hydrating toner with hyaluronic acid and centella to calm and plump the skin.",
    [["Size", "150 ml"], ["Key ingredients", "Hyaluronic acid, centella"], ["Skin type", "Dry, sensitive"], ["Free from", "Alcohol, fragrance"]],
    [["GL-TONER-150", "150 ml", 59_900, null, 120]]),
  P("glow-lab", "skincare", "sunscreen-serum-spf50", "Glow Lab SPF 50+ Sunscreen Serum", "serum", 3_050, [4.8, 2_600], 25,
    "A weightless SPF 50+ PA++++ sunscreen with no white cast, made for daily use in the Philippine sun.",
    [["Size", "50 ml"], ["Protection", "SPF 50+, PA++++"], ["Finish", "No white cast"], ["Skin type", "All"]],
    [["GL-SPF50-50", "50 ml", 79_900, 99_900, 180, 22]]),
  P("glow-lab", "skincare", "gentle-retinol-night", "Glow Lab Gentle Retinol Night Serum", "serum", 410, [4.5, 300], 9,
    "A gentle 0.3% retinol with squalane for smoother skin while you sleep.",
    [["Size", "30 ml"], ["Key ingredients", "0.3% retinol, squalane"], ["Use", "Night only"], ["Skin type", "Normal, combination"]],
    [["GL-RETINOL-30", "30 ml", 99_900, null, 70]]),
  P("glow-lab", "skincare", "calamansi-face-oil", "Glow Lab Calamansi Brightening Face Oil", "serum", 230, [4.6, 170], 120,
    "A light face oil with calamansi and coconut extracts for a natural glow.",
    [["Size", "20 ml"], ["Key ingredients", "Calamansi, virgin coconut oil"], ["Skin type", "Dry, normal"], ["Made in", "Taguig, PH"]],
    [["GL-CALAMANSI-20", "20 ml", 64_900, null, 60]]),

  // --- Fragrance ---
  P("glow-lab", "fragrance", "rose-veil-edp-50", "Rose Veil Eau de Parfum 50ml", "perfume", 233, [4.7, 190], 150,
    "A soft floral eau de parfum with rose, peony and white musk.",
    [["Size", "50 ml"], ["Type", "Eau de parfum"], ["Notes", "Rose, peony, white musk"], ["Lasts", "6–8 hours"]],
    [["GL-ROSE-50", "50 ml", 319_900, null, 60]]),
  P("glow-lab", "fragrance", "sampaguita-edp-50", "Sampaguita Eau de Parfum 50ml", "perfume", 410, [4.8, 330], 40,
    "A fresh, elegant scent built around the Philippines' national flower, sampaguita.",
    [["Size", "50 ml"], ["Type", "Eau de parfum"], ["Notes", "Sampaguita, citrus, sandalwood"], ["Lasts", "6–8 hours"]],
    [["GL-SAMPAGUITA-50", "50 ml", 289_900, 349_900, 36, 54]]),
  P("sol-co", "fragrance", "coastal-cologne-100", "Coastal Cologne 100ml", "perfume", 520, [4.5, 380], 80,
    "A clean, salty-fresh cologne for hot days, with bergamot and sea notes.",
    [["Size", "100 ml"], ["Type", "Eau de cologne"], ["Notes", "Bergamot, sea salt, vetiver"], ["Lasts", "3–4 hours"]],
    [["SOL-COASTAL-100", "100 ml", 149_900, null, 70]]),
  P("glow-lab", "fragrance", "oud-amber-edp-50", "Oud & Amber Eau de Parfum 50ml", "perfume", 120, [4.6, 90], 6,
    "A warm evening scent of oud, amber and vanilla.",
    [["Size", "50 ml"], ["Type", "Eau de parfum"], ["Notes", "Oud, amber, vanilla"], ["Lasts", "8–10 hours"]],
    [["GL-OUD-50", "50 ml", 389_900, null, 24]]),

  // --- Sports & Fitness ---
  P("peak-outdoors", "sports-fitness", "hydra-steel-750", "Hydra Steel Insulated Bottle 750ml", "water-bottle", 1_620, [4.8, 1_300], 280,
    "Keeps drinks cold for 24 hours and hot for 12, with a leak-proof lid.",
    [["Capacity", "750 ml"], ["Insulation", "Cold 24 h, hot 12 h"], ["Material", "18/8 stainless steel"], ["BPA-free", "Yes"]],
    [["PO-HYDRA-750-NVY", "Navy", 109_900, null, 120], ["PO-HYDRA-750-SAGE", "Sage", 109_900, null, 90]]),
  P("peak-outdoors", "sports-fitness", "flow-grip-yoga-set", "Flow Grip Yoga Mat + Cork Block Set", "yoga-mat", 488, [4.7, 360], 190,
    "A non-slip natural rubber yoga mat with a cork block, for home and studio.",
    [["Mat", "183 × 61 cm, 5 mm"], ["Material", "Natural rubber, cork"], ["Includes", "Mat, block, strap"], ["Weight", "2.4 kg"]],
    [["PO-FLOW-SAGE", "Sage", 209_900, 279_900, 40, 32]]),
  P("peak-outdoors", "sports-fitness", "hydra-steel-tumbler-1l", "Hydra Steel Insulated Tumbler 1L with Straw", "water-bottle", 2_210, [4.7, 1_780], 60,
    "A 1-litre tumbler with a straw lid and a handle that fits most car cup holders.",
    [["Capacity", "1 L"], ["Insulation", "Cold 24 h"], ["Lid", "Straw + handle"], ["Fits", "Car cup holders"]],
    [["PO-TUMBLER-BLSH", "Blush", 129_900, 159_900, 85], ["PO-TUMBLER-BLK", "Black", 129_900, 159_900, 110]]),
  P("peak-outdoors", "sports-fitness", "hydra-kids-bottle-400", "Hydra Kids Bottle 400ml", "water-bottle", 940, [4.6, 700], 22,
    "A small insulated bottle with a flip straw that kids can open themselves.",
    [["Capacity", "400 ml"], ["Insulation", "Cold 12 h"], ["Lid", "Flip straw"], ["BPA-free", "Yes"]],
    [["PO-KIDSBTL-DINO", "Dino Green", 69_900, null, 80], ["PO-KIDSBTL-UNI", "Unicorn Pink", 69_900, null, 75]]),
  P("peak-outdoors", "sports-fitness", "travel-yoga-mat", "Foldable Travel Yoga Mat 1.5mm", "yoga-mat", 360, [4.5, 260], 100,
    "A thin, foldable yoga mat that fits in your luggage for workouts anywhere.",
    [["Mat", "183 × 61 cm, 1.5 mm"], ["Weight", "0.9 kg"], ["Folds to", "30 × 20 cm"], ["Material", "Natural rubber"]],
    [["PO-TRAVELMAT-SND", "Sand", 149_900, null, 30]]),
  P("peak-outdoors", "sports-fitness", "thick-pilates-mat", "Thick Pilates & Exercise Mat 10mm", "yoga-mat", 520, [4.6, 400], 7,
    "An extra-thick 10 mm mat that cushions knees and back during pilates and floor workouts.",
    [["Mat", "183 × 61 cm, 10 mm"], ["Material", "NBR foam"], ["Includes", "Carry strap"], ["Weight", "1.0 kg"]],
    [["PO-PILATES-LAV", "Lavender", 99_900, null, 44], ["PO-PILATES-GRY", "Grey", 99_900, null, 50]]),

  // A draft (not published yet): must never appear to shoppers.
  P("soundcraft-audio", "speakers", "boom-max-pro", "Boom Max Pro 80W (coming soon)", "speaker", 0, [0, 0], 0,
    "Coming soon.", [], [["SC-BOOM-MAXPRO", "Black", 1_299_900, null, 0]], "DRAFT")
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Upserts the demo catalog. `now` makes deal end times and "New" badges predictable in tests. */
export async function seedDemoData(prisma: PrismaClient, now = new Date()) {
  const categoryIds = new Map<string, string>();
  for (const [i, [slug, name, parent]] of CATEGORIES.entries()) {
    const parentId = parent ? (categoryIds.get(parent) ?? null) : null;
    const c = await prisma.category.upsert({ where: { slug }, update: { name, parentId, sortOrder: i }, create: { slug, name, parentId, sortOrder: i } });
    categoryIds.set(slug, c.id);
  }

  const storeIds = new Map<string, string>();
  for (const s of STORES) {
    const owner = await prisma.user.upsert({ where: { email: s.email }, update: {}, create: { email: s.email, name: s.name, role: "SELLER", emailVerifiedAt: now } });
    // followerCount is a demo counter (no screen lists followers); ratings are computed from reviews below.
    // approvedAt is reset too, so a store is always older than its products and their reviews.
    const approvedAt = new Date(now.getTime() - 400 * DAY);
    const data = { name: s.name, description: s.about, shipsFrom: s.shipsFrom, categoryId: categoryIds.get(s.category) ?? null, followerCount: s.followers, submittedAt: new Date(approvedAt.getTime() - 2 * DAY), approvedAt };
    const store = await prisma.store.upsert({
      where: { slug: s.slug },
      update: data,
      create: { ...data, slug: s.slug, ownerId: owner.id, businessType: "REGISTERED_BUSINESS", status: "APPROVED" }
    });
    storeIds.set(s.slug, store.id);
  }

  for (const p of PRODUCTS) {
    const storeId = storeIds.get(p.store);
    const categoryId = categoryIds.get(p.category);
    if (!storeId || !categoryId) throw new Error(`demo data: unknown store or category for ${p.slug}`);
    const fields = {
      title: p.title,
      description: p.description,
      categoryId,
      status: p.status ?? "ACTIVE",
      soldCount: p.sold,
      specs: p.specs.map(([label, value]) => ({ label, value })),
      publishedAt: p.status === "DRAFT" ? null : new Date(now.getTime() - p.days * DAY)
    };
    const product = await prisma.product.upsert({
      where: { storeId_slug: { storeId, slug: p.slug } },
      update: fields,
      create: { ...fields, storeId, slug: p.slug }
    });
    for (const [i, [sku, name, price, compareAt, stock, dealHours]] of p.variants.entries()) {
      const v = { name, priceCentavos: price, compareAtCentavos: compareAt, stock, sortOrder: i, saleEndsAt: dealHours ? new Date(now.getTime() + dealHours * HOUR) : null };
      await prisma.productVariant.upsert({ where: { storeId_sku: { storeId, sku } }, update: v, create: { ...v, productId: product.id, storeId, sku } });
    }
    await prisma.productImage.deleteMany({ where: { productId: product.id } });
    await prisma.productImage.create({ data: { productId: product.id, url: `/images/products/${p.image}.png`, alt: p.title, sortOrder: 0 } });
  }

  await prisma.user.upsert({
    where: { email: "maria.santos@example.com" },
    update: {},
    create: { email: "maria.santos@example.com", name: "Maria Santos", phone: "+639175550142", emailVerifiedAt: now }
  });

  return seedDemoReviews(prisma, PRODUCTS, now);
}
