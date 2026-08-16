import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/aura-agent-client.test.ts",
      "test/capture-log.test.ts",
      "test/memory-context.test.ts",
      "test/openwiki-trace-recorder.test.ts",
    ],
  },
});
