import { mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow, exec } from "../util/exec.js";

/**
 * Directories that live inside a project but are deliberately gitignored, so a
 * fresh worktree will not contain them. Without these a test command fails for
 * the boring reason that its dependencies are missing, which would poison every
 * measurement. We symlink them in from the real project instead of copying.
 *
 * These are shared read-only by the test run. A test suite that *writes* to one
 * of them would write through to the real project, so keep this list to
 * dependency caches only.
 */
export const DEFAULT_LINKED_PATHS = [
  "node_modules",
  ".venv",
  "venv",
  "vendor/bundle",
];

export interface SandboxOptions {
  /** Extra gitignored paths to link in, relative to the repo root. */
  link?: readonly string[];
  /** Skip the defaults and link only what `link` names. */
  replaceDefaults?: boolean;
}

export interface Sandbox {
  /** Absolute path to the checked-out sandbox worktree. */
  path: string;
  /** Paths that were successfully linked in from the real project. */
  linked: string[];
  /** Detach and delete the sandbox. Safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * Check `commit` out into a throwaway worktree under the system temp dir.
 *
 * Everything whodunit does to candidate states happens in here. The user's real
 * working tree is never modified, which is the property that makes the tool
 * safe to run on uncommitted work.
 */
export async function createSandbox(
  repo: string,
  commit: string,
  options: SandboxOptions = {},
): Promise<Sandbox> {
  const parent = await mkdtemp(join(tmpdir(), "whodunit-"));
  // `git worktree add` insists on creating the leaf directory itself.
  const path = join(parent, "work");

  await execOrThrow("git", ["worktree", "add", "--detach", "--quiet", path, commit], {
    cwd: repo,
  });

  const wanted = options.replaceDefaults
    ? [...(options.link ?? [])]
    : [...DEFAULT_LINKED_PATHS, ...(options.link ?? [])];

  const linked: string[] = [];
  for (const relative of wanted) {
    const source = join(repo, relative);
    const target = join(path, relative);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      await symlink(source, target, "dir");
      linked.push(relative);
    } catch {
      // A link that cannot be made is not fatal; the test run will say so.
    }
  }

  let disposed = false;
  return {
    path,
    linked,
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Best effort: tell Git first so its administrative files stay clean,
      // then make sure the directory is actually gone.
      await exec("git", ["worktree", "remove", "--force", path], { cwd: repo });
      await rm(parent, { recursive: true, force: true });
      await exec("git", ["worktree", "prune"], { cwd: repo });
    },
  };
}
