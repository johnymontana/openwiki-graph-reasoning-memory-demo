import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendJournalLine,
  parseRunJournal,
  type RunJournalLine,
} from "../src/openwiki/run-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const HEADER: RunJournalLine = {
  kind: "header",
  trace: {
    repository: "github.com/example/demo-repo",
    sessionId: "session-1",
    startedAt: "2026-08-19T00:00:00.000Z",
    task: "init the OpenWiki",
    traceId: "trace-1",
  },
  version: 1,
};

describe("run journal", () => {
  it("appends and parses a complete run round trip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "journal-"));
    temporaryDirectories.push(directory);
    const journalPath = join(directory, "journal.jsonl");

    appendJournalLine(journalPath, HEADER);
    appendJournalLine(journalPath, {
      at: "2026-08-19T00:00:01.000Z",
      kind: "plan_snapshot",
      plan: "- inspect files",
    });
    appendJournalLine(journalPath, {
      at: "2026-08-19T00:00:02.000Z",
      chunk: [["agent"], "tools", { event: "on_tool_start", name: "glob" }],
      kind: "raw_chunk",
    });
    appendJournalLine(journalPath, {
      finish: { completedAt: "2026-08-19T00:00:03.000Z" },
      kind: "finish",
      runResult: { command: "init", model: "claude-haiku-4-5" },
    });

    const parsed = parseRunJournal(await readFile(journalPath, "utf8"));

    expect(parsed.header?.traceId).toBe("trace-1");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({ kind: "plan_snapshot" });
    expect(parsed.entries[1]).toMatchObject({ kind: "raw_chunk" });
    expect(parsed.finish?.completedAt).toBe("2026-08-19T00:00:03.000Z");
    expect(parsed.finish?.success).toBeUndefined();
    expect(parsed.runResult).toEqual({
      command: "init",
      model: "claude-haiku-4-5",
    });
    expect(parsed.fatal).toBeUndefined();
    expect(parsed.ignoredLineCount).toBe(0);
  });

  it("tolerates a truncated final line from a killed child", () => {
    const source = [
      JSON.stringify(HEADER),
      JSON.stringify({ at: "t", kind: "plan_snapshot", plan: "p" }),
      '{"kind":"raw_chunk","chunk":[["agent"],"tools",{"ev',
    ].join("\n");

    const parsed = parseRunJournal(source);

    expect(parsed.header?.traceId).toBe("trace-1");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.ignoredLineCount).toBe(1);
    expect(parsed.finish).toBeUndefined();
  });

  it("captures fatal lines and ignores unknown kinds and scalars", () => {
    const source = [
      JSON.stringify(HEADER),
      JSON.stringify({ kind: "future_kind", payload: 1 }),
      JSON.stringify(42),
      JSON.stringify({ kind: "fatal", message: "boom", source: "run" }),
      "",
    ].join("\n");

    const parsed = parseRunJournal(source);

    expect(parsed.fatal).toEqual({ message: "boom", source: "run" });
    expect(parsed.ignoredLineCount).toBe(2);
    expect(parsed.entries).toHaveLength(0);
  });

  it("parses an empty journal to an empty result", () => {
    expect(parseRunJournal("")).toEqual({ entries: [], ignoredLineCount: 0 });
  });
});
