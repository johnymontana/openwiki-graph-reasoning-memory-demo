import type { Driver } from "neo4j-driver";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ReasoningTrace } from "../src/domain/types.js";
import {
  REASONING_SCHEMA_STATEMENTS,
  REFRESH_TOOL_STATS,
  UPSERT_STEPS,
  UPSERT_TOOL_CALLS,
  UPSERT_TRACE,
} from "../src/store/cypher.js";
import {
  Neo4jReasoningStore,
  readNeo4jEnvironment,
} from "../src/store/neo4j-reasoning-store.js";

const TRACE: ReasoningTrace = {
  completedAt: "2026-08-15T12:00:02.000Z",
  id: "trace-1",
  metadata: { source: "openwiki" },
  outcome: "Done",
  repository: "github.com/example/demo-repo",
  sessionId: "session-1",
  startedAt: "2026-08-15T12:00:00.000Z",
  steps: [
    {
      action: "Inspect package.json",
      createdAt: "2026-08-15T12:00:01.000Z",
      id: "trace-1:step:1",
      metadata: { source: "openwiki" },
      observation: "finished",
      stepNumber: 1,
      toolCalls: [
        {
          arguments: { path: "package.json" },
          createdAt: "2026-08-15T12:00:01.000Z",
          durationMs: 250,
          id: "call-1",
          status: "success",
          stepId: "trace-1:step:1",
          toolName: "read_file",
        },
      ],
      traceId: "trace-1",
    },
  ],
  success: true,
  task: "Inspect the repository",
};

function createDriverHarness() {
  const transactionRun = vi.fn(
    async (_query: string, _parameters?: Record<string, unknown>) => ({}),
  );
  const sessionRun = vi.fn(async (_query: string) => ({}));
  const sessionClose = vi.fn(async () => undefined);
  const executeWrite = vi.fn(
    async (
      work: (transaction: { run: typeof transactionRun }) => Promise<unknown>,
    ) => work({ run: transactionRun }),
  );
  const session = {
    close: sessionClose,
    executeWrite,
    run: sessionRun,
  };
  const driverSession = vi.fn(() => session);
  const driverClose = vi.fn(async () => undefined);
  const verifyConnectivity = vi.fn(async () => undefined);
  const driver = {
    close: driverClose,
    session: driverSession,
    verifyConnectivity,
  } as unknown as Driver;

  return {
    driver,
    driverClose,
    driverSession,
    executeWrite,
    sessionClose,
    sessionRun,
    transactionRun,
    verifyConnectivity,
  };
}

describe("reasoning-only Cypher", () => {
  it("references only reasoning-memory graph types", () => {
    const statements = [
      ...REASONING_SCHEMA_STATEMENTS,
      UPSERT_TRACE,
      UPSERT_STEPS,
      UPSERT_TOOL_CALLS,
      REFRESH_TOOL_STATS,
    ];
    const allowedGraphTypes = new Set([
      "HAS_STEP",
      "INSTANCE_OF",
      "ReasoningStep",
      "ReasoningTrace",
      "Tool",
      "ToolCall",
      "USES_TOOL",
    ]);

    for (const statement of statements) {
      const graphTypes = [...statement.matchAll(/:([A-Z][A-Za-z0-9_]*)/gu)].map(
        (match) => match[1]!,
      );
      expect(graphTypes.length).toBeGreaterThan(0);
      for (const graphType of graphTypes) {
        expect(allowedGraphTypes.has(graphType), statement).toBe(true);
      }
    }
  });

  it("keeps the neo4j-cli schema file in sync with the application schema", async () => {
    const schemaFile = await readFile("cypher/reasoning-schema.cypher", "utf8");
    const fileStatements = schemaFile
      .split(";")
      .map((statement) => statement.replace(/\s+/gu, " ").trim())
      .filter(Boolean);

    expect(fileStatements).toEqual([...REASONING_SCHEMA_STATEMENTS]);
  });

  it("scopes traces by repository and indexes the property", () => {
    expect(UPSERT_TRACE).toContain("rt.repository = $repository");
    expect(
      REASONING_SCHEMA_STATEMENTS.some((statement) =>
        statement.includes("trace_repository_idx"),
      ),
    ).toBe(true);
  });

  it("nulls embedding placeholders only when a node is first created", () => {
    // Re-upserting a trace must never clobber embeddings added out of band;
    // agent-memory's only retrieval path is vector search over these fields.
    const traceOnCreate = UPSERT_TRACE.slice(0, UPSERT_TRACE.indexOf("\nSET "));
    const stepOnCreate = UPSERT_STEPS.slice(0, UPSERT_STEPS.indexOf("\nSET "));
    expect(traceOnCreate).toContain("rt.task_embedding = null");
    expect(stepOnCreate).toContain("rs.embedding = null");
    expect(UPSERT_TRACE.slice(traceOnCreate.length)).not.toContain(
      "task_embedding",
    );
    expect(UPSERT_STEPS.slice(stepOnCreate.length)).not.toContain(
      "rs.embedding",
    );
  });
});

