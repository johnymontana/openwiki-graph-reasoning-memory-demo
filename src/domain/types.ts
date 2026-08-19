/** The event contract exposed by OpenWiki's `onEvent` run option. */
export type OpenWikiRunEvent =
  | {
      source?: "main" | "subgraph";
      text: string;
      type: "text";
    }
  | {
      call: string;
      id: string;
      input: unknown;
      name: string;
      type: "tool_start";
    }
  | {
      id: string;
      name: string;
      status: "error" | "finished";
      type: "tool_end";
    }
  | {
      message: string;
      type: "debug";
    };

/** Current tool payload emitted by OpenWiki's `streamMode: ["tools"]`. */
export interface OpenWikiToolStreamPayload {
  error?: unknown;
  event: string;
  id?: string;
  input?: unknown;
  name?: string;
  output?: unknown;
  result?: unknown;
  toolCallId?: string;
  [key: string]: unknown;
}

/**
 * Raw chunks yielded by OpenWiki's Deep Agent stream. The namespace identifies
 * root versus subgraph execution; payloads deliberately remain open because
 * LangGraph message classes vary by provider.
 */
export type OpenWikiRawStreamChunk =
  | readonly [
      namespace: readonly string[],
      mode: "messages",
      payload: unknown,
    ]
  | readonly [
      namespace: readonly string[],
      mode: "tools",
      payload: OpenWikiToolStreamPayload,
    ];

/** Status vocabulary used by neo4j-agent-memory reasoning tool calls. */
export type ToolCallStatus =
  | "pending"
  | "success"
  | "failure"
  | "error"
  | "timeout"
  | "cancelled";

/**
 * Agent-memory-compatible representation of an observed tool invocation.
 * `arguments` is always JSON-safe so it can be persisted without executing
 * user-controlled serializers later in the ingestion path.
 */
export interface ToolCall {
  arguments: Record<string, unknown>;
  createdAt: string;
  durationMs?: number;
  error?: string;
  id: string;
  result?: unknown;
  status: ToolCallStatus;
  stepId?: string;
  toolName: string;
}

/** One observed execution step. OpenWiki does not expose model thoughts. */
export interface ReasoningStep {
  action?: string;
  createdAt: string;
  id: string;
  metadata: Record<string, unknown>;
  observation?: string;
  stepNumber: number;
  thought?: string;
  toolCalls: ToolCall[];
  traceId: string;
}

/**
 * The reasoning-only trace shape mirrored from neo4j-agent-memory.
 * No conversation messages, entities, facts, or preferences are represented.
 */
export interface ReasoningTrace {
  completedAt?: string;
  id: string;
  metadata: Record<string, unknown>;
  outcome?: string;
  /** Stable repository identifier (host/owner/repo) used to scope recall. */
  repository?: string;
  sessionId: string;
  startedAt: string;
  steps: ReasoningStep[];
  success?: boolean;
  task: string;
}

export type TimestampInput = Date | number | string;

export interface OpenWikiTraceRecorderOptions {
  /** Clock injection keeps event durations deterministic in tests and replays. */
  clock?: () => TimestampInput;
  /** Maximum characters retained in an oversized input/output/plan preview. */
  maxSerializedInputChars?: number;
  metadata?: Record<string, unknown>;
  /** Stable repository identifier (host/owner/repo) used to scope recall. */
  repository?: string;
  sessionId: string;
  startedAt: TimestampInput;
  task: string;
  traceId: string;
}

export interface FinishTraceOptions {
  completedAt?: TimestampInput;
  /**
   * If omitted, success is derived from the final tool-call statuses: true
   * only when at least one call was observed and every call succeeded, and
   * undefined (stored as null) when no calls were observed at all.
   */
  success?: boolean;
}
