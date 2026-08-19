import type { TraceSummaryRow } from "../store/reasoning-store.js";
import type { EvaluationArm } from "./evaluate.js";

export interface EvalTrialRow {
  arm: EvaluationArm | "unknown";
  cancelledToolCalls: number;
  durationMs: number | null;
  memoryChars: number | null;
  model: string | null;
  recallDurationMs: number | null;
  recallFailed: boolean;
  sessionId: string;
  steps: number;
  success: boolean | null;
  task: string;
  timedOut: boolean;
  toolCalls: number;
  traceId: string;
  trialIndex: number | null;
  failedToolCalls: number;
  wikiFileCount: number | null;
  wikiTotalBytes: number | null;
}

export interface ArmAggregate {
  arm: EvaluationArm;
  cancelledToolCalls: number;
  durationMeanMs: number | null;
  durationMedianMs: number | null;
  durationStdDevMs: number | null;
  failedToolCalls: number;
  meanMemoryChars: number | null;
  meanRecallDurationMs: number | null;
  meanSteps: number | null;
  meanToolCalls: number | null;
  meanWikiBytes: number | null;
  meanWikiFiles: number | null;
  runs: number;
  succeededRuns: number;
  timedOutRuns: number;
}

export interface EvalReport {
  arms: ArmAggregate[];
  /** Augmented trials whose recall failed: listed, never aggregated. */
  excludedRecallFailures: EvalTrialRow[];
  runId: string;
  trials: EvalTrialRow[];
}

/** Parses trace summaries (metadata JSON included) into an A/B report. */
export function buildEvalReport(
  rows: TraceSummaryRow[],
  runId: string,
): EvalReport {
  const trials = rows.map(toTrialRow);
  const excludedRecallFailures = trials.filter(
    (trial) => trial.arm === "augmented" && trial.recallFailed,
  );

  const arms: ArmAggregate[] = [];
  for (const arm of ["seed", "baseline", "augmented"] as const) {
    const armTrials = trials.filter(
      (trial) =>
        trial.arm === arm && !(arm === "augmented" && trial.recallFailed),
    );
    if (armTrials.length > 0) {
      arms.push(aggregateArm(arm, armTrials));
    }
  }

  return { arms, excludedRecallFailures, runId, trials };
}

export function renderEvalReportMarkdown(report: EvalReport): string {
  const lines: string[] = [
    `# Recall evaluation ${report.runId}`,
    "",
    `Traces analyzed: ${report.trials.length} (aggregates exclude ${report.excludedRecallFailures.length} recall-failed augmented trial(s)).`,
    "",
    "## Arms",
    "",
    "| arm | runs | succeeded | timed out | duration ms (mean ± sd / median) | steps | tool calls | failed calls | cancelled calls | wiki files | wiki KB | recall ms | memory chars |",
    "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of report.arms) {
    lines.push(
      `| ${arm.arm} | ${arm.runs} | ${arm.succeededRuns} | ${arm.timedOutRuns} | ${formatDuration(arm)} | ${formatNumber(arm.meanSteps)} | ${formatNumber(arm.meanToolCalls)} | ${arm.failedToolCalls} | ${arm.cancelledToolCalls} | ${formatNumber(arm.meanWikiFiles)} | ${formatKilobytes(arm.meanWikiBytes)} | ${formatNumber(arm.meanRecallDurationMs)} | ${formatNumber(arm.meanMemoryChars)} |`,
    );
  }

  lines.push(
    "",
    "## Trials",
    "",
    "| session | arm | success | timed out | steps | tool calls | failed | cancelled | duration ms | wiki files | recall failed |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const trial of report.trials) {
    lines.push(
      `| ${trial.sessionId} | ${trial.arm} | ${String(trial.success)} | ${trial.timedOut ? "yes" : "no"} | ${trial.steps} | ${trial.toolCalls} | ${trial.failedToolCalls} | ${trial.cancelledToolCalls} | ${trial.durationMs ?? "—"} | ${trial.wikiFileCount ?? "—"} | ${trial.recallFailed ? "yes" : "no"} |`,
    );
  }

  lines.push(
    "",
    "## Methodology and limits",
    "",
    "- Small N with LLM nondeterminism dominating variance: differences here are indicative, not statistically significant.",
    "- The workload (repeated runs against the same repository) is recall's best case; results do not generalize to cross-repository memory.",
    "- Wiki size is an output-volume signal, not a quality judgment; derived `success` reflects observed tool evidence only.",
    "- Later augmented trials can also recall traces persisted by earlier trials in this run — realistic memory accumulation, stated rather than controlled.",
    "- Augmented trials whose recall failed are listed above but excluded from arm aggregates: they received no intervention.",
    "- This experiment can support or refute \"recall changes efficiency metrics on repeat runs of the same repo\", not \"memory makes agents better\" in general.",
    "",
  );

  return lines.join("\n");
}

