import { describe, expect, it } from "vitest";
import { buildOpenWikiChildEnv } from "../src/openwiki/child-env.js";

describe("buildOpenWikiChildEnv", () => {
  it("pins the anthropic provider and disables telemetry", () => {
    const base: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "key",
      OPENAI_API_KEY: "should-not-win-provider-precedence",
      OPENWIKI_REASONING_EFFORT: "high",
      PATH: "/usr/bin",
    };

    const environment = buildOpenWikiChildEnv(base, {});

    expect(environment.OPENWIKI_PROVIDER).toBe("anthropic");
    expect(environment.OPENWIKI_REASONING_EFFORT).toBeUndefined();
    expect(environment.OPENWIKI_TELEMETRY_DISABLED).toBe("1");
    expect(environment.DO_NOT_TRACK).toBe("1");
    expect(environment.PATH).toBe("/usr/bin");
    // The caller's environment object is never mutated.
    expect(base.OPENWIKI_REASONING_EFFORT).toBe("high");
    expect(base.OPENWIKI_TELEMETRY_DISABLED).toBeUndefined();
  });

  it("requires an Anthropic key for the default provider", () => {
    expect(() => buildOpenWikiChildEnv({}, {})).toThrow(
      "ANTHROPIC_API_KEY is required",
    );
  });

  it("trusts an explicitly configured non-anthropic provider", () => {
    const environment = buildOpenWikiChildEnv(
      { OPENWIKI_PROVIDER: "openai", OPENAI_API_KEY: "key" },
      {},
    );

    expect(environment.OPENWIKI_PROVIDER).toBe("openai");
  });

  it("applies model override and HOME isolation", () => {
    const environment = buildOpenWikiChildEnv(
      { ANTHROPIC_API_KEY: "key", HOME: "/Users/someone" },
      { isolatedHomeDir: "/tmp/run-home", modelId: "claude-sonnet-5" },
    );

    expect(environment.OPENWIKI_MODEL_ID).toBe("claude-sonnet-5");
    expect(environment.HOME).toBe("/tmp/run-home");
    expect(environment.USERPROFILE).toBe("/tmp/run-home");
  });

  it("keeps the parent HOME when isolation is disabled", () => {
    const environment = buildOpenWikiChildEnv(
      { ANTHROPIC_API_KEY: "key", HOME: "/Users/someone" },
      {},
    );

    expect(environment.HOME).toBe("/Users/someone");
  });
});
