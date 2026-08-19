import { join } from "node:path";
import type {
  OpenWikiRunRecord,
  OpenWikiRunRequest,
} from "../openwiki/openwiki-runner.js";

export type EvaluationArm = "augmented" | "baseline" | "seed";

export interface EvaluationOptions {
  /** Skip the seed phase; the caller asserts memory is already populated. */
  assumeSeeded: boolean;
  command: "init" | "update";
  debug?: boolean;
  isolateHome: boolean;
  keepTemp: boolean;
  modelId?: string;
  /** Root output directory; the run writes under `<outDir>/<runId>/`. */
  outDir: string;
  repoPath: string;
  repository: string;
  runId: string;
  seedRuns: number;
  task: string;
  timeoutMs: number;
  trials: number;
}

export interface AugmentationAttempt {
  augmentedTask: string;
  memoryChars: number;
  recallDurationMs: number;
  recallError?: Error;
}

export interface TrialResult {
  arm: EvaluationArm;
  captureLogPath?: string;
  childExitCode: number | null;
  error?: string;
  memoryChars?: number;
  persisted: boolean;
  recallDurationMs?: number;
  recallFailed?: boolean;
  sessionId: string;
  stepCount: number;
  success: boolean | null;
  timedOut: boolean;
  toolCallCount: number;
  traceId: string;
  trialIndex: number;
  wikiFileCount: number;
  wikiTotalBytes: number;
}

export interface EvaluationSummary {
  results: TrialResult[];
  resultsPath: string;
  runId: string;
}

export interface EvaluationDeps {
  /** Recall through the Aura Agent MCP client (the sole recall path). */
  augment: (task: string, repository: string) => Promise<AugmentationAttempt>;
  copyRepo: (sourceRepo: string, destDir: string) => Promise<void>;
  ensureDir: (dir: string) => Promise<void>;
  log: (message: string) => void;
  removeDir: (dir: string) => Promise<void>;
  runSingle: (request: OpenWikiRunRequest) => Promise<OpenWikiRunRecord>;
  writeFileText: (path: string, content: string) => Promise<void>;
}

interface ScheduledTrial {
  arm: EvaluationArm;
  trialIndex: number;
}

/**
 * Interleaved seed → baseline/augmented schedule. The first arm alternates
 * per round so slow drift (provider load, cache warmth) cancels out instead
 * of favoring whichever arm consistently runs first.
 */
export function buildTrialSchedule(
  seedRuns: number,
  trials: number,
): ScheduledTrial[] {
  const schedule: ScheduledTrial[] = [];
  for (let index = 0; index < seedRuns; index += 1) {
    schedule.push({ arm: "seed", trialIndex: index });
  }
  for (let index = 0; index < trials; index += 1) {
    const round: ScheduledTrial[] =
      index % 2 === 0
        ? [
            { arm: "baseline", trialIndex: index },
            { arm: "augmented", trialIndex: index },
          ]
        : [
            { arm: "augmented", trialIndex: index },
            { arm: "baseline", trialIndex: index },
          ];
    schedule.push(...round);
  }
  return schedule;
}

/**
 * Runs the A/B evaluation: every trial executes on a fresh copy of the
 * target repository, the augmented arm recalls through the Aura Agent
 * before its run (retrying once, then proceeding tagged `recallFailed` so
 * the report can exclude it from arm aggregates), and no trial failure
 * aborts the schedule. Results are mirrored to `<outDir>/<runId>/results.json`
 * so persistence gaps in Neo4j remain visible.
 */
export async function runEvaluation(
  options: EvaluationOptions,
  deps: EvaluationDeps,
): Promise<EvaluationSummary> {
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new RangeError("trials must be a positive integer.");
  }
  if (!Number.isInteger(options.seedRuns) || options.seedRuns < 0) {
    throw new RangeError("seedRuns must be a non-negative integer.");
  }

  const runDir = join(options.outDir, options.runId);
  await deps.ensureDir(runDir);

  const schedule = buildTrialSchedule(
    options.assumeSeeded ? 0 : options.seedRuns,
    options.trials,
  );
  const results: TrialResult[] = [];

  for (const scheduled of schedule) {
    results.push(await runTrial(scheduled, options, deps, runDir));
    // Mirror partial progress after every trial: an interrupted evaluation
    // still leaves an inspectable local record.
    await deps.writeFileText(
      join(runDir, "results.json"),
      JSON.stringify({ options: describeOptions(options), results }, null, 2),
    );
  }

  return {
    results,
    resultsPath: join(runDir, "results.json"),
    runId: options.runId,
  };
}

