import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deriveRepositoryId,
  normalizeGitRemoteUrl,
} from "../src/openwiki/repository-id.js";

describe("normalizeGitRemoteUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "github.com/owner/repo"],
    ["https://user@github.com/owner/repo/", "github.com/owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "github.com/owner/repo"],
    ["ssh://git@github.com:2222/owner/repo", "github.com/owner/repo"],
    ["git@github.com:owner/repo.git", "github.com/owner/repo"],
    ["git@GitLab.example.COM:group/subgroup/repo.git", "gitlab.example.com/group/subgroup/repo"],
    ["git://github.com/owner/repo.git", "github.com/owner/repo"],
  ])("normalizes %s", (url, expected) => {
    expect(normalizeGitRemoteUrl(url)).toBe(expected);
  });

  it.each(["", "   ", "not a url", "/local/path/repo", "host.com:"])(
    "returns null for %j",
    (url) => {
      expect(normalizeGitRemoteUrl(url)).toBeNull();
    },
  );
});

describe("deriveRepositoryId", () => {
  it("prefers the normalized origin remote", async () => {
    const readRemote = vi.fn(async () => "git@github.com:owner/repo.git");

    await expect(
      deriveRepositoryId("/tmp/checkout", readRemote),
    ).resolves.toBe("github.com/owner/repo");
    expect(readRemote).toHaveBeenCalledWith(resolve("/tmp/checkout"));
  });

  it("falls back to the directory basename without a usable remote", async () => {
    await expect(
      deriveRepositoryId("/tmp/parent/my-repo", async () => null),
    ).resolves.toBe("my-repo");
    await expect(
      deriveRepositoryId("relative-dir/../my-other-repo", async () => "???"),
    ).resolves.toBe("my-other-repo");
  });

  it("uses the real git reader, falling back for a non-repository directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "no-git-here-"));
    try {
      const repository = await deriveRepositoryId(directory);
      expect(repository).toBe(basename(directory));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
