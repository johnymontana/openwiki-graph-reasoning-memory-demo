import { describe, expect, it } from "vitest";
import {
  OpenWikiTraceRecorder,
  REDACTED_VALUE,
  sanitizeToolArguments,
} from "../src/capture/openwiki-trace-recorder.js";

const STARTED_AT = "2026-08-15T12:00:00.000Z";

function recorder(): OpenWikiTraceRecorder {
  return new OpenWikiTraceRecorder({
    clock: () => "2026-08-15T12:00:09.000Z",
    sessionId: "session-1",
    startedAt: STARTED_AT,
    task: "Inspect the OpenWiki repository",
    traceId: "trace-1",
  });
}

describe("OpenWikiTraceRecorder", () => {
  it("maps interleaved tool calls to separate steps and correlates ends by id", () => {
    const traceRecorder = recorder();

    traceRecorder.record(
      {
        call: "Read the package manifest",
        id: "call-a",
        input: { path: "package.json" },
        name: "read_file",
        type: "tool_start",
      },
      "2026-08-15T12:00:01.000Z",
    );
    traceRecorder.record(
      {
        call: "Search for agent entry points",
        id: "call-b",
        input: { pattern: "createDeepAgent" },
        name: "grep",
        type: "tool_start",
      },
      "2026-08-15T12:00:02.000Z",
    );
    traceRecorder.record(
      { id: "call-b", name: "grep", status: "finished", type: "tool_end" },
      "2026-08-15T12:00:04.250Z",
    );
    traceRecorder.record(
      {
        id: "call-a",
        name: "read_file",
        status: "error",
        type: "tool_end",
      },
      "2026-08-15T12:00:06.000Z",
    );

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:07.000Z",
    });

    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]).toMatchObject({
      action: "Read the package manifest",
      observation: "error",
      stepNumber: 1,
      thought: undefined,
    });
    expect(trace.steps[0]?.toolCalls[0]).toMatchObject({
      durationMs: 5_000,
      id: "trace-1:tool:public:call-a",
      status: "error",
      toolName: "read_file",
    });
    expect(trace.steps[1]?.toolCalls[0]).toMatchObject({
      durationMs: 2_250,
      id: "trace-1:tool:public:call-b",
      status: "success",
      toolName: "grep",
    });
    expect(trace.success).toBe(false);
    expect(trace.metadata.durationMs).toBe(7_000);
  });

  it("uses only main-agent text as the outcome and ignores debug events", () => {
    const traceRecorder = recorder();

    traceRecorder.record({ type: "text", text: "First " });
    traceRecorder.record({ type: "debug", message: "secret diagnostics" });
    traceRecorder.record({
      source: "subgraph",
      text: "subagent intermediate answer",
      type: "text",
    });
    traceRecorder.record({ source: "main", text: "answer", type: "text" });

    const trace = traceRecorder.finish({ success: true });

    expect(trace.outcome).toBe("First answer");
    expect(trace.steps).toEqual([]);
    expect(JSON.stringify(trace)).not.toContain("secret diagnostics");
    expect(JSON.stringify(trace)).not.toContain("subagent intermediate answer");
  });

  it("cancels unfinished calls at completion and computes their duration", () => {
    const traceRecorder = recorder();

    traceRecorder.record(
      {
        call: "List source files",
        id: "call-open",
        input: {},
        name: "glob",
        type: "tool_start",
      },
      "2026-08-15T12:00:03.000Z",
    );

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:08.500Z",
    });

    expect(trace.steps[0]?.observation).toBe("cancelled");
    expect(trace.steps[0]?.toolCalls[0]).toMatchObject({
      durationMs: 5_500,
      status: "cancelled",
    });
    expect(trace.success).toBe(false);
  });

  it("recursively redacts secret-looking keys without redacting ordinary values", () => {
    const argumentsObject = sanitizeToolArguments({
      auth: "Bearer auth-value",
      request: {
        accessToken: "access-token-value",
        nested: [{ api_key: "api-key-value", query: "token economics" }],
      },
      password: "password-value",
      tokenCount: 42,
    });

    expect(argumentsObject).toEqual({
      auth: REDACTED_VALUE,
      request: {
        accessToken: REDACTED_VALUE,
        nested: [{ api_key: REDACTED_VALUE, query: "token economics" }],
      },
      password: REDACTED_VALUE,
      tokenCount: 42,
    });
    expect(JSON.stringify(argumentsObject)).not.toContain("auth-value");
    expect(JSON.stringify(argumentsObject)).not.toContain("access-token-value");
    expect(JSON.stringify(argumentsObject)).not.toContain("api-key-value");
    expect(JSON.stringify(argumentsObject)).not.toContain("password-value");
  });

  it("replaces oversized serialized inputs with a bounded marked preview", () => {
    const maxChars = 64;
    const argumentsObject = sanitizeToolArguments(
      { content: "x".repeat(1_000), secret: "never-retain-this" },
      maxChars,
    );

    expect(argumentsObject._truncated).toBe(true);
    expect(argumentsObject._originalLength).toBeGreaterThan(maxChars);
    expect(String(argumentsObject._preview)).toHaveLength(maxChars);
    expect(argumentsObject._preview).toContain("[TRUNCATED]");
    expect(JSON.stringify(argumentsObject)).not.toContain("never-retain-this");
  });

  it("keeps thought undefined rather than treating text or debug as reasoning", () => {
    const traceRecorder = recorder();
    traceRecorder.record({ type: "debug", message: "model is thinking" });
    traceRecorder.record({ source: "main", text: "Done", type: "text" });
    traceRecorder.record(
      {
        call: "Inspect README",
        id: "call-readme",
        input: "README.md",
        name: "read_file",
        type: "tool_start",
      },
      "2026-08-15T12:00:01.000Z",
    );
    traceRecorder.record(
      {
        id: "call-readme",
        name: "read_file",
        status: "finished",
        type: "tool_end",
      },
      "2026-08-15T12:00:02.000Z",
    );

    const trace = traceRecorder.finish({ success: true });

    expect(trace.steps[0]).toHaveProperty("thought", undefined);
    expect(trace.steps[0]?.toolCalls[0]?.arguments).toEqual({
      input: "README.md",
    });
  });

  it("captures and correlates interleaved raw calls by namespace and provider id", () => {
    const traceRecorder = recorder();

    traceRecorder.recordRawChunk(
      [
        ["root", "research:a"],
        "tools",
        {
          event: "on_tool_start",
          input: {
            authorization: "Bearer input-token-123456",
            query: "agent memory",
          },
          name: "search",
          toolCallId: "reused-id",
        },
      ],
      "2026-08-15T12:00:01.000Z",
    );
    traceRecorder.recordRawChunk(
      [
        ["root", "research:b"],
        "tools",
        {
          event: "on_tool_start",
          input: { query: "Aura Agent" },
          name: "search",
          toolCallId: "reused-id",
        },
      ],
      "2026-08-15T12:00:02.000Z",
    );
    traceRecorder.recordRawChunk(
      [
        ["root", "research:b"],
        "tools",
        {
          error: "request failed with Bearer error-token-123456",
          event: "on_tool_error",
          name: "search",
          toolCallId: "reused-id",
        },
      ],
      "2026-08-15T12:00:03.000Z",
    );
    traceRecorder.recordRawChunk(
      [
        ["root", "research:a"],
        "tools",
        {
          event: "on_tool_end",
          name: "search",
          output: {
            apiKey: "output-key-must-not-survive",
            answer: "found",
            proof: "sk-proj-abcdefghijklmnop",
          },
          toolCallId: "reused-id",
        },
      ],
      "2026-08-15T12:00:05.000Z",
    );

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:06.000Z",
    });
    const first = trace.steps[0];
    const second = trace.steps[1];

    expect(first?.metadata).toMatchObject({
      namespace: ["root", "research:a"],
      openWikiCallId: "reused-id",
      openWikiEndEvent: "on_tool_end",
    });
    expect(first?.toolCalls[0]).toMatchObject({
      durationMs: 4_000,
      id: "trace-1:tool:raw:ns/root/research%3Aa:reused-id",
      result: {
        apiKey: REDACTED_VALUE,
        answer: "found",
        proof: REDACTED_VALUE,
      },
      status: "success",
    });
    expect(second?.metadata.namespace).toEqual(["root", "research:b"]);
    expect(second?.toolCalls[0]).toMatchObject({
      durationMs: 1_000,
      id: "trace-1:tool:raw:ns/root/research%3Ab:reused-id",
      status: "error",
    });
    expect(second?.toolCalls[0]?.error).toContain(REDACTED_VALUE);
    expect(JSON.stringify(trace)).not.toContain("input-token-123456");
    expect(JSON.stringify(trace)).not.toContain("error-token-123456");
    expect(JSON.stringify(trace)).not.toContain("output-key-must-not-survive");
    expect(JSON.stringify(trace)).not.toContain("sk-proj-abcdefghijklmnop");
  });

  it("ignores duplicate start events for a still-active call", () => {
    // Live LangGraph streams re-emit on_tool_start for active calls; the
    // repeats must not manufacture phantom cancelled calls.
    const traceRecorder = recorder();
    const start = {
      event: "on_tool_start",
      input: { path: "src/index.ts" },
      name: "read_file",
      toolCallId: "call-1",
    };

    traceRecorder.recordRawChunk([["agent"], "tools", start], "2026-08-15T12:00:01.000Z");
    traceRecorder.recordRawChunk([["agent"], "tools", start], "2026-08-15T12:00:02.000Z");
    traceRecorder.recordRawChunk(
      [
        ["agent"],
        "tools",
        { event: "on_tool_end", name: "read_file", output: "ok", toolCallId: "call-1" },
      ],
      "2026-08-15T12:00:03.000Z",
    );

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:04.000Z",
    });

    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]?.toolCalls).toHaveLength(1);
    expect(trace.steps[0]?.toolCalls[0]).toMatchObject({
      durationMs: 2_000,
      status: "success",
    });
    expect(trace.steps[0]?.metadata.duplicateStartCount).toBe(1);
    expect(trace.success).toBe(true);
  });

  it("cancels the previous call when a live id is reused for a different tool", () => {
    const traceRecorder = recorder();

    traceRecorder.recordRawChunk(
      [
        ["agent"],
        "tools",
        { event: "on_tool_start", input: {}, name: "read_file", toolCallId: "call-1" },
      ],
      "2026-08-15T12:00:01.000Z",
    );
    traceRecorder.recordRawChunk(
      [
        ["agent"],
        "tools",
        { event: "on_tool_start", input: {}, name: "write_file", toolCallId: "call-1" },
      ],
      "2026-08-15T12:00:02.000Z",
    );
    traceRecorder.recordRawChunk(
      [
        ["agent"],
        "tools",
        { event: "on_tool_end", name: "write_file", toolCallId: "call-1" },
      ],
      "2026-08-15T12:00:03.000Z",
    );

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:04.000Z",
    });

    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]?.toolCalls[0]?.status).toBe("cancelled");
    expect(trace.steps[1]?.toolCalls[0]?.status).toBe("success");
    expect(trace.success).toBe(false);
  });

  it("extracts only observable main text from raw message tuples", () => {
    const traceRecorder = new OpenWikiTraceRecorder({
      maxSerializedInputChars: 64,
      sessionId: "session-1",
      startedAt: STARTED_AT,
      task: "Answer safely",
      traceId: "trace-raw-text",
    });

    traceRecorder.recordRawChunk([
      ["agent"],
      "messages",
      [
        {
          content: [
            { reasoning: "private rationale", type: "reasoning" },
            {
              text: `Visible Bearer outcome-token-123456 ${"x".repeat(100)}`,
              type: "text",
            },
          ],
          role: "assistant",
        },
        { langgraph_node: "model" },
      ],
    ]);
    traceRecorder.recordRawChunk([
      ["agent"],
      "messages",
      [
        {
          _getType: () => "human",
          content: "live human prompt must not become outcome",
        },
        { langgraph_node: "model" },
      ],
    ]);
    traceRecorder.recordRawChunk([
      ["agent", "subgraph:1"],
      "messages",
      { content: "subgraph answer", role: "assistant" },
    ]);
    traceRecorder.recordRawChunk([
      ["agent"],
      "messages",
      [
        {
          content: "human prompt must not become outcome",
          id: ["langchain_core", "messages", "HumanMessage"],
        },
        { langgraph_node: "model" },
      ],
    ]);

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:01.000Z",
    });

    expect(trace.outcome).toContain(REDACTED_VALUE);
    expect(trace.outcome).toContain("[TRUNCATED]");
    expect(trace.outcome).toHaveLength(64);
    expect(JSON.stringify(trace)).not.toContain("private rationale");
    expect(JSON.stringify(trace)).not.toContain("outcome-token-123456");
    expect(JSON.stringify(trace)).not.toContain("subgraph answer");
    expect(JSON.stringify(trace)).not.toContain(
      "human prompt must not become outcome",
    );
    expect(JSON.stringify(trace)).not.toContain(
      "live human prompt must not become outcome",
    );
  });

  it("inserts and updates an explicit plan as the first 1-based step", () => {
    const traceRecorder = recorder();
    traceRecorder.record(
      {
        call: "Inspect files",
        id: "call-before-plan",
        input: {},
        name: "read_file",
        type: "tool_start",
      },
      "2026-08-15T12:00:01.000Z",
    );
    traceRecorder.recordPlanSnapshot(
      '- inspect files\napiKey: "plan-key-must-not-survive"',
      "2026-08-15T12:00:02.000Z",
    );
    traceRecorder.recordPlanSnapshot(
      '- inspect carefully\napiKey="latest-plan-key"\nAuthorization: Bearer plan-token-123456',
      "2026-08-15T12:00:03.000Z",
    );
    traceRecorder.record(
      {
        id: "call-before-plan",
        name: "read_file",
        status: "finished",
        type: "tool_end",
      },
      "2026-08-15T12:00:04.000Z",
    );

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:05.000Z",
    });

    expect(trace.steps[0]).toMatchObject({
      action: "plan",
      id: "trace-1:step:1",
      metadata: {
        eventType: "plan_snapshot",
        observable: true,
        observableOrder: 0,
        snapshotCount: 2,
      },
      stepNumber: 1,
    });
    expect(trace.steps[0]?.thought).toContain("- inspect carefully");
    expect(trace.steps[0]?.thought).toContain(REDACTED_VALUE);
    expect(trace.steps[1]).toMatchObject({
      id: "trace-1:step:2",
      stepNumber: 2,
      thought: undefined,
    });
    expect(trace.steps[1]?.toolCalls[0]?.stepId).toBe("trace-1:step:2");
    expect(JSON.stringify(trace)).not.toContain("plan-key-must-not-survive");
    expect(JSON.stringify(trace)).not.toContain("latest-plan-key");
    expect(JSON.stringify(trace)).not.toContain("plan-token-123456");
  });

  it("bounds raw tool outputs after recursive redaction", () => {
    const traceRecorder = new OpenWikiTraceRecorder({
      maxSerializedInputChars: 64,
      sessionId: "session-1",
      startedAt: STARTED_AT,
      task: "Capture output",
      traceId: "trace-output",
    });
    traceRecorder.recordRawChunk(
      [
        [],
        "tools",
        {
          event: "on_tool_start",
          input: {},
          name: "large_tool",
          toolCallId: "large-call",
        },
      ],
      "2026-08-15T12:00:01.000Z",
    );
    traceRecorder.recordRawChunk(
      [
        [],
        "tools",
        {
          event: "on_tool_end",
          name: "large_tool",
          output: { password: "output-password", body: "x".repeat(1_000) },
          toolCallId: "large-call",
        },
      ],
      "2026-08-15T12:00:02.000Z",
    );

    const trace = traceRecorder.finish({
      completedAt: "2026-08-15T12:00:03.000Z",
    });
    const result = trace.steps[0]?.toolCalls[0]?.result as
      | Record<string, unknown>
      | undefined;

    expect(result?._truncated).toBe(true);
    expect(String(result?._preview)).toHaveLength(64);
    expect(JSON.stringify(trace)).not.toContain("output-password");
  });

  it("copies a redacted repository identifier onto the trace", () => {
    const scoped = new OpenWikiTraceRecorder({
      repository: "github.com/example/demo-repo",
      sessionId: "session-1",
      startedAt: STARTED_AT,
      task: "Scoped capture",
      traceId: "trace-repo",
    });
    const secretRepository = new OpenWikiTraceRecorder({
      repository: "Bearer abcdef1234567890",
      sessionId: "session-1",
      startedAt: STARTED_AT,
      task: "Scoped capture",
      traceId: "trace-repo-secret",
    });

    expect(scoped.finish().repository).toBe("github.com/example/demo-repo");
    expect(secretRepository.finish().repository).toBe(
      `Bearer ${REDACTED_VALUE}`,
    );
    expect(recorder().finish({ success: true }).repository).toBeUndefined();
  });

  it("derives success only from observed tool-call evidence", () => {
    // No observed tool calls: success is unknowable, not true.
    expect(recorder().finish().success).toBeUndefined();

    const successful = recorder();
    successful.record(
      {
        call: "read_file(package.json)",
        id: "call-1",
        input: {},
        name: "read_file",
        type: "tool_start",
      },
      "2026-08-15T12:00:01.000Z",
    );
    successful.record(
      { id: "call-1", name: "read_file", status: "finished", type: "tool_end" },
      "2026-08-15T12:00:02.000Z",
    );
    expect(successful.finish().success).toBe(true);

    // An unfinished call is cancelled at completion and blocks derived success.
    const dangling = recorder();
    dangling.record(
      {
        call: "read_file(package.json)",
        id: "call-2",
        input: {},
        name: "read_file",
        type: "tool_start",
      },
      "2026-08-15T12:00:01.000Z",
    );
    expect(dangling.finish().success).toBe(false);
  });
});
