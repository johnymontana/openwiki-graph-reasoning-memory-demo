import { describe, expect, it, vi } from "vitest";
import type {
  OpenWikiAgentModule,
  OpenWikiAgentRunOptions,
} from "../src/openwiki/agent-module.js";
import type { RunJournalLine } from "../src/openwiki/run-journal.js";
import {
  executeChildRun,
  parseChildRunConfig,
  type ChildRunConfig,
  type ChildRunDeps,
} from "../src/openwiki/runner-child.js";

const CONFIG: ChildRunConfig = {
  agentEntry: "/fork/dist/agent/index.js",
  command: "init",
  cwd: "/repos/target",
  journalPath: "/work/journal.jsonl",
  trace: {
    repository: "github.com/example/demo-repo",
    sessionId: "session-1",
    startedAt: "2026-08-19T00:00:00.000Z",
    task: "init the OpenWiki",
    traceId: "trace-1",
  },
  userMessage: "init the OpenWiki",
};

function createDeps(agentModule: OpenWikiAgentModule) {
  const lines: Array<{ line: RunJournalLine; path: string }> = [];
  const fatalHandlers: Array<(source: string, error: unknown) => void> = [];
  const stderrLines: string[] = [];
  let tick = 0;
  const deps: ChildRunDeps = {
    appendLine: (path, line) => {
      lines.push({ line, path });
    },
    importAgent: vi.fn(async () => agentModule),
    installFatalHandlers: (onFatal) => {
      fatalHandlers.push(onFatal);
    },
    now: () => `2026-08-19T00:00:0${(tick += 1)}.000Z`,
    stderr: (message) => {
      stderrLines.push(message);
    },
  };

  return { deps, fatalHandlers, lines, stderrLines };
}

describe("executeChildRun", () => {
  it("journals header, capture entries, and a success-free finish in order", async () => {
    let capturedOptions: OpenWikiAgentRunOptions | undefined;
    const agentModule: OpenWikiAgentModule = {
      runOpenWikiAgent: async (command, cwd, options) => {
        capturedOptions = options;
        await options.onPlanSnapshot?.("- plan");
        await options.onRawStreamChunk?.([
          ["agent"],
          "tools",
          { event: "on_tool_start", name: "glob", toolCallId: "call-1" },
        ]);
        await options.onRawStreamChunk?.([
          ["agent"],
          "tools",
          { event: "on_tool_end", name: "glob", output: [], toolCallId: "call-1" },
        ]);
        expect(command).toBe("init");
        expect(cwd).toBe("/repos/target");
        return { command, model: "claude-haiku-4-5" };
      },
    };
    const harness = createDeps(agentModule);

    const exitCode = await executeChildRun(CONFIG, harness.deps);

    expect(exitCode).toBe(0);
    expect(harness.lines.every((entry) => entry.path === CONFIG.journalPath)).toBe(true);
    const kinds = harness.lines.map((entry) => entry.line.kind);
    expect(kinds).toEqual([
      "header",
      "plan_snapshot",
      "raw_chunk",
      "raw_chunk",
      "finish",
    ]);
    const finish = harness.lines.at(-1)!.line as Extract<
      RunJournalLine,
      { kind: "finish" }
    >;
    expect(finish.finish?.success).toBeUndefined();
    expect(finish.runResult).toEqual({
      command: "init",
      model: "claude-haiku-4-5",
    });
    expect(capturedOptions?.outputMode).toBe("repository");
    expect(capturedOptions?.userMessage).toBe("init the OpenWiki");
    expect(capturedOptions?.modelId).toBeNull();
    // onEvent is a debug affordance only; capture flows through raw chunks.
    expect(capturedOptions?.onEvent).toBeUndefined();
  });

  it("marks a skipped run in the finish line", async () => {
    const harness = createDeps({
      runOpenWikiAgent: async (command) => ({
        command,
        model: "claude-haiku-4-5",
        skipped: true,
      }),
    });

    await executeChildRun(CONFIG, harness.deps);

    const finish = harness.lines.at(-1)!.line as Extract<
      RunJournalLine,
      { kind: "finish" }
    >;
    expect(finish.runResult?.skipped).toBe(true);
  });

  it("journals an import failure as fatal and exits 1", async () => {
    const harness = createDeps({
      runOpenWikiAgent: async () => {
        throw new Error("unreachable");
      },
    });
    harness.deps.importAgent = vi.fn(async () => {
      throw new Error("better-sqlite3 failed to load");
    });

    const exitCode = await executeChildRun(CONFIG, harness.deps);

    expect(exitCode).toBe(1);
    const fatal = harness.lines.at(-1)!.line as Extract<
      RunJournalLine,
      { kind: "fatal" }
    >;
    expect(fatal.source).toBe("import");
    expect(fatal.message).toContain("better-sqlite3 failed to load");
  });

  it("journals a thrown run as fatal and exits 1", async () => {
    const harness = createDeps({
      runOpenWikiAgent: async () => {
        throw new Error("provider rejected the request");
      },
    });

    const exitCode = await executeChildRun(CONFIG, harness.deps);

    expect(exitCode).toBe(1);
    const fatal = harness.lines.at(-1)!.line as Extract<
      RunJournalLine,
      { kind: "fatal" }
    >;
    expect(fatal.source).toBe("run");
    expect(fatal.message).toContain("provider rejected the request");
  });

  it("never lets a capture write failure reach the OpenWiki run", async () => {
    const harness = createDeps({
      runOpenWikiAgent: async (command, _cwd, options) => {
        await options.onRawStreamChunk?.({ chunk: 1 });
        return { command, model: "m" };
      },
    });
    const realAppend = harness.deps.appendLine;
    harness.deps.appendLine = (path, line) => {
      if (line.kind === "raw_chunk") {
        throw new Error("disk full");
      }
      realAppend(path, line);
    };

    const exitCode = await executeChildRun(
      { ...CONFIG, debug: true },
      harness.deps,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderrLines.join("\n")).toContain("dropped an unserializable raw chunk");
  });

  it("journals process-level fatals through the installed handler", async () => {
    const harness = createDeps({
      runOpenWikiAgent: async (command) => ({ command, model: "m" }),
    });

    await executeChildRun(CONFIG, harness.deps);
    harness.fatalHandlers[0]!("unhandledRejection", new Error("escaped subagent rejection"));

    const fatal = harness.lines.at(-1)!.line as Extract<
      RunJournalLine,
      { kind: "fatal" }
    >;
    expect(fatal.source).toBe("unhandledRejection");
    expect(fatal.message).toContain("escaped subagent rejection");
  });
});

describe("parseChildRunConfig", () => {
  it("accepts a valid config", () => {
    expect(parseChildRunConfig(JSON.parse(JSON.stringify(CONFIG)))).toMatchObject({
      command: "init",
      cwd: "/repos/target",
    });
  });

  it.each([
    ["a non-object", 42, "must be a JSON object"],
    ["a missing agentEntry", { ...CONFIG, agentEntry: "" }, "agentEntry"],
    ["a bad command", { ...CONFIG, command: "chat" }, "init or update"],
    ["a relative cwd", { ...CONFIG, cwd: "relative/path" }, "absolute path"],
    [
      "a non-string userMessage",
      { ...CONFIG, userMessage: 7 },
      "string or null",
    ],
    ["a missing trace", { ...CONFIG, trace: null }, "trace object"],
    [
      "an incomplete trace",
      { ...CONFIG, trace: { sessionId: "s" } },
      "trace.startedAt",
    ],
  ])("rejects %s", (_label, value, message) => {
    expect(() => parseChildRunConfig(value)).toThrow(message);
  });
});
