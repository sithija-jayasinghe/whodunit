#!/usr/bin/env node
import { parseArgs } from "node:util";

import { checkPreconditions } from "./commands/doctor.js";
import { listHunks, formatHunkListing } from "./commands/hunks.js";
import { pruneSnapshots } from "./git/snapshot.js";
import { repoRoot } from "./git/repo.js";
import { DEFAULT_TEST_TIMEOUT_MS } from "./runner/test.js";
import type { TestResult } from "./types.js";

const VERSION = "0.0.1";

const HELP = `whodunit ${VERSION}
Find which single change broke your test.

USAGE
  whodunit [options] -- <test command>

COMMANDS
  doctor    Check that the baseline passes and the current tree fails,
            without searching. Use this first.
  hunks     List the individual changes the search would bisect.
  prune     Delete every snapshot ref whodunit has created in this repo.

OPTIONS
  --since <ref>     Baseline to compare against. Default: HEAD
  --timeout <ms>    Kill a test run after this long. Default: ${DEFAULT_TEST_TIMEOUT_MS}
  --context <n>     Diff context lines. Fewer splits changes more finely
                    but places them less reliably. Default: 3
  --link <path>     Extra gitignored path to link into the sandbox.
                    Repeatable. node_modules and .venv are linked already.
  -h, --help        Show this help
  -v, --version     Show version

EXAMPLES
  whodunit hunks
  whodunit doctor -- npm test
  whodunit doctor --since HEAD~1 -- npx vitest run auth.test.ts
`;

/** Split argv at the first bare "--" so the test command stays intact. */
function splitCommand(argv: string[]): { own: string[]; testCommand: string[] } {
  const separator = argv.indexOf("--");
  if (separator === -1) return { own: argv, testCommand: [] };
  return { own: argv.slice(0, separator), testCommand: argv.slice(separator + 1) };
}

function describe(result: TestResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const label =
    result.outcome === "pass" ? "PASS" : result.outcome === "fail" ? "FAIL" : "UNRESOLVED";
  const detail = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
  return `${label}  (${detail}, ${seconds}s)`;
}

async function main(argv: string[]): Promise<number> {
  const { own, testCommand } = splitCommand(argv);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      since: { type: "string", default: "HEAD" },
      timeout: { type: "string" },
      link: { type: "string", multiple: true, default: [] },
      context: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || (positionals.length === 0 && testCommand.length === 0)) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = positionals[0] ?? "run";
  const repo = await repoRoot(process.cwd());

  if (command === "prune") {
    const removed = await pruneSnapshots(repo);
    process.stdout.write(`Removed ${removed} snapshot ref${removed === 1 ? "" : "s"}.\n`);
    return 0;
  }

  if (command === "hunks") {
    const contextLines = values.context === undefined ? undefined : Number(values.context);
    if (contextLines !== undefined && (!Number.isInteger(contextLines) || contextLines < 0)) {
      process.stderr.write("--context must be a non-negative whole number.\n");
      return 2;
    }
    const listing = await listHunks({ repo, baselineRef: values.since, contextLines });
    process.stdout.write(formatHunkListing(listing));
    return listing.hunks.length > 0 ? 0 : 1;
  }

  if (testCommand.length === 0) {
    process.stderr.write("No test command given. Put it after --, e.g. whodunit doctor -- npm test\n");
    return 2;
  }

  const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    process.stderr.write(`--timeout must be a positive number of milliseconds.\n`);
    return 2;
  }

  if (command === "doctor") {
    const report = await checkPreconditions({
      repo,
      baselineRef: values.since,
      testCommand,
      timeoutMs,
      link: values.link,
      onStep: (message) => process.stdout.write(`  ${message}...\n`),
    });

    process.stdout.write(
      [
        ``,
        `  repo        ${report.repo}`,
        `  baseline    ${report.baselineRef} (${report.baselineCommit.slice(0, 7)})`,
        `  snapshot    ${report.snapshotCommit.slice(0, 7)}`,
        `  dirty       ${report.dirty ? "yes" : "no"}`,
        `  linked      ${report.linked.length > 0 ? report.linked.join(", ") : "nothing"}`,
        ``,
        `  baseline    ${describe(report.baseline)}`,
        `  current     ${describe(report.current)}`,
        ``,
        `  ${report.searchable ? "READY" : "CANNOT SEARCH"}  ${report.reason}`,
        ``,
      ].join("\n"),
    );
    return report.searchable ? 0 : 1;
  }

  if (command === "run") {
    process.stderr.write(
      "The search is not built yet (phases 2 and 3).\nRun `whodunit doctor -- <test command>` to verify the setup works.\n",
    );
    return 3;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`whodunit: ${message}\n`);
    process.exitCode = 1;
  });
