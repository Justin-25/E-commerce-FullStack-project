import { seedDemoData } from "../../prisma/demo-data.js";
import { addressesRouter } from "../../src/modules/addresses/addresses.routes.js";
import { AddressService } from "../../src/modules/addresses/addresses.service.js";
import { cartRouter } from "../../src/modules/cart/cart.routes.js";
import { CartService } from "../../src/modules/cart/cart.service.js";
import { RecommendationService } from "../../src/modules/cart/recommendations.js";
import { catalogRouter } from "../../src/modules/catalog/catalog.routes.js";
import { homeRouter } from "../../src/modules/home/home.routes.js";
import { ordersRouter } from "../../src/modules/orders/orders.routes.js";
import { OrderService } from "../../src/modules/orders/orders.service.js";
import { webhooksRouter } from "../../src/modules/orders/webhooks.routes.js";
import { HomeService } from "../../src/modules/home/home.service.js";
import { CatalogService } from "../../src/modules/catalog/catalog.service.js";
import { reviewsRouter } from "../../src/modules/reviews/reviews.routes.js";
import { ReviewService } from "../../src/modules/reviews/reviews.service.js";
import { storesRouter } from "../../src/modules/stores/stores.routes.js";
import { StoreService } from "../../src/modules/stores/stores.service.js";
import { wishlistRouter } from "../../src/modules/wishlist/wishlist.routes.js";
import { WishlistService } from "../../src/modules/wishlist/wishlist.service.js";
import { createAuthHarness, type HarnessDeps } from "./authHarness.js";
import { FakePaymongo, TEST_WEBHOOK_SECRET } from "./fakePaymongo.js";
import { FakeMedia } from "./fakeMedia.js";
import { SecurityService } from "../../src/modules/auth/security.service.js";
import { OnboardingService } from "../../src/modules/seller/onboarding.service.js";
import { sellerRouter } from "../../src/modules/seller/seller.routes.js";

/**
 * The real catalog, reviews and store routes on a fresh test database filled with the
 * demo data (63 products, demo shoppers, orders and reviews), plus the real sign-in
 * stack, so signed-in actions like Follow are tested with real cookies and CSRF tokens.
 */
export async function createCatalogHarness() {
  const paymongo = new FakePaymongo();
  const media = new FakeMedia();
  /** The order service of the most recently built app (tests call its background job directly). */
  const services: { orders?: OrderService } = {};
  // One order service per built app, shared by its routes and its webhook (like server.ts).
  const built = new WeakMap<HarnessDeps, OrderService>();
  const orderService = (deps: HarnessDeps) => {
    const existing = built.get(deps);
    if (existing) return existing;
    const { prisma, kv, logger, email, config } = deps;
    const orders = new OrderService({ prisma, cart: new CartService({ prisma }), gateway: paymongo, email, kv, appUrl: config.APP_URL, logger });
    built.set(deps, orders);
    services.orders = orders;
    return orders;
  };
  const h = await createAuthHarness({ PAYMONGO_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET }, {
    webhooks: (deps) => [webhooksRouter({ orders: orderService(deps), secret: deps.config.PAYMONGO_WEBHOOK_SECRET, logger: deps.logger })],
    routers: (deps) => {
      const { prisma, kv, guards, logger } = deps;
      const catalog = new CatalogService({ prisma, kv, logger });
      return [
        catalogRouter({ catalog }),
        reviewsRouter({ reviews: new ReviewService({ prisma }), guards }),
        storesRouter({ stores: new StoreService({ prisma }), guards }),
        homeRouter({ home: new HomeService({ prisma, kv, catalog, logger }) }),
        wishlistRouter({ wishlist: new WishlistService({ prisma, catalog }), guards }),
        cartRouter({ cart: new CartService({ prisma }), recommendations: new RecommendationService({ prisma, catalog }), guards }),
        addressesRouter({ addresses: new AddressService({ prisma }), guards }),
        ordersRouter({ orders: orderService(deps), guards }),
        sellerRouter({
          onboarding: new OnboardingService({ prisma, kv, media, email: deps.email, config: deps.config, logger }),
          security: new SecurityService({ prisma, kv, email: deps.email, config: deps.config, logger }),
          guards,
          config: deps.config
        })
      ];
    }
  });
  const demo = await seedDemoData(h.db.prisma);

  /** A product's id by its slug (demo data slugs are unique). */
  const idOf = async (slug: string) => (await h.db.prisma.product.findFirstOrThrow({ where: { slug }, select: { id: true } })).id;

  const orders = () => {
    if (!services.orders) throw new Error("no order service yet");
    return services.orders;
  };
  return { ...h, demo, idOf, paymongo, media, orders };
}

export type CatalogHarness = Awaited<ReturnType<typeof createCatalogHarness>>;
