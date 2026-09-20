import { createSandbox } from "../git/worktree.js";
import { applySubset } from "../diff/apply.js";
import { runTest } from "../runner/test.js";
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
  maxProbes?: number;
  link?: readonly string[];
  onStep?: (message: string) => void;
  onProbe?: (event: ProbeEvent) => void;
}

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

  const base = {
    baselineCommit,
    snapshotCommit,
    patches,
    hunks,
    elapsedMs: 0,
  };

  if (hunks.length === 0) {
    return {
      ...base,
      searchable: false,
      reason: "No changes against the baseline. Nothing to search.",
      elapsedMs: Date.now() - startedAt,
    };
  }

  const sandbox = await createSandbox(repo, baselineCommit, { link: options.link });
  const preserve = sandbox.linked;

  const probe: Probe = async (subset) => {
    const applied = await applySubset(sandbox.path, patches, subset, preserve);
    // A rejected patch is not a reachable state, so we cannot judge it.
    if (!applied.applied) return "unresolved";
    const run = await runTest(testCommand, {
      cwd: sandbox.path,
      timeoutMs: options.timeoutMs,
    });
    return run.outcome;
  };

  try {
    onStep(`Testing baseline (${hunks.length} changes to search)`);
    await applySubset(sandbox.path, patches, [], preserve);
    const baseline = await runTest(testCommand, {
      cwd: sandbox.path,
      timeoutMs: options.timeoutMs,
    });

    if (baseline.outcome !== "pass") {
      return {
        ...base,
        baseline,
        searchable: false,
        reason:
          baseline.outcome === "unresolved"
            ? "The baseline test timed out, so there is no known-good state to compare against."
            : "The test already fails at the baseline, so these changes did not break it.",
        elapsedMs: Date.now() - startedAt,
      };
    }

    onStep("Confirming the current tree fails");
    const fullApplied = await applySubset(sandbox.path, patches, hunks, preserve);
    if (!fullApplied.applied) {
      return {
        ...base,
        baseline,
        searchable: false,
        reason: `The full change set would not apply to the baseline: ${fullApplied.stderr.trim()}`,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const current = await runTest(testCommand, {
      cwd: sandbox.path,
      timeoutMs: options.timeoutMs,
    });

    if (current.outcome !== "fail") {
      return {
        ...base,
        baseline,
        current,
        searchable: false,
        reason:
          current.outcome === "pass"
            ? "The test passes with every change applied. Nothing is broken."
            : "The current test timed out. Narrow the test command or raise --timeout.",
        elapsedMs: Date.now() - startedAt,
      };
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

    return {
      ...base,
      baseline,
      current,
      result,
      searchable: true,
      reason: result.minimal
        ? "Search completed."
        : "Probe budget reached before the set was proven minimal.",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await sandbox.dispose();
  }
}
