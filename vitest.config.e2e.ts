import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
