import { defineConfig } from "vitest/config";

/**
 * The live check of Vendora AI against the real Claude API (`npm run test:ai-live`). It costs real money
 * (about US$1 a run), so it never runs with `npm test` or in CI. It uses a local test database, never Neon.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false
  }
});
