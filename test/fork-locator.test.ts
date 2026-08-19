import { describe, expect, it } from "vitest";
import {
  assertReasoningHooksPresent,
  resolveOpenWikiFork,
  type ForkProbe,
} from "../src/openwiki/fork-locator.js";

function probeWithFiles(
  files: Record<string, string>,
): ForkProbe {
  return {
    fileExists: async (path) => path in files,
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`missing ${path}`);
      }
      return content;
    },
  };
}

describe("resolveOpenWikiFork", () => {
  it("resolves the sibling default checkout with a built dist", async () => {
    const probe = probeWithFiles({
      "/repos/openwiki/package.json": "{}",
      "/repos/openwiki/dist/agent/index.js": "code",
    });

    const fork = await resolveOpenWikiFork({}, "/repos/demo", probe);

    expect(fork.dir).toBe("/repos/openwiki");
    expect(fork.agentEntry).toBe("/repos/openwiki/dist/agent/index.js");
  });

  it("honors OPENWIKI_DIR, resolving relative values against the demo root", async () => {
    const probe = probeWithFiles({
      "/repos/forks/ow/package.json": "{}",
      "/repos/forks/ow/dist/agent/index.js": "code",
    });

    const absolute = await resolveOpenWikiFork(
      { OPENWIKI_DIR: "/repos/forks/ow" },
      "/repos/demo",
      probe,
    );
    const relative = await resolveOpenWikiFork(
      { OPENWIKI_DIR: "../forks/ow" },
      "/repos/demo",
      probe,
    );

    expect(absolute.dir).toBe("/repos/forks/ow");
    expect(relative.dir).toBe("/repos/forks/ow");
  });

  it("explains how to obtain a missing fork", async () => {
    await expect(
      resolveOpenWikiFork({}, "/repos/demo", probeWithFiles({})),
    ).rejects.toThrow(/johnymontana\/openwiki.*OPENWIKI_DIR/su);
  });

  it("explains how to build an unbuilt fork", async () => {
    const probe = probeWithFiles({ "/repos/openwiki/package.json": "{}" });

    await expect(
      resolveOpenWikiFork({}, "/repos/demo", probe),
    ).rejects.toThrow(/pnpm install && pnpm build/u);
  });
});

describe("assertReasoningHooksPresent", () => {
  it("accepts a build containing the raw stream hook", async () => {
    const probe = probeWithFiles({
      "/fork/dist/agent/index.js": "options.onRawStreamChunk?.(chunk)",
    });

    await expect(
      assertReasoningHooksPresent("/fork/dist/agent/index.js", probe),
    ).resolves.toBeUndefined();
  });

  it("rejects an un-patched build so runs cannot silently capture nothing", async () => {
    const probe = probeWithFiles({
      "/fork/dist/agent/index.js": "parseAgentStreamChunk(chunk)",
    });

    await expect(
      assertReasoningHooksPresent("/fork/dist/agent/index.js", probe),
    ).rejects.toThrow(/reasoning capture hooks/u);
  });
});
