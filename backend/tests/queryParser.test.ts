import { describe, expect, it } from "vitest";
import { createQueryParser } from "../src/lib/queryParser.js";

describe("createQueryParser", () => {
  it("keeps the last value for normal keys (parameter pollution guard)", () => {
    expect(createQueryParser()("sort=price&sort=name")).toEqual({ sort: "name" });
  });

  it("collects repeatable keys into an array", () => {
    expect(createQueryParser(["category"])("category=shoes&category=bags&q=red")).toEqual({ category: ["shoes", "bags"], q: "red" });
  });

  it("does not turn bracket syntax into objects", () => {
    const q = createQueryParser()("price[$gt]=0&user[role]=admin");
    expect(q).toEqual({ "price[$gt]": "0", "user[role]": "admin" });
    expect(typeof q["price[$gt]"]).toBe("string");
  });

  it("stores __proto__ as plain data without polluting objects", () => {
    const q = createQueryParser()("__proto__=polluted&constructor=x");
    expect(Object.getPrototypeOf(q)).toBeNull();
    expect(q["__proto__"]).toBe("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads at most maxParams parameters", () => {
    const qs = Array.from({ length: 100 }, (_, i) => `k${i}=v`).join("&");
    expect(Object.keys(createQueryParser([], 50)(qs))).toHaveLength(50);
  });
});
