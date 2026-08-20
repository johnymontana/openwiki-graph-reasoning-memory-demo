import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildRecallFunction } from "../src/openwiki/child-recall.js";
import type { ReasoningMemoryClient } from "../src/integration/memory-context.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createChildRecallFunction", () => {
  it("returns undefined when the MCP environment cannot build a client", () => {
    const recall = createChildRecallFunction({}, {}, () => {
      throw new Error("Set AURA_AGENT_MCP_ACCESS_TOKEN or client credentials.");
    });

    expect(recall).toBeUndefined();
  });

  it("scopes the mid-run question to the repository and returns the text", async () => {
    const queryMemory = vi.fn(async (_question: string) => ({
      raw: {},
      text: "Prior plan: inventory files first.",
      toolName: "memory",
    }));
    const client: ReasoningMemoryClient = { queryMemory };

    const recall = createChildRecallFunction(
      { AURA_AGENT_MCP_ACCESS_TOKEN: "token" },
      { repository: "github.com/example/demo-repo" },
      () => client,
    )!;

    await expect(recall("prior successful plan")).resolves.toBe(
      "Prior plan: inventory files first.",
    );
    const question = queryMemory.mock.calls[0]![0];
    expect(question).toContain(
      "Repository: github.com/example/demo-repo — always pass this exact value",
    );
    expect(question).toContain("Question: prior successful plan");
  });

  it("substitutes a default question for a blank query", async () => {
    const queryMemory = vi.fn(async (_question: string) => ({
      raw: {},
      text: "ok",
      toolName: "memory",
    }));

    const recall = createChildRecallFunction({}, {}, () => ({ queryMemory }))!;
    await recall("   ");

    expect(String(queryMemory.mock.calls[0]![0])).toContain(
      "What prior execution experience is relevant right now?",
    );
  });

  it("rejects when recall exceeds its timeout budget", async () => {
    vi.useFakeTimers();
    const queryMemory = vi.fn(
      () => new Promise<never>(() => undefined),
    ) as unknown as ReasoningMemoryClient["queryMemory"];

    const recall = createChildRecallFunction(
      {},
      { timeoutMs: 5_000 },
      () => ({ queryMemory }),
    )!;
    const pending = recall("anything");
    const outcome = expect(pending).rejects.toThrow(
      "Reasoning-memory recall timed out after 5000ms.",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
  });
});
