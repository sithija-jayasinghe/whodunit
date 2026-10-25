import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec, execOrThrow } from "../src/util/exec.js";

let root: string;
let repo: string;

/**
 * Run the real CLI inside the fixture repo. tsx is resolved from here: the
 * child runs in the fixture, where a bare "tsx" specifier would not be found.
 */
function whodunit(...args: string[]) {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  return exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
    cwd: repo,
    timeoutMs: 60000,
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "whodunit-cli-"));
  repo = join(root, "repo");
  await execOrThrow("git", ["init", "-q", repo], { cwd: root });
  await execOrThrow("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  await execOrThrow("git", ["config", "user.name", "test"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "fine\n");
  await writeFile(join(repo, "b.txt"), "fine\n");
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "base"], { cwd: repo });
  // Two changes; only the one in b.txt breaks the "test".
  await writeFile(join(repo, "a.txt"), "fine, reworded\n");
  await writeFile(join(repo, "b.txt"), "broken\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const TEST = ["sh", "-c", "! grep -q broken b.txt"];

test("--json prints exactly one parseable document naming the culprit", async () => {
  const result = await whodunit("--json", "--", ...TEST);

  assert.equal(result.exitCode, 0, result.stderr);
  // No progress lines mixed in: the whole of stdout must parse.
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 1);
  assert.equal(report.command, "run");
  assert.equal(report.searchable, true);
  assert.equal(report.minimal, true);
  assert.equal(report.totalChanges, 2);
  assert.deepEqual(
    report.culprits.map((hunk: { file: string }) => hunk.file),
    ["b.txt"],
  );
  assert.match(report.culprits[0].patch, /\+broken/);
  assert.equal(report.current.outcome, "fail");
  assert.equal(report.current.stdout, undefined, "output is only included with --verbose");
});

test("--json --verbose includes the test output", async () => {
  const result = await whodunit("doctor", "--json", "--verbose", "--", "sh", "-c", "echo hello; exit 1");

  const report = JSON.parse(result.stdout);
  assert.equal(report.command, "doctor");
  assert.equal(report.baseline.stdout, "hello\n");
});

test("--json hunks lists every change", async () => {
  const result = await whodunit("hunks", "--json");

  const listing = JSON.parse(result.stdout);
  assert.equal(listing.command, "hunks");
  assert.deepEqual(
    listing.hunks.map((hunk: { file: string; line: number }) => `${hunk.file}:${hunk.line}`),
    ["a.txt:1", "b.txt:1"],
  );
});

test("a usage error under --json is still JSON, with the usual exit code", async () => {
  const result = await whodunit("--json", "--timeout", "soon", "--", ...TEST);

  assert.equal(result.exitCode, 2);
  assert.match(JSON.parse(result.stdout).error, /--timeout/);
});

test("an unknown option is bad usage, exit 2", async () => {
  const result = await whodunit("--json", "--bogus", "--", ...TEST);

  assert.equal(result.exitCode, 2);
  assert.match(JSON.parse(result.stdout).error, /--bogus/);
});

test("nothing to search is reported in JSON, not as an error", async () => {
  const result = await whodunit("--json", "--", "true");

  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.searchable, false);
  assert.match(report.reason, /Nothing is broken/);
  assert.deepEqual(report.culprits, []);
});
