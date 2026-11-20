import type { Prisma } from "../../generated/prisma/client.js";

/**
 * What shoppers can see, in ONE place (the search SQL in search.ts applies the same rule):
 * an ACTIVE product, from an APPROVED store, with at least one variant on sale.
 * Anything else answers 404, exactly like an id that never existed.
 */
export const visibleProduct = (id: string) =>
  ({
    id,
    status: "ACTIVE",
    store: { status: "APPROVED" },
    variants: { some: { isActive: true } }
  }) satisfies Prisma.ProductWhereInput;
