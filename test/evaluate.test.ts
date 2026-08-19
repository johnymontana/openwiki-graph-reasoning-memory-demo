import { describe, expect, it, vi } from "vitest";
import {
  buildTrialSchedule,
  runEvaluation,
  type EvaluationDeps,
  type EvaluationOptions,
} from "../src/eval/evaluate.js";
import type {
  OpenWikiRunRecord,
  OpenWikiRunRequest,
} from "../src/openwiki/openwiki-runner.js";

const OPTIONS: EvaluationOptions = {
  assumeSeeded: false,
  command: "init",
  isolateHome: true,
  keepTemp: false,
  outDir: "/out",
  repoPath: "/repos/target",
  repository: "github.com/example/demo-repo",
  runId: "run1",
  seedRuns: 1,
  task: "init the OpenWiki for github.com/example/demo-repo",
  timeoutMs: 60_000,
  trials: 2,
};

function successRecord(request: OpenWikiRunRequest): OpenWikiRunRecord {
  return {
    captureLogPath: `${request.captureDir}/${request.traceId}.json`,
    childExitCode: 0,
    persisted: true,
    runResult: { command: request.command, model: "claude-haiku-4-5" },
    timedOut: false,
    trace: {
      completedAt: "2026-08-19T00:01:00.000Z",
      id: request.traceId,
      metadata: request.metadata,
      repository: request.repository,
      sessionId: request.sessionId,
      startedAt: "2026-08-19T00:00:00.000Z",
      steps: [
        {
          createdAt: "2026-08-19T00:00:01.000Z",
          id: `${request.traceId}:step:1`,
          metadata: {},
          stepNumber: 1,
          toolCalls: [
            {
              arguments: {},
              createdAt: "2026-08-19T00:00:01.000Z",
              id: `${request.traceId}:tool:1`,
              status: "success",
              toolName: "glob",
            },
          ],
          traceId: request.traceId,
        },
      ],
      success: true,
      task: request.task,
    },
    warnings: [],
    wikiStats: { fileCount: 2, totalBytes: 512 },
  };
}

function createDeps(overrides: Partial<EvaluationDeps> = {}) {
  const requests: OpenWikiRunRequest[] = [];
  const copies: Array<{ destination: string; source: string }> = [];
  const removed: string[] = [];
  const written = new Map<string, string>();
  const logs: string[] = [];

  const deps: EvaluationDeps = {
    augment: vi.fn(async (task: string) => ({
      augmentedTask: `${task}\n<memory>`,
      memoryChars: 42,
      recallDurationMs: 120,
    })),
    copyRepo: async (source, destination) => {
      copies.push({ destination, source });
    },
    ensureDir: async () => undefined,
    log: (message) => {
      logs.push(message);
    },
    removeDir: async (dir) => {
      removed.push(dir);
    },
    runSingle: vi.fn(async (request: OpenWikiRunRequest) => {
      requests.push(request);
      return successRecord(request);
    }),
    writeFileText: async (path, content) => {
      written.set(path, content);
    },
    ...overrides,
  };

  return { copies, deps, logs, removed, requests, written };
}

describe("buildTrialSchedule", () => {
  it("interleaves arms with an alternating first arm per round", () => {
    expect(buildTrialSchedule(1, 3)).toEqual([
      { arm: "seed", trialIndex: 0 },
      { arm: "baseline", trialIndex: 0 },
      { arm: "augmented", trialIndex: 0 },
      { arm: "augmented", trialIndex: 1 },
      { arm: "baseline", trialIndex: 1 },
      { arm: "baseline", trialIndex: 2 },
      { arm: "augmented", trialIndex: 2 },
    ]);
  });
});

