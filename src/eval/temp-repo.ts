import { cp, mkdir, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  const destinationRelativeToSource = relative(source, destination);
  const destinationInsideSource =
    destinationRelativeToSource !== "" &&
    !destinationRelativeToSource.startsWith("..") &&
    !isAbsolute(destinationRelativeToSource);
  // A destination inside the source is safe only under a directory the walk
  // prunes anyway (the default layout puts eval-runs/ inside the target repo
  // when the demo evaluates itself). Anywhere else inside the source would
  // recurse into its own output.
  if (
    destination === source ||
    (destinationInsideSource &&
      !EXCLUDED_ROOT_ENTRIES.has(destinationRelativeToSource.split(sep)[0]!))
  ) {
    throw new Error(
      `The trial copy destination ${destination} must live outside the source repository ` +
        `(or under one of: ${[...EXCLUDED_ROOT_ENTRIES].join(", ")}).`,
    );
  }

  await mkdir(destination, { recursive: true });

  // Copy per top-level entry rather than one whole-tree cp: fs.cp refuses to
  // copy a directory into its own subtree (EINVAL) even when a filter prunes
  // the branch containing the destination. Skipping the pruned roots here
  // means no individual copy ever targets a subdirectory of itself.
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (
      EXCLUDED_ROOT_ENTRIES.has(entry.name) ||
      entry.name === ".DS_Store" ||
      (!options.includeNodeModules && entry.name === "node_modules")
    ) {
      continue;
    }

    await cp(join(source, entry.name), join(destination, entry.name), {
      filter: (sourcePath) => {
        const segments = relative(source, sourcePath).split(sep);
        if (!options.includeNodeModules && segments.includes("node_modules")) {
          return false;
        }
        return basename(sourcePath) !== ".DS_Store";
      },
      recursive: true,
    });
  }
}
