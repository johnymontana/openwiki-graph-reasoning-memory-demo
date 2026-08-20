import { describe, expect, it, vi } from "vitest";
import type { ReasoningTrace } from "../src/domain/types.js";
import {
  buildChildNodeArguments,
  runInstrumentedOpenWiki,
  type OpenWikiRunnerDeps,
  type OpenWikiRunRequest,
  type SpawnChildResult,
} from "../src/openwiki/openwiki-runner.js";
import type { RunJournalLine } from "../src/openwiki/run-journal.js";

const REQUEST: OpenWikiRunRequest = {
  captureDir: "/out/captures",
  command: "init",
  ingest: true,
  isolateHome: true,
  metadata: { augmented: false, command: "init", outputMode: "repository" },
  repoPath: "/repos/target",
  repository: "github.com/example/demo-repo",
  sessionId: "eval:run-1:baseline:0",
  task: "init the OpenWiki for github.com/example/demo-repo",
  timeoutMs: 60_000,
  traceId: "trace-1",
  userMessage: "init the OpenWiki for github.com/example/demo-repo",
  workDir: "/out/captures/trace-1-work",
};

function journalSource(lines: RunJournalLine[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const CLEAN_JOURNAL = journalSource([
  {
    kind: "header",
    trace: {
      repository: REQUEST.repository,
      sessionId: REQUEST.sessionId,
      startedAt: "2026-08-19T00:00:00.000Z",
      task: REQUEST.task,
      traceId: REQUEST.traceId,
    },
    version: 1,
  },
  {
    at: "2026-08-19T00:00:01.000Z",
    chunk: [
      ["agent"],
      "tools",
      {
        event: "on_tool_start",
        input: { pattern: "**/*.ts" },
        name: "glob",
        toolCallId: "call-1",
      },
    ],
    kind: "raw_chunk",
  },
  {
    at: "2026-08-19T00:00:02.000Z",
    chunk: [
      ["agent"],
      "tools",
      { event: "on_tool_end", name: "glob", output: ["a.ts"], toolCallId: "call-1" },
    ],
    kind: "raw_chunk",
  },
  {
    finish: { completedAt: "2026-08-19T00:00:03.000Z", success: true },
    kind: "finish",
    runResult: { command: "init", model: "claude-haiku-4-5" },
  },
]);

interface HarnessOptions {
  journal?: string | null;
  saveError?: Error;
  spawnResult?: SpawnChildResult;
}

function createHarness(options: HarnessOptions = {}) {
  const savedTraces: ReasoningTrace[] = [];
  const writtenFiles = new Map<string, string>();
  const ensuredDirs: string[] = [];
  let clockTick = 0;

  const deps: OpenWikiRunnerDeps = {
    clock: () => new Date(Date.UTC(2026, 7, 19, 0, 0, 10 + (clockTick += 1))),
    ensureDir: async (dir) => {
      ensuredDirs.push(dir);
    },
    environment: { ANTHROPIC_API_KEY: "key" },
    locateFork: vi.fn(async () => ({
      agentEntry: "/fork/dist/agent/index.js",
      dir: "/fork",
    })),
    readFileText: async (path) =>
      path === "/out/captures/trace-1-work/journal.jsonl"
        ? (options.journal === undefined ? CLEAN_JOURNAL : options.journal)
        : null,
    saveTrace: vi.fn(async (trace: ReasoningTrace) => {
      if (options.saveError) {
        throw options.saveError;
      }
      savedTraces.push(trace);
    }),
    scanWiki: vi.fn(async () => ({ fileCount: 4, totalBytes: 9_000 })),
    spawnChild: vi.fn(async () =>
      options.spawnResult ?? { exitCode: 0, timedOut: false },
    ),
    writeFileText: async (path, content) => {
      writtenFiles.set(path, content);
    },
  };

  return { deps, ensuredDirs, savedTraces, writtenFiles };
}

describe("buildChildNodeArguments", () => {
  it("propagates the parent loader and adds tsx only for bare .ts entries", () => {
    expect(
      buildChildNodeArguments("/demo/src/cli.ts", [
        "--import",
        "file:///x/tsx/dist/loader.mjs",
      ]),
    ).toEqual(["--import", "file:///x/tsx/dist/loader.mjs"]);
    expect(buildChildNodeArguments("/demo/src/cli.ts", [])).toEqual([
      "--import",
      "tsx",
    ]);
    expect(buildChildNodeArguments("/demo/dist/cli.js", [])).toEqual([]);
  });
});

describe("runInstrumentedOpenWiki", () => {
  it("recovers a clean journal into a persisted trace and capture log", async () => {
    const harness = createHarness();

    const record = await runInstrumentedOpenWiki(REQUEST, harness.deps);

    expect(record.childExitCode).toBe(0);
    expect(record.cleanExit).toBe(true);
    expect(record.timedOut).toBe(false);
    expect(record.persisted).toBe(true);
    expect(record.warnings).toEqual([]);
    expect(record.runResult).toEqual({
      command: "init",
      model: "claude-haiku-4-5",
    });
    expect(record.wikiStats).toEqual({ fileCount: 4, totalBytes: 9_000 });

    // Derived success (M4): one observed call, finished → true.
    expect(record.trace.success).toBe(true);
    expect(record.trace.repository).toBe(REQUEST.repository);
    expect(record.trace.steps).toHaveLength(1);
    expect(record.trace.metadata).toMatchObject({
      childExitCode: 0,
      model: "claude-haiku-4-5",
      timedOut: false,
      wikiFileCount: 4,
      wikiTotalBytes: 9_000,
    });
    expect(record.trace.metadata.error_kind).toBeUndefined();

    expect(harness.savedTraces).toHaveLength(1);
    expect(record.captureLogPath).toBe("/out/captures/trace-1.json");
    const captureLog = JSON.parse(
      harness.writtenFiles.get("/out/captures/trace-1.json")!,
    );
    expect(captureLog.entries).toHaveLength(2);
    expect(captureLog.finish.completedAt).toBe("2026-08-19T00:00:03.000Z");

    const childConfig = JSON.parse(
      harness.writtenFiles.get("/out/captures/trace-1-work/child-config.json")!,
    );
    expect(childConfig).toMatchObject({
      agentEntry: "/fork/dist/agent/index.js",
      command: "init",
      cwd: "/repos/target",
      userMessage: REQUEST.userMessage,
    });
    expect(childConfig.trace.repository).toBe(REQUEST.repository);
    expect(harness.ensuredDirs).toContain("/out/captures/trace-1-work/home");
  });

  it("marks a timed-out run failed with an explicit error kind", async () => {
    const harness = createHarness({
      journal: journalSource([
        {
          kind: "header",
          trace: {
            sessionId: REQUEST.sessionId,
            startedAt: "2026-08-19T00:00:00.000Z",
            task: REQUEST.task,
            traceId: REQUEST.traceId,
          },
          version: 1,
        },
      ]),
      spawnResult: { exitCode: null, timedOut: true },
    });

    const record = await runInstrumentedOpenWiki(REQUEST, harness.deps);

    expect(record.timedOut).toBe(true);
    expect(record.cleanExit).toBe(false);
    expect(record.trace.success).toBe(false);
    expect(record.trace.metadata).toMatchObject({ error_kind: "timeout" });
    expect(record.warnings.join("\n")).toContain("no captured steps");
  });

  it("marks a child fatal failed and records the fatal detail", async () => {
    const harness = createHarness({
      journal: journalSource([
        {
          kind: "header",
          trace: {
            sessionId: REQUEST.sessionId,
            startedAt: "2026-08-19T00:00:00.000Z",
            task: REQUEST.task,
            traceId: REQUEST.traceId,
          },
          version: 1,
        },
        { kind: "fatal", message: "escaped subagent rejection", source: "unhandledRejection" },
      ]),
      spawnResult: { exitCode: 1, timedOut: false },
    });

    const record = await runInstrumentedOpenWiki(REQUEST, harness.deps);

    expect(record.trace.success).toBe(false);
    expect(record.trace.metadata).toMatchObject({
      error_kind: "child_fatal",
      fatalSource: "unhandledRejection",
    });
    expect(String(record.trace.metadata.fatalMessage)).toContain(
      "escaped subagent rejection",
    );
  });

  it("survives a missing journal entirely", async () => {
    const harness = createHarness({
      journal: null,
      spawnResult: { exitCode: 1, timedOut: false },
    });

    const record = await runInstrumentedOpenWiki(REQUEST, harness.deps);

    expect(record.trace.success).toBe(false);
    expect(record.cleanExit).toBe(false);
    expect(record.trace.steps).toHaveLength(0);
    expect(record.trace.metadata).toMatchObject({ error_kind: "child_exit" });
    expect(record.persisted).toBe(true);
  });

  it("reports persistence failures without throwing", async () => {
    const harness = createHarness({ saveError: new Error("neo4j down") });

    const record = await runInstrumentedOpenWiki(REQUEST, harness.deps);

    expect(record.persisted).toBe(false);
    expect(record.persistenceError?.message).toBe("neo4j down");
    expect(record.warnings.join("\n")).toContain("was not persisted");
    // The capture log is still written for later replay.
    expect(harness.writtenFiles.has("/out/captures/trace-1.json")).toBe(true);
  });

  it("skips persistence and home isolation when disabled", async () => {
    const harness = createHarness();

    const record = await runInstrumentedOpenWiki(
      { ...REQUEST, ingest: false, isolateHome: false },
      harness.deps,
    );

    expect(record.persisted).toBe(false);
    expect(harness.savedTraces).toHaveLength(0);
    expect(harness.ensuredDirs).not.toContain(
      "/out/captures/trace-1-work/home",
    );
  });

  it("warns when the journal header belongs to a different trace", async () => {
    const harness = createHarness({
      journal: journalSource([
        {
          kind: "header",
          trace: {
            sessionId: "other",
            startedAt: "2026-08-19T00:00:00.000Z",
            task: "other",
            traceId: "someone-else",
          },
          version: 1,
        },
        {
          finish: { completedAt: "2026-08-19T00:00:03.000Z" },
          kind: "finish",
          runResult: { command: "init", model: "m" },
        },
      ]),
    });

    const record = await runInstrumentedOpenWiki(REQUEST, harness.deps);

    expect(record.warnings.join("\n")).toContain("does not match requested trace");
  });
});
