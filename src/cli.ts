#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { checkPreconditions } from "./commands/doctor.js";
import { listHunks, formatHunkListing } from "./commands/hunks.js";
import { search, DEFAULT_MAX_PROBES } from "./commands/search.js";
import { formatCulprit, formatRunOutput } from "./report/format.js";
import { hunksToJson, JSON_SCHEMA_VERSION, preconditionsToJson, searchToJson } from "./report/json.js";
import { pruneSnapshots } from "./git/snapshot.js";
import { repoRoot } from "./git/repo.js";
import { serveMcp } from "./mcp/server.js";
import { shutdown } from "./util/interrupt.js";
import { DEFAULT_TEST_TIMEOUT_MS, SKIP_EXIT_CODE } from "./runner/test.js";
import type { TestResult } from "./types.js";

// package.json sits one level above both src/cli.ts and dist/cli.js, and npm
// always ships it, so this one path works in development and when installed.
const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const HELP = `whodunit ${VERSION}
Find which single change broke your test.

USAGE
  whodunit [options] -- <test command>

COMMANDS
  doctor    Check that the baseline passes and the current tree fails,
            without searching. Use this first.
  hunks     List the individual changes the search would bisect.
  prune     Delete snapshot refs left behind by a run that crashed or
            was force-killed. Normal runs clean up after themselves.
  mcp       Run as an MCP server on stdio, so an agent can call the
            search, doctor and hunks as tools.

OPTIONS
  --since <ref>     Baseline to compare against. Default: HEAD
  --timeout <ms>    Kill a test run after this long. Default: ${DEFAULT_TEST_TIMEOUT_MS} (10 min)
  --context <n>     Diff context lines. Higher values make Git merge
                    nearby changes into one hunk. Default: 1
  --max-probes <n>  Give up after this many search runs, not counting the
                    two initial checks. Default: ${DEFAULT_MAX_PROBES}
  --repeat <n>      Run the baseline, the current tree and the answer n
                    times each. Catches a flaky test instead of trusting
                    it. Default: 1
  --skip-exit-code <n>
                    Treat this exit code as "cannot test this state", e.g.
                    when the build fails. Repeatable. ${SKIP_EXIT_CODE} always counts,
                    as in git bisect run.
  --link <path>     Extra gitignored path to link into the sandbox.
                    Repeatable. node_modules, .venv, venv and vendor/bundle
                    are linked already.
  --verbose         Print the output of every test run.
  --json            Print one JSON object instead of text, for scripts and
                    agents. With --verbose it includes test output.
  -h, --help        Show this help
  -v, --version     Show version

EXAMPLES
  whodunit doctor -- npm test auth.test.ts
  whodunit -- npm test auth.test.ts
  whodunit --since HEAD~1 -- npx vitest run auth.test.ts
  whodunit -- sh -c 'npm run build || exit 125; npm test auth.test.ts'
  whodunit --json -- npm test auth.test.ts
  whodunit hunks
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

/** Write `data` as the one JSON document on stdout. */
function printJson(data: object): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Report a usage or runtime error. In JSON mode it goes to stdout as JSON, so
 * a caller parsing stdout always gets a document it can read.
 */
function reportError(message: string, json: boolean): void {
  if (json) printJson({ schema: JSON_SCHEMA_VERSION, error: message });
  else process.stderr.write(`${message}\n`);
}

async function main(argv: string[], json: boolean): Promise<number> {
  const { own, testCommand } = splitCommand(argv);
  const fail = (message: string): number => {
    reportError(message, json);
    return 2;
  };

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      since: { type: "string", default: "HEAD" },
      timeout: { type: "string" },
      link: { type: "string", multiple: true, default: [] },
      context: { type: "string" },
      "max-probes": { type: "string" },
      repeat: { type: "string" },
      "skip-exit-code": { type: "string", multiple: true, default: [] },
      verbose: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
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

  // Before repoRoot: the server is started by an agent, often outside any
  // repository, and each tool call names its own.
  if (command === "mcp") {
    await serveMcp({ input: process.stdin, output: process.stdout, version: VERSION });
    // The client closed the connection. Stop any search still running and
    // remove its sandbox rather than leaving it behind.
    return shutdown(0);
  }

  const repo = await repoRoot(process.cwd());

  if (command === "prune") {
    const removed = await pruneSnapshots(repo);
    if (json) {
      printJson({ schema: JSON_SCHEMA_VERSION, command: "prune", removed });
      return 0;
    }
    process.stdout.write(`Removed ${removed} snapshot ref${removed === 1 ? "" : "s"}.\n`);
    return 0;
  }

  if (command === "hunks") {
    const contextLines = values.context === undefined ? undefined : Number(values.context);
    if (contextLines !== undefined && (!Number.isInteger(contextLines) || contextLines < 0)) {
      return fail("--context must be a non-negative whole number.");
    }
    const listing = await listHunks({ repo, baselineRef: values.since, contextLines });
    if (json) printJson(hunksToJson(listing));
    else process.stdout.write(formatHunkListing(listing));
    return listing.hunks.length > 0 ? 0 : 1;
  }

  if (testCommand.length === 0) {
    return fail("No test command given. Put it after --, e.g. whodunit doctor -- npm test");
  }

  const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return fail("--timeout must be a positive number of milliseconds.");
  }

  const extraSkipCodes = values["skip-exit-code"].map(Number);
  if (extraSkipCodes.some((code) => !Number.isInteger(code) || code < 1 || code > 255)) {
    return fail("--skip-exit-code must be a whole number from 1 to 255.");
  }
  const skipExitCodes = [SKIP_EXIT_CODE, ...extraSkipCodes];

  const repeat = values.repeat === undefined ? undefined : Number(values.repeat);
  if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1)) {
    return fail("--repeat must be a whole number of at least 1.");
  }

  if (command === "doctor") {
    const report = await checkPreconditions({
      repo,
      baselineRef: values.since,
      testCommand,
      timeoutMs,
      skipExitCodes,
      repeat,
      link: values.link,
      onStep: (message) => {
        if (!json) process.stdout.write(`  ${message}...\n`);
      },
    });

    if (json) {
      printJson(preconditionsToJson(report, { verbose: values.verbose }));
      return report.searchable ? 0 : 1;
    }

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
        ...(values.verbose ? [formatRunOutput(report.baseline, "              ").trimEnd()] : []),
        `  current     ${describe(report.current)}`,
        ...(values.verbose ? [formatRunOutput(report.current, "              ").trimEnd()] : []),
        ``,
        `  ${report.searchable ? "READY" : "CANNOT SEARCH"}  ${report.reason}`,
        ``,
      ].join("\n"),
    );
    return report.searchable ? 0 : 1;
  }

  if (command === "run") {
    const contextLines = values.context === undefined ? undefined : Number(values.context);
    if (contextLines !== undefined && (!Number.isInteger(contextLines) || contextLines < 0)) {
      return fail("--context must be a non-negative whole number.");
    }
    const maxProbes =
      values["max-probes"] === undefined ? undefined : Number(values["max-probes"]);
    if (maxProbes !== undefined && (!Number.isInteger(maxProbes) || maxProbes < 1)) {
      return fail("--max-probes must be a whole number of at least 1.");
    }

    // A probe's output arrives just before the line that announces it, so
    // hold it until that line has been printed.
    let pendingOutput: string | undefined;

    const report = await search({
      repo,
      baselineRef: values.since,
      testCommand,
      contextLines,
      timeoutMs,
      skipExitCodes,
      maxProbes,
      repeat,
      link: values.link,
      onStep: (message) => {
        if (!json) process.stdout.write(`  ${message}...\n`);
      },
      onRun: (event) => {
        if (!values.verbose || json) return;
        if (event.kind === "rejected") {
          pendingOutput = formatRunOutput(
            { stdout: "patch did not apply, so the test did not run", stderr: event.stderr },
            "           ",
          );
        } else if (event.kind === "probe") {
          pendingOutput = formatRunOutput(event.result, "           ");
        } else {
          process.stdout.write(`    ${event.kind.padEnd(9)}${describe(event.result)}\n`);
          process.stdout.write(formatRunOutput(event.result, "           "));
        }
      },
      onProbe: (event) => {
        if (event.cached || json) return;
        const label = event.outcome.toUpperCase();
        process.stdout.write(
          `    [${String(event.probe).padStart(2)}]  ` +
            `${String(event.subset.length).padStart(3)} of ${String(event.of).padEnd(3)}  ${label}\n`,
        );
        if (pendingOutput !== undefined) process.stdout.write(pendingOutput);
        pendingOutput = undefined;
      },
    });

    // An answer that did not survive being re-run is not a finding.
    const found = report.searchable && report.result !== undefined && !report.flaky;

    if (json) {
      printJson(searchToJson(report, { verbose: values.verbose }));
      return found ? 0 : 1;
    }

    if (!report.searchable || !report.result) {
      process.stdout.write(`\n  CANNOT SEARCH  ${report.reason}\n\n`);
      return 1;
    }

    process.stdout.write(
      formatCulprit({
        culprits: report.result.culprits,
        patches: report.patches,
        total: report.hunks.length,
        testRuns: report.testRuns,
        minimal: report.result.minimal,
        elapsedMs: report.elapsedMs,
        repeat: report.repeat,
        flaky: report.flaky,
      }),
    );
    return found ? 0 : 1;
  }

  return fail(`Unknown command: ${command}`);
}

const argv = process.argv.slice(2);
// Known before parsing, so even a parse error can be reported as JSON.
const json = splitCommand(argv).own.includes("--json");

main(argv, json)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    reportError(`whodunit: ${message}`, json);
    // parseArgs rejects unknown or malformed options with an ERR_PARSE_ARGS_*
    // code. That is bad usage, the same as any other invalid option.
    const code = (error as { code?: unknown } | null)?.code;
    process.exitCode = typeof code === "string" && code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  });
