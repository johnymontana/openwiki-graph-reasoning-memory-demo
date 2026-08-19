export interface ChildEnvOptions {
  /**
   * When set, HOME (and USERPROFILE) point here for the child run. This is
   * the only reliable defence against `~/.openwiki/.env` re-introducing
   * variables the run must not see: OpenWiki back-fills every env key that
   * is undefined in the process environment, so deleting a key from the
   * child env alone is not enough.
   */
  isolatedHomeDir?: string;
  modelId?: string;
}

/**
 * Builds the environment for an instrumented OpenWiki child run.
 *
 * OpenWiki resolves its provider from the environment, not the model id, and
 * an ambient OPENAI_API_KEY outranks ANTHROPIC_API_KEY — so the provider is
 * pinned to anthropic unless the caller explicitly configured another one.
 * OPENWIKI_REASONING_EFFORT is stripped because OpenWiki throws when it is
 * present for the anthropic provider.
 */
export function buildOpenWikiChildEnv(
  base: NodeJS.ProcessEnv,
  options: ChildEnvOptions = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  delete environment.OPENWIKI_REASONING_EFFORT;

  const provider = base.OPENWIKI_PROVIDER?.trim() || "anthropic";
  environment.OPENWIKI_PROVIDER = provider;
  if (provider === "anthropic" && !base.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "ANTHROPIC_API_KEY is required to run OpenWiki with the anthropic provider. " +
        "Set it in the environment (or set OPENWIKI_PROVIDER for another provider).",
    );
  }

  environment.OPENWIKI_TELEMETRY_DISABLED = "1";
  environment.DO_NOT_TRACK = "1";

  if (options.modelId) {
    environment.OPENWIKI_MODEL_ID = options.modelId;
  }
  if (options.isolatedHomeDir) {
    environment.HOME = options.isolatedHomeDir;
    environment.USERPROFILE = options.isolatedHomeDir;
  }

  return environment;
}
