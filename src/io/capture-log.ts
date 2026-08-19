import { readFile } from "node:fs/promises";
import type {
  FinishTraceOptions,
  OpenWikiRunEvent,
  OpenWikiTraceRecorderOptions,
  ReasoningTrace,
  TimestampInput,
} from "../domain/types.js";
import { OpenWikiTraceRecorder } from "../capture/openwiki-trace-recorder.js";

export type OpenWikiCaptureLogEntry =
  | {
      at?: TimestampInput;
      event: OpenWikiRunEvent;
      kind: "public_event";
    }
  | {
      at?: TimestampInput;
      chunk: unknown;
      kind: "raw_chunk";
    }
  | {
      at?: TimestampInput;
      kind: "plan_snapshot";
      plan: string;
    };

export interface OpenWikiCaptureLog {
  entries: OpenWikiCaptureLogEntry[];
  finish?: FinishTraceOptions;
  trace: OpenWikiTraceRecorderOptions;
}

/** Replay a portable capture log into the reasoning-only domain model. */
export function translateCaptureLog(log: OpenWikiCaptureLog): ReasoningTrace {
  const recorder = new OpenWikiTraceRecorder(log.trace);

  for (const entry of log.entries) {
    if (entry.kind === "public_event") {
      recorder.record(entry.event, entry.at);
    } else if (entry.kind === "raw_chunk") {
      recorder.recordRawChunk(entry.chunk, entry.at);
    } else {
      recorder.recordPlanSnapshot(entry.plan, entry.at);
    }
  }

  return recorder.finish(log.finish);
}

export async function readCaptureLog(filePath: string): Promise<OpenWikiCaptureLog> {
  const source = await readFile(filePath, "utf8");
  const value = JSON.parse(source) as unknown;
  assertCaptureLog(value, filePath);
  return value;
}

function assertCaptureLog(
  value: unknown,
  filePath: string,
): asserts value is OpenWikiCaptureLog {
  if (!isRecord(value) || !isRecord(value.trace) || !Array.isArray(value.entries)) {
    throw new Error(`${filePath} is not an OpenWiki capture log.`);
  }

  for (const key of ["traceId", "sessionId", "task"] as const) {
    if (typeof value.trace[key] !== "string") {
      throw new Error(`${filePath} has an invalid trace.${key}.`);
    }
  }
  if (!isTimestampInput(value.trace.startedAt)) {
    throw new Error(`${filePath} has an invalid trace.startedAt.`);
  }
  if (value.trace.metadata !== undefined && !isRecord(value.trace.metadata)) {
    throw new Error(`${filePath} has invalid trace.metadata.`);
  }
  if (
    value.trace.repository !== undefined &&
    typeof value.trace.repository !== "string"
  ) {
    throw new Error(`${filePath} has an invalid trace.repository.`);
  }
  if (
    value.trace.maxSerializedInputChars !== undefined &&
    !Number.isInteger(value.trace.maxSerializedInputChars)
  ) {
    throw new Error(`${filePath} has invalid trace.maxSerializedInputChars.`);
  }

  if (value.finish !== undefined) {
    assertFinishOptions(value.finish, filePath);
  }

  for (const [index, entry] of value.entries.entries()) {
    if (!isRecord(entry) || typeof entry.kind !== "string") {
      throw new Error(`${filePath} has an invalid entry at index ${index}.`);
    }
    if (entry.at !== undefined && !isTimestampInput(entry.at)) {
      throw invalidEntry(filePath, index, "timestamp");
    }

    switch (entry.kind) {
      case "public_event":
        assertPublicEvent(entry.event, filePath, index);
        break;
      case "raw_chunk":
        assertRawChunk(entry.chunk, filePath, index);
        break;
      case "plan_snapshot":
        if (typeof entry.plan !== "string") {
          throw invalidEntry(filePath, index, "plan snapshot");
        }
        break;
      default:
        throw new Error(`${filePath} has an unknown entry kind at index ${index}.`);
    }
  }
}

function assertFinishOptions(value: unknown, filePath: string): void {
  if (!isRecord(value)) {
    throw new Error(`${filePath} has invalid finish options.`);
  }
  if (value.completedAt !== undefined && !isTimestampInput(value.completedAt)) {
    throw new Error(`${filePath} has invalid finish.completedAt.`);
  }
  if (value.success !== undefined && typeof value.success !== "boolean") {
    throw new Error(`${filePath} has invalid finish.success.`);
  }
}

function assertPublicEvent(
  value: unknown,
  filePath: string,
  index: number,
): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidEntry(filePath, index, "public event");
  }

  switch (value.type) {
    case "text":
      if (
        typeof value.text !== "string" ||
        (value.source !== undefined &&
          value.source !== "main" &&
          value.source !== "subgraph")
      ) {
        throw invalidEntry(filePath, index, "text event");
      }
      return;
    case "tool_start":
      if (
        typeof value.call !== "string" ||
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        !Object.hasOwn(value, "input")
      ) {
        throw invalidEntry(filePath, index, "tool_start event");
      }
      return;
    case "tool_end":
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        (value.status !== "error" && value.status !== "finished")
      ) {
        throw invalidEntry(filePath, index, "tool_end event");
      }
      return;
    case "debug":
      if (typeof value.message !== "string") {
        throw invalidEntry(filePath, index, "debug event");
      }
      return;
    default:
      throw invalidEntry(filePath, index, "public event type");
  }
}

function assertRawChunk(
  value: unknown,
  filePath: string,
  index: number,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Array.isArray(value[0]) ||
    !value[0].every((part) => typeof part === "string") ||
    (value[1] !== "messages" && value[1] !== "tools")
  ) {
    throw invalidEntry(filePath, index, "raw chunk");
  }

  if (
    value[1] === "tools" &&
    (!isRecord(value[2]) || typeof value[2].event !== "string")
  ) {
    throw invalidEntry(filePath, index, "raw tool chunk");
  }
}

function invalidEntry(filePath: string, index: number, detail: string): Error {
  return new Error(
    `${filePath} has an invalid ${detail} at entry index ${index}.`,
  );
}

function isTimestampInput(value: unknown): value is TimestampInput {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
