import type {
  FinishTraceOptions,
  OpenWikiRawStreamChunk,
  OpenWikiRunEvent,
  OpenWikiTraceRecorderOptions,
  ReasoningStep,
  ReasoningTrace,
  TimestampInput,
  ToolCall,
} from "../domain/types.js";

export const DEFAULT_MAX_SERIALIZED_INPUT_CHARS = 4_096;
export const REDACTED_VALUE = "[REDACTED]";

const TRUNCATION_MARKER = "…[TRUNCATED]";

interface ActiveToolCall {
  startedAtMs: number;
  step: ReasoningStep;
  toolCall: ToolCall;
}

interface ToolCallCaptureContext {
  correlationId?: string;
  namespace?: readonly string[];
  persistedToolCallId?: string;
  rawEvent?: string;
}

interface ToolCallCompletion {
  error?: unknown;
  id: string;
  name?: string;
  namespace?: readonly string[];
  rawEvent?: string;
  result?: unknown;
  status: "error" | "finished";
}

/**
 * Converts OpenWiki's public streaming events into a reasoning-only trace.
 *
 * The recorder deliberately does not inspect prompts, messages, or hidden model
 * state. Tool steps exist only when OpenWiki reports an invocation, and their
 * `thought` remains undefined. The sole exception is an explicitly supplied
 * `_plan.md` snapshot, which is marked observable rather than inferred.
 */
export class OpenWikiTraceRecorder {
  readonly #activeCalls = new Map<string, ActiveToolCall>();
  readonly #clock: () => TimestampInput;
  readonly #maxSerializedInputChars: number;
  readonly #outcomeChunks: string[] = [];
  readonly #startedAtMs: number;
  readonly #toolCallIdCounts = new Map<string, number>();
  readonly #trace: ReasoningTrace;
  #finished = false;
  #nextToolStepNumber = 1;
  #planStep?: ReasoningStep;

  constructor(options: OpenWikiTraceRecorderOptions) {
    this.#startedAtMs = toEpochMilliseconds(options.startedAt, "startedAt");
    this.#clock = options.clock ?? Date.now;
    this.#maxSerializedInputChars =
      options.maxSerializedInputChars ?? DEFAULT_MAX_SERIALIZED_INPUT_CHARS;

    if (!Number.isInteger(this.#maxSerializedInputChars)) {
      throw new TypeError("maxSerializedInputChars must be an integer.");
    }
    if (this.#maxSerializedInputChars < TRUNCATION_MARKER.length) {
      throw new RangeError(
        `maxSerializedInputChars must be at least ${TRUNCATION_MARKER.length}.`,
      );
    }

    this.#trace = {
      id: options.traceId,
      metadata: {
        ...sanitizeToolArguments(
          options.metadata ?? {},
          this.#maxSerializedInputChars,
        ),
        source: "openwiki",
      },
      sessionId: options.sessionId,
      startedAt: new Date(this.#startedAtMs).toISOString(),
      steps: [],
      task: options.task,
    };
  }

  /** Record one event. The optional timestamp is useful for event-log replay. */
  record(event: OpenWikiRunEvent, occurredAt?: TimestampInput): void {
    if (this.#finished) {
      throw new Error("Cannot record an event after the trace has finished.");
    }

    switch (event.type) {
      case "text":
        // OpenWiki omits source for main-agent text, so only an explicit
        // subgraph marker excludes a chunk from the final outcome.
        if (event.source !== "subgraph") {
          this.#outcomeChunks.push(event.text);
        }
        return;

      case "tool_start":
        this.#startToolCall(event, occurredAt ?? this.#clock());
        return;

      case "tool_end":
        this.#endToolCall(event, occurredAt ?? this.#clock());
        return;

      case "debug":
        return;
    }
  }

  /**
   * Record one raw chunk from OpenWiki's current
   * `[namespace, "messages" | "tools", payload]` stream.
   *
   * Returns `true` when the chunk contained an observable text or tool event.
   */
  recordRawChunk(
    chunk: OpenWikiRawStreamChunk,
    occurredAt?: TimestampInput,
  ): boolean;
  recordRawChunk(
    chunk: unknown,
    occurredAt?: TimestampInput,
  ): boolean;
  recordRawChunk(chunk: unknown, occurredAt?: TimestampInput): boolean {
    if (this.#finished) {
      throw new Error("Cannot record a chunk after the trace has finished.");
    }

    if (!isOpenWikiRawStreamChunk(chunk)) {
      return false;
    }

    const [namespace, mode, payload] = chunk;
    if (mode === "messages") {
      const text = extractObservableMessageText(payload);
      if (text.length === 0) {
        return false;
      }

      this.record({
        source: namespace.length > 1 ? "subgraph" : "main",
        text,
        type: "text",
      });
      return true;
    }

    if (!isRecord(payload)) {
      return false;
    }

    const rawEvent = getStringRecordValue(payload, "event");
    if (!rawEvent) {
      return false;
    }

    const name = getStringRecordValue(payload, "name") ?? "tool";
    const id =
      getStringRecordValue(payload, "toolCallId") ??
      getStringRecordValue(payload, "id") ??
      name;
    const correlationId = rawToolCorrelationId(namespace, id);
    const timestamp = occurredAt ?? this.#clock();

    if (isRawToolStartEvent(rawEvent)) {
      const input = payload.input;
      this.#startToolCall(
        {
          call: formatObservedToolAction(
            name,
            input,
            this.#maxSerializedInputChars,
          ),
          id,
          input,
          name,
          type: "tool_start",
        },
        timestamp,
        {
          correlationId,
          namespace,
          persistedToolCallId: scopedRawToolCallId(
            this.#trace.id,
            namespace,
            id,
          ),
          rawEvent,
        },
      );
      return true;
    }

    if (isRawToolEndEvent(rawEvent) || isRawToolErrorEvent(rawEvent)) {
      const result = Object.hasOwn(payload, "output")
        ? payload.output
        : Object.hasOwn(payload, "result")
          ? payload.result
          : undefined;
      this.#completeToolCall(
        {
          error: isRawToolErrorEvent(rawEvent) ? payload.error : undefined,
          id: correlationId,
          name,
          namespace,
          rawEvent,
          result,
          status: isRawToolErrorEvent(rawEvent) ? "error" : "finished",
        },
        timestamp,
      );
      return true;
    }

