import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
