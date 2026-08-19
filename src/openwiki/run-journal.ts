import { appendFileSync } from "node:fs";
import type { OpenWikiCaptureLogEntry } from "../io/capture-log.js";

/**
 * Serializable recorder options written as the journal header. Matches
 * OpenWikiTraceRecorderOptions minus the non-serializable clock injection.
 */
export interface JournalTraceOptions {
  maxSerializedInputChars?: number;
  metadata?: Record<string, unknown>;
  repository?: string;
  sessionId: string;
  startedAt: string;
  task: string;
  traceId: string;
}

export interface JournalFinish {
  completedAt?: string;
  success?: boolean;
}

export interface JournalRunResult {
  command: string;
  model: string;
  skipped?: boolean;
}

export type RunJournalLine =
  | OpenWikiCaptureLogEntry
  | { kind: "fatal"; message: string; source: string }
  | { finish?: JournalFinish; kind: "finish"; runResult?: JournalRunResult }
  | { kind: "header"; trace: JournalTraceOptions; version: 1 };

export interface ParsedRunJournal {
  entries: OpenWikiCaptureLogEntry[];
  fatal?: { message: string; source: string };
  finish?: JournalFinish;
  header?: JournalTraceOptions;
  /** Lines that could not be parsed or carried an unknown kind. */
  ignoredLineCount: number;
  runResult?: JournalRunResult;
}

/**
 * Appends one journal line synchronously. The journal is the crash barrier:
 * per-line synchronous appends survive a `process.exit` mid-run and are
 * cheap relative to the network-paced LangGraph stream that feeds them.
 */
export function appendJournalLine(
  filePath: string,
  line: RunJournalLine,
): void {
  appendFileSync(filePath, `${JSON.stringify(line)}\n`);
}

const CAPTURE_ENTRY_KINDS = new Set(["plan_snapshot", "public_event", "raw_chunk"]);

/**
 * Parses a run journal, tolerating a truncated final line (the child may
 * have been killed mid-append). Entry validation is deliberately left to
 * the capture-log layer, which the parsed entries flow through next.
 */
export function parseRunJournal(source: string): ParsedRunJournal {
  const parsed: ParsedRunJournal = { entries: [], ignoredLineCount: 0 };

  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      parsed.ignoredLineCount += 1;
      continue;
    }
    if (value === null || typeof value !== "object") {
      parsed.ignoredLineCount += 1;
      continue;
    }

    const record = value as Record<string, unknown> & { kind?: unknown };
    switch (record.kind) {
      case "header":
        parsed.header = record.trace as JournalTraceOptions;
        break;
      case "finish":
        parsed.finish = record.finish as JournalFinish | undefined;
        parsed.runResult = record.runResult as JournalRunResult | undefined;
        break;
      case "fatal":
        parsed.fatal = {
          message: String(record.message ?? "unknown fatal error"),
          source: String(record.source ?? "unknown"),
        };
        break;
      default:
        if (
          typeof record.kind === "string" &&
          CAPTURE_ENTRY_KINDS.has(record.kind)
        ) {
          parsed.entries.push(record as unknown as OpenWikiCaptureLogEntry);
        } else {
          parsed.ignoredLineCount += 1;
        }
    }
  }

  return parsed;
}
