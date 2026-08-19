import { cp, mkdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export interface TempRepoCopyOptions {
  /** node_modules is excluded by default; pass true to copy it too. */
  includeNodeModules?: boolean;
}

/**
 * Root-level entries never copied into a trial repository: prior wiki output
 * would bias the run, and evaluation state must not recurse into itself.
 */
const EXCLUDED_ROOT_ENTRIES = new Set(["captures", "eval-runs", "openwiki"]);

/**
 * Copies a repository (including .git, so OpenWiki's git probing stays
 * realistic) into a fresh trial directory. Each evaluation trial runs on its
 * own copy, which is what makes `init` trials hermetically comparable.
 */
export async function createTempRepoCopy(
  sourceRepo: string,
  destDir: string,
  options: TempRepoCopyOptions = {},
): Promise<void> {
  const source = resolve(sourceRepo);
  const destination = resolve(destDir);
  if (destination === source || destination.startsWith(`${source}${sep}`)) {
    // Guarded here as well as by the root-entry filter: copying a repo into
    // itself would otherwise recurse forever.
    throw new Error(
      `The trial copy destination ${destination} must live outside the source repository.`,
    );
  }

  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    filter: (sourcePath) => {
      const relativePath = relative(source, sourcePath);
      if (!relativePath) {
        return true;
      }
      const segments = relativePath.split(sep);
      if (!options.includeNodeModules && segments.includes("node_modules")) {
        return false;
      }
      if (EXCLUDED_ROOT_ENTRIES.has(segments[0]!)) {
        return false;
      }
      return basename(sourcePath) !== ".DS_Store";
    },
    recursive: true,
  });
}
