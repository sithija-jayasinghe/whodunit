import type { FilePatch, Hunk } from "../types.js";
import { notImplemented } from "../util/todo.js";

/**
 * PHASE 2
 *
 * Rebuild a unified diff containing only `subset`, re-attaching each hunk to
 * its file header, then `git apply` it inside the sandbox.
 *
 * Returns false when the patch does not apply cleanly. That is not an error:
 * it means this particular combination of hunks is not a reachable state, and
 * the search treats it as "unresolved".
 */
export async function applySubset(
  _sandboxPath: string,
  _patches: readonly FilePatch[],
  _subset: readonly Hunk[],
): Promise<boolean> {
  return notImplemented(2, "apply a subset of hunks inside the sandbox");
}

/** Reset the sandbox back to the baseline tree between attempts. */
export async function resetSandbox(_sandboxPath: string): Promise<void> {
  return notImplemented(2, "reset the sandbox working tree to the baseline");
}
