import { createSandbox } from "../git/worktree.js";
import { snapshotWorkingTree } from "../git/snapshot.js";
import { isDirty, resolveRef } from "../git/repo.js";
import { runTest } from "../runner/test.js";
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
  link?: readonly string[];
  onStep?: (message: string) => void;
}): Promise<PreconditionReport> {
  const { repo, baselineRef, testCommand, timeoutMs, link, onStep = () => {} } = options;

  const baselineCommit = await resolveRef(repo, baselineRef);
  const dirty = await isDirty(repo);

  onStep(`Snapshotting working tree`);
  const snapshot = await snapshotWorkingTree(repo, "whodunit: working tree snapshot");

  onStep(`Testing baseline (${baselineRef} ${baselineCommit.slice(0, 7)})`);
  const baselineSandbox = await createSandbox(repo, baselineCommit, { link });
  let baseline: TestResult;
  try {
    baseline = await runTest(testCommand, { cwd: baselineSandbox.path, timeoutMs });
  } finally {
    await baselineSandbox.dispose();
  }

  onStep(`Testing current tree (${snapshot.commit.slice(0, 7)})`);
  const currentSandbox = await createSandbox(repo, snapshot.commit, { link });
  let current: TestResult;
  let linked: string[];
  try {
    linked = currentSandbox.linked;
    current = await runTest(testCommand, { cwd: currentSandbox.path, timeoutMs });
  } finally {
    await currentSandbox.dispose();
  }

  let reason: string;
  let searchable = false;
  if (baseline.outcome !== "pass") {
    reason =
      baseline.outcome === "unresolved"
        ? "The baseline test timed out, so there is no known-good state to compare against."
        : "The test already fails at the baseline, so the change did not break it.";
  } else if (current.outcome === "pass") {
    reason = "The test passes on the current tree. Nothing is broken.";
  } else if (current.outcome === "unresolved") {
    reason = "The current test timed out. Narrow the test command or raise --timeout.";
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
