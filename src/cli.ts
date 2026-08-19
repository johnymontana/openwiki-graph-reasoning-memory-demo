#!/usr/bin/env node
import { config as loadEnvironment } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runEvaluation as executeEvaluation,
  type EvaluationOptions,
  type EvaluationSummary,
} from "./eval/evaluate.js";
import {
  buildEvalReport,
  renderEvalReportMarkdown,
} from "./eval/report.js";
import { createTempRepoCopy } from "./eval/temp-repo.js";
import {
  AuraAgentTokenProvider,
  createAuraAgentMcpClientFromEnvironment,
} from "./mcp/aura-agent-client.js";
import type { AuraAgentTokenProviderOptions } from "./mcp/aura-agent-client.js";
import { readCaptureLog, translateCaptureLog } from "./io/capture-log.js";
import {
  augmentOpenWikiTaskWithReasoningMemory,
  type ReasoningMemoryClient,
} from "./integration/memory-context.js";
import {
  createDefaultRunnerDeps,
  runInstrumentedOpenWiki,
  type OpenWikiRunRecord,
  type OpenWikiRunRequest,
} from "./openwiki/openwiki-runner.js";
import { deriveRepositoryId } from "./openwiki/repository-id.js";
import {
  executeChildRun,
  parseChildRunConfig,
} from "./openwiki/runner-child.js";
import { Neo4jReasoningStore } from "./store/neo4j-reasoning-store.js";
import type { ReasoningStore } from "./store/reasoning-store.js";

loadEnvironment({ quiet: true });

const DEFAULT_CAPTURE_FILE = resolve("examples/openwiki-run.json");
const DEMO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_RUN_TIMEOUT_MINUTES = 20;

export interface CliDependencies {
  createMcpClient: () => ReasoningMemoryClient;
  createStore: () => ReasoningStore;
  createTokenProvider: (
    options: AuraAgentTokenProviderOptions,
  ) => Pick<AuraAgentTokenProvider, "getAccessToken">;
  deriveRepository: (repoPath: string) => Promise<string>;
  environment: NodeJS.ProcessEnv;
  runEvaluation: (options: EvaluationOptions) => Promise<EvaluationSummary>;
  runOpenWiki: (request: OpenWikiRunRequest) => Promise<OpenWikiRunRecord>;
  runOpenWikiChild: (configPath: string) => Promise<number>;
}

/* v8 ignore start -- production wiring; every branch is covered through the
   injected CliDependencies used by the test harnesses */
const DEFAULT_DEPENDENCIES: CliDependencies = {
  createMcpClient: () => createAuraAgentMcpClientFromEnvironment(),
  createStore: () => Neo4jReasoningStore.fromEnvironment(),
  createTokenProvider: (options) => new AuraAgentTokenProvider(options),
  deriveRepository: (repoPath) => deriveRepositoryId(repoPath),
  environment: process.env,
  runOpenWiki: async (request) => {
    if (!request.ingest) {
      // The runner never touches the store when ingestion is disabled, so
      // --no-ingest works without any Neo4j configuration.
      return runInstrumentedOpenWiki(
        request,
        createDefaultRunnerDeps({
          demoRoot: DEMO_ROOT,
          store: {
            saveTrace: async () => {
              throw new Error("Ingestion is disabled for this run.");
            },
          },
        }),
      );
    }

    const store = Neo4jReasoningStore.fromEnvironment();
    try {
      await store.ensureSchema();
      return await runInstrumentedOpenWiki(
        request,
        createDefaultRunnerDeps({ demoRoot: DEMO_ROOT, store }),
      );
    } finally {
      await store.close();
    }
  },
  runEvaluation: async (options) => {
    // Preflight before any model spend: recall is MCP-only, so the Aura
    // Agent endpoint must answer tools/list, and the store must be ready.
    // One client and one store are shared across every trial (the token
    // provider caches a single exchange for the whole evaluation).
    const client = createAuraAgentMcpClientFromEnvironment();
    const clientWithDiscovery = client as unknown as {
      listTools?: () => Promise<unknown>;
    };
    if (typeof clientWithDiscovery.listTools === "function") {
      await clientWithDiscovery.listTools();
    }

    const store = Neo4jReasoningStore.fromEnvironment();
    try {
      await store.ensureSchema();
      const runnerDeps = createDefaultRunnerDeps({
        demoRoot: DEMO_ROOT,
        store,
      });
      return await executeEvaluation(options, {
        augment: async (task, repository) => {
          const augmentation = await augmentOpenWikiTaskWithReasoningMemory(
            task,
            client,
            { repository },
          );
          return {
            augmentedTask: augmentation.augmentedTask,
            memoryChars: augmentation.memory?.text.length ?? 0,
            recallDurationMs: augmentation.recallDurationMs,
            recallError: augmentation.recallError,
          };
        },
        copyRepo: (sourceRepo, destDir) =>
          createTempRepoCopy(sourceRepo, destDir),
        ensureDir: async (dir) => {
          await mkdir(dir, { recursive: true });
        },
        log: (message) => {
          console.error(message);
        },
        removeDir: async (dir) => {
          await rm(dir, { force: true, recursive: true });
        },
        runSingle: (request) => runInstrumentedOpenWiki(request, runnerDeps),
        writeFileText: (path, content) => writeFile(path, content, "utf8"),
      });
    } finally {
      await store.close();
    }
  },
  runOpenWikiChild: async (configPath) => {
    const source = await readFile(configPath, "utf8");
    return executeChildRun(parseChildRunConfig(JSON.parse(source)));
  },
};
/* v8 ignore stop */