    return false;
  }

  /**
   * Store the latest plan artifact that OpenWiki made externally observable.
   * Agent Memory uses the `thought` field for the plan text, while metadata
   * makes clear that this is an explicit snapshot rather than hidden rationale.
   */
  recordPlanSnapshot(planText: string, occurredAt?: TimestampInput): void {
    if (this.#finished) {
      throw new Error("Cannot record a plan after the trace has finished.");
    }

    const observedAtMs = toEpochMilliseconds(
      occurredAt ?? this.#clock(),
      "plan timestamp",
    );
    const observedAt = new Date(observedAtMs).toISOString();
    const safePlan = truncateText(
      redactSensitiveText(planText),
      this.#maxSerializedInputChars,
    );

    if (this.#planStep) {
      const snapshotCount = this.#planStep.metadata.snapshotCount;
      this.#planStep.thought = safePlan;
      this.#planStep.metadata.snapshotCount =
        typeof snapshotCount === "number" ? snapshotCount + 1 : 2;
      this.#planStep.metadata.updatedAt = observedAt;
      return;
    }

    // Agent Memory requires positive, 1-based step numbers. The observable
    // plan is logically first, so shift already-observed tool steps when a
    // final plan snapshot arrives after them.
    for (const step of this.#trace.steps) {
      step.stepNumber += 1;
      step.id = `${this.#trace.id}:step:${step.stepNumber}`;
      for (const toolCall of step.toolCalls) {
        toolCall.stepId = step.id;
      }
    }
    this.#nextToolStepNumber += 1;

    this.#planStep = {
      action: "plan",
      createdAt: observedAt,
      id: `${this.#trace.id}:step:1`,
      metadata: {
        eventType: "plan_snapshot",
        observableOrder: 0,
        observable: true,
        snapshotCount: 1,
        source: "openwiki",
        updatedAt: observedAt,
      },
      stepNumber: 1,
      thought: safePlan,
      toolCalls: [],
      traceId: this.#trace.id,
    };
    this.#trace.steps.unshift(this.#planStep);
  }

  /**
   * Complete the trace and cancel any tool calls for which no end event arrived.
   * Repeated calls are idempotent and return the originally completed trace.
   */
  finish(options: FinishTraceOptions = {}): ReasoningTrace {
    if (this.#finished) {
      return this.#trace;
    }

    const completedAt = options.completedAt ?? this.#clock();
    const completedAtMs = toEpochMilliseconds(completedAt, "completedAt");

    for (const activeCall of this.#activeCalls.values()) {
      activeCall.toolCall.status = "cancelled";
      activeCall.toolCall.durationMs = elapsedMilliseconds(
        activeCall.startedAtMs,
        completedAtMs,
      );
      activeCall.step.observation = "cancelled";
    }
    this.#activeCalls.clear();

    const outcome = truncateText(
      redactSensitiveText(this.#outcomeChunks.join("")),
      this.#maxSerializedInputChars,
    );
    if (outcome.length > 0) {
      this.#trace.outcome = outcome;
    }

    this.#trace.completedAt = new Date(completedAtMs).toISOString();
    this.#trace.metadata.durationMs = elapsedMilliseconds(
      this.#startedAtMs,
      completedAtMs,
    );
    this.#trace.success = options.success ?? this.#deriveSuccess();
    this.#finished = true;

    return this.#trace;
  }

  #deriveSuccess(): boolean {
    return this.#trace.steps.every((step) =>
      step.toolCalls.every((toolCall) => toolCall.status === "success"),
    );
  }

  #endToolCall(
    event: Extract<OpenWikiRunEvent, { type: "tool_end" }>,
    occurredAt: TimestampInput,
  ): void {
    this.#completeToolCall(
      {
        id: event.id,
        name: event.name,
        status: event.status,
      },
      occurredAt,
    );
  }

  #completeToolCall(
    completion: ToolCallCompletion,
    occurredAt: TimestampInput,
  ): void {
    const activeCall = this.#activeCalls.get(completion.id);
    // An end event has no input or action, so it cannot form a useful standalone
    // reasoning step. Ignore it when its corresponding start was not observed.
    if (!activeCall) {
      return;
    }

    const endedAtMs = toEpochMilliseconds(occurredAt, "event timestamp");
    activeCall.toolCall.durationMs = elapsedMilliseconds(
      activeCall.startedAtMs,
      endedAtMs,
    );
    activeCall.toolCall.status =
      completion.status === "finished" ? "success" : "error";
    activeCall.step.observation = completion.status;

    if (completion.result !== undefined) {
      activeCall.toolCall.result = sanitizeCapturedValue(
        completion.result,
        this.#maxSerializedInputChars,
      );
    }
    if (completion.error !== undefined) {
      activeCall.toolCall.error = formatObservedError(
        completion.error,
        this.#maxSerializedInputChars,
      );
    }
    if (completion.name) {
      activeCall.step.metadata.openWikiEndToolName = redactSensitiveText(
        completion.name,
      );
    }
    if (completion.namespace) {
      activeCall.step.metadata.endNamespace = sanitizeNamespace(
        completion.namespace,
      );
    }
    if (completion.rawEvent) {
      activeCall.step.metadata.openWikiEndEvent = redactSensitiveText(
        completion.rawEvent,
      );
    }

    this.#activeCalls.delete(completion.id);
  }

  #startToolCall(
    event: Extract<OpenWikiRunEvent, { type: "tool_start" }>,
    occurredAt: TimestampInput,
    context: ToolCallCaptureContext = {},
  ): void {
    const startedAtMs = toEpochMilliseconds(occurredAt, "event timestamp");
    const correlationId = context.correlationId ?? event.id;

    // IDs are correlation keys in OpenWiki. If a malformed stream reuses a live
    // ID, preserve the first observation as cancelled instead of overwriting it.
    const previousCall = this.#activeCalls.get(correlationId);
    if (previousCall) {
      previousCall.toolCall.durationMs = elapsedMilliseconds(
        previousCall.startedAtMs,
        startedAtMs,
      );
      previousCall.toolCall.status = "cancelled";
      previousCall.step.observation = "cancelled";
      this.#activeCalls.delete(correlationId);
    }

    const stepNumber = this.#nextToolStepNumber;
    this.#nextToolStepNumber += 1;
    const stepId = `${this.#trace.id}:step:${stepNumber}`;
    const timestamp = new Date(startedAtMs).toISOString();
    const toolCallId = this.#claimToolCallId(
      context.persistedToolCallId ??
        `${this.#trace.id}:tool:public:${encodeIdPart(redactSensitiveText(event.id))}`,
    );
    const toolCall: ToolCall = {
      arguments: sanitizeToolArguments(
        event.input,
        this.#maxSerializedInputChars,
      ),
      createdAt: timestamp,
      id: toolCallId,
      status: "pending",
      stepId,
      toolName: redactSensitiveText(event.name),
    };
    const step: ReasoningStep = {
      action: truncateText(
        redactSensitiveText(event.call),
        this.#maxSerializedInputChars,
      ),
      createdAt: timestamp,
      id: stepId,
      metadata: {
        openWikiCallId: redactSensitiveText(event.id),
        ...(context.namespace
          ? { namespace: sanitizeNamespace(context.namespace) }
          : {}),
        ...(context.rawEvent
          ? { openWikiStartEvent: redactSensitiveText(context.rawEvent) }
          : {}),
        source: "openwiki",
      },
      stepNumber,
      thought: undefined,
      toolCalls: [toolCall],
      traceId: this.#trace.id,
    };

    this.#trace.steps.push(step);
    this.#activeCalls.set(correlationId, { startedAtMs, step, toolCall });
  }

  #claimToolCallId(baseId: string): string {
    const attempt = (this.#toolCallIdCounts.get(baseId) ?? 0) + 1;
    this.#toolCallIdCounts.set(baseId, attempt);
    return attempt === 1 ? baseId : `${baseId}:attempt:${attempt}`;
  }
}

