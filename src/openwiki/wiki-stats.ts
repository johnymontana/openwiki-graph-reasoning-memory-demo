import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface WikiOutputStats {
  fileCount: number;
  totalBytes: number;
}

/**
 * Sizes the wiki output a run produced under `<repo>/openwiki/`. OpenWiki's
 * run result reports no file list, so this scan is the only output metric.
 * A missing directory (failed or skipped run) counts as zero output.
 */
export async function scanWikiOutput(dir: string): Promise<WikiOutputStats> {
  const stats: WikiOutputStats = { fileCount: 0, totalBytes: 0 };
  await scanDirectory(dir, stats);
  return stats;
}

async function scanDirectory(
  dir: string,
  stats: WikiOutputStats,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(entryPath, stats);
    } else if (entry.isFile()) {
      stats.fileCount += 1;
      try {
        stats.totalBytes += (await stat(entryPath)).size;
      } catch {
        // The file vanished mid-scan; keep the count without its size.
      }
    }
  }
}
