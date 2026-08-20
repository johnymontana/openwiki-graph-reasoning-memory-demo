import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";
import type {
  EvaluationOptions,
  EvaluationSummary,
} from "../src/eval/evaluate.js";
import type { AuraAgentMemoryResult } from "../src/mcp/aura-agent-client.js";
import type {
  OpenWikiRunRecord,
  OpenWikiRunRequest,
} from "../src/openwiki/openwiki-runner.js";
import type {
  ReasoningStore,
  TraceSummaryRow,
} from "../src/store/reasoning-store.js";

// A real directory: run/evaluate validate --repo before doing anything else.
const REPO_DIR = tmpdir();

function createHarness(options: {
  environment?: NodeJS.ProcessEnv;
  memory?: AuraAgentMemoryResult;
  memoryError?: Error;
  saveError?: Error;
  traceSummaries?: TraceSummaryRow[];
} = {}) {
  const ensureSchema = vi.fn(async () => undefined);
  const saveTrace = options.saveError
    ? vi.fn(async (_trace: unknown) => Promise.reject(options.saveError))
    : vi.fn(async (_trace: unknown) => undefined);
  const fetchTraceSummaries = vi.fn(
    async (_prefix: string) => options.traceSummaries ?? [],
  );
  const close = vi.fn(async () => undefined);
  const queryMemory = vi.fn(async () => {
    if (options.memoryError) {
      throw options.memoryError;
    }
    return (
      options.memory ?? {
        raw: { content: [] },
        text: "Use glob before read_file.",
        toolName: "reasoning-memory",
      }
    );
  });
  const getAccessToken = vi.fn(async () => "short-lived-token");
  const createStore = vi.fn(
    () =>
      ({
        close,
        ensureSchema,
        fetchTraceSummaries,
        saveTrace,
      }) as unknown as ReasoningStore,
  );
  const createMcpClient = vi.fn(() => ({ queryMemory }));
  const createTokenProvider = vi.fn(() => ({ getAccessToken }));
  const deriveRepository = vi.fn(async () => "github.com/example/derived");
  const runOpenWiki = vi.fn(
    async (request: OpenWikiRunRequest): Promise<OpenWikiRunRecord> => ({
      captureLogPath: `captures/${request.traceId}.json`,
      childExitCode: 0,
      cleanExit: true,
      persisted: request.ingest,
      runResult: { command: request.command, model: "claude-haiku-4-5" },
      timedOut: false,
      trace: {
        completedAt: "2026-08-19T00:00:10.000Z",
        id: request.traceId,
        metadata: request.metadata,
        repository: request.repository,
        sessionId: request.sessionId,
        startedAt: "2026-08-19T00:00:00.000Z",
        steps: [],
        success: true,
        task: request.task,
      },
      warnings: [],
      wikiStats: { fileCount: 3, totalBytes: 2_048 },
    }),
  );
  const runOpenWikiChild = vi.fn(async (_configPath: string) => 0);
  const runEvaluation = vi.fn(
    async (evaluationOptions: EvaluationOptions): Promise<EvaluationSummary> => ({
      results: [
        {
          arm: "baseline",
          childExitCode: 0,
          cleanExit: true,
          persisted: true,
          sessionId: `eval:${evaluationOptions.runId}:baseline:0`,
          stepCount: 3,
          success: true,
          timedOut: false,
          toolCallCount: 4,
          traceId: `eval-${evaluationOptions.runId}-baseline-0`,
          trialIndex: 0,
          wikiFileCount: 2,
          wikiTotalBytes: 1_000,
        },
      ],
      resultsPath: `${evaluationOptions.outDir}/${evaluationOptions.runId}/results.json`,
      runId: evaluationOptions.runId,
    }),
  );
  const dependencies: CliDependencies = {
    createMcpClient,
    createStore,
    createTokenProvider,
    deriveRepository,
    environment:
      options.environment ?? {
        AURA_AGENT_MCP_CLIENT_ID: "client-id",
        AURA_AGENT_MCP_CLIENT_SECRET: "client-secret",
      },
    runEvaluation,
    runOpenWiki,
    runOpenWikiChild,
  };
  const log = vi.fn();
  const error = vi.fn();
  const io = { error, log } as unknown as Pick<Console, "error" | "log">;

  return {
    close,
    createMcpClient,
    createStore,
    createTokenProvider,
    dependencies,
    deriveRepository,
    ensureSchema,
    error,
    fetchTraceSummaries,
    getAccessToken,
    io,
    log,
    queryMemory,
    runEvaluation,
    runOpenWiki,
    runOpenWikiChild,
    saveTrace,
  };
}

