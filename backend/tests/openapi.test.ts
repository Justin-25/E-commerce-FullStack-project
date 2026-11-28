/**
 * Contract test: openapi.yaml (what the frontend is promised) and the code
 * (what actually exists) must agree. A route added without documenting it, or
 * documented but never built, fails here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Router } from "express";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ERROR_CODES } from "../src/lib/errors.js";
import { MemoryKv } from "../src/lib/kv.js";
import { createAuthGuards } from "../src/middleware/auth.js";
import { createCsrf } from "../src/middleware/csrf.js";
import { authRouter } from "../src/modules/auth/auth.routes.js";
import type { AuthService } from "../src/modules/auth/auth.service.js";
import type { GoogleService } from "../src/modules/auth/google.service.js";
import type { SecurityService } from "../src/modules/auth/security.service.js";
import { catalogRouter } from "../src/modules/catalog/catalog.routes.js";
import type { CatalogService } from "../src/modules/catalog/catalog.service.js";
import { addressesRouter } from "../src/modules/addresses/addresses.routes.js";
import type { AddressService } from "../src/modules/addresses/addresses.service.js";
import { cartRouter } from "../src/modules/cart/cart.routes.js";
import type { CartService } from "../src/modules/cart/cart.service.js";
import type { RecommendationService } from "../src/modules/cart/recommendations.js";
import { homeRouter } from "../src/modules/home/home.routes.js";
import { ordersRouter } from "../src/modules/orders/orders.routes.js";
import type { OrderService } from "../src/modules/orders/orders.service.js";
import { webhooksRouter } from "../src/modules/orders/webhooks.routes.js";
import type { OnboardingService } from "../src/modules/seller/onboarding.service.js";
import type { SellerProductService } from "../src/modules/seller/products.service.js";
import type { SellerOrderService } from "../src/modules/seller/orders.service.js";
import type { DeliveryService } from "../src/modules/orders/delivery.js";
import type { VisitService } from "../src/modules/stores/visits.js";
import type { DashboardService } from "../src/modules/seller/dashboard.service.js";
import type { PayoutService } from "../src/modules/seller/payouts.service.js";
import { adminRouter } from "../src/modules/admin/admin.routes.js";
import type { ApplicationService } from "../src/modules/admin/applications.service.js";
import type { AdminDashboardService } from "../src/modules/admin/dashboard.service.js";
import type { MoneyService } from "../src/modules/admin/money.service.js";
import type { UserAdminService } from "../src/modules/admin/users.service.js";
import type { StoreAdminService } from "../src/modules/admin/stores.service.js";
import type { AuditLogService } from "../src/modules/admin/auditLog.service.js";
import type { ModerationService } from "../src/modules/admin/moderation.service.js";
import { reportsRouter } from "../src/modules/moderation/reports.routes.js";
import type { ReportService } from "../src/modules/moderation/reports.service.js";
import { sellerRouter } from "../src/modules/seller/seller.routes.js";
import { notificationsRouter } from "../src/modules/notifications/notifications.routes.js";
import type { PriceDropService } from "../src/modules/notifications/priceDrops.service.js";
import type { HomeService } from "../src/modules/home/home.service.js";
import { reviewsRouter } from "../src/modules/reviews/reviews.routes.js";
import type { ReviewService } from "../src/modules/reviews/reviews.service.js";
import { storesRouter } from "../src/modules/stores/stores.routes.js";
import type { StoreService } from "../src/modules/stores/stores.service.js";
import { wishlistRouter } from "../src/modules/wishlist/wishlist.routes.js";
import type { WishlistService } from "../src/modules/wishlist/wishlist.service.js";
import { TokenService } from "../src/modules/auth/tokens.js";
import { aiRouter } from "../src/modules/ai/ai.routes.js";
import type { AssistantService } from "../src/modules/ai/assistant.service.js";
import { testConfig } from "./helpers.js";

type Spec = { paths: Record<string, Record<string, { operationId?: string }>>; components: Record<string, unknown> };
const spec = parse(readFileSync(join(import.meta.dirname, "..", "openapi", "openapi.yaml"), "utf8")) as Spec;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** "METHOD /path" for every route registered on an Express router, mounted at `prefix`. */
function routesOf(router: Router, prefix: string): string[] {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
  return stack.flatMap((layer) =>
    // Express writes path parameters as ":id", OpenAPI as "{id}".
    layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${layer.route?.path.replace(/:(\w+)/g, "{$1}")}`) : []
  );
}

function documented(prefix: string): string[] {
  return Object.entries(spec.paths)
    .filter(([path]) => path.startsWith(prefix))
    .flatMap(([path, ops]) => Object.keys(ops).filter((m) => HTTP_METHODS.has(m)).map((m) => `${m.toUpperCase()} ${path}`));
}

describe("openapi.yaml", () => {
  it("documents exactly the /api/v1 routes the code has (sign-in, catalog, stores, reviews…)", () => {
    const config = testConfig();
    const tokens = new TokenService(config);
    const auth = authRouter({
      service: {} as AuthService, // never called: we only list the routes
      security: {} as SecurityService,
      google: {} as GoogleService,
      tokens,
      csrf: createCsrf(config),
      guards: createAuthGuards({ tokens, kv: new MemoryKv() }),
      config
    });
    const guards = createAuthGuards({ tokens, kv: new MemoryKv() });
    const routers = [
      auth,
      catalogRouter({ catalog: {} as CatalogService, visits: {} as VisitService }),
      reviewsRouter({ reviews: {} as ReviewService, guards }),
      storesRouter({ stores: {} as StoreService, guards, visits: {} as VisitService }),
      homeRouter({ home: {} as HomeService }),
      wishlistRouter({ wishlist: {} as WishlistService, guards }),
      cartRouter({ cart: {} as CartService, recommendations: {} as RecommendationService, guards }),
      addressesRouter({ addresses: {} as AddressService, guards }),
      ordersRouter({ orders: {} as OrderService, delivery: {} as DeliveryService, guards }),
      webhooksRouter({ orders: {} as OrderService, secret: undefined }),
      sellerRouter({ onboarding: {} as OnboardingService, products: {} as SellerProductService, orders: {} as SellerOrderService, dashboard: {} as DashboardService, payouts: {} as PayoutService, security: {} as SecurityService, guards, config }),
      notificationsRouter({ priceDrops: {} as PriceDropService, guards }),
      reportsRouter({ reports: {} as ReportService, guards }),
      aiRouter({ assistant: {} as AssistantService, guards, config }),
      adminRouter({ dashboard: {} as AdminDashboardService, applications: {} as ApplicationService, money: {} as MoneyService, users: {} as UserAdminService, stores: {} as StoreAdminService, auditLog: {} as AuditLogService, moderation: {} as ModerationService, security: {} as SecurityService, guards })
    ];
    const inCode = routers.flatMap((r) => routesOf(r, "/api/v1"));
    expect(documented("/api/v1/").sort()).toEqual(inCode.sort());
  });

  it("lists exactly the error codes the code can return", () => {
    const errorSchema = (spec.components.schemas as Record<string, { properties: { error: { properties: { code: { enum: string[] } } } } }>).Error;
    expect(errorSchema?.properties.error.properties.code.enum).toEqual([...ERROR_CODES]);
  });

  it("has a unique operationId on every operation", () => {
    const ids = Object.values(spec.paths).flatMap((ops) => Object.entries(ops).filter(([m]) => HTTP_METHODS.has(m)).map(([, op]) => op.operationId));
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no broken $ref links", () => {
    const broken: string[] = [];
    const resolve = (ref: string) => ref.replace(/^#\//, "").split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], spec);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string" && resolve(value) === undefined) broken.push(value);
          else walk(value);
        }
      }
    };
    walk(spec);
    expect(broken).toEqual([]);
  });
});
