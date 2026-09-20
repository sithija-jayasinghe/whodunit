import { snapshotWorkingTree } from "../git/snapshot.js";
import { resolveRef } from "../git/repo.js";
import { diffCommits, DEFAULT_CONTEXT_LINES } from "../git/diff.js";
import { parseDiff, collectHunks } from "../diff/parse.js";
import type { FilePatch, Hunk } from "../types.js";

export interface HunkListing {
  baselineCommit: string;
  snapshotCommit: string;
  patches: FilePatch[];
  hunks: Hunk[];
}

/**
 * Snapshot the working tree, diff it against the baseline, and split the result
 * into hunks. This is the candidate set the search will bisect.
 */
export async function listHunks(options: {
  repo: string;
  baselineRef: string;
  contextLines?: number;
}): Promise<HunkListing> {
  const baselineCommit = await resolveRef(options.repo, options.baselineRef);
  const snapshot = await snapshotWorkingTree(options.repo, "whodunit: working tree snapshot");
  const diff = await diffCommits(options.repo, baselineCommit, snapshot.commit, {
    contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES,
  });
  const patches = parseDiff(diff);
  return {
    baselineCommit,
    snapshotCommit: snapshot.commit,
    patches,
    hunks: collectHunks(patches),
  };
}

/** Render a hunk listing for the terminal. */
export function formatHunkListing(listing: HunkListing): string {
  const { patches, hunks } = listing;
  if (hunks.length === 0) {
    return "\n  No changes against the baseline.\n";
  }

  const lines: string[] = [
    "",
    `  ${hunks.length} change${hunks.length === 1 ? "" : "s"} across ${patches.length} file${patches.length === 1 ? "" : "s"}`,
    "",
  ];

  for (const patch of patches) {
    lines.push(`  ${patch.file}`);
    for (const hunk of patch.hunks) {
      const where = hunk.atomic ? (patch.binary ? "binary" : "whole file") : `line ${hunk.newStart}`;
      const delta = hunk.atomic ? "" : `  +${hunk.added} -${hunk.removed}`;
      lines.push(`    [${hunk.index}]  ${where.padEnd(12)}${delta}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
