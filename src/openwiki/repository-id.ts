import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRemoteReader = (repoPath: string) => Promise<string | null>;

const defaultRemoteReader: GitRemoteReader = async (repoPath) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "remote", "get-url", "origin"],
      { timeout: 5_000 },
    );
    const url = stdout.trim();
    return url ? url : null;
  } catch {
    return null;
  }
};

/**
 * Normalizes a git remote URL to a stable `host/owner/repo` identifier.
 * Handles https://, ssh://, and scp-like (git@host:owner/repo.git) forms.
 * Returns null for values that do not look like a remote URL.
 */
export function normalizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const schemeMatch =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/iu.exec(
      trimmed,
    );
  const scpMatch = schemeMatch
    ? null
    : /^(?:[^@\s]+@)?([^:/\s]+\.[^:/\s]+):(.+)$/u.exec(trimmed);
  const match = schemeMatch ?? scpMatch;
  if (!match) {
    return null;
  }

  const host = match[1]!.toLowerCase();
  const path = match[2]!
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "")
    .replace(/^\/+/u, "");
  if (!path) {
    return null;
  }

  return `${host}/${path}`;
}

/**
 * Derives the stable repository identifier used to scope reasoning memory:
 * the normalized origin remote when one exists, otherwise the directory
 * basename. Evaluation harnesses must derive this once from the source
 * repository and pass it explicitly — temp copies never re-derive it.
 */
export async function deriveRepositoryId(
  repoPath: string,
  readRemote: GitRemoteReader = defaultRemoteReader,
): Promise<string> {
  const absolutePath = resolve(repoPath);
  const remoteUrl = await readRemote(absolutePath);
  if (remoteUrl) {
    const normalized = normalizeGitRemoteUrl(remoteUrl);
    if (normalized) {
      return normalized;
    }
  }

  return basename(absolutePath);
}
