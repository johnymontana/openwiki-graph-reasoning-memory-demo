import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReasoningTrace } from "../domain/types.js";
import {
  translateCaptureLog,
  type OpenWikiCaptureLog,
} from "../io/capture-log.js";
import type { ReasoningStore } from "../store/reasoning-store.js";
import {
  assertReasoningHooksPresent,
  resolveOpenWikiFork,
  type OpenWikiForkLocation,
} from "./fork-locator.js";
import { buildOpenWikiChildEnv } from "./child-env.js";
import { parseRunJournal, type JournalRunResult } from "./run-journal.js";
import type { ChildRunConfig } from "./runner-child.js";
import { scanWikiOutput, type WikiOutputStats } from "./wiki-stats.js";

export interface OpenWikiRunRequest {
  /** Directory receiving the replayable capture log. */
  captureDir: string;
  command: "init" | "update";
  debug?: boolean;
  /** Persist the trace to Neo4j; the capture log is written regardless. */
  ingest: boolean;
  /** Give the child an isolated HOME so ~/.openwiki/.env cannot leak in. */
  isolateHome: boolean;
  maxSerializedInputChars?: number;
  metadata: Record<string, unknown>;
  modelId?: string;
  /** Absolute path of the repository to document (run writes openwiki/). */
  repoPath: string;
  repository: string;
  sessionId: string;
  task: string;
  timeoutMs: number;
  traceId: string;
  /** What OpenWiki actually receives; the trace task stays the base task. */
  userMessage: string | null;
  /** Scratch directory for the child config, journal, log, isolated home. */
  workDir: string;
}

export interface OpenWikiRunRecord {
  captureLogPath: string;
  childExitCode: number | null;
  persisted: boolean;
  persistenceError?: Error;
  runResult?: JournalRunResult;
  timedOut: boolean;
  trace: ReasoningTrace;
  warnings: string[];
  wikiStats: WikiOutputStats;
}

export interface SpawnChildResult {
  exitCode: number | null;
  timedOut: boolean;
}

export interface OpenWikiRunnerDeps {
  clock: () => Date;
  ensureDir: (dir: string) => Promise<void>;
  environment: NodeJS.ProcessEnv;
  locateFork: () => Promise<OpenWikiForkLocation>;
  readFileText: (path: string) => Promise<string | null>;
  saveTrace: (trace: ReasoningTrace) => Promise<void>;
  scanWiki: (dir: string) => Promise<WikiOutputStats>;
  spawnChild: (
    configPath: string,
    environment: NodeJS.ProcessEnv,
    logPath: string,
    timeoutMs: number,
  ) => Promise<SpawnChildResult>;
  writeFileText: (path: string, content: string) => Promise<void>;
}

export function createDefaultRunnerDeps(options: {
  demoRoot: string;
  environment?: NodeJS.ProcessEnv;
  store: Pick<ReasoningStore, "saveTrace">;
}): OpenWikiRunnerDeps {
  const environment = options.environment ?? process.env;
  return {
    clock: () => new Date(),
    ensureDir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    environment,
    locateFork: async () => {
      const fork = await resolveOpenWikiFork(environment, options.demoRoot);
      await assertReasoningHooksPresent(fork.agentEntry);
      return fork;
    },
    readFileText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    saveTrace: (trace) => options.store.saveTrace(trace),
    scanWiki: scanWikiOutput,
    spawnChild: spawnOpenWikiChild,
    writeFileText: (path, content) => writeFile(path, content, "utf8"),
  };
}

/**
 * Runs one instrumented OpenWiki invocation in a child process and recovers
 * its journal into a persisted reasoning trace plus a replayable capture log.
 *
 * The child boundary is deliberate: it gives a hard timeout over a possibly
 * hung LangGraph stream, contains OpenWiki's known escaped-subagent-rejection
 * failure mode, and isolates the run's environment. Every failure shape —
 * crash, timeout, empty journal — still produces a `success: false` trace,
 * and persistence failures are reported, never thrown (the write path stays
 * fail-open end to end).
 */
