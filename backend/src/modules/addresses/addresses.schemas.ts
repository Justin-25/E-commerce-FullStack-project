import { z } from "zod";

/** The Philippines' 18 regions (Negros Island Region re-created in 2024). Metro Manila (NCR) has no province. */
export const REGIONS = [
  "NCR", "CAR", "Ilocos Region", "Cagayan Valley", "Central Luzon", "CALABARZON", "MIMAROPA", "Bicol Region", "Western Visayas",
  "Negros Island Region", "Central Visayas", "Eastern Visayas", "Zamboanga Peninsula", "Northern Mindanao", "Davao Region",
  "SOCCSKSARGEN", "Caraga", "BARMM"
] as const;

/** Enough for home, office, parents' house…; stops one account from filling the table. */
export const MAX_ADDRESSES = 10;

/** "0917 123 4567", "+63 917-123-4567", "639171234567" → "+639171234567"; anything else → null. */
export function normalizePhone(raw: string): string | null {
  const m = /^(?:\+?63|0)?(9\d{9})$/.exec(raw.replace(/[\s().-]/g, ""));
  return m ? `+63${m[1]}` : null;
}

const text = (label: string, min: number, max: number) =>
  z.string({ error: `Enter the ${label}` }).trim().min(min, { error: `Enter the ${label}` }).max(max, { error: `Use ${max} characters or fewer` });

/**
 * The whole address form (create and edit send every field). Strict: unknown fields are
 * refused, so nothing else (like userId) can be slipped in.
 */
const addressFields = z.strictObject({
  label: z.string().trim().max(30, { error: "Use 30 characters or fewer" }).nullish().transform((v) => v || null), // "Home", "Office"
  fullName: text("full name", 2, 100),
  phone: z
    .string({ error: "Enter a mobile number" })
    .refine((v) => normalizePhone(v) !== null, { error: "Enter a Philippine mobile number, e.g. 0917 123 4567" })
    .transform((v) => normalizePhone(v) as string),
  region: z.enum(REGIONS, { error: "Choose a region" }),
  province: z.string().trim().max(100, { error: "Use 100 characters or fewer" }).nullish(),
  city: text("city or municipality", 2, 100),
  barangay: text("barangay", 1, 100),
  street: text("house number, street and building", 3, 255),
  postalCode: z.string({ error: "Enter the postal code" }).trim().regex(/^\d{4}$/, { error: "Use the 4-digit postal code" })
});

const withProvinceRule = <T extends z.ZodType<{ region: string; province?: string | null | undefined }>>(schema: T) =>
  schema
    .refine((v) => v.region === "NCR" || Boolean(v.province), { error: "Enter the province", path: ["province"] })
    .transform((v) => ({ ...v, province: v.region === "NCR" ? null : (v.province ?? null) }));

export const addressCreateSchema = withProvinceRule(addressFields.extend({ isDefault: z.boolean().optional() }));
export const addressUpdateSchema = withProvinceRule(addressFields);
export const addressIdSchema = z.object({ id: z.uuid({ error: "Address not found" }) });

export type AddressInput = z.infer<typeof addressUpdateSchema>;
