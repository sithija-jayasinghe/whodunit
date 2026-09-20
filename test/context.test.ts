import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow } from "../src/util/exec.js";
import { diffCommits } from "../src/git/diff.js";
import { parseDiff, collectHunks } from "../src/diff/parse.js";
import { applySubset } from "../src/diff/apply.js";
import { createSandbox, type Sandbox } from "../src/git/worktree.js";

/**
 * Thirty small functions. Each one's body changes, but every signature and
 * brace survives. This is the shape of a routine agent refactor, and the case
 * where Git's hunk merging decides how finely we can bisect.
 */
function source(rewritten: ReadonlySet<number>): string {
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) {
    lines.push(`function step${i}() {`);
    if (rewritten.has(i)) {
      lines.push(`  const value = ${i} * 2;`);
      lines.push("  return value;");
    } else {
      lines.push(`  return ${i};`);
    }
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

const none = new Set<number>();
const all = new Set<number>(Array.from({ length: 30 }, (_, i) => i + 1));

let root: string;
let repo: string;
let base: string;
let head: string;
let sandbox: Sandbox;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "whodunit-ctx-"));
  repo = join(root, "repo");
  await execOrThrow("git", ["init", "-q", repo], { cwd: root });
  await execOrThrow("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  await execOrThrow("git", ["config", "user.name", "test"], { cwd: repo });

  await writeFile(join(repo, "steps.js"), source(none));
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "base"], { cwd: repo });
  base = (await execOrThrow("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  await writeFile(join(repo, "steps.js"), source(all));
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "head"], { cwd: repo });
  head = (await execOrThrow("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  sandbox = await createSandbox(repo, base, { replaceDefaults: true });
});

after(async () => {
  await sandbox?.dispose();
  await rm(root, { recursive: true, force: true });
});

test("context level decides how finely a refactor can be split", async () => {
  const counts: Record<number, number> = {};
  for (const context of [0, 1, 2, 3]) {
    const patches = parseDiff(await diffCommits(repo, base, head, { contextLines: context }));
    counts[context] = collectHunks(patches).length;
  }

  // Thirty independent edits. At -U2 and above Git merges them into one hunk,
  // because three blank/brace lines separate them and the context windows touch.
  assert.equal(counts[0], 30);
  assert.equal(counts[1], 30);
  assert.equal(counts[3], 1, "the default hides all thirty edits behind one hunk");
});

/** Which function number does this hunk rewrite? */
function functionOf(patch: string): number {
  const match = /^\+\s*const value = (\d+) \* 2;$/m.exec(patch);
  assert.ok(match, `could not identify hunk:\n${patch}`);
  return Number(match[1]);
}

for (const context of [1]) {
  test(`-U${context}: every hunk applies alone and lands on the right function`, async () => {
    const patches = parseDiff(await diffCommits(repo, base, head, { contextLines: context }));
    const hunks = collectHunks(patches);
    assert.equal(hunks.length, 30);

    for (const hunk of hunks) {
      const n = functionOf(hunk.patch);
      const result = await applySubset(sandbox.path, patches, [hunk]);
      assert.equal(result.applied, true, `hunk for step${n} was rejected: ${result.stderr}`);
      assert.equal(
        await readFile(join(sandbox.path, "steps.js"), "utf8"),
        source(new Set([n])),
        `hunk for step${n} produced the wrong tree`,
      );
    }
  });

  test(`-U${context}: scattered subsets apply and produce exactly the right tree`, async () => {
    const patches = parseDiff(await diffCommits(repo, base, head, { contextLines: context }));
    const hunks = collectHunks(patches);

    // Interleaved, contiguous, and the halves a binary search actually asks for.
    const selections: number[][] = [
      [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29],
      [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
      [1, 30],
      [15],
      [1, 2, 29, 30],
    ];

    for (const picked of selections) {
      const wanted = new Set(picked);
      const subset = hunks.filter((hunk) => wanted.has(functionOf(hunk.patch)));
      assert.equal(subset.length, picked.length, "test setup: hunk selection mismatch");

      const result = await applySubset(sandbox.path, patches, subset);
      assert.equal(result.applied, true, `subset [${picked}] rejected: ${result.stderr}`);
      assert.equal(
        await readFile(join(sandbox.path, "steps.js"), "utf8"),
        source(wanted),
        `subset [${picked}] produced the wrong tree`,
      );
    }
  });
}

test("zero context is rejected by git apply, which is why 1 is the floor", async () => {
  // -U0 splits no more finely than -U1 here, and `git apply` refuses the
  // result without --unidiff-zero. That flag turns off the context check that
  // stops a hunk landing in the wrong place, so we do not use it.
  const patches = parseDiff(await diffCommits(repo, base, head, { contextLines: 0 }));
  const hunks = collectHunks(patches);
  assert.equal(hunks.length, 30, "same granularity as -U1");

  const result = await applySubset(sandbox.path, patches, [hunks[0]!]);
  assert.equal(result.applied, false);
  assert.match(result.stderr, /does not apply/);
});

test("a genuinely new file is one hunk at any context level", async () => {
  // This is the limitation that is real: there is no baseline to bisect
  // against, so the whole file is one indivisible change.
  await writeFile(join(repo, "brand-new.js"), "export const a = 1;\nexport const b = 2;\n");
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "add file"], { cwd: repo });
  const withFile = (await execOrThrow("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  for (const context of [0, 1, 3]) {
    const patches = parseDiff(await diffCommits(repo, head, withFile, { contextLines: context }));
    assert.equal(patches.length, 1);
    assert.equal(patches[0]!.hunks.length, 1, `-U${context} should still be one hunk`);
  }
});
