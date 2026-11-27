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
import { SellerProductService } from "../../src/modules/seller/products.service.js";
import { sellerRouter } from "../../src/modules/seller/seller.routes.js";
import { notificationsRouter } from "../../src/modules/notifications/notifications.routes.js";
import { PriceDropService } from "../../src/modules/notifications/priceDrops.service.js";
import { LowStockService } from "../../src/modules/notifications/lowStock.service.js";
import { DeliveryService } from "../../src/modules/orders/delivery.js";
import { SellerOrderService } from "../../src/modules/seller/orders.service.js";
import { CancellationService } from "../../src/modules/orders/cancellation.js";
import { RefundService } from "../../src/modules/orders/refunds.js";
import { VisitService } from "../../src/modules/stores/visits.js";
import { DashboardService } from "../../src/modules/seller/dashboard.service.js";
import { PayoutService } from "../../src/modules/seller/payouts.service.js";
import { adminRouter } from "../../src/modules/admin/admin.routes.js";
import { ApplicationService } from "../../src/modules/admin/applications.service.js";
import { AdminDashboardService } from "../../src/modules/admin/dashboard.service.js";
import { MoneyService } from "../../src/modules/admin/money.service.js";
import { UserAdminService } from "../../src/modules/admin/users.service.js";

/**
 * The real catalog, reviews and store routes on a fresh test database filled with the
 * demo data (63 products, demo shoppers, orders and reviews), plus the real sign-in
 * stack, so signed-in actions like Follow are tested with real cookies and CSRF tokens.
 */
export async function createCatalogHarness() {
  const paymongo = new FakePaymongo();
  const media = new FakeMedia();
  /** The order service of the most recently built app (tests call its background job directly). */
  const services: {
    orders?: OrderService;
    priceDrops?: PriceDropService;
    delivery?: DeliveryService;
    sellerOrders?: SellerOrderService;
    lowStock?: LowStockService;
    refunds?: RefundService;
    cancellation?: CancellationService;
    visits?: VisitService;
    payouts?: PayoutService;
  } = {};
  /** Moves the clock of the background jobs and Seller Center orders (a day, a week) without waiting. */
  const clock = { offsetMs: 0 };
  const now = () => new Date(Date.now() + clock.offsetMs);
  // One set of order services per built app, shared by its routes, its webhook and the jobs (like server.ts).
  const built = new WeakMap<HarnessDeps, { orders: OrderService; refunds: RefundService; cancellation: CancellationService }>();
  const orderServices = (deps: HarnessDeps) => {
    const existing = built.get(deps);
    if (existing) return existing;
    const { prisma, kv, logger, email, config } = deps;
    const refunds = new RefundService({ prisma, gateway: paymongo, email, appUrl: config.APP_URL, logger, now });
    const cancellation = new CancellationService({ prisma, refunds, email, appUrl: config.APP_URL, logger, now });
    const orders = new OrderService({ prisma, cart: new CartService({ prisma }), gateway: paymongo, email, kv, appUrl: config.APP_URL, refunds, cancellation, logger, now });
    const bundle = { orders, refunds, cancellation };
    built.set(deps, bundle);
    Object.assign(services, bundle);
    return bundle;
  };
  const orderService = (deps: HarnessDeps) => orderServices(deps).orders;
  const h = await createAuthHarness({ PAYMONGO_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET }, {
    webhooks: (deps) => [webhooksRouter({ orders: orderService(deps), secret: deps.config.PAYMONGO_WEBHOOK_SECRET, logger: deps.logger })],
    routers: (deps) => {
      const { prisma, kv, guards, logger } = deps;
      const catalog = new CatalogService({ prisma, kv, logger });
      const priceDrops = new PriceDropService({ prisma, email: deps.email, config: deps.config, logger, now });
      services.priceDrops = priceDrops;
      const delivery = new DeliveryService({ prisma, logger, now });
      services.delivery = delivery;
      const sellerOrders = new SellerOrderService({ prisma, email: deps.email, appUrl: deps.config.APP_URL, cancellation: orderServices(deps).cancellation, logger, now });
      const visits = new VisitService({ prisma, kv, secret: deps.config.CODE_HASH_SECRET, logger, now });
      services.visits = visits;
      const payouts = new PayoutService({ prisma, email: deps.email, appUrl: deps.config.APP_URL, logger, now });
      services.payouts = payouts;
      services.sellerOrders = sellerOrders;
      services.lowStock = new LowStockService({ prisma, email: deps.email, config: deps.config, logger, now });
      return [
        notificationsRouter({ priceDrops, guards }),
        adminRouter({
          dashboard: new AdminDashboardService({ prisma, now }),
          applications: new ApplicationService({ prisma, media, email: deps.email, config: deps.config, logger, now }),
          money: new MoneyService({ prisma, payouts, refunds: orderServices(deps).refunds, config: deps.config }),
          users: new UserAdminService({ prisma, kv, email: deps.email, config: deps.config, logger, now }),
          security: new SecurityService({ prisma, kv, email: deps.email, config: deps.config, logger }),
          guards
        }),
        catalogRouter({ catalog, visits }),
        reviewsRouter({ reviews: new ReviewService({ prisma }), guards }),
        storesRouter({ stores: new StoreService({ prisma }), guards, visits }),
        homeRouter({ home: new HomeService({ prisma, kv, catalog, logger }) }),
        wishlistRouter({ wishlist: new WishlistService({ prisma, catalog }), guards }),
        cartRouter({ cart: new CartService({ prisma }), recommendations: new RecommendationService({ prisma, catalog }), guards }),
        addressesRouter({ addresses: new AddressService({ prisma }), guards }),
        ordersRouter({ orders: orderService(deps), delivery, guards }),
        sellerRouter({
          onboarding: new OnboardingService({ prisma, kv, media, email: deps.email, config: deps.config, logger }),
          products: new SellerProductService({ prisma, kv, media, logger }),
          orders: sellerOrders,
          dashboard: new DashboardService({ prisma, visits, now }),
          payouts,
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
  const priceDrops = () => {
    if (!services.priceDrops) throw new Error("no price-drop service yet");
    return services.priceDrops;
  };
  const service = <K extends keyof typeof services>(name: K) => () => {
    const s = services[name];
    if (!s) throw new Error(`no ${name} service yet`);
    return s as NonNullable<(typeof services)[K]>;
  };
  return { ...h, demo, idOf, paymongo, media, orders, priceDrops, clock, delivery: service("delivery"), sellerOrders: service("sellerOrders"), lowStock: service("lowStock"), refunds: service("refunds"), cancellation: service("cancellation"), visits: service("visits"), payouts: service("payouts") };
}

export type CatalogHarness = Awaited<ReturnType<typeof createCatalogHarness>>;
