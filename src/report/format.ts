import type { Hunk } from "../types.js";
import { notImplemented } from "../util/todo.js";

/**
 * PHASE 4
 *
 * Render the found culprit for a terminal: file and line, the offending lines
 * with +/- markers, and the follow-up commands.
 */
export function formatCulprit(_culprits: readonly Hunk[], _probes: number): string {
  return notImplemented(4, "format the culprit report");
}
