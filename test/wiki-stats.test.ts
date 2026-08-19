import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanWikiOutput } from "../src/openwiki/wiki-stats.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("scanWikiOutput", () => {
  it("counts nested files and their bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wiki-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "index.md"), "12345");
    await mkdir(join(directory, "pages"), { recursive: true });
    await writeFile(join(directory, "pages", "architecture.md"), "1234567890");

    await expect(scanWikiOutput(directory)).resolves.toEqual({
      fileCount: 2,
      totalBytes: 15,
    });
  });

  it("treats a missing output directory as zero output", async () => {
    await expect(
      scanWikiOutput("/nonexistent/openwiki-output"),
    ).resolves.toEqual({ fileCount: 0, totalBytes: 0 });
  });
});
