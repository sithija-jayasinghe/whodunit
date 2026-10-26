import type { FilePatch, Flakiness, Hunk } from "../types.js";

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
  /** Every run of the test command, the two precondition checks included. */
  testRuns: number;
  minimal: boolean;
  elapsedMs: number;
  /** How many times each check ran. Above 1, the answer was re-run too. */
  repeat?: number;
  /** Set when re-running the answer gave a different outcome. */
  flaky?: Flakiness;
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
  const { culprits, patches, total, testRuns, minimal, elapsedMs, repeat = 1, flaky } = report;
  const byFile = new Map(patches.map((patch) => [patch.file, patch]));
  const seconds = (elapsedMs / 1000).toFixed(1);
  const lines: string[] = [""];

  if (culprits.length === 0) {
    lines.push("  No single change reproduces the failure on its own.");
    lines.push("");
    return lines.join("\n");
  }

  const count = culprits.length;
  const changes = `${count} change${count === 1 ? "" : "s"} out of ${total}`;
  const headline = flaky
    ? `Narrowed to ${changes}, but this answer cannot be trusted:`
    : minimal
      ? `Found it. ${changes}:`
      : `Narrowed to ${changes}:`;
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

  if (flaky) {
    lines.push(
      `  Re-running this answer gave ${flaky.outcomes.join(", then ")} on the same code.`,
      "  The test is flaky, so do not trust this result.",
    );
  } else if (minimal) {
    lines.push(
      count === 1
        ? "  Proven: the test passes without this change and fails with it."
        : "  Proven: these changes only fail together. Removing any one fixes it.",
    );
  } else {
    lines.push("  Probe budget ran out, so this set is not proven minimal.");
    lines.push("  Re-run with a higher --max-probes to narrow it further.");
  }

  if (!flaky && repeat > 1) {
    lines.push(`  Confirmed: the answer gave the same result in ${repeat} re-runs.`);
  }
  lines.push(`  ${testRuns} test run${testRuns === 1 ? "" : "s"} in ${seconds}s.`, "");
  return lines.join("\n");
}

/**
 * Render a test run's output for --verbose, indented under the line that
 * introduced it so it reads as belonging to that run.
 *
 * stdout and stderr are captured separately, so they cannot be interleaved in
 * their original order; stdout comes first.
 */
export function formatRunOutput(output: { stdout: string; stderr: string }, indent: string): string {
  const text = [output.stdout, output.stderr]
    .map((part) => part.replace(/\s+$/, ""))
    .filter((part) => part !== "")
    .join("\n");
  const lines = text === "" ? ["(no output)"] : text.split("\n");
  return lines.map((line) => `${indent}| ${line}`.trimEnd()).join("\n") + "\n";
}