/**
 * Recursively redacts credential-like keys and returns a JSON-safe arguments
 * object. Oversized inputs are replaced by a bounded, explicitly marked preview.
 */
export function sanitizeToolArguments(
  input: unknown,
  maxSerializedInputChars = DEFAULT_MAX_SERIALIZED_INPUT_CHARS,
): Record<string, unknown> {
  if (!Number.isInteger(maxSerializedInputChars)) {
    throw new TypeError("maxSerializedInputChars must be an integer.");
  }
  if (maxSerializedInputChars < TRUNCATION_MARKER.length) {
    throw new RangeError(
      `maxSerializedInputChars must be at least ${TRUNCATION_MARKER.length}.`,
    );
  }

  const redacted = makeJsonSafe(input, new WeakSet<object>());
  const argumentsObject = isPlainRecord(redacted)
    ? redacted
    : { input: redacted };
  const serialized = JSON.stringify(argumentsObject) ?? "{}";

  if (serialized.length <= maxSerializedInputChars) {
    return argumentsObject;
  }

  const previewLength = maxSerializedInputChars - TRUNCATION_MARKER.length;
  return {
    _originalLength: serialized.length,
    _preview: `${serialized.slice(0, previewLength)}${TRUNCATION_MARKER}`,
    _truncated: true,
  };
}

