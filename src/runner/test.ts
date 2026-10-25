import { exec } from "../util/exec.js";
import type { TestResult } from "../types.js";

export interface RunTestOptions {
  cwd: string;
  /** Kill the command after this long. A timeout counts as "unresolved". */
  timeoutMs?: number;
  /** Exit codes that mean "cannot judge this state". Default: 125. */
  skipExitCodes?: readonly number[];
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The exit code `git bisect run` reserves for "this commit cannot be tested".
 * Reusing it means a script written for bisect works here unchanged.
 */
export const SKIP_EXIT_CODE = 125;

/**
 * Run the user's test command against whatever is currently in `cwd`.
 *
 * The contract is deliberately narrow: exit code 0 means the state is good,
 * a skip code (125 unless told otherwise) or a timeout means we could not
 * tell, and any other exit code means it is bad. That is all whodunit needs,
 * and it is why the tool works with any language and any test runner.
 *
 * The skip code matters more than it looks. A subset of hunks that does not
 * compile exits non-zero just like a real failure, and the search would happily
 * narrow onto the hunk that broke the build instead of the one that broke the
 * test. A test command that exits 125 when the build fails prevents that.
 */
export async function runTest(
  command: readonly string[],
  options: RunTestOptions,
): Promise<TestResult> {
  const [program, ...args] = command;
  if (!program) {
    throw new Error("No test command given.");
  }

  const skipExitCodes = options.skipExitCodes ?? [SKIP_EXIT_CODE];
  const startedAt = Date.now();
  const result = await exec(program, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;

  return {
    outcome:
      result.timedOut || skipExitCodes.includes(result.exitCode)
        ? "unresolved"
        : result.exitCode === 0
          ? "pass"
          : "fail",
    exitCode: result.exitCode,
    durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

/**
 * Explain an "unresolved" baseline or current run, which leaves nothing to
 * search. `which` names the run, e.g. "baseline".
 */
export function explainUnresolved(which: string, result: TestResult): string {
  return result.timedOut
    ? `The ${which} test timed out. Narrow the test command or raise --timeout.`
    : `The ${which} test exited ${result.exitCode}, which means skip, so it cannot be judged.`;
}
