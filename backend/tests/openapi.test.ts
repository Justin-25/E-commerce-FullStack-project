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
import { reviewsRouter } from "../src/modules/reviews/reviews.routes.js";
import type { ReviewService } from "../src/modules/reviews/reviews.service.js";
import { storesRouter } from "../src/modules/stores/stores.routes.js";
import type { StoreService } from "../src/modules/stores/stores.service.js";
import { TokenService } from "../src/modules/auth/tokens.js";
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
      catalogRouter({ catalog: {} as CatalogService }),
      reviewsRouter({ reviews: {} as ReviewService }),
      storesRouter({ stores: {} as StoreService, guards })
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