describe("runEvaluation", () => {
  it("runs seeds and interleaved trials on fresh copies with tagged sessions", async () => {
    const harness = createDeps();

    const summary = await runEvaluation(OPTIONS, harness.deps);

    expect(summary.results.map((result) => result.sessionId)).toEqual([
      "eval:run1:seed:0",
      "eval:run1:baseline:0",
      "eval:run1:augmented:0",
      "eval:run1:augmented:1",
      "eval:run1:baseline:1",
    ]);
    // Every trial ran on its own fresh copy under the run directory.
    expect(harness.copies.map((copy) => copy.destination)).toEqual([
      "/out/run1/seed-0/repo",
      "/out/run1/baseline-0/repo",
      "/out/run1/augmented-0/repo",
      "/out/run1/augmented-1/repo",
      "/out/run1/baseline-1/repo",
    ]);
    expect(
      harness.copies.every((copy) => copy.source === "/repos/target"),
    ).toBe(true);

    const augmentedRequests = harness.requests.filter(
      (request) => request.metadata.arm === "augmented",
    );
    expect(augmentedRequests).toHaveLength(2);
    for (const request of augmentedRequests) {
      expect(request.userMessage).toContain("<memory>");
      expect(request.task).toBe(OPTIONS.task);
      expect(request.metadata).toMatchObject({ augmented: true, memoryChars: 42 });
    }
    const baselineRequests = harness.requests.filter(
      (request) => request.metadata.arm === "baseline",
    );
    for (const request of baselineRequests) {
      expect(request.userMessage).toBe(OPTIONS.task);
    }
    // The repository id is passed through explicitly, never re-derived.
    expect(
      harness.requests.every(
        (request) => request.repository === OPTIONS.repository,
      ),
    ).toBe(true);

    // Clean runs delete the repo copy; results.json mirrors every trial.
    expect(harness.removed).toContain("/out/run1/seed-0/repo");
    const resultsFile = JSON.parse(
      harness.written.get("/out/run1/results.json")!,
    );
    expect(resultsFile.results).toHaveLength(5);
  });

  it("retries recall once, then tags the trial recallFailed and runs unaugmented", async () => {
    const augment = vi
      .fn()
      .mockResolvedValueOnce({
        augmentedTask: "unused",
        memoryChars: 0,
        recallDurationMs: 10,
        recallError: new Error("first failure"),
      })
      .mockResolvedValueOnce({
        augmentedTask: "unused",
        memoryChars: 0,
        recallDurationMs: 11,
        recallError: new Error("second failure"),
      })
      .mockResolvedValue({
        augmentedTask: "task\n<memory>",
        memoryChars: 9,
        recallDurationMs: 12,
      });
    const harness = createDeps({ augment });

    const summary = await runEvaluation(
      { ...OPTIONS, seedRuns: 0, trials: 2 },
      harness.deps,
    );

    const firstAugmented = summary.results.find(
      (result) => result.sessionId === "eval:run1:augmented:0",
    )!;
    expect(firstAugmented.recallFailed).toBe(true);
    const firstAugmentedRequest = harness.requests.find(
      (request) => request.sessionId === "eval:run1:augmented:0",
    )!;
    expect(firstAugmentedRequest.userMessage).toBe(OPTIONS.task);
    expect(firstAugmentedRequest.metadata.recallFailed).toBe(true);

    const secondAugmented = summary.results.find(
      (result) => result.sessionId === "eval:run1:augmented:1",
    )!;
    expect(secondAugmented.recallFailed).toBeUndefined();
    expect(augment).toHaveBeenCalledTimes(3);
  });

  it("continues the schedule when a trial fails and keeps failed repo copies", async () => {
    const runSingle = vi
      .fn(async (request: OpenWikiRunRequest) => successRecord(request))
      .mockImplementationOnce(async () => {
        throw new Error("fork missing mid-run");
      });
    const harness = createDeps({ runSingle });

    const summary = await runEvaluation(
      { ...OPTIONS, seedRuns: 1, trials: 1 },
      harness.deps,
    );

    expect(summary.results).toHaveLength(3);
    expect(summary.results[0]).toMatchObject({
      arm: "seed",
      error: "fork missing mid-run",
      persisted: false,
    });
    // The failed trial's copy is kept for debugging; later clean ones are not.
    expect(harness.removed).not.toContain("/out/run1/seed-0/repo");
    expect(harness.removed).toContain("/out/run1/baseline-0/repo");
  });

  it("honors assumeSeeded and keepTemp", async () => {
    const harness = createDeps();

    const summary = await runEvaluation(
      { ...OPTIONS, assumeSeeded: true, keepTemp: true, trials: 1 },
      harness.deps,
    );

    expect(
      summary.results.every((result) => result.arm !== "seed"),
    ).toBe(true);
    expect(harness.removed).toHaveLength(0);
  });

  it("rejects invalid counts up front", async () => {
    const harness = createDeps();

    await expect(
      runEvaluation({ ...OPTIONS, trials: 0 }, harness.deps),
    ).rejects.toThrow("trials must be a positive integer.");
    await expect(
      runEvaluation({ ...OPTIONS, seedRuns: -1 }, harness.deps),
    ).rejects.toThrow("seedRuns must be a non-negative integer.");
  });
});
