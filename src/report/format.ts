import type { FilePatch, Hunk } from "../types.js";

const MAX_LINES_PER_HUNK = 12;

/** The changed lines of a hunk, without the surrounding context. */
function changedLines(hunk: Hunk): string[] {
  return hunk.patch
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"));
}

function describeLocation(hunk: Hunk, patch: FilePatch | undefined): string {
  if (hunk.atomic) {
    if (patch?.binary) return `${hunk.file} (binary, cannot be split)`;
    if (hunk.patch === "") return `${hunk.file} (file mode)`;
    return `${hunk.file} (whole file)`;
  }
  return `${hunk.file}, line ${hunk.newStart}`;
}

export interface CulpritReport {
  culprits: readonly Hunk[];
  patches: readonly FilePatch[];
  /** Total hunks the search started from. */
  total: number;
  probes: number;
  minimal: boolean;
  elapsedMs: number;
}

/**
 * Render the found culprit for a terminal.
 *
 * The wording is deliberate about what was proven. A minimal result means the
 * test was observed to pass without these changes and fail with them. A result
 * that ran out of probes is a real failing set but not a proven-minimal one,
 * and it says so rather than overclaiming.
 */
export function formatCulprit(report: CulpritReport): string {
  const { culprits, patches, total, probes, minimal, elapsedMs } = report;
  const byFile = new Map(patches.map((patch) => [patch.file, patch]));
  const seconds = (elapsedMs / 1000).toFixed(1);
  const lines: string[] = [""];

  if (culprits.length === 0) {
    lines.push("  No single change reproduces the failure on its own.");
    lines.push("");
    return lines.join("\n");
  }

  const count = culprits.length;
  const headline = minimal
    ? `Found it. ${count} change${count === 1 ? "" : "s"} out of ${total}:`
    : `Narrowed to ${count} change${count === 1 ? "" : "s"} out of ${total}:`;
  lines.push(`  ${headline}`, "");

  for (const hunk of culprits) {
    lines.push(`  ${describeLocation(hunk, byFile.get(hunk.file))}`, "");
    const body = changedLines(hunk);
    for (const line of body.slice(0, MAX_LINES_PER_HUNK)) {
      lines.push(`    ${line}`);
    }
    if (body.length > MAX_LINES_PER_HUNK) {
      lines.push(`    ... ${body.length - MAX_LINES_PER_HUNK} more lines`);
    }
    lines.push("");
  }

  if (minimal) {
    lines.push(
      count === 1
        ? "  Proven: the test passes without this change and fails with it."
        : "  Proven: these changes only fail together. Removing any one fixes it.",
    );
  } else {
    lines.push("  Probe budget ran out, so this set is not proven minimal.");
    lines.push("  Re-run with a higher --max-probes to narrow it further.");
  }

  lines.push(`  ${probes} test run${probes === 1 ? "" : "s"} in ${seconds}s.`, "");
  return lines.join("\n");
}
