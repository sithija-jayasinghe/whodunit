import { test } from "node:test";
import assert from "node:assert/strict";

import { formatCulprit, formatRunOutput } from "../src/report/format.js";
import type { Hunk } from "../src/types.js";

test("run output is indented under its run, stdout before stderr", () => {
  const text = formatRunOutput({ stdout: "ok 1\nok 2\n", stderr: "FAIL 3\n" }, "  ");

  assert.equal(text, "  | ok 1\n  | ok 2\n  | FAIL 3\n");
});

test("a silent run says so instead of printing nothing", () => {
  assert.equal(formatRunOutput({ stdout: "", stderr: "\n" }, ""), "| (no output)\n");
});

test("blank lines inside the output keep their marker without trailing spaces", () => {
  const text = formatRunOutput({ stdout: "a\n\nb", stderr: "" }, "  ");

  assert.equal(text, "  | a\n  |\n  | b\n");
});

test("the run count in the report is the one it is given", () => {
  const hunk: Hunk = {
    id: "a.js:0",
    file: "a.js",
    index: 0,
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    removed: 1,
    added: 1,
    oldStart: 1,
    newStart: 1,
    atomic: false,
  };
  const text = formatCulprit({
    culprits: [hunk],
    patches: [],
    total: 1,
    testRuns: 2,
    minimal: true,
    elapsedMs: 1500,
  });

  assert.match(text, /2 test runs in 1\.5s/);
});
