import { seedDemoData } from "../../prisma/demo-data.js";
import { catalogRouter } from "../../src/modules/catalog/catalog.routes.js";
import { CatalogService } from "../../src/modules/catalog/catalog.service.js";
import { reviewsRouter } from "../../src/modules/reviews/reviews.routes.js";
import { ReviewService } from "../../src/modules/reviews/reviews.service.js";
import { storesRouter } from "../../src/modules/stores/stores.routes.js";
import { StoreService } from "../../src/modules/stores/stores.service.js";
import { createAuthHarness } from "./authHarness.js";

/**
 * The real catalog, reviews and store routes on a fresh test database filled with the
 * demo data (63 products, demo shoppers, orders and reviews), plus the real sign-in
 * stack, so signed-in actions like Follow are tested with real cookies and CSRF tokens.
 */
export async function createCatalogHarness() {
  const h = await createAuthHarness({}, {
    routers: ({ prisma, kv, guards, logger }) => [
      catalogRouter({ catalog: new CatalogService({ prisma, kv, logger }) }),
      reviewsRouter({ reviews: new ReviewService({ prisma }) }),
      storesRouter({ stores: new StoreService({ prisma }), guards })
    ]
  });
  const demo = await seedDemoData(h.db.prisma);

  /** A product's id by its slug (demo data slugs are unique). */
  const idOf = async (slug: string) => (await h.db.prisma.product.findFirstOrThrow({ where: { slug }, select: { id: true } })).id;

  return { ...h, demo, idOf };
}

export type CatalogHarness = Awaited<ReturnType<typeof createCatalogHarness>>;
