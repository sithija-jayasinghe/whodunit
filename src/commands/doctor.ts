import { createSandbox } from "../git/worktree.js";
import { snapshotWorkingTree } from "../git/snapshot.js";
import { isDirty, resolveRef } from "../git/repo.js";
import { explainUnresolved, runTest } from "../runner/test.js";
import type { TestResult } from "../types.js";

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
  onStep?: (message: string) => void;
}): Promise<PreconditionReport> {
  const { repo, baselineRef, testCommand, timeoutMs, skipExitCodes, link, onStep = () => {} } =
    options;

  const baselineCommit = await resolveRef(repo, baselineRef);
  const dirty = await isDirty(repo);

  onStep(`Snapshotting working tree`);
  const snapshot = await snapshotWorkingTree(repo, "whodunit: working tree snapshot");

  let baseline: TestResult;
  let current: TestResult;
  let linked: string[];
  try {
    onStep(`Testing baseline (${baselineRef} ${baselineCommit.slice(0, 7)})`);
    const baselineSandbox = await createSandbox(repo, baselineCommit, { link });
    try {
      baseline = await runTest(testCommand, {
        cwd: baselineSandbox.path,
        timeoutMs,
        skipExitCodes,
      });
    } finally {
      await baselineSandbox.dispose();
    }

    onStep(`Testing current tree (${snapshot.commit.slice(0, 7)})`);
    const currentSandbox = await createSandbox(repo, snapshot.commit, { link });
    try {
      linked = currentSandbox.linked;
      current = await runTest(testCommand, {
        cwd: currentSandbox.path,
        timeoutMs,
        skipExitCodes,
      });
    } finally {
      await currentSandbox.dispose();
    }
  } finally {
    await snapshot.release();
  }

  let reason: string;
  let searchable = false;
  if (baseline.outcome !== "pass") {
    reason =
      baseline.outcome === "unresolved"
        ? explainUnresolved("baseline", baseline)
        : "The test already fails at the baseline, so the change did not break it.";
  } else if (current.outcome === "pass") {
    reason = "The test passes on the current tree. Nothing is broken.";
  } else if (current.outcome === "unresolved") {
    reason = explainUnresolved("current", current);
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
  };
}
