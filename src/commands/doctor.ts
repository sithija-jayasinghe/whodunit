import { createSandbox } from "../git/worktree.js";
import { snapshotWorkingTree } from "../git/snapshot.js";
import { isDirty, resolveRef } from "../git/repo.js";
import { disagree, explainFlaky, explainUnresolved, runRepeated, runTest } from "../runner/test.js";
import type { Flakiness, TestResult } from "../types.js";

export interface PreconditionReport {
  repo: string;
  baselineRef: string;
  baselineCommit: string;
  snapshotCommit: string;
  dirty: boolean;
  linked: string[];
  baseline: TestResult;
  current: TestResult;
  /** True when the baseline passes and the current state fails -- the only
   *  situation in which searching for a culprit is meaningful. */
  searchable: boolean;
  reason: string;
  /** How many times each side was run. */
  repeat: number;
  /** The --match text, when one was given. */
  match?: string;
  /** Set when re-running the same side gave a different outcome. */
  flaky?: Flakiness;
}

/**
 * Establish that there is actually a regression to hunt.
 *
 * Runs the test command twice in isolated sandboxes: once against the baseline
 * and once against the current working tree. If the baseline does not pass, or
 * the current state does not fail, there is nothing for the search to bisect
 * and we say so instead of burning ten minutes finding out.
 */
export async function checkPreconditions(options: {
  repo: string;
  baselineRef: string;
  testCommand: readonly string[];
  timeoutMs?: number;
  /** Exit codes that mean "cannot judge this state". Default: 125. */
  skipExitCodes?: readonly number[];
  link?: readonly string[];
  /** Stop: the running test is killed, the sandbox removed, and the call rejects. */
  signal?: AbortSignal;
  /** Run each side this many times, to catch a flaky test. Default: 1. */
  repeat?: number;
  /** Text a failing run must print to count as the failure being hunted. */
  match?: string;
  onStep?: (message: string) => void;
}): Promise<PreconditionReport> {
  const { repo, baselineRef, testCommand, timeoutMs, skipExitCodes, link, signal, onStep = () => {} } =
    options;
  const repeat = options.repeat ?? 1;
  const { match } = options;

  const baselineCommit = await resolveRef(repo, baselineRef);
  const dirty = await isDirty(repo);

  onStep(`Snapshotting working tree`);
  const snapshot = await snapshotWorkingTree(repo, "whodunit: working tree snapshot");

  let baselines: TestResult[];
  let currents: TestResult[];
  let linked: string[];
  try {
    onStep(`Testing baseline (${baselineRef} ${baselineCommit.slice(0, 7)})`);
    const baselineSandbox = await createSandbox(repo, baselineCommit, { link });
    try {
      baselines = await runRepeated(repeat, () =>
        runTest(testCommand, { cwd: baselineSandbox.path, timeoutMs, skipExitCodes, match, signal }),
      );
    } finally {
      await baselineSandbox.dispose();
    }

    signal?.throwIfAborted();
    onStep(`Testing current tree (${snapshot.commit.slice(0, 7)})`);
    const currentSandbox = await createSandbox(repo, snapshot.commit, { link });
    try {
      linked = currentSandbox.linked;
      currents = await runRepeated(repeat, () =>
        runTest(testCommand, { cwd: currentSandbox.path, timeoutMs, skipExitCodes, match, signal }),
      );
    } finally {
      await currentSandbox.dispose();
    }
  } finally {
    await snapshot.release();
  }

  const baseline = baselines[baselines.length - 1]!;
  const current = currents[currents.length - 1]!;

  let reason: string;
  let searchable = false;
  let flaky: Flakiness | undefined;
  if (disagree(baselines)) {
    reason = explainFlaky("baseline", baselines);
    flaky = { stage: "baseline", outcomes: baselines.map((result) => result.outcome) };
  } else if (disagree(currents)) {
    reason = explainFlaky("current tree", currents);
    flaky = { stage: "current", outcomes: currents.map((result) => result.outcome) };
  } else if (baseline.outcome !== "pass") {
    reason =
      baseline.outcome === "unresolved"
        ? explainUnresolved("baseline", baseline, match)
        : "The test already fails at the baseline, so the change did not break it.";
  } else if (current.outcome === "pass") {
    reason = "The test passes on the current tree. Nothing is broken.";
  } else if (current.outcome === "unresolved") {
    reason = explainUnresolved("current", current, match);
  } else {
    reason = "Baseline passes and the current tree fails. Ready to search.";
    searchable = true;
  }

  return {
    repo,
    baselineRef,
    baselineCommit,
    snapshotCommit: snapshot.commit,
    dirty,
    linked,
    baseline,
    current,
    searchable,
    reason,
    repeat,
    ...(match !== undefined ? { match } : {}),
    ...(flaky ? { flaky } : {}),
  };
}