async function runTrial(
  scheduled: ScheduledTrial,
  options: EvaluationOptions,
  deps: EvaluationDeps,
  runDir: string,
): Promise<TrialResult> {
  const { arm, trialIndex } = scheduled;
  const label = `${arm}-${trialIndex}`;
  const trialDir = join(runDir, label);
  const repoCopy = join(trialDir, "repo");
  const sessionId = `eval:${options.runId}:${arm}:${trialIndex}`;
  const traceId = `eval-${options.runId}-${arm}-${trialIndex}`;

  const result: TrialResult = {
    arm,
    childExitCode: null,
    persisted: false,
    sessionId,
    stepCount: 0,
    success: null,
    timedOut: false,
    toolCallCount: 0,
    traceId,
    trialIndex,
    wikiFileCount: 0,
    wikiTotalBytes: 0,
  };

  try {
    await deps.ensureDir(trialDir);
    deps.log(`[${label}] copying ${options.repoPath} → ${repoCopy}`);
    await deps.copyRepo(options.repoPath, repoCopy);

    const metadata: Record<string, unknown> = {
      arm,
      augmented: arm === "augmented",
      command: options.command,
      evalRunId: options.runId,
      outputMode: "repository",
      trial: trialIndex,
    };
    let userMessage = options.task;

    if (arm === "augmented") {
      const augmentation = await augmentWithRetry(options, deps, label);
      result.memoryChars = augmentation.memoryChars;
      result.recallDurationMs = augmentation.recallDurationMs;
      metadata.memoryChars = augmentation.memoryChars;
      metadata.recallDurationMs = augmentation.recallDurationMs;
      if (augmentation.recallError) {
        // The intervention is absent: run anyway, but tag the trial so the
        // report never counts it inside the augmented arm's aggregates.
        result.recallFailed = true;
        metadata.recallFailed = true;
        deps.log(
          `[${label}] recall failed twice (${augmentation.recallError.message}); running unaugmented and tagging recallFailed`,
        );
      } else {
        userMessage = augmentation.augmentedTask;
      }
    }

    const record = await deps.runSingle({
      captureDir: trialDir,
      command: options.command,
      debug: options.debug,
      ingest: true,
      isolateHome: options.isolateHome,
      metadata,
      modelId: options.modelId,
      repoPath: repoCopy,
      repository: options.repository,
      sessionId,
      task: options.task,
      timeoutMs: options.timeoutMs,
      traceId,
      userMessage,
      workDir: join(trialDir, "work"),
    });

    result.captureLogPath = record.captureLogPath;
    result.childExitCode = record.childExitCode;
    result.persisted = record.persisted;
    result.stepCount = record.trace.steps.length;
    result.success = record.trace.success ?? null;
    result.timedOut = record.timedOut;
    result.toolCallCount = record.trace.steps.reduce(
      (total, step) => total + step.toolCalls.length,
      0,
    );
    result.wikiFileCount = record.wikiStats.fileCount;
    result.wikiTotalBytes = record.wikiStats.totalBytes;
    for (const warning of record.warnings) {
      deps.log(`[${label}] warning: ${warning}`);
    }
    deps.log(
      `[${label}] done: success=${String(result.success)} steps=${result.stepCount} toolCalls=${result.toolCallCount} wikiFiles=${result.wikiFileCount}`,
    );

    const cleanRun = record.childExitCode === 0 && !record.timedOut;
    if (!options.keepTemp && cleanRun) {
      await deps.removeDir(repoCopy);
    }
  } catch (error) {
    // A single broken trial (copy failure, unexpected runner throw) must
    // never abort the remaining schedule.
    result.error = error instanceof Error ? error.message : String(error);
    deps.log(`[${label}] failed: ${result.error}`);
  }

  return result;
}

async function augmentWithRetry(
  options: EvaluationOptions,
  deps: EvaluationDeps,
  label: string,
): Promise<AugmentationAttempt> {
  const first = await deps.augment(options.task, options.repository);
  if (!first.recallError) {
    return first;
  }
  deps.log(
    `[${label}] recall attempt 1 failed (${first.recallError.message}); retrying once`,
  );
  return deps.augment(options.task, options.repository);
}

function describeOptions(
  options: EvaluationOptions,
): Record<string, unknown> {
  return {
    assumeSeeded: options.assumeSeeded,
    command: options.command,
    modelId: options.modelId ?? null,
    repoPath: options.repoPath,
    repository: options.repository,
    runId: options.runId,
    seedRuns: options.seedRuns,
    task: options.task,
    timeoutMs: options.timeoutMs,
    trials: options.trials,
  };
}
