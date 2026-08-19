import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const OPENWIKI_DIR_ENV = "OPENWIKI_DIR";

export interface OpenWikiForkLocation {
  /** Absolute path to `dist/agent/index.js` inside the fork. */
  agentEntry: string;
  /** Absolute path to the fork checkout. */
  dir: string;
}

export interface ForkProbe {
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

const DEFAULT_PROBE: ForkProbe = {
  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (path: string) => readFile(path, "utf8"),
};

/**
 * Locates the built OpenWiki fork. The demo intentionally has no package.json
 * dependency on OpenWiki (CI must install without the fork present), so the
 * checkout is resolved at runtime from OPENWIKI_DIR or the sibling default.
 */
export async function resolveOpenWikiFork(
  environment: NodeJS.ProcessEnv,
  demoRoot: string,
  probe: ForkProbe = DEFAULT_PROBE,
): Promise<OpenWikiForkLocation> {
  const configured = environment[OPENWIKI_DIR_ENV]?.trim();
  const dir = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(demoRoot, configured)
    : resolve(demoRoot, "../openwiki");

  if (!(await probe.fileExists(join(dir, "package.json")))) {
    throw new Error(
      `OpenWiki fork not found at ${dir}. Clone github.com/johnymontana/openwiki ` +
        `(branch reasoning-memory) there, or point ${OPENWIKI_DIR_ENV} at your checkout.`,
    );
  }

  const agentEntry = join(dir, "dist", "agent", "index.js");
  if (!(await probe.fileExists(agentEntry))) {
    throw new Error(
      `OpenWiki fork at ${dir} is not built (missing dist/agent/index.js). ` +
        `Run: cd ${dir} && pnpm install && pnpm build`,
    );
  }

  return { agentEntry, dir };
}

/**
 * Refuses to run against a build without the reasoning hooks: an un-patched
 * OpenWiki would silently produce empty traces and poison any evaluation.
 */
export async function assertReasoningHooksPresent(
  agentEntry: string,
  probe: ForkProbe = DEFAULT_PROBE,
): Promise<void> {
  const source = await probe.readFile(agentEntry);
  if (!source.includes("onRawStreamChunk")) {
    throw new Error(
      `${agentEntry} was built without the reasoning capture hooks. ` +
        "Check out the fork's reasoning-memory branch (or apply " +
        "patches/openwiki-main-ea80ddc-reasoning-hooks.patch) and rebuild.",
    );
  }
}
