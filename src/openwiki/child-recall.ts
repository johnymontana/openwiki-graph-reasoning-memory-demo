import {
  createAuraAgentMcpClientFromEnvironment,
  type AuraAgentMcpClient,
} from "../mcp/aura-agent-client.js";
import type { ReasoningMemoryClient } from "../integration/memory-context.js";

export interface ChildRecallOptions {
  repository?: string;
  /** Budget per recall; the fork tool fails open on rejection. */
  timeoutMs?: number;
}

export const DEFAULT_CHILD_RECALL_TIMEOUT_MS = 60_000;

/**
 * Builds the recall function the child hands to OpenWiki's
 * recall_reasoning_memory tool. Runs inside the child process: the MCP
 * client is constructed from the child's environment, and one client (and
 * therefore one cached token) serves every recall in the run.
 *
 * Returns undefined when the MCP environment is not configured — the caller
 * proceeds without the tool, keeping memory strictly fail-open.
 */
export function createChildRecallFunction(
  environment: NodeJS.ProcessEnv,
  options: ChildRecallOptions = {},
  createClient: (
    environment: NodeJS.ProcessEnv,
  ) => ReasoningMemoryClient = createAuraAgentMcpClientFromEnvironment as (
    environment: NodeJS.ProcessEnv,
  ) => AuraAgentMcpClient,
): ((query: string) => Promise<string>) | undefined {
  let client: ReasoningMemoryClient;
  try {
    client = createClient(environment);
  } catch {
    return undefined;
  }

  const repository = options.repository?.trim();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_RECALL_TIMEOUT_MS;

  return async (query: string): Promise<string> => {
    const question = [
      "An OpenWiki run is asking its reasoning memory mid-execution. Answer concisely with operational guidance.",
      ...(repository
        ? [
            `Repository: ${repository} — always pass this exact value as the repository tool parameter.`,
          ]
        : []),
      `Question: ${query.trim() || "What prior execution experience is relevant right now?"}`,
    ].join("\n");

    const result = await withTimeout(client.queryMemory(question), timeoutMs);
    return result.text;
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // A recall that loses the race may reject later; never let that surface as
  // an unhandled rejection inside the child (it would journal as fatal).
  promise.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`Reasoning-memory recall timed out after ${timeoutMs}ms.`),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
