import { exec, execOrThrow } from "../util/exec.js";

export interface DiffOptions {
  /** Lines of context per hunk. Fewer means finer granularity but less
   *  reliable placement when hunks are applied in isolation. */
  contextLines?: number;
}

export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Produce the unified diff between two commits.
 *
 * Renames are expanded into a delete plus an add (`--no-renames`) because a
 * rename cannot be half-applied, and treating it as two ordinary changes keeps
 * every hunk independently selectable. `--binary` makes binary changes
 * applyable rather than just reported.
 */
export async function diffCommits(
  repo: string,
  base: string,
  head: string,
  options: DiffOptions = {},
): Promise<string> {
  const context = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const result = await execOrThrow(
    "git",
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--binary",
      `--unified=${context}`,
      base,
      head,
    ],
    { cwd: repo },
  );
  return result.stdout;
}

export interface ApplyResult {
  ok: boolean;
  stderr: string;
}

/**
 * Apply a patch to the working tree at `cwd`, reading it from stdin.
 *
 * A rejected patch is an expected outcome, not an error: it means this
 * combination of hunks is not a reachable state. Context matching is left
 * strict on purpose -- a loosely placed hunk would produce a state that is not
 * the one we meant to test, and a wrong answer is worse than no answer.
 */
export async function applyPatch(cwd: string, patch: string): Promise<ApplyResult> {
  if (patch.trim() === "") return { ok: true, stderr: "" };
  const result = await exec("git", ["apply", "--whitespace=nowarn", "-"], {
    cwd,
    input: patch,
  });
  return { ok: result.exitCode === 0, stderr: result.stderr };
}

/** Check whether a patch would apply, without touching the working tree. */
export async function patchApplies(cwd: string, patch: string): Promise<boolean> {
  if (patch.trim() === "") return true;
  const result = await exec("git", ["apply", "--check", "--whitespace=nowarn", "-"], {
    cwd,
    input: patch,
  });
  return result.exitCode === 0;
}

/**
 * Return the working tree at `cwd` to its checked-out commit.
 *
 * `git clean` leaves ignored files alone by default, so linked dependency
 * directories survive. `preserve` guards anything that is not ignored.
 */
export async function resetWorktree(cwd: string, preserve: readonly string[] = []): Promise<void> {
  await execOrThrow("git", ["reset", "--hard", "--quiet"], { cwd });
  const cleanArgs = ["clean", "-fdq"];
  for (const path of preserve) cleanArgs.push("-e", path);
  await execOrThrow("git", cleanArgs, { cwd });
}
