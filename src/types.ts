/** A single contiguous change within one file, as Git defines it. */
export interface Hunk {
  /** Stable id, e.g. "src/auth/token.ts:3" (file + index within that file). */
  id: string;
  /** Path relative to the repo root, as it appears in the new tree. */
  file: string;
  /** Index of this hunk within its file, starting at 0. */
  index: number;
  /** The raw unified-diff text for this hunk, including its @@ header. */
  patch: string;
  /** Line count of the removed side, for reporting. */
  removed: number;
  /** Line count of the added side, for reporting. */
  added: number;
  /** First line touched on the baseline side. */
  oldStart: number;
  /** First line touched on the changed side. */
  newStart: number;
  /**
   * True when this "hunk" is really a whole-file change that cannot be split:
   * a binary file, a mode change, or a pure rename. It can still be included
   * or excluded, just not subdivided.
   */
  atomic: boolean;
}

/** The per-file header lines a hunk must be re-attached to in order to apply. */
export interface FilePatch {
  file: string;
  /** Everything before the first @@ hunk: "diff --git", mode lines, ---/+++. */
  header: string;
  hunks: Hunk[];
  /** True when Git reported this file as binary. */
  binary: boolean;
}

/** What running the test command told us about one candidate state. */
export type Outcome =
  /** Test passed: this state is good. */
  | "pass"
  /** Test failed the way we are hunting: this state is bad. */
  | "fail"
  /**
   * We could not tell. The patch would not apply, the build broke, or the
   * command timed out. Delta debugging treats this as "skip" rather than
   * folding it into pass or fail.
   */
  | "unresolved";

export interface TestResult {
  outcome: Outcome;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
