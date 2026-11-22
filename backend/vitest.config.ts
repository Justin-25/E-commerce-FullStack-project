import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    // Checkout tests chain many requests; against a remote database (CI's real-Postgres path
    // run from a laptop) they can take longer than Vitest's 5-second default.
    testTimeout: 30_000
  }
});
