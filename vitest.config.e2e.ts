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
    // The files share one sandbox and derive their accounts from a small set
    // of fixed test keys, so concurrent files publish the same Schnorr
    // contract class at the same time and the loser is rejected with
    // "Nullifier conflict with existing tx". singleFork alone does not stop
    // this: it puts the files in one process but still interleaves them.
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
