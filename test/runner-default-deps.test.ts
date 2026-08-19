import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { ReasoningTrace } from "../src/domain/types.js";
import { createDefaultRunnerDeps } from "../src/openwiki/openwiki-runner.js";
import {
  executeChildRun,
  installProcessFatalHandlers,
  type ChildRunConfig,
  type FatalProcessLike,
} from "../src/openwiki/runner-child.js";
import type { RunJournalLine } from "../src/openwiki/run-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("createDefaultRunnerDeps", () => {
  it("wires real filesystem probes, the fork locator, and the store", async () => {
    const root = await createTempDir("runner-deps-");
    const forkDir = join(root, "openwiki");
    await mkdir(join(forkDir, "dist", "agent"), { recursive: true });
    await writeFile(join(forkDir, "package.json"), "{}");
    await writeFile(
      join(forkDir, "dist", "agent", "index.js"),
      "// options.onRawStreamChunk hook present",
    );
    const demoRoot = join(root, "demo");
    await mkdir(demoRoot, { recursive: true });

    const saveTrace = vi.fn(async (_trace: ReasoningTrace) => undefined);
    const deps = createDefaultRunnerDeps({
      demoRoot,
      environment: { ANTHROPIC_API_KEY: "key" },
      store: { saveTrace },
    });

    const fork = await deps.locateFork();
    expect(fork.agentEntry).toBe(join(forkDir, "dist", "agent", "index.js"));

    const scratch = join(root, "scratch", "nested");
    await deps.ensureDir(scratch);
    await deps.writeFileText(join(scratch, "file.txt"), "content");
    await expect(deps.readFileText(join(scratch, "file.txt"))).resolves.toBe(
      "content",
    );
    await expect(deps.readFileText(join(scratch, "missing.txt"))).resolves.toBeNull();

    await deps.saveTrace({} as ReasoningTrace);
    expect(saveTrace).toHaveBeenCalledOnce();
    expect(deps.clock()).toBeInstanceOf(Date);
    await expect(deps.scanWiki(join(scratch, "missing"))).resolves.toEqual({
      fileCount: 0,
      totalBytes: 0,
    });
  });
});

describe("installProcessFatalHandlers", () => {
  it("journals and exits on both fatal event kinds", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const exit = vi.fn();
    const processLike: FatalProcessLike = {
      exit,
      once: (event, listener) => listeners.set(event, listener),
    };
    const fatals: Array<{ error: unknown; source: string }> = [];

    installProcessFatalHandlers((source, error) => {
      fatals.push({ error, source });
    }, processLike);
    listeners.get("uncaughtException")!(new Error("boom"));
    listeners.get("unhandledRejection")!("reason");

    expect(fatals.map((fatal) => fatal.source)).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("executeChildRun default merging", () => {
  it("fills unspecified dependencies with working defaults", async () => {
    const directory = await createTempDir("child-defaults-");
    const journalPath = join(directory, "journal.jsonl");
    const config: ChildRunConfig = {
      agentEntry: "/unused/dist/agent/index.js",
      command: "init",
      cwd: "/repos/target",
      journalPath,
      trace: {
        sessionId: "session-1",
        startedAt: "2026-08-19T00:00:00.000Z",
        task: "init",
        traceId: "trace-defaults",
      },
      userMessage: null,
    };
    const lines: RunJournalLine[] = [];

    // appendLine and now come from the defaults except where overridden;
    // importAgent and installFatalHandlers are stubbed to stay in-process.
    const exitCode = await executeChildRun(config, {
      appendLine: (_path, line) => {
        lines.push(line);
      },
      importAgent: async () => ({
        runOpenWikiAgent: async (command, _cwd, options) => {
          await options.onPlanSnapshot?.("- plan");
          return { command, model: "fixture" };
        },
      }),
      installFatalHandlers: () => undefined,
    });

    expect(exitCode).toBe(0);
    const plan = lines.find((line) => line.kind === "plan_snapshot") as
      | { at?: string; kind: "plan_snapshot"; plan: string }
      | undefined;
    // The default clock stamped the entry with a parseable ISO timestamp.
    expect(Number.isFinite(Date.parse(String(plan?.at)))).toBe(true);
  });
});
