import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importOpenWikiAgentModule } from "../src/openwiki/agent-module.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("importOpenWikiAgentModule", () => {
  it("imports a module exporting runOpenWikiAgent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-module-"));
    temporaryDirectories.push(directory);
    const entry = join(directory, "index.mjs");
    await writeFile(
      entry,
      "export async function runOpenWikiAgent(command) { return { command, model: 'fixture' }; }\n",
    );

    const module = await importOpenWikiAgentModule(entry);

    await expect(
      module.runOpenWikiAgent("init", "/tmp", { outputMode: "repository" }),
    ).resolves.toEqual({ command: "init", model: "fixture" });
  });

  it("rejects a module without the expected export", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-module-"));
    temporaryDirectories.push(directory);
    const entry = join(directory, "index.mjs");
    await writeFile(entry, "export const somethingElse = 1;\n");

    await expect(importOpenWikiAgentModule(entry)).rejects.toThrow(
      "does not export runOpenWikiAgent",
    );
  });
});