describe("CLI integration", () => {
  it("translates the checked-in capture without connecting to Neo4j", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      ["demo", "examples/openwiki-run.json"],
      harness.io,
      harness.dependencies,
    );
    const trace = JSON.parse(String(harness.log.mock.calls[0]?.[0]));

    expect(exitCode).toBe(0);
    expect(harness.error).not.toHaveBeenCalled();
    expect(harness.createStore).not.toHaveBeenCalled();
    expect(trace).toMatchObject({ id: "openwiki-demo-001", success: true });
    expect(trace.steps[0]).toMatchObject({ action: "plan", stepNumber: 1 });
    expect(trace.steps[1].toolCalls[0].arguments.authorization).toBe(
      "[REDACTED]",
    );
  });

  it.each([
    ["demo with ingest", ["demo", "examples/openwiki-run.json", "--ingest"]],
    ["ingest", ["ingest", "examples/openwiki-run.json"]],
  ])("ensures schema, saves, and closes for %s", async (_name, args) => {
    const harness = createHarness();

    expect(
      await runCli(args, harness.io, harness.dependencies),
    ).toBe(0);
    expect(harness.ensureSchema).toHaveBeenCalledOnce();
    expect(harness.saveTrace).toHaveBeenCalledOnce();
    expect(harness.saveTrace.mock.calls[0]?.[0]).toMatchObject({
      id: "openwiki-demo-001",
    });
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("closes the store when ingestion fails", async () => {
    const harness = createHarness({ saveError: new Error("write failed") });

    await expect(
      runCli(
        ["ingest", "examples/openwiki-run.json"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("write failed");
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("creates the schema and closes the store", async () => {
    const harness = createHarness();

    expect(
      await runCli(["schema"], harness.io, harness.dependencies),
    ).toBe(0);
    expect(harness.ensureSchema).toHaveBeenCalledOnce();
    expect(harness.saveTrace).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.log).toHaveBeenCalledWith(
      "Reasoning-only Neo4j schema is ready.",
    );
  });

  it("queries reasoning memory and prints returned text", async () => {
    const harness = createHarness();

    expect(
      await runCli(
        ["query-memory", "How", "should", "I", "inspect?"],
        harness.io,
        harness.dependencies,
      ),
    ).toBe(0);
    expect(harness.queryMemory).toHaveBeenCalledWith(
      "How should I inspect?",
    );
    expect(harness.log).toHaveBeenCalledWith("Use glob before read_file.");
  });

  it("prints structured MCP output when no text block is returned", async () => {
    const harness = createHarness({
      memory: {
        raw: { structuredContent: { traces: 0 } },
        text: "",
        toolName: "reasoning-memory",
      },
    });

    await runCli(
      ["query-memory", "anything"],
      harness.io,
      harness.dependencies,
    );

    expect(harness.log.mock.calls[0]?.[0]).toContain('"traces": 0');
  });

  it("rejects an empty memory query", async () => {
    const harness = createHarness();

    await expect(
      runCli(["query-memory", "   "], harness.io, harness.dependencies),
    ).rejects.toThrow("Usage: npm run query-memory");
    expect(harness.createMcpClient).not.toHaveBeenCalled();
  });

  it("prints a bounded, untrusted augmented OpenWiki task", async () => {
    const harness = createHarness();

    expect(
      await runCli(
        ["augment-task", "Document", "the", "repo"],
        harness.io,
        harness.dependencies,
      ),
    ).toBe(0);
    expect(harness.log.mock.calls[0]?.[0]).toContain("Document the repo");
    expect(harness.log.mock.calls[0]?.[0]).toContain(
      'trust="untrusted-historical-data"',
    );
  });

  it("rejects an empty augmentation task", async () => {
    const harness = createHarness();

    await expect(
      runCli(["augment-task"], harness.io, harness.dependencies),
    ).rejects.toThrow("Usage: npm run augment-task");
  });

  it("passes --repository through to the recall question", async () => {
    const harness = createHarness();

    expect(
      await runCli(
        [
          "augment-task",
          "--repository",
          "github.com/example/demo-repo",
          "Document",
          "the",
          "repo",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).toBe(0);
    expect(harness.queryMemory).toHaveBeenCalledWith(
      expect.stringContaining("Repository: github.com/example/demo-repo"),
    );
    expect(harness.log.mock.calls[0]?.[0]).toContain("Document the repo");
  });

  it("rejects --repository without a value", async () => {
    const harness = createHarness();

    await expect(
      runCli(
        ["augment-task", "--repository"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("--repository requires a value.");
  });

  it("prints the unaugmented task and a warning when recall fails open", async () => {
    const harness = createHarness({
      memoryError: new Error("MCP unavailable"),
    });

    expect(
      await runCli(
        ["augment-task", "Document", "the", "repo"],
        harness.io,
        harness.dependencies,
      ),
    ).toBe(0);
    expect(harness.log).toHaveBeenCalledWith("Document the repo");
    expect(harness.error.mock.calls[0]?.[0]).toContain(
      "failed open",
    );
    expect(harness.error.mock.calls[0]?.[0]).toContain("MCP unavailable");
  });

  it("runs an instrumented OpenWiki run with defaults and a derived repository", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      ["run", "--repo", REPO_DIR],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.deriveRepository).toHaveBeenCalledWith(resolve(REPO_DIR));
    expect(harness.runOpenWiki).toHaveBeenCalledOnce();
    const request = harness.runOpenWiki.mock.calls[0]![0];
    expect(request).toMatchObject({
      command: "init",
      ingest: true,
      isolateHome: true,
      repoPath: resolve(REPO_DIR),
      repository: "github.com/example/derived",
      task: "init the OpenWiki for github.com/example/derived",
      timeoutMs: 20 * 60_000,
      userMessage: "init the OpenWiki for github.com/example/derived",
    });
    expect(request.metadata).toMatchObject({ augmented: false });
    expect(request.sessionId).toBe(`run:${request.traceId}`);
    expect(harness.queryMemory).not.toHaveBeenCalled();
    expect(harness.log.mock.calls[0]?.[0]).toContain("Trace");
    expect(harness.log.mock.calls[0]?.[0]).toContain("wiki output: 3 file(s)");
  });

  it("augments the run task over MCP when --augment is set", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      [
        "run",
        "--repo",
        REPO_DIR,
        "--augment",
        "--repository",
        "github.com/example/demo-repo",
        "--command",
        "update",
        "--task",
        "Refresh the architecture page",
        "--no-ingest",
        "--no-isolate-home",
        "--timeout-minutes",
        "5",
      ],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.deriveRepository).not.toHaveBeenCalled();
    expect(harness.queryMemory).toHaveBeenCalledWith(
      expect.stringContaining("Repository: github.com/example/demo-repo"),
    );
    const request = harness.runOpenWiki.mock.calls[0]![0];
    expect(request).toMatchObject({
      command: "update",
      ingest: false,
      isolateHome: false,
      repository: "github.com/example/demo-repo",
      task: "Refresh the architecture page",
      timeoutMs: 5 * 60_000,
    });
    expect(request.userMessage).toContain("Refresh the architecture page");
    expect(request.userMessage).toContain("openwiki_reasoning_memory");
    expect(request.metadata).toMatchObject({
      augmented: true,
      memoryChars: "Use glob before read_file.".length,
    });
  });

  it("keeps the run going unaugmented when recall fails open", async () => {
    const harness = createHarness({
      memoryError: new Error("MCP unavailable"),
    });

    const exitCode = await runCli(
      ["run", "--repo", REPO_DIR, "--augment"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    const request = harness.runOpenWiki.mock.calls[0]![0];
    expect(request.userMessage).toBe(request.task);
    expect(request.metadata).toMatchObject({
      augmented: true,
      recallFailed: true,
    });
    expect(harness.error.mock.calls.flat().join("\n")).toContain(
      "failed open",
    );
  });

  it("rejects a repository path that does not exist before any spend", async () => {
    const harness = createHarness();

    await expect(
      runCli(
        ["run", "--repo", "/nonexistent/definitely-not-here", "--augment"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("does not exist");
    await expect(
      runCli(
        ["run", "--repo", "package.json"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("is not a directory");
    await expect(
      runCli(
        ["evaluate", "--repo", "/nonexistent/definitely-not-here"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("does not exist");
    expect(harness.queryMemory).not.toHaveBeenCalled();
    expect(harness.runOpenWiki).not.toHaveBeenCalled();
    expect(harness.runEvaluation).not.toHaveBeenCalled();
  });

  it("requires --task for update runs and --repo for every run", async () => {
    const harness = createHarness();

    await expect(
      runCli(
        ["run", "--repo", REPO_DIR, "--command", "update"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("requires --task");
    await expect(
      runCli(["run"], harness.io, harness.dependencies),
    ).rejects.toThrow("Usage: npm run run");
    await expect(
      runCli(
        ["run", "--repo", REPO_DIR, "--frobnicate"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("Unknown run argument(s): --frobnicate");
    expect(harness.runOpenWiki).not.toHaveBeenCalled();
  });

  it("exits non-zero and surfaces warnings when the child run fails", async () => {
    const harness = createHarness();
    harness.runOpenWiki.mockResolvedValueOnce({
      captureLogPath: "captures/failed.json",
      childExitCode: 1,
      cleanExit: false,
      persisted: false,
      timedOut: false,
      trace: {
        id: "failed-trace",
        metadata: {},
        sessionId: "run:failed-trace",
        startedAt: "2026-08-19T00:00:00.000Z",
        steps: [],
        success: false,
        task: "init the OpenWiki for x",
      },
      warnings: ["The trace has no captured steps — verify the fork's reasoning hooks and see the child log."],
      wikiStats: { fileCount: 0, totalBytes: 0 },
    });

    const exitCode = await runCli(
      ["run", "--repo", REPO_DIR],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.error.mock.calls.flat().join("\n")).toContain(
      "no captured steps",
    );
  });

  it("dispatches openwiki-child to the injected child runner", async () => {
    const harness = createHarness();
    harness.runOpenWikiChild.mockResolvedValueOnce(3);

    const exitCode = await runCli(
      ["openwiki-child", "work/child-config.json"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(3);
    expect(harness.runOpenWikiChild).toHaveBeenCalledWith(
      expect.stringMatching(/work\/child-config\.json$/u),
    );
    await expect(
      runCli(["openwiki-child"], harness.io, harness.dependencies),
    ).rejects.toThrow("Usage: openwiki-child");
  });

  it("runs an evaluation with derived defaults and prints the report hint", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      ["evaluate", "--repo", REPO_DIR, "--trials", "1"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.runEvaluation).toHaveBeenCalledOnce();
    const options = harness.runEvaluation.mock.calls[0]![0];
    expect(options).toMatchObject({
      assumeSeeded: false,
      command: "init",
      isolateHome: true,
      keepTemp: false,
      outDir: resolve("eval-runs"),
      repoPath: REPO_DIR,
      repository: "github.com/example/derived",
      seedRuns: 1,
      task: "init the OpenWiki for github.com/example/derived",
      timeoutMs: 20 * 60_000,
      trials: 1,
    });
    expect(options.runId).toMatch(/^[A-Za-z0-9._-]+$/u);
    const costWarning = String(harness.error.mock.calls[0]?.[0]);
    expect(costWarning).toContain("3 real OpenWiki run(s)");
    expect(costWarning).toContain("model tokens");
    expect(harness.log.mock.calls[0]?.[0]).toContain("npm run report -- --run-id");
  });

  it("validates evaluate arguments before running anything", async () => {
    const harness = createHarness();

    await expect(
      runCli(
        ["evaluate", "--command", "update"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("requires --task");
    await expect(
      runCli(
        ["evaluate", "--run-id", "bad:id"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("--run-id may only contain");
    await expect(
      runCli(
        ["evaluate", "--trials", "0"],
        harness.io,
        harness.dependencies,
      ),
    ).rejects.toThrow("--trials must be a positive integer.");
    expect(harness.runEvaluation).not.toHaveBeenCalled();
  });

  it("renders an evaluation report from persisted trace summaries", async () => {
    const harness = createHarness({
      traceSummaries: [
        {
          cancelledToolCalls: 0,
          completedAt: "2026-08-19T00:10:00.000Z",
          failedToolCalls: 1,
          id: "eval-run1-baseline-0",
          metadataJson: JSON.stringify({
            arm: "baseline",
            durationMs: 60_000,
            trial: 0,
            wikiFileCount: 3,
            wikiTotalBytes: 4_096,
          }),
          repository: "github.com/example/demo-repo",
          sessionId: "eval:run1:baseline:0",
          startedAt: "2026-08-19T00:00:00.000Z",
          steps: 5,
          success: true,
          task: "init the OpenWiki",
          toolCalls: 7,
        },
      ],
    });

    const exitCode = await runCli(
      ["report", "--run-id", "run1"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.fetchTraceSummaries).toHaveBeenCalledWith("eval:run1:");
    expect(harness.close).toHaveBeenCalledOnce();
    const rendered = String(harness.log.mock.calls[0]?.[0]);
    expect(rendered).toContain("# Recall evaluation run1");
    expect(rendered).toContain("| baseline | 1 | 1 |");
    expect(rendered).toContain("Methodology and limits");
  });

  it("fails the report command when no evaluation traces exist", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      ["report", "--run-id", "missing"],
      harness.io,
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.error.mock.calls.flat().join("\n")).toContain(
      "No traces found",
    );
    await expect(
      runCli(["report"], harness.io, harness.dependencies),
    ).rejects.toThrow("Usage: npm run report");
  });

  it("mints a token with the configured client credentials", async () => {
    const harness = createHarness();

    expect(
      await runCli(["mint-token"], harness.io, harness.dependencies),
    ).toBe(0);
    expect(harness.createTokenProvider).toHaveBeenCalledWith({
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    expect(harness.getAccessToken).toHaveBeenCalledOnce();
    expect(harness.log).toHaveBeenCalledWith("short-lived-token");
    expect(harness.error.mock.calls[0]?.[0]).toContain("Sensitive");
  });

  it.each([
    [{}, "AURA_AGENT_MCP_CLIENT_ID"],
    [
      { AURA_AGENT_MCP_CLIENT_ID: "client-id" },
      "AURA_AGENT_MCP_CLIENT_SECRET",
    ],
  ])("requires mint-token environment values", async (environment, missing) => {
    const harness = createHarness({ environment });

    await expect(
      runCli(["mint-token"], harness.io, harness.dependencies),
    ).rejects.toThrow(`${missing} is required`);
    expect(harness.createTokenProvider).not.toHaveBeenCalled();
  });

  it.each([["help"], ["--help"], ["-h"], []].map((args) => [args] as [string[]]))(
    "prints help for %j",
    async (args) => {
      const harness = createHarness();
      expect(await runCli(args, harness.io, harness.dependencies)).toBe(0);
      expect(harness.log.mock.calls[0]?.[0]).toContain(
        "OpenWiki reasoning-memory POC",
      );
    },
  );

  it("rejects unknown commands with help text", async () => {
    const harness = createHarness();

    await expect(
      runCli(["unknown"], harness.io, harness.dependencies),
    ).rejects.toThrow(/Unknown command: unknown[\s\S]*OpenWiki reasoning-memory POC/u);
  });
});
