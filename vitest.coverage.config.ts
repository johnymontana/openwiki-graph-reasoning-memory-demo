import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        branches: 75,
        functions: 90,
        lines: 80,
        statements: 80,
      },
    },
    environment: "node",
    exclude: ["dist/**", "node_modules/**", "test/e2e/**"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
