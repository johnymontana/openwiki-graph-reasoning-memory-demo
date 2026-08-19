import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/agent-module.test.ts",
      "test/aura-agent-client.test.ts",
      "test/capture-log.test.ts",
      "test/child-env.test.ts",
      "test/fork-locator.test.ts",
      "test/memory-context.test.ts",
      "test/openwiki-trace-recorder.test.ts",
      "test/report.test.ts",
      "test/repository-id.test.ts",
      "test/run-journal.test.ts",
      "test/wiki-stats.test.ts",
    ],
  },
});
