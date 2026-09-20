import { exec } from "../util/exec.js";
import type { TestResult } from "../types.js";

export interface RunTestOptions {
  cwd: string;
  /** Kill the command after this long. A timeout counts as "unresolved". */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run the user's test command against whatever is currently in `cwd`.
 *
 * The contract is deliberately narrow: exit code 0 means the state is good,
 * any other exit code means it is bad, and a timeout means we could not tell.
 * That is all culprit needs, and it is why the tool works with any language
 * and any test runner.
 */
export async function runTest(
  command: readonly string[],
  options: RunTestOptions,
): Promise<TestResult> {
  const [program, ...args] = command;
  if (!program) {
    throw new Error("No test command given.");
  }

  const startedAt = Date.now();
  const result = await exec(program, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;

  return {
    outcome: result.timedOut ? "unresolved" : result.exitCode === 0 ? "pass" : "fail",
    exitCode: result.exitCode,
    durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}