export async function runCli(
  argv: string[],
  io: Pick<Console, "error" | "log"> = console,
  dependencies: CliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const [command = "help", ...args] = argv;

  switch (command) {
    case "demo": {
      const ingest = args.includes("--ingest");
      const positional = args.filter((argument) => argument !== "--ingest");
      const filePath = resolve(positional[0] ?? DEFAULT_CAPTURE_FILE);
      const trace = translateCaptureLog(await readCaptureLog(filePath));
      io.log(JSON.stringify(trace, null, 2));

      if (ingest) {
        await saveToNeo4j(trace, dependencies);
        io.error(`Ingested reasoning trace ${trace.id}.`);
      }
      return 0;
    }

    case "ingest": {
      const filePath = resolve(args[0] ?? DEFAULT_CAPTURE_FILE);
      const trace = translateCaptureLog(await readCaptureLog(filePath));
      await saveToNeo4j(trace, dependencies);
      io.log(`Ingested reasoning trace ${trace.id}.`);
      return 0;
    }

    case "schema": {
      const store = dependencies.createStore();
      try {
        await store.ensureSchema();
      } finally {
        await store.close();
      }
      io.log("Reasoning-only Neo4j schema is ready.");
      return 0;
    }

    case "query-memory": {
      const question = args.join(" ").trim();
      if (!question) {
        throw new Error("Usage: npm run query-memory -- <question>");
      }
      const result = await dependencies.createMcpClient().queryMemory(question);
      io.log(result.text || JSON.stringify(result.raw, null, 2));
      return 0;
    }

    case "augment-task": {
      const { remaining, value: repository } = extractOption(
        args,
        "--repository",
      );
      const task = remaining.join(" ").trim();
      if (!task) {
        throw new Error(
          "Usage: npm run augment-task -- [--repository <host/owner/repo>] <OpenWiki task>",
        );
      }
      const result = await augmentOpenWikiTaskWithReasoningMemory(
        task,
        dependencies.createMcpClient(),
        { repository },
      );
      if (result.recallError) {
        io.error(
          `Reasoning-memory recall failed open; the task is unaugmented: ${result.recallError.message}`,
        );
      }
      io.log(result.augmentedTask);
      return 0;
    }

    case "mint-token": {
      const clientId = requiredEnv(
        dependencies.environment,
        "AURA_AGENT_MCP_CLIENT_ID",
      );
      const clientSecret = requiredEnv(
        dependencies.environment,
        "AURA_AGENT_MCP_CLIENT_SECRET",
      );
      const token = await dependencies.createTokenProvider({
        clientId,
        clientSecret,
      }).getAccessToken();
      io.error(
        "Sensitive short-lived token follows. Do not commit it; refresh it after expiry.",
      );
      io.log(token);
      return 0;
    }

    case "run": {
      const parsed = parseRunArguments(args);
      const repoPath = resolve(parsed.repo);
      if (parsed.command === "update" && !parsed.task) {
        throw new Error(
          "run --command update requires --task: OpenWiki no-ops an update on a clean tree without one.",
        );
      }

      const repository =
        parsed.repository ?? (await dependencies.deriveRepository(repoPath));
      const task =
        parsed.task?.trim() || `${parsed.command} the OpenWiki for ${repository}`;
      const traceId = randomUUID();
      const sessionId = parsed.session ?? `run:${traceId}`;
      const metadata: Record<string, unknown> = {
        augmented: parsed.augment,
        command: parsed.command,
        outputMode: "repository",
      };

      let userMessage = task;
      if (parsed.augment) {
        const augmentation = await augmentOpenWikiTaskWithReasoningMemory(
          task,
          dependencies.createMcpClient(),
          { repository },
        );
        metadata.memoryChars = augmentation.memory?.text.length ?? 0;
        metadata.recallDurationMs = augmentation.recallDurationMs;
        if (augmentation.recallError) {
          metadata.recallFailed = true;
          io.error(
            `Reasoning-memory recall failed open; running unaugmented: ${augmentation.recallError.message}`,
          );
        } else {
          io.error(
            `Recalled reasoning memory over MCP in ${augmentation.recallDurationMs}ms (${String(metadata.memoryChars)} chars).`,
          );
        }
        userMessage = augmentation.augmentedTask;
      }

      io.error(
        `Running openwiki ${parsed.command} on ${repoPath} (repository ${repository}); the wiki is written to ${join(repoPath, "openwiki")}.`,
      );
      const record = await dependencies.runOpenWiki({
        captureDir: parsed.captureDir,
        command: parsed.command,
        debug: parsed.debug,
        ingest: parsed.ingest,
        isolateHome: parsed.isolateHome,
        metadata,
        modelId: parsed.model,
        repoPath,
        repository,
        sessionId,
        task,
        timeoutMs: parsed.timeoutMinutes * 60_000,
        traceId,
        userMessage,
        workDir: join(parsed.captureDir, `${traceId}-work`),
      });

      for (const warning of record.warnings) {
        io.error(`Warning: ${warning}`);
      }
      const toolCallCount = record.trace.steps.reduce(
        (total, step) => total + step.toolCalls.length,
        0,
      );
      io.log(
        [
          `Trace ${record.trace.id} (${parsed.command} on ${repository})`,
          `  steps: ${record.trace.steps.length}, tool calls: ${toolCallCount}, success: ${String(record.trace.success ?? "unknown")}`,
          `  wiki output: ${record.wikiStats.fileCount} file(s), ${record.wikiStats.totalBytes} bytes`,
          `  persisted to Neo4j: ${record.persisted ? "yes" : "no"}`,
          `  capture log: ${record.captureLogPath}`,
        ].join("\n"),
      );

      return record.cleanExit ? 0 : 1;
    }

    case "openwiki-child": {
      const configPath = args[0];
      if (!configPath) {
        throw new Error("Usage: openwiki-child <child-config.json>");
      }
      return dependencies.runOpenWikiChild(resolve(configPath));
    }

    case "evaluate": {
      const parsed = parseEvaluateArguments(args);
      const repoPath = resolve(parsed.repo ?? DEMO_ROOT);
      const repository =
        parsed.repository ?? (await dependencies.deriveRepository(repoPath));
      const task =
        parsed.task?.trim() || `${parsed.command} the OpenWiki for ${repository}`;
      const runId = parsed.runId ?? generateEvalRunId();
      const totalRuns =
        (parsed.assumeSeeded ? 0 : parsed.seedRuns) + parsed.trials * 2;

      io.error(
        `Evaluation ${runId}: ${totalRuns} real OpenWiki run(s) on ${repoPath} ` +
          `(repository ${repository}). Each run costs real model tokens and minutes; ` +
          "augmented trials also invoke the Aura Agent over MCP.",
      );

      const summary = await dependencies.runEvaluation({
        assumeSeeded: parsed.assumeSeeded,
        command: parsed.command,
        debug: parsed.debug,
        isolateHome: parsed.isolateHome,
        keepTemp: parsed.keepTemp,
        modelId: parsed.model,
        outDir: parsed.outDir,
        repoPath,
        repository,
        runId,
        seedRuns: parsed.seedRuns,
        task,
        timeoutMs: parsed.timeoutMinutes * 60_000,
        trials: parsed.trials,
      });

      const succeeded = summary.results.filter(
        (result) => result.success === true,
      ).length;
      const broken = summary.results.filter(
        (result) => result.error !== undefined || !result.cleanExit,
      );
      io.log(
        [
          `Evaluation ${summary.runId} finished: ${summary.results.length} trial(s), ${succeeded} succeeded, ${broken.length} failed.`,
          `  results: ${summary.resultsPath}`,
          `  report:  npm run report -- --run-id ${summary.runId}`,
        ].join("\n"),
      );
      return broken.length === summary.results.length ? 1 : 0;
    }

    case "report": {
      const runIdOption = extractOption(args, "--run-id");
      const formatOption = extractOption(runIdOption.remaining, "--format");
      const outOption = extractOption(formatOption.remaining, "--out");
      if (outOption.remaining.length > 0) {
        throw new Error(
          `Unknown report argument(s): ${outOption.remaining.join(" ")}`,
        );
      }
      const runId = runIdOption.value;
      if (!runId) {
        throw new Error(
          "Usage: npm run report -- --run-id <id> [--format md|json] [--out <file>]",
        );
      }
      const format = formatOption.value ?? "md";
      if (format !== "md" && format !== "json") {
        throw new Error("--format must be md or json.");
      }

      const store = dependencies.createStore();
      let rows;
      try {
        rows = await store.fetchTraceSummaries(`eval:${runId}:`);
      } finally {
        await store.close();
      }
      if (rows.length === 0) {
        io.error(
          `No traces found for session prefix eval:${runId}: — did the evaluation persist to this database?`,
        );
        return 1;
      }

      const report = buildEvalReport(rows, runId);
      const rendered =
        format === "json"
          ? JSON.stringify(report, null, 2)
          : renderEvalReportMarkdown(report);
      if (outOption.value) {
        await writeFile(resolve(outOption.value), rendered, "utf8");
        io.error(`Report written to ${outOption.value}`);
      }
      io.log(rendered);
      return 0;
    }

    case "help":
    case "--help":
    case "-h":
      io.log(helpText());
      return 0;

    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

async function saveToNeo4j(
  trace: ReturnType<typeof translateCaptureLog>,
  dependencies: CliDependencies,
): Promise<void> {
  const store = dependencies.createStore();
  try {
    await store.ensureSchema();
    await store.saveTrace(trace);
  } finally {
    await store.close();
  }
}

interface RunArguments {
  augment: boolean;
  captureDir: string;
  command: "init" | "update";
  debug: boolean;
  ingest: boolean;
  isolateHome: boolean;
  model?: string;
  repo: string;
  repository?: string;
  session?: string;
  task?: string;
  timeoutMinutes: number;
}

function parseRunArguments(args: string[]): RunArguments {
  let remaining = args;
  const options: Record<string, string | undefined> = {};
  for (const name of [
    "--repo",
    "--command",
    "--task",
    "--repository",
    "--model",
    "--session",
    "--timeout-minutes",
    "--capture-dir",
  ]) {
    const extracted = extractOption(remaining, name);
    options[name] = extracted.value;
    remaining = extracted.remaining;
  }
  const flags: Record<string, boolean> = {};
  for (const name of [
    "--augment",
    "--no-ingest",
    "--no-isolate-home",
    "--debug",
  ]) {
    const extracted = extractFlag(remaining, name);
    flags[name] = extracted.present;
    remaining = extracted.remaining;
  }
  if (remaining.length > 0) {
    throw new Error(`Unknown run argument(s): ${remaining.join(" ")}`);
  }

  const repo = options["--repo"];
  if (!repo) {
    throw new Error(
      "Usage: npm run run -- --repo <path> [--command init|update] [--task <text>] [--augment] " +
        "[--repository <host/owner/repo>] [--model <id>] [--session <id>] " +
        `[--timeout-minutes ${DEFAULT_RUN_TIMEOUT_MINUTES}] [--capture-dir captures] [--no-ingest] [--no-isolate-home] [--debug]`,
    );
  }
  const command = options["--command"] ?? "init";
  if (command !== "init" && command !== "update") {
    throw new Error("--command must be init or update.");
  }
  const timeoutMinutes = options["--timeout-minutes"]
    ? parsePositiveNumber(options["--timeout-minutes"], "--timeout-minutes")
    : DEFAULT_RUN_TIMEOUT_MINUTES;

  return {
    augment: flags["--augment"]!,
    captureDir: options["--capture-dir"] ?? "captures",
    command,
    debug: flags["--debug"]!,
    ingest: !flags["--no-ingest"],
    isolateHome: !flags["--no-isolate-home"],
    model: options["--model"],
    repo,
    repository: options["--repository"],
    session: options["--session"],
    task: options["--task"],
    timeoutMinutes,
  };
}

interface EvaluateArguments {
  assumeSeeded: boolean;
  command: "init" | "update";
  debug: boolean;
  isolateHome: boolean;
  keepTemp: boolean;
  model?: string;
  outDir: string;
  repo?: string;
  repository?: string;
  runId?: string;
  seedRuns: number;
  task?: string;
  timeoutMinutes: number;
  trials: number;
}

function parseEvaluateArguments(args: string[]): EvaluateArguments {
  let remaining = args;
  const options: Record<string, string | undefined> = {};
  for (const name of [
    "--repo",
    "--trials",
    "--seed-runs",
    "--command",
    "--task",
    "--model",
    "--repository",
    "--run-id",
    "--timeout-minutes",
    "--out-dir",
  ]) {
    const extracted = extractOption(remaining, name);
    options[name] = extracted.value;
    remaining = extracted.remaining;
  }
  const flags: Record<string, boolean> = {};
  for (const name of [
    "--keep-temp",
    "--assume-seeded",
    "--no-isolate-home",
    "--debug",
  ]) {
    const extracted = extractFlag(remaining, name);
    flags[name] = extracted.present;
    remaining = extracted.remaining;
  }
  if (remaining.length > 0) {
    throw new Error(`Unknown evaluate argument(s): ${remaining.join(" ")}`);
  }

  const command = options["--command"] ?? "init";
  if (command !== "init" && command !== "update") {
    throw new Error("--command must be init or update.");
  }
  if (command === "update" && !options["--task"]) {
    throw new Error(
      "evaluate --command update requires --task: OpenWiki no-ops an update on a clean tree without one.",
    );
  }
  const runId = options["--run-id"];
  if (runId !== undefined && !/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw new Error(
      "--run-id may only contain letters, digits, dot, underscore, and dash (it becomes part of session ids).",
    );
  }

  return {
    assumeSeeded: flags["--assume-seeded"]!,
    command,
    debug: flags["--debug"]!,
    isolateHome: !flags["--no-isolate-home"],
    keepTemp: flags["--keep-temp"]!,
    model: options["--model"],
    outDir: options["--out-dir"] ?? "eval-runs",
    repo: options["--repo"],
    repository: options["--repository"],
    runId,
    seedRuns: options["--seed-runs"]
      ? parseNonNegativeInteger(options["--seed-runs"], "--seed-runs")
      : 1,
    task: options["--task"],
    timeoutMinutes: options["--timeout-minutes"]
      ? parsePositiveNumber(options["--timeout-minutes"], "--timeout-minutes")
      : DEFAULT_RUN_TIMEOUT_MINUTES,
    trials: options["--trials"]
      ? parsePositiveInteger(options["--trials"], "--trials")
      : 2,
  };
}

function generateEvalRunId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

/** Removes one boolean `--name` flag from an argument list. */
function extractFlag(
  argumentList: string[],
  name: string,
): { present: boolean; remaining: string[] } {
  const index = argumentList.indexOf(name);
  if (index === -1) {
    return { present: false, remaining: argumentList };
  }
  return {
    present: true,
    remaining: [
      ...argumentList.slice(0, index),
      ...argumentList.slice(index + 1),
    ],
  };
}

/** Removes one `--name <value>` pair from an argument list. */
function extractOption(
  argumentList: string[],
  name: string,
): { remaining: string[]; value: string | undefined } {
  const index = argumentList.indexOf(name);
  if (index === -1) {
    return { remaining: argumentList, value: undefined };
  }

  const value = argumentList[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return {
    remaining: [
      ...argumentList.slice(0, index),
      ...argumentList.slice(index + 2),
    ],
    value,
  };
}

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function helpText(): string {
  return [
    "OpenWiki reasoning-memory POC",
    "",
    "  npm run demo -- [capture.json] [--ingest]",
    "  npm run ingest -- [capture.json]",
    "  npm run schema",
    "  npm run query-memory -- <question>",
    "  npm run augment-task -- [--repository <host/owner/repo>] <OpenWiki task>",
    "  npm run run -- --repo <path> [--command init|update] [--task <text>] [--augment]",
    "                 [--repository <id>] [--model <id>] [--session <id>]",
    "                 [--timeout-minutes 20] [--capture-dir captures]",
    "                 [--no-ingest] [--no-isolate-home] [--debug]",
    "      Runs an instrumented OpenWiki run from the built fork (OPENWIKI_DIR)",
    "      and persists the reasoning trace. Costs real model tokens.",
    "  npm run evaluate -- [--repo <path>] [--trials 2] [--seed-runs 1]",
    "                 [--command init|update] [--task <text>] [--model <id>]",
    "                 [--repository <id>] [--run-id <id>] [--timeout-minutes 20]",
    "                 [--out-dir eval-runs] [--keep-temp] [--assume-seeded]",
    "                 [--no-isolate-home] [--debug]",
    "      A/B evaluation: seed runs, then interleaved baseline/augmented",
    "      trials on fresh temp copies. Performs seed-runs + 2*trials REAL",
    "      OpenWiki runs (default 5) — real model cost and minutes per run.",
    "      Recall goes through the Aura Agent MCP endpoint.",
    "  npm run report -- --run-id <id> [--format md|json] [--out <file>]",
    "  npx tsx src/cli.ts mint-token",
  ].join("\n");
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
