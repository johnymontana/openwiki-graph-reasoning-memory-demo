import type { ReasoningTrace } from "../domain/types.js";

/** Persistence boundary kept deliberately narrower than a full memory client. */
export interface ReasoningStore {
  close(): Promise<void>;
  ensureSchema(): Promise<void>;
  saveTrace(trace: ReasoningTrace): Promise<void>;
}

