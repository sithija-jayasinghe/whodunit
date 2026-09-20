import type { FilePatch, Hunk } from "../types.js";
import { notImplemented } from "../util/todo.js";

/**
 * PHASE 2
 *
 * Split a unified diff into per-file patches and individual hunks.
 *
 * Produced by `git diff <base> <head>` with zero context disabled -- we keep
 * the default 3 lines of context so that `git apply` can place each hunk.
 */
export function parseDiff(_unifiedDiff: string): FilePatch[] {
  return notImplemented(2, "parse a unified diff into FilePatch[]");
}

/** Flatten parsed file patches into the ordered hunk list the search consumes. */
export function collectHunks(_patches: readonly FilePatch[]): Hunk[] {
  return notImplemented(2, "flatten FilePatch[] into Hunk[]");
}
