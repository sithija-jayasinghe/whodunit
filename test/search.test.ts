import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow } from "../src/util/exec.js";
import { search } from "../src/commands/search.js";

const TEST_COMMAND = ["node", "test.js"];

let root: string;
let repo: string;

/**
 * Eight modules, one function each.
 *
 * `touched` adds a harmless comment to every module, so that all eight files
 * differ from the baseline. Without it only the broken file would show up in
 * the diff and there would be nothing to search.
 */
async function writeProject(broken: number | null, touched = false) {
  await mkdir(join(repo, "src"), { recursive: true });
  for (let m = 1; m <= 8; m++) {
    const lines = [`export function calc${m}(input) {`];
    if (touched) lines.push("  // normalized in refactor pass");
    lines.push(m === broken ? `  return input * ${m * 10};` : `  return input * ${m * 10} + ${m};`);
    lines.push("}");
    await writeFile(join(repo, "src", `mod${m}.js`), lines.join("\n") + "\n");
  }
}

async function writeHarness() {
  const imports: string[] = [];
  const checks: string[] = [];
  for (let m = 1; m <= 8; m++) {
    imports.push(`import { calc${m} } from './src/mod${m}.js';`);
    checks.push(`check('calc${m}', calc${m}(2), ${2 * m * 10 + m});`);
  }
  await writeFile(
    join(repo, "test.js"),
    `${imports.join("\n")}

let failed = 0;
function check(label, actual, expected) {
  if (actual !== expected) { console.error('FAIL ' + label); failed++; }
}

${checks.join("\n")}

if (failed > 0) process.exit(1);
console.log("ok");
`,
  );
}

/** Put the repo back to a committed, passing state. */
async function commitGreen() {
  await writeProject(null);
  await writeHarness();
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-q", "--allow-empty", "-m", "green"], { cwd: repo });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "whodunit-search-"));
  repo = join(root, "repo");
  await execOrThrow("git", ["init", "-q", repo], { cwd: root });
  await execOrThrow("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  await execOrThrow("git", ["config", "user.name", "test"], { cwd: repo });
  await writeFile(join(repo, "package.json"), '{"type":"module"}\n');
  await writeProject(null);
  await writeHarness();
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "green"], { cwd: repo });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("finds the one broken module among eight, end to end", async () => {
  await writeProject(6, true);

  const report = await search({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND });

  assert.equal(report.searchable, true, report.reason);
  assert.equal(report.hunks.length, 8, "every module should differ from the baseline");
  assert.ok(report.result);
  assert.equal(report.result.minimal, true);
  assert.equal(report.result.culprits.length, 1);
  assert.equal(report.result.culprits[0]!.file, "src/mod6.js");
  assert.ok(
    report.result.probes < report.hunks.length,
    `used ${report.result.probes} probes for ${report.hunks.length} hunks`,
  );
});

test("the real working tree is never touched by a search", async () => {
  await writeProject(6, true);
  const before = await execOrThrow("git", ["status", "--porcelain"], { cwd: repo });

  await search({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND });

  const after = await execOrThrow("git", ["status", "--porcelain"], { cwd: repo });
  assert.equal(after.stdout, before.stdout, "working tree changed during the search");

  const worktrees = await execOrThrow("git", ["worktree", "list"], { cwd: repo });
  assert.equal(
    worktrees.stdout.trim().split("\n").length,
    1,
    "a sandbox worktree was left behind",
  );
});

test("says so when nothing is broken instead of searching", async () => {
  await writeProject(null, true);

  const report = await search({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND });

  assert.equal(report.searchable, false);
  assert.match(report.reason, /Nothing is broken/);
  assert.equal(report.result, undefined);
});

test("says so when the baseline is already failing", async () => {
  // The baseline is a checkout of HEAD, not of the working tree, so HEAD
  // itself has to be broken for this case to arise.
  await writeProject(6);
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "broken baseline"], { cwd: repo });
  await writeProject(6, true);

  const report = await search({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND });

  assert.equal(report.searchable, false);
  assert.match(report.reason, /already fails at the baseline/);

  await commitGreen();
});

test("a probe budget still returns a real failing set", async () => {
  await commitGreen();
  await writeProject(6, true);

  const report = await search({
    repo,
    baselineRef: "HEAD",
    testCommand: TEST_COMMAND,
    maxProbes: 2,
  });

  assert.equal(report.searchable, true, report.reason);
  assert.ok(report.result);
  assert.equal(report.result.probes, 2, "the budget must actually bind");
  assert.equal(report.result.minimal, false, "must not claim minimality it did not prove");
  assert.ok(report.result.culprits.length > 0);
});
