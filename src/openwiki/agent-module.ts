import { pathToFileURL } from "node:url";

/**
 * The narrow surface this project uses from the OpenWiki fork's
 * `dist/agent/index.js`. The package publishes no export map, so the module
 * is deep-imported at runtime and never statically linked; keep this type in
 * sync with `runOpenWikiAgent` on the fork's `reasoning-memory` branch.
 */
export interface OpenWikiAgentRunOptions {
  debug?: boolean;
  modelId?: string | null;
  onEvent?: (event: unknown) => void;
  /** Reasoning-hooks patch: observable `_plan.md` snapshot before cleanup. */
  onPlanSnapshot?: (plan: string) => void | Promise<void>;
  /** Reasoning-hooks patch: lossless LangGraph stream seam. */
  onRawStreamChunk?: (chunk: unknown) => void | Promise<void>;
  /**
   * Always "repository" here. OpenWiki discards the cwd argument entirely
   * when outputMode is omitted, so the field is deliberately required.
   */
  outputMode: "repository";
  threadId?: string;
  userMessage?: string | null;
}

export interface OpenWikiAgentRunResult {
  command: string;
  model: string;
  skipped?: boolean;
}

export interface OpenWikiAgentModule {
  runOpenWikiAgent(
    command: "init" | "update",
    cwd: string,
    options: OpenWikiAgentRunOptions,
  ): Promise<OpenWikiAgentRunResult>;
}

/**
 * Dynamically imports the fork's agent entry point. Loading is confined to
 * the child-run process: the module pulls in a native better-sqlite3 binding
 * at import time and must never be reachable from unit tests or CI.
 */
export async function importOpenWikiAgentModule(
  agentEntry: string,
): Promise<OpenWikiAgentModule> {
  const module = (await import(
    pathToFileURL(agentEntry).href
  )) as Partial<OpenWikiAgentModule>;

  if (typeof module.runOpenWikiAgent !== "function") {
    throw new Error(
      `${agentEntry} does not export runOpenWikiAgent; rebuild the OpenWiki fork (pnpm install && pnpm build).`,
    );
  }
  return module as OpenWikiAgentModule;
}
