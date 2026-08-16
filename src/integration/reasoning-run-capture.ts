import { OpenWikiTraceRecorder } from "../capture/openwiki-trace-recorder.js";
import type {
  FinishTraceOptions,
  OpenWikiRunEvent,
  OpenWikiTraceRecorderOptions,
  ReasoningTrace,
  TimestampInput,
} from "../domain/types.js";
import type { ReasoningStore } from "../store/reasoning-store.js";

export interface CompletedReasoningCapture {
  persisted: boolean;
  persistenceError?: Error;
  trace: ReasoningTrace;
}

export interface ReasoningRunCaptureOptions extends OpenWikiTraceRecorderOptions {
  /** Neo4j failures are reported in the result and never fail the OpenWiki run. */
  store?: Pick<ReasoningStore, "saveTrace">;
}

/**
 * Thin integration boundary for an instrumented OpenWiki run.
 *
 * Wire `onRawChunk` immediately inside OpenWiki's `for await (const chunk of
 * stream)` loop, before `parseAgentStreamChunk`. Use `onEvent` only as the
 * lower-fidelity fallback supplied by OpenWiki's public API.
 */
export class ReasoningRunCapture {
  #completion?: Promise<CompletedReasoningCapture>;
  readonly #recorder: OpenWikiTraceRecorder;
  readonly #store?: Pick<ReasoningStore, "saveTrace">;

  constructor(options: ReasoningRunCaptureOptions) {
    this.#recorder = new OpenWikiTraceRecorder(options);
    this.#store = options.store;
  }

  onEvent = (event: OpenWikiRunEvent, occurredAt?: TimestampInput): void => {
    this.#recorder.record(event, occurredAt);
  };

  onRawChunk = (chunk: unknown, occurredAt?: TimestampInput): void => {
    this.#recorder.recordRawChunk(chunk, occurredAt);
  };

  onPlanSnapshot = (plan: string, occurredAt?: TimestampInput): void => {
    this.#recorder.recordPlanSnapshot(plan, occurredAt);
  };

  complete(
    options: FinishTraceOptions = {},
  ): Promise<CompletedReasoningCapture> {
    this.#completion ??= this.#completeOnce(options);
    return this.#completion;
  }

  async #completeOnce(
    options: FinishTraceOptions,
  ): Promise<CompletedReasoningCapture> {
    const trace = this.#recorder.finish(options);
    if (!this.#store) {
      return { persisted: false, trace };
    }

    try {
      await this.#store.saveTrace(trace);
      return { persisted: true, trace };
    } catch (error) {
      return {
        persisted: false,
        persistenceError:
          error instanceof Error ? error : new Error(String(error)),
        trace,
      };
    }
  }
}
