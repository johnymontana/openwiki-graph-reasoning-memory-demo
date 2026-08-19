import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCaptureLog,
  translateCaptureLog,
} from "../src/io/capture-log.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("translateCaptureLog", () => {
  it("translates a plan and raw tool lifecycle without memory-domain nodes", () => {
    const trace = translateCaptureLog({
      entries: [
        { kind: "plan_snapshot", plan: "- inspect files" },
        {
          at: "2026-08-15T12:00:01.000Z",
          chunk: [
            ["agent"],
            "tools",
            {
              event: "on_tool_start",
              input: { path: "package.json" },
              name: "read_file",
              toolCallId: "call-1",
            },
          ],
          kind: "raw_chunk",
        },
        {
          at: "2026-08-15T12:00:02.000Z",
          chunk: [
            ["agent"],
            "tools",
            {
              event: "on_tool_end",
              name: "read_file",
              output: "ok",
              toolCallId: "call-1",
            },
          ],
          kind: "raw_chunk",
        },
      ],
      finish: { completedAt: "2026-08-15T12:00:03.000Z" },
      trace: {
        sessionId: "s-1",
        startedAt: "2026-08-15T12:00:00.000Z",
        task: "inspect",
        traceId: "t-1",
      },
    });

    expect(trace.steps[0]).toMatchObject({ action: "plan", stepNumber: 1 });
    expect(trace.steps[1]?.toolCalls[0]).toMatchObject({
      result: "ok",
      status: "success",
    });
    expect(JSON.stringify(trace)).not.toMatch(
      /Conversation|Message|Entity|Fact|Preference/u,
    );
  });
});

describe("readCaptureLog", () => {
  it("reads and validates the checked-in capture", async () => {
    const log = await readCaptureLog("examples/openwiki-run.json");

    expect(log.trace.traceId).toBe("openwiki-demo-001");
    expect(log.trace.repository).toBe("github.com/example/demo-repo");
    expect(log.entries.length).toBeGreaterThan(0);
    expect(translateCaptureLog(log).repository).toBe(
      "github.com/example/demo-repo",
    );
  });

  it("rejects invalid JSON", async () => {
    const filePath = await writeTemporaryCapture("{not-json", false);

    await expect(readCaptureLog(filePath)).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    {
      label: "a non-string trace id",
      mutate: (log: Record<string, any>) => {
        log.trace.traceId = 42;
      },
    },
    {
      label: "an invalid start timestamp",
      mutate: (log: Record<string, any>) => {
        log.trace.startedAt = "not-a-date";
      },
    },
    {
      label: "invalid trace metadata",
      mutate: (log: Record<string, any>) => {
        log.trace.metadata = [];
      },
    },
    {
      label: "a non-string trace repository",
      mutate: (log: Record<string, any>) => {
        log.trace.repository = 42;
      },
    },
    {
      label: "an invalid public event payload",
      mutate: (log: Record<string, any>) => {
        log.entries = [
          {
            event: {
              id: "call-1",
              name: "read_file",
              status: "pending",
              type: "tool_end",
            },
            kind: "public_event",
          },
        ];
      },
    },
    {
      label: "an invalid raw tool chunk",
      mutate: (log: Record<string, any>) => {
        log.entries = [
          { chunk: [["agent"], "tools", {}], kind: "raw_chunk" },
        ];
      },
    },
    {
      label: "a non-string plan snapshot",
      mutate: (log: Record<string, any>) => {
        log.entries = [{ kind: "plan_snapshot", plan: 7 }];
      },
    },
    {
      label: "an invalid entry timestamp",
      mutate: (log: Record<string, any>) => {
        log.entries = [
          {
            at: "yesterday-ish",
            event: { message: "debug", type: "debug" },
            kind: "public_event",
          },
        ];
      },
    },
    {
      label: "invalid finish options",
      mutate: (log: Record<string, any>) => {
        log.finish = { success: "yes" };
      },
    },
  ])("rejects $label before replay", async ({ mutate }) => {
    const log = validCaptureLog();
    mutate(log);
    const filePath = await writeTemporaryCapture(log);

    await expect(readCaptureLog(filePath)).rejects.toThrow(/invalid/iu);
  });

  it("distinguishes unknown entry kinds in diagnostics", async () => {
    const log = validCaptureLog();
    log.entries = [{ kind: "future_event" }];
    const filePath = await writeTemporaryCapture(log);

    await expect(readCaptureLog(filePath)).rejects.toThrow(
      "unknown entry kind at index 0",
    );
  });
});

function validCaptureLog(): Record<string, any> {
  return {
    entries: [
      {
        event: { source: "main", text: "Done", type: "text" },
        kind: "public_event",
      },
    ],
    finish: {
      completedAt: "2026-08-15T12:00:01.000Z",
      success: true,
    },
    trace: {
      sessionId: "session-1",
      startedAt: "2026-08-15T12:00:00.000Z",
      task: "Inspect",
      traceId: "trace-1",
    },
  };
}

async function writeTemporaryCapture(
  value: unknown,
  serialize = true,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openwiki-capture-test-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "capture.json");
  await writeFile(filePath, serialize ? JSON.stringify(value) : String(value));
  return filePath;
}
