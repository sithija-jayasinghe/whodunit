import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow } from "../src/util/exec.js";
import { diffCommits, applyPatch } from "../src/git/diff.js";
import { parseDiff, collectHunks } from "../src/diff/parse.js";
import { buildPatch, applySubset } from "../src/diff/apply.js";
import { createSandbox, type Sandbox } from "../src/git/worktree.js";
import type { FilePatch, Hunk } from "../src/types.js";

/** 40 numbered lines, so edits land in well-separated hunks. */
function numbered(overrides: Record<number, string | undefined> = {}): string {
  const lines: string[] = [];
  for (let n = 1; n <= 40; n++) lines.push(overrides[n] ?? `line ${n}`);
  return lines.join("\n") + "\n";
}

let root: string;
let repo: string;
let base: string;
let head: string;
let patches: FilePatch[];
let hunks: Hunk[];
let sandbox: Sandbox;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "whodunit-test-"));
  repo = join(root, "repo");
  await execOrThrow("git", ["init", "-q", repo], { cwd: root });
  await execOrThrow("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  await execOrThrow("git", ["config", "user.name", "test"], { cwd: repo });

  await writeFile(join(repo, "main.txt"), numbered());
  await writeFile(join(repo, "side.txt"), "alpha\nbeta\ngamma\n");
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "base"], { cwd: repo });
  base = (await execOrThrow("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  // Three well-separated edits in one file, one edit in another.
  await writeFile(
    join(repo, "main.txt"),
    numbered({ 5: "LINE FIVE", 20: "LINE TWENTY", 35: "LINE THIRTY FIVE" }),
  );
  await writeFile(join(repo, "side.txt"), "alpha\nBETA\ngamma\n");
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "head"], { cwd: repo });
  head = (await execOrThrow("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  patches = parseDiff(await diffCommits(repo, base, head));
  hunks = collectHunks(patches);
  sandbox = await createSandbox(repo, base, { replaceDefaults: true });
});

after(async () => {
  await sandbox?.dispose();
  await rm(root, { recursive: true, force: true });
});

test("git diff splits into the expected hunks", () => {
  assert.deepEqual(patches.map((p) => p.file), ["main.txt", "side.txt"]);
  assert.equal(patches[0]!.hunks.length, 3, "three separated edits, three hunks");
  assert.equal(patches[1]!.hunks.length, 1);
  assert.equal(hunks.length, 4);
});

test("an empty subset produces an empty patch", () => {
  assert.equal(buildPatch(patches, []), "");
});

test("a subset only includes files it touches", () => {
  const patch = buildPatch(patches, [hunks[0]!]);
  assert.ok(patch.includes("main.txt"));
  assert.ok(!patch.includes("side.txt"), "untouched files stay out of the patch");
});

test("every one of the 16 subsets applies and produces exactly the right tree", async () => {
  // The real question phase 3 depends on: can any combination of hunks be
  // built? Skipping a middle hunk shifts the line offsets of the ones after
  // it, which is the case most likely to break.
  const expectedMain = (picked: Set<string>) =>
    numbered({
      ...(picked.has("main.txt:0") ? { 5: "LINE FIVE" } : {}),
      ...(picked.has("main.txt:1") ? { 20: "LINE TWENTY" } : {}),
      ...(picked.has("main.txt:2") ? { 35: "LINE THIRTY FIVE" } : {}),
    });
  const expectedSide = (picked: Set<string>) =>
    picked.has("side.txt:0") ? "alpha\nBETA\ngamma\n" : "alpha\nbeta\ngamma\n";

  for (let mask = 0; mask < 1 << hunks.length; mask++) {
    const subset = hunks.filter((_, index) => (mask & (1 << index)) !== 0);
    const picked = new Set(subset.map((h) => h.id));

    const result = await applySubset(sandbox.path, patches, subset);
    assert.equal(result.applied, true, `subset ${[...picked].join(",") || "(empty)"} failed: ${result.stderr}`);

    assert.equal(
      await readFile(join(sandbox.path, "main.txt"), "utf8"),
      expectedMain(picked),
      `main.txt wrong for subset ${[...picked].join(",") || "(empty)"}`,
    );
    assert.equal(
      await readFile(join(sandbox.path, "side.txt"), "utf8"),
      expectedSide(picked),
      `side.txt wrong for subset ${[...picked].join(",") || "(empty)"}`,
    );
  }
});

test("skipping a middle hunk still places the later one correctly", async () => {
  const subset = [hunks[0]!, hunks[2]!];
  const result = await applySubset(sandbox.path, patches, subset);
  assert.equal(result.applied, true, result.stderr);

  const content = await readFile(join(sandbox.path, "main.txt"), "utf8");
  const lines = content.split("\n");
  assert.equal(lines[4], "LINE FIVE");
  assert.equal(lines[19], "line 20", "the skipped hunk must not be applied");
  assert.equal(lines[34], "LINE THIRTY FIVE", "the later hunk must still land");
});

test("the full subset reproduces the head tree exactly", async () => {
  const result = await applySubset(sandbox.path, patches, hunks);
  assert.equal(result.applied, true, result.stderr);

  const status = await execOrThrow("git", ["diff", "--stat", head], { cwd: sandbox.path });
  assert.equal(status.stdout.trim(), "", "sandbox should now match head");
});

test("a patch that does not apply is reported, not thrown", async () => {
  const bogus = [
    "diff --git a/main.txt b/main.txt",
    "--- a/main.txt",
    "+++ b/main.txt",
    "@@ -1,3 +1,3 @@",
    " nothing",
    "-like",
    "+the",
    " file",
    "",
  ].join("\n");

  const result = await applyPatch(sandbox.path, bogus);
  assert.equal(result.ok, false);
  assert.ok(result.stderr.length > 0, "git should say why");
});

test("applying a subset resets residue from the previous attempt", async () => {
  await applySubset(sandbox.path, patches, hunks);
  const after = await applySubset(sandbox.path, patches, []);
  assert.equal(after.applied, true);
  assert.equal(await readFile(join(sandbox.path, "main.txt"), "utf8"), numbered());
});
