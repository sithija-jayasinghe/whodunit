import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDiff, collectHunks } from "../src/diff/parse.js";

test("parses a multi-hunk single-file diff", () => {
  const diff = [
    "diff --git a/sum.js b/sum.js",
    "index 1111111..2222222 100644",
    "--- a/sum.js",
    "+++ b/sum.js",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10,3 +10,4 @@",
    " ten",
    "-eleven",
    "+ELEVEN",
    "+extra",
    " twelve",
    "",
  ].join("\n");

  const patches = parseDiff(diff);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.file, "sum.js");
  assert.equal(patches[0]!.hunks.length, 2);

  const [first, second] = patches[0]!.hunks;
  assert.equal(first!.id, "sum.js:0");
  assert.equal(first!.removed, 1);
  assert.equal(first!.added, 1);
  assert.equal(first!.oldStart, 1);
  assert.match(first!.patch, /^@@ -1,3 \+1,3 @@/);
  assert.ok(!first!.patch.includes("@@ -10,3"), "hunks must not bleed into each other");

  assert.equal(second!.id, "sum.js:1");
  assert.equal(second!.removed, 1);
  assert.equal(second!.added, 2);
  assert.equal(second!.oldStart, 10);
});

test("does not mistake diff text inside a hunk body for structure", () => {
  // A hunk body containing lines that look like diff markers is exactly the
  // case that breaks marker-scanning parsers. Counting lines survives it.
  const diff = [
    "diff --git a/doc.md b/doc.md",
    "--- a/doc.md",
    "+++ b/doc.md",
    "@@ -1,4 +1,4 @@",
    " intro",
    "-diff --git a/fake b/fake",
    "+@@ -1,1 +1,1 @@",
    " outro",
    "",
  ].join("\n");

  const patches = parseDiff(diff);
  assert.equal(patches.length, 1, "one real file section");
  assert.equal(patches[0]!.hunks.length, 1, "one real hunk");
  assert.ok(patches[0]!.hunks[0]!.patch.includes("-diff --git a/fake b/fake"));
});

test("handles added and deleted files", () => {
  const diff = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");

  const patches = parseDiff(diff);
  assert.deepEqual(patches.map((p) => p.file), ["new.txt", "gone.txt"]);
  assert.equal(patches[0]!.hunks[0]!.added, 2);
  assert.equal(patches[0]!.hunks[0]!.removed, 0);
  assert.equal(patches[1]!.hunks[0]!.removed, 1);
  assert.equal(patches[1]!.hunks[0]!.added, 0);
});

test("keeps the no-newline marker with its hunk", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  const patches = parseDiff(diff);
  const hunk = patches[0]!.hunks[0]!;
  assert.equal(hunk.removed, 1);
  assert.equal(hunk.added, 1);
  assert.equal((hunk.patch.match(/\\ No newline/g) ?? []).length, 2);
});

test("treats a binary change as one atomic hunk", () => {
  const diff = [
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "GIT binary patch",
    "literal 8",
    "PcmZQzU|?*17zP4A0Zjj9",
    "",
    "diff --git a/after.txt b/after.txt",
    "--- a/after.txt",
    "+++ b/after.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");

  const patches = parseDiff(diff);
  assert.equal(patches.length, 2, "binary section must not swallow the next file");
  assert.equal(patches[0]!.binary, true);
  assert.equal(patches[0]!.hunks.length, 1);
  assert.equal(patches[0]!.hunks[0]!.atomic, true);
  assert.equal(patches[1]!.file, "after.txt");
});

test("treats a mode-only change as one atomic hunk", () => {
  const diff = [
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n");

  const patches = parseDiff(diff);
  assert.equal(patches[0]!.hunks.length, 1);
  assert.equal(patches[0]!.hunks[0]!.atomic, true);
  assert.equal(patches[0]!.hunks[0]!.patch, "", "the header alone is the change");
});

test("empty diff yields no patches", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("\n  \n"), []);
});

test("collectHunks flattens in order with unique ids", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-1",
    "+2",
    "@@ -5 +5 @@",
    "-5",
    "+6",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");

  const hunks = collectHunks(parseDiff(diff));
  assert.deepEqual(hunks.map((h) => h.id), ["a.txt:0", "a.txt:1", "b.txt:0"]);
  assert.equal(new Set(hunks.map((h) => h.id)).size, hunks.length);
});
