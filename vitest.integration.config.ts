import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/cli.test.ts",
      "test/neo4j-reasoning-store.test.ts",
      "test/reasoning-run-capture.test.ts",
      "test/integration/**/*.test.ts",
    ],
    testTimeout: 30_000,
  },
});