/** Redact credential assignments and recognizable token formats in free text. */
export function redactSensitiveText(value: string): string {
  let redacted = value
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
      `Bearer ${REDACTED_VALUE}`,
    )
    .replace(
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
      REDACTED_VALUE,
    )
    .replace(
      /\b(?:pk|sk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
      REDACTED_VALUE,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,
      REDACTED_VALUE,
    )
    .replace(
      /\b(?:xox[baprs]-[A-Za-z0-9-]{8,}|nams_[A-Za-z0-9_-]{8,})\b/g,
      REDACTED_VALUE,
    )
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED_VALUE)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED_VALUE)
    .replace(
      /\b(?:api|access)[_-]?token[_-][A-Za-z0-9._-]{8,}\b/gi,
      REDACTED_VALUE,
    )
    .replace(
      /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      REDACTED_VALUE,
    );

  const secretAssignment = new RegExp(
    String.raw`((?:["']?)(?:api[-_ ]?key|access[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|authorization|client[-_ ]?secret|private[-_ ]?key|password|passwd|passphrase|secret[-_ ]?key|secret|credential|credentials|cookie)(?:["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)`,
    "gi",
  );
  redacted = redacted.replace(
    secretAssignment,
    (_match: string, prefix: string, capturedValue: string) => {
      const quote = capturedValue.startsWith('"')
        ? '"'
        : capturedValue.startsWith("'")
          ? "'"
          : "";
      return `${prefix}${quote}${REDACTED_VALUE}${quote}`;
    },
  );

  return redacted;
}

