import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepoCopy } from "../src/eval/temp-repo.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createSourceRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "temp-repo-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  await mkdir(join(source, ".git"), { recursive: true });
  await writeFile(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(source, "README.md"), "hello");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "index.ts"), "export {};");
  await mkdir(join(source, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(source, "node_modules", "pkg", "index.js"), "x");
  await mkdir(join(source, "openwiki"), { recursive: true });
  await writeFile(join(source, "openwiki", "index.md"), "old wiki output");
  await mkdir(join(source, "eval-runs", "old"), { recursive: true });
  await writeFile(join(source, "eval-runs", "old", "results.json"), "{}");
  return source;
}

describe("createTempRepoCopy", () => {
  it("copies sources and .git but excludes wiki output, node_modules, and eval state", async () => {
    const source = await createSourceRepo();
    const destination = join(source, "..", "copy");

    await createTempRepoCopy(source, destination);

    expect(await exists(join(destination, "README.md"))).toBe(true);
    expect(await exists(join(destination, "src", "index.ts"))).toBe(true);
    expect(await exists(join(destination, ".git", "HEAD"))).toBe(true);
    expect(await exists(join(destination, "node_modules"))).toBe(false);
    expect(await exists(join(destination, "openwiki"))).toBe(false);
    expect(await exists(join(destination, "eval-runs"))).toBe(false);
  });

  it("can include node_modules when explicitly requested", async () => {
    const source = await createSourceRepo();
    const destination = join(source, "..", "copy-with-modules");

    await createTempRepoCopy(source, destination, {
      includeNodeModules: true,
    });

    expect(
      await exists(join(destination, "node_modules", "pkg", "index.js")),
    ).toBe(true);
  });

  it("refuses to copy a repository into itself", async () => {
    const source = await createSourceRepo();

    await expect(
      createTempRepoCopy(source, join(source, "nested-copy")),
    ).rejects.toThrow("must live outside the source repository");
  });
});
