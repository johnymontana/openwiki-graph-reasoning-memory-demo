import { describe, expect, it } from "vitest";
import {
  buildEvalReport,
  renderEvalReportMarkdown,
} from "../src/eval/report.js";
import type { TraceSummaryRow } from "../src/store/reasoning-store.js";

function summaryRow(overrides: Partial<TraceSummaryRow>): TraceSummaryRow {
  return {
    cancelledToolCalls: 0,
    completedAt: "2026-08-19T00:05:00.000Z",
    failedToolCalls: 0,
    id: "trace",
    metadataJson: null,
    repository: "github.com/example/demo-repo",
    sessionId: "eval:run1:baseline:0",
    startedAt: "2026-08-19T00:00:00.000Z",
    steps: 4,
    success: true,
    task: "init the OpenWiki",
    toolCalls: 6,
    ...overrides,
  };
}

function metadata(values: Record<string, unknown>): string {
  return JSON.stringify(values);
}

const ROWS: TraceSummaryRow[] = [
  summaryRow({
    id: "seed-0",
    metadataJson: metadata({ arm: "seed", durationMs: 90_000, trial: 0, wikiFileCount: 3, wikiTotalBytes: 3_072 }),
    sessionId: "eval:run1:seed:0",
  }),
  summaryRow({
    id: "baseline-0",
    metadataJson: metadata({ arm: "baseline", durationMs: 80_000, trial: 0, wikiFileCount: 3, wikiTotalBytes: 2_048 }),
    sessionId: "eval:run1:baseline:0",
    steps: 6,
    toolCalls: 9,
  }),
  summaryRow({
    id: "baseline-1",
    failedToolCalls: 1,
    metadataJson: metadata({ arm: "baseline", durationMs: 100_000, timedOut: false, trial: 1, wikiFileCount: 4, wikiTotalBytes: 4_096 }),
    sessionId: "eval:run1:baseline:1",
    steps: 8,
    success: false,
    toolCalls: 11,
  }),
  summaryRow({
    id: "augmented-0",
    metadataJson: metadata({ arm: "augmented", durationMs: 60_000, memoryChars: 900, recallDurationMs: 1_500, trial: 0, wikiFileCount: 3, wikiTotalBytes: 2_560 }),
    sessionId: "eval:run1:augmented:0",
    steps: 5,
    toolCalls: 7,
  }),
  summaryRow({
    id: "augmented-1",
    metadataJson: metadata({ arm: "augmented", durationMs: 70_000, memoryChars: 0, recallFailed: true, trial: 1 }),
    sessionId: "eval:run1:augmented:1",
  }),
];

describe("buildEvalReport", () => {
  it("aggregates per arm and excludes recall-failed augmented trials", () => {
    const report = buildEvalReport(ROWS, "run1");

    expect(report.trials).toHaveLength(5);
    expect(report.excludedRecallFailures.map((trial) => trial.traceId)).toEqual([
      "augmented-1",
    ]);

    const baseline = report.arms.find((arm) => arm.arm === "baseline")!;
    expect(baseline.runs).toBe(2);
    expect(baseline.succeededRuns).toBe(1);
    expect(baseline.durationMeanMs).toBe(90_000);
    expect(baseline.durationMedianMs).toBe(90_000);
    expect(baseline.durationStdDevMs).toBeCloseTo(14_142.13, 1);
    expect(baseline.meanSteps).toBe(7);
    expect(baseline.failedToolCalls).toBe(1);

    const augmented = report.arms.find((arm) => arm.arm === "augmented")!;
    expect(augmented.runs).toBe(1);
    expect(augmented.durationMeanMs).toBe(60_000);
    expect(augmented.meanRecallDurationMs).toBe(1_500);
    expect(augmented.meanMemoryChars).toBe(900);

    const seed = report.arms.find((arm) => arm.arm === "seed")!;
    expect(seed.runs).toBe(1);
    expect(seed.durationStdDevMs).toBeNull();
  });

  it("falls back to the session-id convention when metadata is unparseable", () => {
    const report = buildEvalReport(
      [
        summaryRow({ metadataJson: "not json{", sessionId: "eval:run1:augmented:3" }),
        summaryRow({ metadataJson: null, sessionId: "weird-session" }),
      ],
      "run1",
    );

    expect(report.trials[0]?.arm).toBe("augmented");
    expect(report.trials[1]?.arm).toBe("unknown");
  });
});

describe("renderEvalReportMarkdown", () => {
  it("renders arm and trial tables plus the methodology note", () => {
    const rendered = renderEvalReportMarkdown(buildEvalReport(ROWS, "run1"));

    expect(rendered).toContain("# Recall evaluation run1");
    expect(rendered).toContain("aggregates exclude 1 recall-failed augmented trial(s)");
    expect(rendered).toContain("| baseline | 2 | 1 | 0 |");
    expect(rendered).toContain("| eval:run1:augmented:1 | augmented |");
    expect(rendered).toContain("recall changes efficiency metrics");
    // Wide content is real markdown tables.
    expect(rendered).toContain("| arm | runs |");
  });
});