describe("Neo4jReasoningStore", () => {
  it("writes the agent-memory reasoning shape in one transaction", async () => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({
      database: "neo4j",
      driver: harness.driver,
    });

    await store.saveTrace(TRACE);

    expect(harness.driverSession).toHaveBeenCalledWith({ database: "neo4j" });
    expect(harness.executeWrite).toHaveBeenCalledOnce();
    expect(harness.transactionRun).toHaveBeenCalledTimes(4);
    expect(harness.transactionRun.mock.calls[0]).toEqual([
      UPSERT_TRACE,
      {
        completed_at: TRACE.completedAt,
        id: TRACE.id,
        metadata: JSON.stringify(TRACE.metadata),
        outcome: TRACE.outcome,
        repository: TRACE.repository,
        session_id: TRACE.sessionId,
        started_at: TRACE.startedAt,
        success: TRACE.success,
        task: TRACE.task,
      },
    ]);
    expect(harness.transactionRun.mock.calls[1]?.[0]).toBe(UPSERT_STEPS);
    expect(harness.transactionRun.mock.calls[1]?.[1]).toMatchObject({
      steps: [
        expect.objectContaining({
          action: "Inspect package.json",
          metadata: JSON.stringify({ source: "openwiki" }),
          step_number: 1,
        }),
      ],
      trace_id: TRACE.id,
    });
    expect(harness.transactionRun.mock.calls[2]?.[0]).toBe(UPSERT_TOOL_CALLS);
    expect(harness.transactionRun.mock.calls[2]?.[1]).toMatchObject({
      tool_calls: [
        expect.objectContaining({
          arguments: JSON.stringify({ path: "package.json" }),
          status: "success",
          step_id: "trace-1:step:1",
          tool_name: "read_file",
        }),
      ],
    });
    expect(harness.transactionRun.mock.calls[3]).toEqual([
      REFRESH_TOOL_STATS,
      { tool_names: ["read_file"] },
    ]);
    expect(harness.sessionClose).toHaveBeenCalledOnce();
  });

  it("rejects cross-trace and cross-step references before opening a session", async () => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({ driver: harness.driver });
    const invalidTrace: ReasoningTrace = {
      ...TRACE,
      steps: [
        {
          ...TRACE.steps[0]!,
          toolCalls: [
            {
              ...TRACE.steps[0]!.toolCalls[0]!,
              stepId: "another-step",
            },
          ],
        },
      ],
    };

    await expect(store.saveTrace(invalidTrace)).rejects.toThrow(
      "belongs to step another-step",
    );
    expect(harness.driverSession).not.toHaveBeenCalled();

    await expect(
      store.saveTrace({
        ...TRACE,
        steps: [{ ...TRACE.steps[0]!, traceId: "another-trace" }],
      }),
    ).rejects.toThrow("belongs to trace another-trace");
    expect(harness.driverSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: "Duplicate reasoning step id: trace-1:step:1",
      steps: [TRACE.steps[0]!, { ...TRACE.steps[0]!, stepNumber: 2 }],
    },
    {
      expected: "Duplicate reasoning step number: 1",
      steps: [
        TRACE.steps[0]!,
        { ...TRACE.steps[0]!, id: "trace-1:step:2", toolCalls: [] },
      ],
    },
    {
      expected: "invalid step number 0",
      steps: [{ ...TRACE.steps[0]!, stepNumber: 0 }],
    },
    {
      expected: "Duplicate tool call id: call-1",
      steps: [
        TRACE.steps[0]!,
        {
          ...TRACE.steps[0]!,
          id: "trace-1:step:2",
          stepNumber: 2,
          toolCalls: [
            { ...TRACE.steps[0]!.toolCalls[0]!, stepId: "trace-1:step:2" },
          ],
        },
      ],
    },
  ])("rejects malformed ownership/order: $expected", async ({ expected, steps }) => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({ driver: harness.driver });

    await expect(store.saveTrace({ ...TRACE, steps })).rejects.toThrow(expected);
    expect(harness.driverSession).not.toHaveBeenCalled();
  });

  it("writes a trace with no steps without executing empty UNWIND statements", async () => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({ driver: harness.driver });

    await store.saveTrace({
      ...TRACE,
      completedAt: undefined,
      metadata: {},
      outcome: undefined,
      steps: [],
      success: undefined,
    });

    expect(harness.transactionRun).toHaveBeenCalledOnce();
    expect(harness.transactionRun).toHaveBeenCalledWith(
      UPSERT_TRACE,
      expect.objectContaining({
        completed_at: null,
        outcome: null,
        success: null,
      }),
    );
    expect(harness.sessionClose).toHaveBeenCalledOnce();
  });

  it("writes steps without issuing tool-call or tool-stat statements", async () => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({ driver: harness.driver });

    await store.saveTrace({
      ...TRACE,
      steps: [{ ...TRACE.steps[0]!, toolCalls: [] }],
    });

    expect(harness.transactionRun).toHaveBeenCalledTimes(2);
    expect(harness.transactionRun.mock.calls.map(([query]) => query)).toEqual([
      UPSERT_TRACE,
      UPSERT_STEPS,
    ]);
  });

  it("serializes otherwise non-JSON metadata without aborting ingestion", async () => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({ driver: harness.driver });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await store.saveTrace({ ...TRACE, metadata: circular });

    expect(harness.transactionRun.mock.calls[0]?.[1]).toMatchObject({
      metadata: JSON.stringify({ value: "[object Object]" }),
    });
  });

  it("closes sessions when schema or transaction execution fails", async () => {
    const schemaHarness = createDriverHarness();
    schemaHarness.sessionRun.mockRejectedValueOnce(new Error("schema failed"));
    const schemaStore = new Neo4jReasoningStore({ driver: schemaHarness.driver });

    await expect(schemaStore.ensureSchema()).rejects.toThrow("schema failed");
    expect(schemaHarness.sessionClose).toHaveBeenCalledOnce();

    const writeHarness = createDriverHarness();
    writeHarness.executeWrite.mockRejectedValueOnce(new Error("write failed"));
    const writeStore = new Neo4jReasoningStore({ driver: writeHarness.driver });

    await expect(writeStore.saveTrace(TRACE)).rejects.toThrow("write failed");
    expect(writeHarness.sessionClose).toHaveBeenCalledOnce();
  });

  it("creates only the reasoning schema and always closes the session", async () => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({ driver: harness.driver });

    await store.ensureSchema();

    expect(harness.verifyConnectivity).toHaveBeenCalledOnce();
    expect(harness.sessionRun.mock.calls.map(([query]) => query)).toEqual(
      REASONING_SCHEMA_STATEMENTS,
    );
    expect(harness.sessionClose).toHaveBeenCalledOnce();
  });

  it("closes the driver", async () => {
    const harness = createDriverHarness();
    const store = new Neo4jReasoningStore({ driver: harness.driver });

    await store.close();

    expect(harness.driverClose).toHaveBeenCalledOnce();
  });
});

describe("readNeo4jEnvironment", () => {
  it("trims required values and omits a blank optional database", () => {
    expect(
      readNeo4jEnvironment({
        NEO4J_DATABASE: "  ",
        NEO4J_PASSWORD: " password ",
        NEO4J_URI: " bolt://localhost:7687 ",
        NEO4J_USERNAME: " neo4j ",
      }),
    ).toEqual({
      database: undefined,
      password: "password",
      uri: "bolt://localhost:7687",
      username: "neo4j",
    });
  });

  it.each([
    [{}, "NEO4J_PASSWORD"],
    [{ NEO4J_PASSWORD: "password" }, "NEO4J_URI"],
    [
      { NEO4J_PASSWORD: "password", NEO4J_URI: "bolt://localhost:7687" },
      "NEO4J_USERNAME",
    ],
  ] as const)("requires every connection value", (environment, missing) => {
    expect(() => readNeo4jEnvironment(environment)).toThrow(
      `${missing} is required.`,
    );
  });
});
