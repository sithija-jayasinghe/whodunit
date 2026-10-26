import { exec } from "../util/exec.js";
import type { TestResult } from "../types.js";

export interface RunTestOptions {
  cwd: string;
  /** Kill the command after this long. A timeout counts as "unresolved". */
  timeoutMs?: number;
  /** Exit codes that mean "cannot judge this state". Default: 125. */
  skipExitCodes?: readonly number[];
  /**
   * Text the output must contain for a failure to count. A failure without it
   * broke for some other reason, and is "unresolved".
   */
  match?: string;
  env?: NodeJS.ProcessEnv;
  /** Stop the run. The call then rejects instead of returning a result. */
  signal?: AbortSignal;
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
 * With `match`, a failure must also print that text to count. Otherwise a
 * combination of hunks that breaks something else -- a different test, an
 * import -- would be taken for the failure being hunted.
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
    signal: options.signal,
  });
  const durationMs = Date.now() - startedAt;

  const failed = result.exitCode !== 0 && !result.timedOut && !skipExitCodes.includes(result.exitCode);
  const otherFailure =
    failed &&
    options.match !== undefined &&
    !result.stdout.includes(options.match) &&
    !result.stderr.includes(options.match);

  return {
    outcome:
      result.timedOut || skipExitCodes.includes(result.exitCode) || otherFailure
        ? "unresolved"
        : result.exitCode === 0
          ? "pass"
          : "fail",
    exitCode: result.exitCode,
    durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    otherFailure,
  };
}

/**
 * Explain an "unresolved" baseline or current run, which leaves nothing to
 * search. `which` names the run, e.g. "baseline".
 */
export function explainUnresolved(which: string, result: TestResult, match?: string): string {
  if (result.timedOut) {
    return `The ${which} test timed out. Narrow the test command or raise --timeout.`;
  }
  if (result.otherFailure) {
    return (
      `The ${which} test failed with a different error: its output does not contain ` +
      `"${match}". Check the --match text against the test's output (--verbose shows it).`
    );
  }
  return `The ${which} test exited ${result.exitCode}, which means skip, so it cannot be judged.`;
}

/**
 * Run a test up to `times` times on the same code, stopping at the first
 * outcome that differs from the first. A deterministic test gives `times`
 * equal results; anything else is proof that it is flaky.
 */
export async function runRepeated(
  times: number,
  once: () => Promise<TestResult>,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (let i = 0; i < times; i++) {
    const result = await once();
    results.push(result);
    if (result.outcome !== results[0]!.outcome) break;
  }
  return results;
}

/** True when repeated runs of the same code did not all agree. */
export function disagree(results: readonly TestResult[]): boolean {
  return results.some((result) => result.outcome !== results[0]?.outcome);
}

/** Explain flaky baseline or current runs, which leave nothing to search. */
export function explainFlaky(which: string, results: readonly TestResult[]): string {
  const outcomes = results.map((result) => result.outcome).join(", then ");
  return (
    `The test is flaky: the ${which} gave ${outcomes} on the same code. ` +
    "A search would give a wrong answer, so fix or skip the flaky test first."
  );
}
