import { defineConfig } from "vitest/config";

// The crash smoke runs on its own fresh sandbox (`npm run test:e2e:crash`).
// Its bridges must pass hard readiness, which refuses a finalized tip more
// than 300 s ahead of wall time, and the rest of the suite drives the local
// chain's clock thousands of seconds ahead (docker-compose.yml, anvil).
const CRASH_SMOKE = "tests/e2e/crash-recovery.test.ts";
const crashOnly = process.env["E2E_SUITE"] === "crash";

export default defineConfig({
  test: {
    include: crashOnly ? [CRASH_SMOKE] : ["tests/e2e/**/*.test.ts"],
    exclude: crashOnly ? ["**/node_modules/**"] : ["**/node_modules/**", CRASH_SMOKE],
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
