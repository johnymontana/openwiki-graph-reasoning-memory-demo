import { describe, expect, it, vi } from "vitest";
import { ReasoningRunCapture } from "../src/integration/reasoning-run-capture.js";

describe("ReasoningRunCapture", () => {
  it("forwards public callbacks and persists the completed trace", async () => {
    const saveTrace = vi.fn(async () => undefined);
    const capture = new ReasoningRunCapture({
      sessionId: "session",
      startedAt: "2026-08-15T12:00:00.000Z",
      store: { saveTrace },
      task: "Build wiki",
      traceId: "trace",
    });

    capture.onEvent(
      {
        call: "Inspect files",
        id: "call-1",
        input: { glob: "src/**/*.ts" },
        name: "glob",
        type: "tool_start",
      },
      "2026-08-15T12:00:01.000Z",
    );
    capture.onEvent(
      { id: "call-1", name: "glob", status: "finished", type: "tool_end" },
      "2026-08-15T12:00:02.000Z",
    );
    capture.onEvent({ source: "main", text: "Wiki complete", type: "text" });

    const result = await capture.complete({
      completedAt: "2026-08-15T12:00:03.000Z",
      success: true,
    });

    expect(result.persisted).toBe(true);
    expect(result.persistenceError).toBeUndefined();
    expect(result.trace).toMatchObject({
      outcome: "Wiki complete",
      success: true,
    });
    expect(result.trace.steps[0]?.toolCalls[0]).toMatchObject({
      durationMs: 1_000,
      status: "success",
      toolName: "glob",
    });
    expect(saveTrace).toHaveBeenCalledOnce();
    expect(saveTrace).toHaveBeenCalledWith(result.trace);
  });

  it("forwards raw chunks and plan snapshots without requiring a store", async () => {
    const capture = new ReasoningRunCapture({
      sessionId: "session",
      startedAt: "2026-08-15T12:00:00.000Z",
      task: "Build wiki",
      traceId: "trace",
    });

    capture.onRawChunk(
      [
        ["agent"],
        "tools",
        {
          event: "on_tool_start",
          input: { path: "README.md" },
          name: "read_file",
          toolCallId: "call-1",
        },
      ],
      "2026-08-15T12:00:01.000Z",
    );
    capture.onPlanSnapshot("- inspect README", "2026-08-15T12:00:02.000Z");
    capture.onRawChunk(
      [
        ["agent"],
        "tools",
        {
          event: "on_tool_end",
          name: "read_file",
          output: "contents",
          toolCallId: "call-1",
        },
      ],
      "2026-08-15T12:00:03.000Z",
    );

    const result = await capture.complete({
      completedAt: "2026-08-15T12:00:04.000Z",
    });

    expect(result.persisted).toBe(false);
    expect(result.trace.steps[0]).toMatchObject({
      action: "plan",
      thought: "- inspect README",
    });
    expect(result.trace.steps[1]?.toolCalls[0]).toMatchObject({
      result: "contents",
      status: "success",
    });
  });

  it("completes and persists at most once", async () => {
    const saveTrace = vi.fn(async () => undefined);
    const capture = new ReasoningRunCapture({
      sessionId: "session",
      startedAt: "2026-08-15T12:00:00.000Z",
      store: { saveTrace },
      task: "Build wiki",
      traceId: "trace",
    });

    const firstPromise = capture.complete({
      completedAt: "2026-08-15T12:00:01.000Z",
      success: true,
    });
    const concurrentPromise = capture.complete({
      completedAt: "2026-08-15T12:00:09.000Z",
      success: false,
    });

    expect(concurrentPromise).toBe(firstPromise);
    const first = await firstPromise;
    const concurrent = await concurrentPromise;
    const later = await capture.complete({ success: false });

    expect(concurrent).toBe(first);
    expect(later).toBe(first);
    expect(first.trace.success).toBe(true);
    expect(first.trace.completedAt).toBe("2026-08-15T12:00:01.000Z");
    expect(saveTrace).toHaveBeenCalledOnce();
  });

  it("does not fail the OpenWiki completion path when Neo4j is unavailable", async () => {
    const store = {
      saveTrace: vi.fn(async () => {
        throw new Error("Aura unavailable");
      }),
    };
    const capture = new ReasoningRunCapture({
      sessionId: "session",
      startedAt: "2026-08-15T12:00:00.000Z",
      store,
      task: "Build wiki",
      traceId: "trace",
    });

    const result = await capture.complete({
      completedAt: "2026-08-15T12:00:01.000Z",
      success: true,
    });

    expect(result.persisted).toBe(false);
    expect(result.persistenceError?.message).toBe("Aura unavailable");
    expect(result.trace.success).toBe(true);
  });
});
