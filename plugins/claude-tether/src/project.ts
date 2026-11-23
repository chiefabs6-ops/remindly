// Which Claude Code project is this? Roots from the client first, then CLAUDE_PROJECT_DIR, then cwd.

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export interface RepoInfo {
  rootDir: string;
  name: string;
  gitRemote: string | null;
  branch: string | null;
}

function git(dir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout: 1500, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** "https://github.com/acme/educator-platform.git" -> "educator-platform". */
export function repoNameFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  const m = remote.replace(/\.git$/, "").match(/([^/:\\]+)$/);
  return m ? m[1] : null;
}

/** Strip credentials from a remote URL before it is stored anywhere. */
export function safeRemote(remote: string | null): string | null {
  if (!remote) return null;
  return remote.replace(/\/\/[^/@]+@/, "//");
}

export function rootFromUri(uri: string): string | null {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

export async function describeRepo(dir: string, opts: { branch?: boolean } = {}): Promise<RepoInfo> {
  const top = (await git(dir, ["rev-parse", "--show-toplevel"])) ?? dir;
  const rootDir = top.replace(/\//g, "\\");
  const remote = safeRemote(await git(rootDir, ["remote", "get-url", "origin"]));
  const branch = opts.branch === false ? null : await git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    rootDir,
    name: repoNameFromRemote(remote) ?? basename(rootDir),
    gitRemote: remote,
    branch: branch && branch !== "HEAD" ? branch : null,
  };
}

/** Pick the project folder: explicit argument, client roots, CLAUDE_PROJECT_DIR, cwd. */
export function chooseDir(opts: { explicit?: string | null; roots?: string[]; env?: NodeJS.ProcessEnv; cwd?: string }): string {
  const env = opts.env ?? process.env;
  return (
    opts.explicit?.trim() ||
    opts.roots?.find(Boolean) ||
    env.CLAUDE_PROJECT_DIR?.trim() ||
    opts.cwd ||
    process.cwd()
  );
}
