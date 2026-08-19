import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/cli.test.ts",
      "test/evaluate.test.ts",
      "test/neo4j-reasoning-store.test.ts",
      "test/openwiki-runner.test.ts",
      "test/reasoning-run-capture.test.ts",
      "test/runner-child.test.ts",
      "test/runner-default-deps.test.ts",
      "test/temp-repo.test.ts",
      "test/integration/**/*.test.ts",
    ],
    testTimeout: 30_000,
  },
});
