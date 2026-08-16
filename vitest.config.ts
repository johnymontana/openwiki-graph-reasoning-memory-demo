import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**", "test/e2e/**"],
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
    },
    environment: "node",
  },
});
