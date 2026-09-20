import type { FilePatch, Hunk } from "../types.js";
import { applyPatch, resetWorktree } from "../git/diff.js";

/**
 * Rebuild a unified diff containing only `subset`, re-attaching each hunk to
 * its file header.
 *
 * Files contribute nothing when none of their hunks are selected, so the patch
 * stays as small as the subset. Hunks keep their original @@ headers: because
 * every patch is applied to the baseline tree, the old-side line numbers are
 * always correct, which is what lets Git place a hunk whose neighbours were
 * left out.
 */
export function buildPatch(patches: readonly FilePatch[], subset: readonly Hunk[]): string {
  const selected = new Set(subset.map((hunk) => hunk.id));
  const out: string[] = [];

  for (const patch of patches) {
    const chosen = patch.hunks.filter((hunk) => selected.has(hunk.id));
    if (chosen.length === 0) continue;
    out.push(patch.header);
    for (const hunk of chosen) {
      if (hunk.patch !== "") out.push(hunk.patch);
    }
  }

  return out.join("");
}

export interface ApplySubsetResult {
  /** False when the combination is not a reachable state. Not an error. */
  applied: boolean;
  /** Git's complaint, kept for diagnostics when applied is false. */
  stderr: string;
}

/**
 * Reset the sandbox to the baseline, then apply exactly `subset`.
 *
 * Every candidate state is built from the baseline rather than by patching the
 * previous candidate, so a failed apply cannot leave residue behind that would
 * corrupt the next measurement.
 */
export async function applySubset(
  sandboxPath: string,
  patches: readonly FilePatch[],
  subset: readonly Hunk[],
  preserve: readonly string[] = [],
): Promise<ApplySubsetResult> {
  await resetWorktree(sandboxPath, preserve);
  const patch = buildPatch(patches, subset);
  const result = await applyPatch(sandboxPath, patch);
  return { applied: result.ok, stderr: result.stderr };
}

/** Reset the sandbox back to the baseline tree between attempts. */
export async function resetSandbox(
  sandboxPath: string,
  preserve: readonly string[] = [],
): Promise<void> {
  await resetWorktree(sandboxPath, preserve);
}
