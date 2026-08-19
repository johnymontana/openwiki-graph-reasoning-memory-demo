import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReasoningTrace } from "../../src/domain/types.js";
import { Neo4jReasoningStore } from "../../src/store/neo4j-reasoning-store.js";

const uri = process.env.TEST_NEO4J_URI?.trim();
const username = process.env.TEST_NEO4J_USERNAME?.trim() || "neo4j";
const password = process.env.TEST_NEO4J_PASSWORD?.trim();
const database = process.env.TEST_NEO4J_DATABASE?.trim() || "neo4j";

const describeWithNeo4j = uri && password ? describe : describe.skip;

describeWithNeo4j("Neo4j reasoning store (live)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const traceId = `integration-trace-${suffix}`;
  const toolName = `integration-read-file-${suffix}`;
  let driver: Driver;
  let store: Neo4jReasoningStore;

  beforeAll(async () => {
    driver = neo4j.driver(uri!, neo4j.auth.basic(username, password!));
    store = new Neo4jReasoningStore({ database, driver });
    await store.ensureSchema();
  });

  afterAll(async () => {
    if (!driver) {
      return;
    }

    const session = driver.session({ database });
    try {
      await session.run(
        "MATCH (:ReasoningTrace {id: $trace_id})-[:HAS_STEP]->(:ReasoningStep)-[:USES_TOOL]->(call:ToolCall) DETACH DELETE call",
        { trace_id: traceId },
      );
      await session.run(
        "MATCH (:ReasoningTrace {id: $trace_id})-[:HAS_STEP]->(step:ReasoningStep) DETACH DELETE step",
        { trace_id: traceId },
      );
      await session.run(
        "MATCH (trace:ReasoningTrace {id: $trace_id}) DETACH DELETE trace",
        { trace_id: traceId },
      );
      await session.run(
        "MATCH (tool:Tool {name: $tool_name}) WHERE NOT (tool)<-[:INSTANCE_OF]-() DETACH DELETE tool",
        { tool_name: toolName },
      );
    } finally {
      await session.close();
      await store.close();
    }
  });

  it("creates the reasoning-only schema and idempotently writes the full graph shape", async () => {
    const trace: ReasoningTrace = {
      completedAt: "2026-08-16T12:00:02.000Z",
      id: traceId,
      metadata: { command: "update", source: "openwiki" },
      outcome: "Architecture documented.",
      repository: "github.com/example/integration-repo",
      sessionId: `integration-session-${suffix}`,
      startedAt: "2026-08-16T12:00:00.000Z",
      steps: [
        {
          action: "read_file",
          createdAt: "2026-08-16T12:00:01.000Z",
          id: `${traceId}:step:1`,
          metadata: { source: "openwiki" },
          observation: "finished",
          stepNumber: 1,
          toolCalls: [
            {
              arguments: { path: "src/index.ts" },
              createdAt: "2026-08-16T12:00:01.000Z",
              durationMs: 25,
              id: `${traceId}:tool:1`,
              result: { bytes: 128 },
              status: "success",
              stepId: `${traceId}:step:1`,
              toolName,
            },
          ],
          traceId,
        },
      ],
      success: true,
      task: "Document repository architecture",
    };

    await store.saveTrace(trace);

    const session = driver.session({ database });
    try {
      // Embeddings written out of band (e.g. by agent-memory tooling) must
      // survive replays: the upsert nulls them only when a node is created.
      await session.run(
        `MATCH (trace:ReasoningTrace {id: $trace_id})-[:HAS_STEP]->(step:ReasoningStep)
         SET trace.task_embedding = [0.1, 0.2], step.embedding = [0.3, 0.4]`,
        { trace_id: traceId },
      );
      await store.saveTrace(trace);

      const embeddings = await session.run(
        `MATCH (trace:ReasoningTrace {id: $trace_id})-[:HAS_STEP]->(step:ReasoningStep)
         RETURN trace.task_embedding AS task_embedding,
                step.embedding AS step_embedding,
                trace.repository AS repository`,
        { trace_id: traceId },
      );
      const embeddingRecord = embeddings.records[0]!;
      expect(embeddingRecord.get("task_embedding")).toEqual([0.1, 0.2]);
      expect(embeddingRecord.get("step_embedding")).toEqual([0.3, 0.4]);
      expect(embeddingRecord.get("repository")).toBe(
        "github.com/example/integration-repo",
      );

      const repositoryIndex = await session.run(
        "SHOW INDEXES YIELD name WHERE name = 'trace_repository_idx' RETURN count(*) AS indexes",
      );
      expect(repositoryIndex.records[0]!.get("indexes").toNumber()).toBe(1);

      const result = await session.run(
        `MATCH (trace:ReasoningTrace {id: $trace_id})-[h:HAS_STEP]->(step:ReasoningStep)-[u:USES_TOOL]->(call:ToolCall)-[i:INSTANCE_OF]->(tool:Tool)
         RETURN count(DISTINCT trace) AS traces,
                count(DISTINCT step) AS steps,
                count(DISTINCT call) AS calls,
                count(DISTINCT tool) AS tools,
                labels(trace) AS trace_labels,
                labels(step) AS step_labels,
                labels(call) AS call_labels,
                labels(tool) AS tool_labels,
                type(h) AS has_step_type,
                type(u) AS uses_tool_type,
                type(i) AS instance_of_type,
                h.order AS step_order,
                call.arguments AS arguments,
                call.result AS result,
                tool.total_calls AS total_calls`,
        { trace_id: traceId },
      );
      const record = result.records[0]!;

      expect(record.get("traces").toNumber()).toBe(1);
      expect(record.get("steps").toNumber()).toBe(1);
      expect(record.get("calls").toNumber()).toBe(1);
      expect(record.get("tools").toNumber()).toBe(1);
      expect(record.get("trace_labels")).toEqual(["ReasoningTrace"]);
      expect(record.get("step_labels")).toEqual(["ReasoningStep"]);
      expect(record.get("call_labels")).toEqual(["ToolCall"]);
      expect(record.get("tool_labels")).toEqual(["Tool"]);
      expect(record.get("has_step_type")).toBe("HAS_STEP");
      expect(record.get("uses_tool_type")).toBe("USES_TOOL");
      expect(record.get("instance_of_type")).toBe("INSTANCE_OF");
      expect(record.get("step_order").toNumber()).toBe(1);
      expect(JSON.parse(record.get("arguments"))).toEqual({
        path: "src/index.ts",
      });
      expect(JSON.parse(record.get("result"))).toEqual({ bytes: 128 });
      expect(record.get("total_calls").toNumber()).toBe(1);

      const schema = await session.run(
        "SHOW CONSTRAINTS YIELD name WHERE name STARTS WITH 'reasoning_' OR name IN ['tool_call_id', 'tool_name'] RETURN collect(name) AS names",
      );
      expect(schema.records[0]!.get("names").sort()).toEqual(
        [
          "reasoning_step_id",
          "reasoning_trace_id",
          "tool_call_id",
          "tool_name",
        ].sort(),
      );
    } finally {
      await session.close();
    }
  });
});