function toTrialRow(row: TraceSummaryRow): EvalTrialRow {
  const metadata = parseMetadata(row.metadataJson);
  const arm = readArm(metadata, row.sessionId);
  return {
    arm,
    cancelledToolCalls: row.cancelledToolCalls,
    durationMs: readNumber(metadata.durationMs),
    failedToolCalls: row.failedToolCalls,
    memoryChars: readNumber(metadata.memoryChars),
    model: typeof metadata.model === "string" ? metadata.model : null,
    recallDurationMs: readNumber(metadata.recallDurationMs),
    recallFailed: metadata.recallFailed === true,
    sessionId: row.sessionId,
    steps: row.steps,
    success: row.success,
    task: row.task,
    timedOut: metadata.timedOut === true,
    toolCalls: row.toolCalls,
    traceId: row.id,
    trialIndex: readNumber(metadata.trial),
    wikiFileCount: readNumber(metadata.wikiFileCount),
    wikiTotalBytes: readNumber(metadata.wikiTotalBytes),
  };
}

function aggregateArm(
  arm: EvaluationArm,
  trials: EvalTrialRow[],
): ArmAggregate {
  const durations = trials
    .map((trial) => trial.durationMs)
    .filter((value): value is number => value !== null);

  return {
    arm,
    cancelledToolCalls: sum(trials.map((trial) => trial.cancelledToolCalls)),
    durationMeanMs: mean(durations),
    durationMedianMs: median(durations),
    durationStdDevMs: standardDeviation(durations),
    failedToolCalls: sum(trials.map((trial) => trial.failedToolCalls)),
    meanMemoryChars: mean(collect(trials, "memoryChars")),
    meanRecallDurationMs: mean(collect(trials, "recallDurationMs")),
    meanSteps: mean(trials.map((trial) => trial.steps)),
    meanToolCalls: mean(trials.map((trial) => trial.toolCalls)),
    meanWikiBytes: mean(collect(trials, "wikiTotalBytes")),
    meanWikiFiles: mean(collect(trials, "wikiFileCount")),
    runs: trials.length,
    succeededRuns: trials.filter((trial) => trial.success === true).length,
    timedOutRuns: trials.filter((trial) => trial.timedOut).length,
  };
}

function parseMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readArm(
  metadata: Record<string, unknown>,
  sessionId: string,
): EvalTrialRow["arm"] {
  const fromMetadata = metadata.arm;
  if (
    fromMetadata === "augmented" ||
    fromMetadata === "baseline" ||
    fromMetadata === "seed"
  ) {
    return fromMetadata;
  }
  // Fallback: the session-id convention eval:<runId>:<arm>:<trial>.
  const armSegment = sessionId.split(":").at(-2);
  return armSegment === "augmented" ||
    armSegment === "baseline" ||
    armSegment === "seed"
    ? armSegment
    : "unknown";
}

function collect(
  trials: EvalTrialRow[],
  key: "memoryChars" | "recallDurationMs" | "wikiFileCount" | "wikiTotalBytes",
): number[] {
  return trials
    .map((trial) => trial[key])
    .filter((value): value is number => value !== null);
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const average = mean(values)!;
  const variance =
    sum(values.map((value) => (value - average) ** 2)) / (values.length - 1);
  return Math.sqrt(variance);
}

function formatDuration(arm: ArmAggregate): string {
  if (arm.durationMeanMs === null) {
    return "—";
  }
  const deviation =
    arm.durationStdDevMs === null ? "" : ` ± ${Math.round(arm.durationStdDevMs)}`;
  return `${Math.round(arm.durationMeanMs)}${deviation} / ${Math.round(arm.durationMedianMs ?? arm.durationMeanMs)}`;
}

function formatNumber(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatKilobytes(bytes: number | null): string {
  return bytes === null ? "—" : (bytes / 1024).toFixed(1);
}
