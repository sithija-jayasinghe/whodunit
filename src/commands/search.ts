import { createSandbox } from "../git/worktree.js";
import { applySubset } from "../diff/apply.js";
import { explainUnresolved, runTest } from "../runner/test.js";
import { ddmin, type Probe, type ProbeEvent, type SearchResult } from "../search/ddmin.js";
import { listHunks } from "./hunks.js";
import type { FilePatch, Hunk, TestResult } from "../types.js";

export const DEFAULT_MAX_PROBES = 60;

export interface SearchOptions {
  repo: string;
  baselineRef: string;
  testCommand: readonly string[];
  contextLines?: number;
  timeoutMs?: number;
  /** Exit codes that mean "cannot judge this state". Default: 125. */
  skipExitCodes?: readonly number[];
  maxProbes?: number;
  link?: readonly string[];
  onStep?: (message: string) => void;
  onProbe?: (event: ProbeEvent) => void;
  /** Called after every test run, with its full output, and for every subset
   *  whose patch would not apply. Fires before the matching onProbe. */
  onRun?: (event: RunEvent) => void;
}

export type RunEvent =
  | {
      /** Which run: the two precondition checks, or a search probe. */
      kind: "baseline" | "current" | "probe";
      subset: readonly Hunk[];
      result: TestResult;
    }
  | {
      /** The subset's patch was rejected, so the test never ran. */
      kind: "rejected";
      subset: readonly Hunk[];
      stderr: string;
    };

export interface SearchReport {
  baselineCommit: string;
  snapshotCommit: string;
  patches: FilePatch[];
  hunks: Hunk[];
  /** The baseline run, with no changes applied. */
  baseline?: TestResult;
  /** The current tree, with every change applied. */
  current?: TestResult;
  /** Absent when the preconditions did not hold. */
  result?: SearchResult;
  searchable: boolean;
  reason: string;
  /** Every time the test command ran, preconditions included. */
  testRuns: number;
  elapsedMs: number;
}

/**
 * Find the smallest set of changes that reproduces the failure.
 *
 * Preconditions are measured, not assumed: the baseline is run with nothing
 * applied and the current tree with everything applied. If the baseline does
 * not pass or the full set does not fail there is nothing to bisect, and
 * saying so costs two test runs instead of dozens.
 *
 * Both measurements are then fed to the search as known outcomes, so they are
 * never repeated.
 */
export async function search(options: SearchOptions): Promise<SearchReport> {
  const { repo, baselineRef, testCommand, onStep = () => {} } = options;
  const startedAt = Date.now();

  onStep("Snapshotting working tree");
  const listing = await listHunks({
    repo,
    baselineRef,
    contextLines: options.contextLines,
  });
  const { patches, hunks, baselineCommit, snapshotCommit } = listing;

  let testRuns = 0;
  const finish = (
    outcome: Omit<SearchReport, keyof typeof listing | "testRuns" | "elapsedMs">,
  ): SearchReport => ({
    baselineCommit,
    snapshotCommit,
    patches,
    hunks,
    ...outcome,
    testRuns,
    elapsedMs: Date.now() - startedAt,
  });

  if (hunks.length === 0) {
    return finish({
      searchable: false,
      reason: "No changes against the baseline. Nothing to search.",
    });
  }

  const sandbox = await createSandbox(repo, baselineCommit, { link: options.link });
  const preserve = sandbox.linked;

  const run = async (kind: "baseline" | "current" | "probe", subset: readonly Hunk[]) => {
    testRuns++;
    const result = await runTest(testCommand, {
      cwd: sandbox.path,
      timeoutMs: options.timeoutMs,
      skipExitCodes: options.skipExitCodes,
    });
    options.onRun?.({ kind, subset, result });
    return result;
  };

  const probe: Probe = async (subset) => {
    const applied = await applySubset(sandbox.path, patches, subset, preserve);
    // A rejected patch is not a reachable state, so we cannot judge it.
    if (!applied.applied) {
      options.onRun?.({ kind: "rejected", subset, stderr: applied.stderr });
      return "unresolved";
    }
    return (await run("probe", subset)).outcome;
  };

  try {
    onStep(`Testing baseline (${hunks.length} changes to search)`);
    await applySubset(sandbox.path, patches, [], preserve);
    const baseline = await run("baseline", []);

    if (baseline.outcome !== "pass") {
      return finish({
        baseline,
        searchable: false,
        reason:
          baseline.outcome === "unresolved"
            ? explainUnresolved("baseline", baseline)
            : "The test already fails at the baseline, so these changes did not break it.",
      });
    }

    onStep("Confirming the current tree fails");
    const fullApplied = await applySubset(sandbox.path, patches, hunks, preserve);
    if (!fullApplied.applied) {
      return finish({
        baseline,
        searchable: false,
        reason: `The full change set would not apply to the baseline: ${fullApplied.stderr.trim()}`,
      });
    }
    const current = await run("current", hunks);

    if (current.outcome !== "fail") {
      return finish({
        baseline,
        current,
        searchable: false,
        reason:
          current.outcome === "pass"
            ? "The test passes with every change applied. Nothing is broken."
            : explainUnresolved("current", current),
      });
    }

    onStep("Searching");
    const result = await ddmin(hunks, probe, {
      maxProbes: options.maxProbes ?? DEFAULT_MAX_PROBES,
      onProbe: options.onProbe,
      seed: [
        { subset: [], outcome: baseline.outcome },
        { subset: hunks, outcome: current.outcome },
      ],
    });

    return finish({
      baseline,
      current,
      result,
      searchable: true,
      reason: result.minimal
        ? "Search completed."
        : "Probe budget reached before the set was proven minimal.",
    });
  } finally {
    await sandbox.dispose();
  }
}