function sanitizeCapturedValue(
  value: unknown,
  maxSerializedChars: number,
): unknown {
  const safeValue = makeJsonSafe(value, new WeakSet<object>());
  const serialized = JSON.stringify(safeValue) ?? "[undefined]";
  if (serialized.length <= maxSerializedChars) {
    return safeValue;
  }

  return {
    _originalLength: serialized.length,
    _preview: truncateText(serialized, maxSerializedChars),
    _truncated: true,
  };
}

function formatObservedError(error: unknown, maxSerializedChars: number): string {
  const safeError = sanitizeCapturedValue(error, maxSerializedChars);
  const text =
    typeof safeError === "string"
      ? safeError
      : (JSON.stringify(safeError) ?? String(safeError));
  return truncateText(text, maxSerializedChars);
}

function formatObservedToolAction(
  name: string,
  input: unknown,
  maxSerializedChars: number,
): string {
  const safeName = redactSensitiveText(name);
  if (input === undefined || input === null) {
    return `${safeName}()`;
  }

  const safeArguments = sanitizeToolArguments(input, maxSerializedChars);
  return truncateText(
    `${safeName}(${JSON.stringify(safeArguments) ?? ""})`,
    maxSerializedChars,
  );
}

function sanitizeNamespace(namespace: readonly string[]): string[] {
  return namespace.map(redactSensitiveText);
}

function rawToolCorrelationId(
  namespace: readonly string[],
  openWikiCallId: string,
): string {
  return `raw:${JSON.stringify([namespace, openWikiCallId])}`;
}

function scopedRawToolCallId(
  traceId: string,
  namespace: readonly string[],
  openWikiCallId: string,
): string {
  const namespaceId =
    namespace.length === 0
      ? "root"
      : `ns/${namespace.map((part) => encodeIdPart(redactSensitiveText(part))).join("/")}`;
  return `${traceId}:tool:raw:${namespaceId}:${encodeIdPart(redactSensitiveText(openWikiCallId))}`;
}

function encodeIdPart(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return value
      .split("")
      .map((character) => character.charCodeAt(0).toString(16))
      .join("");
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function isOpenWikiRawStreamChunk(
  value: unknown,
): value is OpenWikiRawStreamChunk {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Array.isArray(value[0]) ||
    !value[0].every((part) => typeof part === "string")
  ) {
    return false;
  }

  if (value[1] === "messages") {
    return true;
  }
  return (
    value[1] === "tools" &&
    isRecord(value[2]) &&
    typeof value[2].event === "string"
  );
}

function isRawToolStartEvent(event: string): boolean {
  return (
    event === "on_tool_start" ||
    event === "tool_start" ||
    event === "tool-started"
  );
}

function isRawToolEndEvent(event: string): boolean {
  return (
    event === "on_tool_end" ||
    event === "tool_end" ||
    event === "tool-finished"
  );
}

function isRawToolErrorEvent(event: string): boolean {
  return (
    event === "on_tool_error" ||
    event === "tool_error" ||
    event === "tool-error"
  );
}

function extractObservableMessageText(payload: unknown): string {
  return extractMessageTextValue(payload, new Set<object>());
}

function extractMessageTextValue(
  payload: unknown,
  seen: Set<object>,
): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (Array.isArray(payload)) {
    if (isStreamMessageTuple(payload)) {
      return extractMessageTextValue(payload[0], seen);
    }

    for (const item of payload) {
      const messageText = extractMessageTextValue(item, seen);
      if (messageText.length > 0) {
        return messageText;
      }
    }
    return payload
      .map((item) => extractContentBlockText(item, seen))
      .join("");
  }

  if (!isRecord(payload) || seen.has(payload)) {
    return "";
  }
  seen.add(payload);

  if (isRecord(payload.chunk)) {
    const chunkText = extractMessageTextValue(payload.chunk, seen);
    if (chunkText.length > 0) {
      return chunkText;
    }
  }
  if (isRecord(payload.message)) {
    const messageText = extractMessageTextValue(payload.message, seen);
    if (messageText.length > 0) {
      return messageText;
    }
  }
  if (!isObservableAssistantMessage(payload)) {
    return "";
  }

  const contentText = extractContentText(payload.content, seen);
  if (contentText.length > 0) {
    return contentText;
  }

  for (const key of [
    "text",
    "output",
    "generations",
    "messages",
    "kwargs",
    "lc_kwargs",
  ]) {
    const text = extractMessageTextValue(payload[key], seen);
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function extractContentText(content: unknown, seen: Set<object>): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => extractContentBlockText(block, seen))
      .join("");
  }
  return extractContentBlockText(content, seen);
}

