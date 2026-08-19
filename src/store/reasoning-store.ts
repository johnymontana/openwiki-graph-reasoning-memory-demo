import type { ReasoningTrace } from "../domain/types.js";

/** One trace's roll-up for evaluation reporting. */
export interface TraceSummaryRow {
  cancelledToolCalls: number;
  completedAt: string | null;
  failedToolCalls: number;
  id: string;
  /** The stored metadata JSON string; parse client-side. */
  metadataJson: string | null;
  repository: string | null;
  sessionId: string;
  startedAt: string;
  steps: number;
  success: boolean | null;
  task: string;
  toolCalls: number;
}

/** Persistence boundary kept deliberately narrower than a full memory client. */
export interface ReasoningStore {
  close(): Promise<void>;
  ensureSchema(): Promise<void>;
  /** Indexed prefix scan over session ids (evaluation runs share a prefix). */
  fetchTraceSummaries(sessionIdPrefix: string): Promise<TraceSummaryRow[]>;
  saveTrace(trace: ReasoningTrace): Promise<void>;
}

