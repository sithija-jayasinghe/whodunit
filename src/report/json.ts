import type { PreconditionReport } from "../commands/doctor.js";
import type { HunkListing } from "../commands/hunks.js";
import type { SearchReport } from "../commands/search.js";
import type { FilePatch, Hunk, TestResult } from "../types.js";

/**
 * Bumped whenever a field is removed or changes meaning, so scripts and agents
 * reading this output can tell. Adding a field does not bump it.
 */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonOptions {
  /** Include each run's stdout and stderr. Off by default: it can be large. */
  verbose?: boolean;
}

export interface JsonHunk {
  id: string;
  file: string;
  /** Index of this change within its file, from 0. */
  index: number;
  /** First line of the change in the current file. */
  line: number;
  /** First line of the change in the baseline file. */
  oldLine: number;
  added: number;
  removed: number;
  /** True for a change that cannot be split: binary, mode, or whole file. */
  atomic: boolean;
  binary: boolean;
  /** The unified diff for this change alone, including its @@ header. */
  patch: string;
}

export interface JsonRun {
  outcome: TestResult["outcome"];
  exitCode: number;
  timedOut: boolean;
  /** Failed, but without the --match text: a different failure. */
  otherFailure: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
}

function hunkToJson(hunk: Hunk, patches: readonly FilePatch[]): JsonHunk {
  const binary = patches.find((patch) => patch.file === hunk.file)?.binary ?? false;
  return {
    id: hunk.id,
    file: hunk.file,
    index: hunk.index,
    line: hunk.newStart,
    oldLine: hunk.oldStart,
    added: hunk.added,
    removed: hunk.removed,
    atomic: hunk.atomic,
    binary,
    patch: hunk.patch,
  };
}

function runToJson(result: TestResult | undefined, options: JsonOptions): JsonRun | null {
  if (!result) return null;
  return {
    outcome: result.outcome,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    otherFailure: result.otherFailure,
    durationMs: result.durationMs,
    ...(options.verbose ? { stdout: result.stdout, stderr: result.stderr } : {}),
  };
}

/** The search result, for `whodunit --json -- <test command>`. */
export function searchToJson(report: SearchReport, options: JsonOptions = {}) {
  return {
    schema: JSON_SCHEMA_VERSION,
    command: "run" as const,
    searchable: report.searchable,
    reason: report.reason,
    baselineCommit: report.baselineCommit,
    snapshotCommit: report.snapshotCommit,
    totalChanges: report.hunks.length,
    culprits: report.result?.culprits.map((hunk) => hunkToJson(hunk, report.patches)) ?? [],
    /** Proven: removing any one culprit makes the test pass. */
    minimal: report.result?.minimal ?? false,
    baseline: runToJson(report.baseline, options),
    current: runToJson(report.current, options),
    /** How many times each check ran. */
    repeat: report.repeat,
    /** Set when re-running the same code gave a different outcome. */
    flaky: report.flaky ?? null,
    /** The --match text, or null. */
    match: report.match ?? null,
    testRuns: report.testRuns,
    elapsedMs: report.elapsedMs,
  };
}

/** The precondition check, for `whodunit doctor --json`. */
export function preconditionsToJson(report: PreconditionReport, options: JsonOptions = {}) {
  return {
    schema: JSON_SCHEMA_VERSION,
    command: "doctor" as const,
    searchable: report.searchable,
    reason: report.reason,
    baselineRef: report.baselineRef,
    baselineCommit: report.baselineCommit,
    snapshotCommit: report.snapshotCommit,
    dirty: report.dirty,
    linked: report.linked,
    baseline: runToJson(report.baseline, options),
    current: runToJson(report.current, options),
    repeat: report.repeat,
    flaky: report.flaky ?? null,
    match: report.match ?? null,
  };
}

/** The candidate changes, for `whodunit hunks --json`. */
export function hunksToJson(listing: HunkListing) {
  return {
    schema: JSON_SCHEMA_VERSION,
    command: "hunks" as const,
    baselineCommit: listing.baselineCommit,
    snapshotCommit: listing.snapshotCommit,
    files: listing.patches.length,
    hunks: listing.hunks.map((hunk) => hunkToJson(hunk, listing.patches)),
  };
}