function extractContentBlockText(block: unknown, seen: Set<object>): string {
  if (typeof block === "string") {
    return block;
  }
  if (!isRecord(block)) {
    return "";
  }

  const type = getStringRecordValue(block, "type")?.toLowerCase();
  if (
    type?.includes("tool") ||
    type?.includes("reasoning") ||
    type?.includes("file") ||
    type?.includes("image")
  ) {
    return "";
  }

  if (type === "text-delta" && typeof block.text === "string") {
    return block.text;
  }
  if (type === "block-delta") {
    return extractContentBlockText(block.fields, seen);
  }

  for (const key of ["text", "content", "output_text"]) {
    if (typeof block[key] === "string") {
      return block[key];
    }
  }
  if (isRecord(block.fields)) {
    return extractContentBlockText(block.fields, seen);
  }
  if (isRecord(block.delta)) {
    return extractContentBlockText(block.delta, seen);
  }

  return "";
}

function isStreamMessageTuple(value: unknown[]): boolean {
  if (value.length !== 2 || !isRecord(value[1]) || !isRecord(value[0])) {
    return false;
  }

  const metadata = value[1];
  return (
    "langgraph_node" in metadata ||
    "run_id" in metadata ||
    "tags" in metadata ||
    "metadata" in metadata
  );
}

function isObservableAssistantMessage(value: Record<string, unknown>): boolean {
  const serializedType = getSerializedMessageType(value);
  if (serializedType === "AIMessage" || serializedType === "AIMessageChunk") {
    return true;
  }
  if (
    serializedType === "HumanMessage" ||
    serializedType === "SystemMessage" ||
    serializedType === "ToolMessage"
  ) {
    return false;
  }

  const role =
    getStringRecordValue(value, "role") ??
    getStringRecordValue(value, "type") ??
    getMessageRoleFromMethod(value);
  return (
    role === null ||
    role === "ai" ||
    role === "assistant" ||
    role === "AIMessage" ||
    role === "AIMessageChunk"
  );
}

function getMessageRoleFromMethod(
  value: Record<string, unknown>,
): string | null {
  const getType = value._getType;
  if (typeof getType !== "function") {
    return null;
  }

  try {
    const role: unknown = getType.call(value);
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

function getSerializedMessageType(
  value: Record<string, unknown>,
): string | null {
  if (!Array.isArray(value.id)) {
    return null;
  }

  for (let index = value.id.length - 1; index >= 0; index -= 1) {
    const part = value.id[index];
    if (typeof part === "string") {
      return part;
    }
  }
  return null;
}

function getStringRecordValue(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function elapsedMilliseconds(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, endedAtMs - startedAtMs);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const exactSecretNames = new Set([
    "auth",
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "credentials",
    "encryptionkey",
    "password",
    "passwd",
    "passphrase",
    "privatekey",
    "secret",
    "secretkey",
    "signingkey",
    "token",
  ]);

  return (
    exactSecretNames.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials")
  );
}

function makeJsonSafe(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Date) {
    const dateValue = Number.isNaN(value.getTime())
      ? "Invalid Date"
      : value.toISOString();
    seen.delete(value);
    return dateValue;
  }

  if (value instanceof Error) {
    const errorValue: Record<string, unknown> = {
      message: redactSensitiveText(value.message),
      name: redactSensitiveText(value.name),
    };
    if (value.cause !== undefined) {
      errorValue.cause = makeJsonSafe(value.cause, seen);
    }
    seen.delete(value);
    return errorValue;
  }

  if (Array.isArray(value)) {
    const result = value.map((item) => makeJsonSafe(item, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    seen.delete(value);
    return "[Unserializable]";
  }

  for (const key of keys) {
    if (isSecretKey(key)) {
      result[key] = REDACTED_VALUE;
      continue;
    }

    try {
      result[key] = makeJsonSafe(
        (value as Record<string, unknown>)[key],
        seen,
      );
    } catch {
      result[key] = "[Unserializable]";
    }
  }
  seen.delete(value);
  return result;
}

function toEpochMilliseconds(value: TimestampInput, name: string): number {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);

  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${name} must be a valid date or epoch timestamp.`);
  }

  return milliseconds;
}