export async function runInstrumentedOpenWiki(
  request: OpenWikiRunRequest,
  deps: OpenWikiRunnerDeps,
): Promise<OpenWikiRunRecord> {
  const fork = await deps.locateFork();
  await deps.ensureDir(request.workDir);
  await deps.ensureDir(request.captureDir);
  const isolatedHomeDir = request.isolateHome
    ? join(request.workDir, "home")
    : undefined;
  if (isolatedHomeDir) {
    await deps.ensureDir(isolatedHomeDir);
  }

  const journalPath = join(request.workDir, "journal.jsonl");
  const configPath = join(request.workDir, "child-config.json");
  const childLogPath = join(request.workDir, "child.log");
  const childConfig: ChildRunConfig = {
    agentEntry: fork.agentEntry,
    command: request.command,
    cwd: request.repoPath,
    debug: request.debug,
    journalPath,
    modelId: request.modelId,
    trace: {
      maxSerializedInputChars: request.maxSerializedInputChars,
      metadata: request.metadata,
      repository: request.repository,
      sessionId: request.sessionId,
      startedAt: deps.clock().toISOString(),
      task: request.task,
      traceId: request.traceId,
    },
    userMessage: request.userMessage,
  };
  await deps.writeFileText(configPath, JSON.stringify(childConfig, null, 2));

  const childEnvironment = buildOpenWikiChildEnv(deps.environment, {
    isolatedHomeDir,
    modelId: request.modelId,
  });
  const { exitCode, timedOut } = await deps.spawnChild(
    configPath,
    childEnvironment,
    childLogPath,
    request.timeoutMs,
  );

  const journal = parseRunJournal(
    (await deps.readFileText(journalPath)) ?? "",
  );
  const wikiStats = await deps.scanWiki(join(request.repoPath, "openwiki"));
  const completedAtFallback = deps.clock().toISOString();

  const warnings: string[] = [];
  if (journal.header && journal.header.traceId !== request.traceId) {
    warnings.push(
      `Journal header trace ${journal.header.traceId} does not match requested trace ${request.traceId}.`,
    );
  }
  if (journal.ignoredLineCount > 0) {
    warnings.push(
      `${journal.ignoredLineCount} journal line(s) were unparseable (truncated write or unknown kind).`,
    );
  }

  const cleanExit =
    exitCode === 0 &&
    !timedOut &&
    journal.finish !== undefined &&
    journal.fatal === undefined;
  const errorKind = timedOut
    ? "timeout"
    : journal.fatal
      ? "child_fatal"
      : cleanExit
        ? undefined
        : "child_exit";

  const captureLog: OpenWikiCaptureLog = {
    entries: journal.entries,
    finish: {
      completedAt: journal.finish?.completedAt ?? completedAtFallback,
      ...(cleanExit
        ? journal.finish?.success !== undefined
          ? { success: journal.finish.success }
          : {}
        : { success: false }),
    },
    trace: {
      ...childConfig.trace,
      metadata: {
        ...request.metadata,
        childExitCode: exitCode,
        command: request.command,
        ...(journal.runResult?.model ? { model: journal.runResult.model } : {}),
        ...(journal.runResult?.skipped ? { skipped: true } : {}),
        timedOut,
        wikiFileCount: wikiStats.fileCount,
        wikiTotalBytes: wikiStats.totalBytes,
        ...(errorKind ? { error_kind: errorKind } : {}),
        ...(journal.fatal
          ? {
              fatalMessage: journal.fatal.message.slice(0, 500),
              fatalSource: journal.fatal.source,
            }
          : {}),
      },
    },
  };

  const trace = translateCaptureLog(captureLog);
  if (trace.steps.length === 0) {
    warnings.push(
      "The trace has no captured steps — verify the fork's reasoning hooks and see the child log.",
    );
  }

  let persisted = false;
  let persistenceError: Error | undefined;
  if (request.ingest) {
    try {
      await deps.saveTrace(trace);
      persisted = true;
    } catch (error) {
      persistenceError =
        error instanceof Error ? error : new Error(String(error));
      warnings.push(
        `The reasoning trace was not persisted: ${persistenceError.message}`,
      );
    }
  }

  const captureLogPath = join(request.captureDir, `${request.traceId}.json`);
  await deps.writeFileText(
    captureLogPath,
    JSON.stringify(captureLog, null, 2),
  );

  return {
    captureLogPath,
    childExitCode: exitCode,
    persisted,
    persistenceError,
    runResult: journal.runResult,
    timedOut,
    trace,
    warnings,
    wikiStats,
  };
}

const CHILD_KILL_GRACE_MS = 10_000;

/**
 * Computes the node arguments for the child spawn. Node arguments are
 * propagated so a tsx-launched parent re-creates the tsx loader; when the
 * entry is a .ts file with no loader in execArgv, tsx is added explicitly.
 */
export function buildChildNodeArguments(
  entry: string,
  execArgv: readonly string[],
): string[] {
  const nodeArguments = [...execArgv];
  if (
    entry.endsWith(".ts") &&
    !nodeArguments.some((argument) => argument.includes("tsx"))
  ) {
    nodeArguments.push("--import", "tsx");
  }
  return nodeArguments;
}

/* v8 ignore start -- real process spawning; exercised by live smoke runs */
/** Spawns the demo CLI back into itself as `openwiki-child`. */
export async function spawnOpenWikiChild(
  configPath: string,
  environment: NodeJS.ProcessEnv,
  logPath: string,
  timeoutMs: number,
): Promise<SpawnChildResult> {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot determine the CLI entry point for the child run.");
  }
  const nodeArguments = buildChildNodeArguments(entry, process.execArgv);

  const logDescriptor = openSync(logPath, "a");
  try {
    const child = spawn(
      process.execPath,
      [...nodeArguments, entry, "openwiki-child", configPath],
      {
        env: environment as Record<string, string>,
        stdio: ["ignore", logDescriptor, logDescriptor],
      },
    );

    return await new Promise<SpawnChildResult>((resolveSpawn, rejectSpawn) => {
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const termTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, CHILD_KILL_GRACE_MS);
      }, timeoutMs);

      child.once("error", (error) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        rejectSpawn(error);
      });
      child.once("exit", (code) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolveSpawn({ exitCode: code, timedOut });
      });
    });
  } finally {
    closeSync(logDescriptor);
  }
}
/* v8 ignore stop */
