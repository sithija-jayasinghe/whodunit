import { exec, execOrThrow } from "../util/exec.js";

/** Run a git command inside `cwd` and return trimmed stdout. Throws on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execOrThrow("git", args, { cwd });
  return result.stdout.trim();
}

/** Run a git command, returning the raw result without throwing. */
export async function gitRaw(cwd: string, ...args: string[]) {
  return exec("git", args, { cwd });
}

/** Absolute path to the root of the repo containing `cwd`. */
export async function repoRoot(cwd: string): Promise<string> {
  const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`Not inside a Git repository: ${cwd}`);
  }
  return result.stdout.trim();
}

/** Resolve a ref (branch, tag, HEAD, sha) to a full commit sha. */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  const result = await exec("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repo });
  if (result.exitCode !== 0) {
    throw new Error(`Cannot resolve "${ref}" to a commit in ${repo}`);
  }
  return result.stdout.trim();
}

/** True when the repo has at least one commit. */
export async function hasCommits(repo: string): Promise<boolean> {
  const result = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo });
  return result.exitCode === 0;
}

/**
 * True when the working tree differs from HEAD -- tracked edits or untracked
 * files that are not ignored. This is the normal state after an agent run.
 */
export async function isDirty(repo: string): Promise<boolean> {
  const status = await git(repo, "status", "--porcelain");
  return status.length > 0;
}
