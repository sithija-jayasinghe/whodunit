import { createSandbox } from "../git/worktree.js";
import { applySubset } from "../diff/apply.js";
import { disagree, explainFlaky, explainUnresolved, runRepeated, runTest } from "../runner/test.js";
import { ddmin, type Probe, type ProbeEvent, type SearchResult } from "../search/ddmin.js";
import { listHunks } from "./hunks.js";
import type { FilePatch, Flakiness, Hunk, Outcome, TestResult } from "../types.js";

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
  /**
   * Run the baseline, the current tree and the final answer this many times
   * each, to catch a flaky test before it produces a wrong answer. Default: 1.
   */
  repeat?: number;
  link?: readonly string[];
  /**
   * Stop the search: the running test is killed, the sandbox removed, and the
   * call rejects with the signal's reason.
   */
  signal?: AbortSignal;
  onStep?: (message: string) => void;
  onProbe?: (event: ProbeEvent) => void;
  /** Called after every test run, with its full output, and for every subset
   *  whose patch would not apply. Fires before the matching onProbe. */
  onRun?: (event: RunEvent) => void;
}

export type RunEvent =
  | {
      /** Which run: a precondition check, a search probe, or a re-run
       *  confirming the answer. */
      kind: "baseline" | "current" | "probe" | "confirm";
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
  /** How many times each check was run. */
  repeat: number;
  /**
   * Set when re-running the same code gave a different outcome. At the
   * baseline or current tree it stops the search; at "confirm" the result is
   * kept but must not be trusted.
   */
  flaky?: Flakiness;
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
  const { repo, baselineRef, testCommand, signal, onStep = () => {} } = options;
  const repeat = options.repeat ?? 1;
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
    outcome: Omit<SearchReport, keyof typeof listing | "repeat" | "testRuns" | "elapsedMs">,
  ): SearchReport => ({
    baselineCommit,
    snapshotCommit,
    patches,
    hunks,
    repeat,
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

  signal?.throwIfAborted();
  const sandbox = await createSandbox(repo, baselineCommit, { link: options.link });
  const preserve = sandbox.linked;

  const run = async (kind: "baseline" | "current" | "probe" | "confirm", subset: readonly Hunk[]) => {
    testRuns++;
    const result = await runTest(testCommand, {
      cwd: sandbox.path,
      timeoutMs: options.timeoutMs,
      skipExitCodes: options.skipExitCodes,
      signal,
    });
    options.onRun?.({ kind, subset, result });
    return result;
  };

  const probe: Probe = async (subset) => {
    // Throwing ends ddmin; the finally below still removes the sandbox.
    signal?.throwIfAborted();
    const applied = await applySubset(sandbox.path, patches, subset, preserve);
    // A rejected patch is not a reachable state, so we cannot judge it.
    if (!applied.applied) {
      options.onRun?.({ kind: "rejected", subset, stderr: applied.stderr });
      return "unresolved";
    }
    return (await run("probe", subset)).outcome;
  };

  /**
   * Re-run the answer. The culprits must fail every time, and with any one
   * of them removed they must never fail. Returns the evidence if either
   * does not hold.
   */
  const confirm = async (culprits: readonly Hunk[], minimal: boolean): Promise<Flakiness | undefined> => {
    const check = async (subset: readonly Hunk[], holds: (outcome: Outcome) => boolean) => {
      const outcomes: Outcome[] = [];
      for (let i = 0; i < repeat; i++) {
        const applied = await applySubset(sandbox.path, patches, subset, preserve);
        const outcome = applied.applied ? (await run("confirm", subset)).outcome : "unresolved";
        outcomes.push(outcome);
        if (!holds(outcome)) return { stage: "confirm" as const, outcomes };
      }
      return undefined;
    };

    // The full set and the empty set were already re-run as the current tree
    // and the baseline, so they need no second confirmation.
    if (culprits.length < hunks.length) {
      const failing = await check(culprits, (outcome) => outcome === "fail");
      if (failing) return failing;
    }
    // A budget-limited result was never claimed minimal, so its reductions
    // may legitimately fail.
    if (!minimal) return undefined;
    for (const hunk of culprits) {
      const reduced = culprits.filter((other) => other !== hunk);
      if (reduced.length === 0) continue;
      const failed = await check(reduced, (outcome) => outcome !== "fail");
      if (failed) return failed;
    }
    return undefined;
  };

  try {
    onStep(`Testing baseline (${hunks.length} changes to search)`);
    await applySubset(sandbox.path, patches, [], preserve);
    const baselines = await runRepeated(repeat, () => run("baseline", []));
    const baseline = baselines[baselines.length - 1]!;

    if (disagree(baselines)) {
      return finish({
        baseline,
        searchable: false,
        reason: explainFlaky("baseline", baselines),
        flaky: { stage: "baseline", outcomes: baselines.map((result) => result.outcome) },
      });
    }
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
    const currents = await runRepeated(repeat, () => run("current", hunks));
    const current = currents[currents.length - 1]!;

    if (disagree(currents)) {
      return finish({
        baseline,
        current,
        searchable: false,
        reason: explainFlaky("current tree", currents),
        flaky: { stage: "current", outcomes: currents.map((result) => result.outcome) },
      });
    }
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
    // ddmin can finish on cached answers alone after an abort; still honor it.
    signal?.throwIfAborted();

    let flaky: Flakiness | undefined;
    if (repeat > 1 && result.culprits.length > 0) {
      onStep(`Confirming the answer (${repeat} runs each)`);
      flaky = await confirm(result.culprits, result.minimal);
    }

    return finish({
      baseline,
      current,
      result,
      searchable: true,
      ...(flaky ? { flaky } : {}),
      reason: flaky
        ? `The answer did not hold up when re-run: it gave ${flaky.outcomes.join(", then ")}. ` +
          "The test is flaky, so do not trust this result."
        : result.minimal
          ? "Search completed."
          : "Probe budget reached before the set was proven minimal.",
    });
  } finally {
    await sandbox.dispose();
  }
}
