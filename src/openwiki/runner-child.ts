import { isAbsolute } from "node:path";
import {
  importOpenWikiAgentModule,
  type OpenWikiAgentModule,
} from "./agent-module.js";
import {
  appendJournalLine,
  type JournalTraceOptions,
  type RunJournalLine,
} from "./run-journal.js";

/** Configuration handed to the child process as a JSON file. */
export interface ChildRunConfig {
  agentEntry: string;
  command: "init" | "update";
  /** Absolute path of the repository the run documents. */
  cwd: string;
  debug?: boolean;
  journalPath: string;
  modelId?: string;
  threadId?: string;
  trace: JournalTraceOptions;
  userMessage: string | null;
}

export interface ChildRunDeps {
  appendLine: (filePath: string, line: RunJournalLine) => void;
  importAgent: (agentEntry: string) => Promise<OpenWikiAgentModule>;
  /**
   * Registers process-level fatal handlers. OpenWiki's own crash guard calls
   * process.exit and is CLI-only; the child installs its own so an escaped
   * subagent rejection is journaled before the process dies.
   */
  installFatalHandlers: (
    onFatal: (source: string, error: unknown) => void,
  ) => void;
  now: () => string;
  stderr: (message: string) => void;
}

export interface FatalProcessLike {
  exit(code?: number): void;
  once(event: "uncaughtException" | "unhandledRejection", listener: (value: unknown) => void): unknown;
}

/**
 * Registers the child's own fatal handlers. OpenWiki's exported crash guard
 * calls process.exit without journaling; this one records the fatal first.
 */
export function installProcessFatalHandlers(
  onFatal: (source: string, error: unknown) => void,
  processLike: FatalProcessLike = process,
): void {
  processLike.once("uncaughtException", (error) => {
    onFatal("uncaughtException", error);
    processLike.exit(1);
  });
  processLike.once("unhandledRejection", (reason) => {
    onFatal("unhandledRejection", reason);
    processLike.exit(1);
  });
}

const DEFAULT_DEPS: ChildRunDeps = {
  appendLine: appendJournalLine,
  importAgent: importOpenWikiAgentModule,
  installFatalHandlers: installProcessFatalHandlers,
  now: () => new Date().toISOString(),
  /* v8 ignore next 3 -- direct stderr write, exercised only in live runs */
  stderr: (message) => {
    process.stderr.write(`${message}\n`);
  },
};

/**
 * Runs one instrumented OpenWiki invocation inside the child process,
 * streaming capture entries to the crash-safe journal. Every exit path —
 * clean finish, thrown run error, import failure, or process-level fatal —
 * leaves a parseable journal for the parent to recover.
 */
export async function executeChildRun(
  config: ChildRunConfig,
  partialDeps: Partial<ChildRunDeps> = {},
): Promise<number> {
  const deps: ChildRunDeps = { ...DEFAULT_DEPS, ...partialDeps };
  // The header goes first so even an import-time crash yields a journal.
  deps.appendLine(config.journalPath, {
    kind: "header",
    trace: config.trace,
    version: 1,
  });
  deps.installFatalHandlers((source, error) => {
    try {
      deps.appendLine(config.journalPath, {
        kind: "fatal",
        message: describeError(error),
        source,
      });
    } catch {
      // The journal itself is unwritable; nothing further can be recorded.
    }
  });

  let agentModule: OpenWikiAgentModule;
  try {
    agentModule = await deps.importAgent(config.agentEntry);
  } catch (error) {
    deps.appendLine(config.journalPath, {
      kind: "fatal",
      message: describeError(error),
      source: "import",
    });
    return 1;
  }

  const journalRawChunk = (chunk: unknown): void => {
    try {
      deps.appendLine(config.journalPath, {
        at: deps.now(),
        chunk,
        kind: "raw_chunk",
      });
    } catch {
      // Never let capture serialization failures reach the OpenWiki run.
      if (config.debug) {
        deps.stderr("reasoning-capture: dropped an unserializable raw chunk");
      }
    }
  };
  const journalPlanSnapshot = (plan: string): void => {
    try {
      deps.appendLine(config.journalPath, {
        at: deps.now(),
        kind: "plan_snapshot",
        plan,
      });
    } catch {
      if (config.debug) {
        deps.stderr("reasoning-capture: dropped a plan snapshot");
      }
    }
  };

  try {
    const result = await agentModule.runOpenWikiAgent(
      config.command,
      config.cwd,
      {
        debug: config.debug,
        modelId: config.modelId ?? null,
        // Raw chunks already carry all observable text and tool events;
        // onEvent is wired for debug visibility only, never for capture.
        onEvent: config.debug
          ? (event) => {
              deps.stderr(`openwiki-event ${safePreview(event)}`);
            }
          : undefined,
        onPlanSnapshot: journalPlanSnapshot,
        onRawStreamChunk: journalRawChunk,
        outputMode: "repository",
        threadId: config.threadId,
        userMessage: config.userMessage,
      },
    );

    // runOpenWikiAgent resolving IS the run succeeding — record that direct
    // knowledge explicitly rather than leaving success to be derived from
    // tool statuses (individual tool errors are normal in successful runs).
    deps.appendLine(config.journalPath, {
      finish: { completedAt: deps.now(), success: true },
      kind: "finish",
      runResult: {
        command: result.command,
        model: result.model,
        ...(result.skipped ? { skipped: true } : {}),
      },
    });
    return 0;
  } catch (error) {
    deps.appendLine(config.journalPath, {
      kind: "fatal",
      message: describeError(error),
      source: "run",
    });
    return 1;
  }
}

/** Validates the child-config JSON the parent wrote. */
export function parseChildRunConfig(value: unknown): ChildRunConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Child run config must be a JSON object.");
  }
  const record = value as Record<string, unknown>;

  for (const key of ["agentEntry", "cwd", "journalPath"] as const) {
    if (typeof record[key] !== "string" || !record[key]) {
      throw new Error(`Child run config requires a ${key} string.`);
    }
  }
  if (record.command !== "init" && record.command !== "update") {
    throw new Error("Child run config command must be init or update.");
  }
  if (!isAbsolute(record.cwd as string)) {
    throw new Error("Child run config cwd must be an absolute path.");
  }
  if (record.userMessage !== null && typeof record.userMessage !== "string") {
    throw new Error("Child run config userMessage must be a string or null.");
  }
  const trace = record.trace;
  if (trace === null || typeof trace !== "object" || Array.isArray(trace)) {
    throw new Error("Child run config requires a trace object.");
  }
  const traceRecord = trace as Record<string, unknown>;
  for (const key of ["sessionId", "startedAt", "task", "traceId"] as const) {
    if (typeof traceRecord[key] !== "string" || !traceRecord[key]) {
      throw new Error(`Child run config requires trace.${key}.`);
    }
  }

  return record as unknown as ChildRunConfig;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function safePreview(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 500) ?? String(value);
  } catch {
    return "[unserializable event]";
  }
}
