import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow } from "../src/util/exec.js";
import { search, type RunEvent } from "../src/commands/search.js";
import { listHunks } from "../src/commands/hunks.js";
import { checkPreconditions } from "../src/commands/doctor.js";

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

test("a hunk that only breaks the build is skipped, not blamed", async () => {
  // run.js stands in for a build step: when the modules will not even load,
  // it exits 125 to say "cannot judge this state".
  await commitGreen();
  await writeFile(
    join(repo, "run.js"),
    `try {
  await import("./test.js");
} catch (error) {
  console.error(error.message);
  process.exit(125);
}
`,
  );
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "add build wrapper"], { cwd: repo });

  // mod1 gains an export that mod5 starts importing, and mod6 is the real
  // regression. Testing mod5's hunk without mod1's fails to link. Counting
  // that as a failure would blame mod5, which broke nothing.
  await writeProject(6, true);
  const mod1 = join(repo, "src", "mod1.js");
  await writeFile(mod1, `export const SCALE = 1;\n${await readFile(mod1, "utf8")}`);
  const mod5 = join(repo, "src", "mod5.js");
  await writeFile(
    mod5,
    `import { SCALE } from "./mod1.js";\n` +
      (await readFile(mod5, "utf8")).replace("input * 50", "input * 50 * SCALE"),
  );

  const outcomes: string[] = [];
  const report = await search({
    repo,
    baselineRef: "HEAD",
    testCommand: ["node", "run.js"],
    onProbe: (event) => outcomes.push(event.outcome),
  });

  assert.equal(report.searchable, true, report.reason);
  assert.ok(report.result);
  assert.ok(outcomes.includes("unresolved"), "no probe hit the broken build");
  assert.deepEqual(
    report.result.culprits.map((hunk) => hunk.file),
    ["src/mod6.js"],
  );

  await commitGreen();
  await rm(join(repo, "run.js"));
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "drop build wrapper"], { cwd: repo });
});

test("no snapshot refs are left behind by any command", async () => {
  await commitGreen();
  await writeProject(6, true);
  const snapshotRefs = async () =>
    (
      await execOrThrow("git", ["for-each-ref", "--format=%(refname)", "refs/whodunit"], {
        cwd: repo,
      })
    ).stdout.trim();

  await listHunks({ repo, baselineRef: "HEAD" });
  assert.equal(await snapshotRefs(), "", "hunks left a ref");

  await checkPreconditions({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND });
  assert.equal(await snapshotRefs(), "", "doctor left a ref");

  const report = await search({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND });
  assert.equal(report.result?.culprits[0]?.file, "src/mod6.js");
  assert.equal(await snapshotRefs(), "", "search left a ref");
});

test("every test run is reported with its output, and all of them are counted", async () => {
  await commitGreen();
  await writeProject(6, true);

  const runs: RunEvent[] = [];
  const report = await search({
    repo,
    baselineRef: "HEAD",
    testCommand: TEST_COMMAND,
    onRun: (event) => runs.push(event),
  });

  assert.ok(report.result);
  assert.deepEqual(
    runs.slice(0, 2).map((event) => event.kind),
    ["baseline", "current"],
  );
  const [baseline, current] = runs;
  assert.ok(baseline?.kind === "baseline" && baseline.result.stdout.includes("ok"));
  assert.ok(current?.kind === "current" && current.result.stderr.includes("FAIL calc6"));

  const probes = runs.filter((event) => event.kind === "probe");
  assert.equal(probes.length, report.result.probes);
  // The two precondition runs happened too, so they belong in the count.
  assert.equal(report.testRuns, report.result.probes + 2);
});

test("an aborted search stops, rejects, and leaves no sandbox", async () => {
  await commitGreen();
  await writeProject(6, true);
  const controller = new AbortController();
  let probesAfterAbort = 0;

  await assert.rejects(
    search({
      repo,
      baselineRef: "HEAD",
      testCommand: TEST_COMMAND,
      signal: controller.signal,
      onProbe: (event) => {
        if (controller.signal.aborted && !event.cached) probesAfterAbort++;
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );

  assert.equal(probesAfterAbort, 0, "the search kept running after the abort");
  const worktrees = await execOrThrow("git", ["worktree", "list"], { cwd: repo });
  assert.equal(worktrees.stdout.trim().split("\n").length, 1, "a sandbox was left behind");
});

/**
 * A test command that counts its own runs in a file outside the sandbox, so a
 * test can make it misbehave on chosen runs. `rule` is shell that sees the run
 * number as $n and may exit early; otherwise the real test runs.
 */
function countingTest(rule: string): string[] {
  const counter = join(root, `counter-${Math.random().toString(36).slice(2)}`);
  return ["sh", "-c", `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; ${rule} exec node test.js`];
}

test("--repeat catches a test that flakes at the baseline instead of searching", async () => {
  await commitGreen();
  await writeProject(6, true);
  // The second run of the unchanged baseline fails for no reason.
  const testCommand = countingTest("[ $n -eq 2 ] && exit 1;");

  const report = await search({ repo, baselineRef: "HEAD", testCommand, repeat: 3 });

  assert.equal(report.searchable, false);
  assert.match(report.reason, /flaky/);
  assert.equal(report.flaky?.stage, "baseline");
  assert.deepEqual(report.flaky?.outcomes, ["pass", "fail"]);
  assert.equal(report.testRuns, 2, "it should stop at the first disagreement");
});

test("--repeat confirms a stable answer", async () => {
  await commitGreen();
  await writeProject(6, true);

  const report = await search({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND, repeat: 3 });

  assert.equal(report.searchable, true, report.reason);
  assert.equal(report.flaky, undefined);
  assert.equal(report.repeat, 3);
  assert.deepEqual(report.result?.culprits.map((hunk) => hunk.file), ["src/mod6.js"]);
});

test("--repeat rejects an answer that does not hold up when re-run", async () => {
  await commitGreen();
  await writeProject(6, true);
  // Learn how many runs a stable search of this fixture takes, then make the
  // test start passing right after that point, as a flaky test might.
  const stable = await search({ repo, baselineRef: "HEAD", testCommand: TEST_COMMAND });
  const searchRuns = stable.testRuns - 2;
  const lastHonestRun = 3 + 3 + searchRuns;
  const testCommand = countingTest(`[ $n -gt ${lastHonestRun} ] && exit 0;`);

  const report = await search({ repo, baselineRef: "HEAD", testCommand, repeat: 3 });

  assert.equal(report.flaky?.stage, "confirm");
  assert.match(report.reason, /did not hold up/);
  assert.ok(report.result, "the unconfirmed set is still reported");
});

test("doctor --repeat reports a flaky current tree", async () => {
  await commitGreen();
  await writeProject(6, true);
  // Runs 1-3 are the baseline. Run 5 is the second current run.
  const testCommand = countingTest("[ $n -eq 5 ] && exit 0;");

  const report = await checkPreconditions({ repo, baselineRef: "HEAD", testCommand, repeat: 3 });

  assert.equal(report.searchable, false);
  assert.equal(report.flaky?.stage, "current");
  assert.deepEqual(report.flaky?.outcomes, ["fail", "pass"]);
});
