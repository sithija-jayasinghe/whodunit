import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import { runTest } from "../src/runner/test.js";

function exitWith(code: number): string[] {
  return [process.execPath, "-e", `process.exit(${code})`];
}

const cwd = tmpdir();

test("exit 0 is a pass and any other code is a fail", async () => {
  assert.equal((await runTest(exitWith(0), { cwd })).outcome, "pass");
  assert.equal((await runTest(exitWith(1), { cwd })).outcome, "fail");
  assert.equal((await runTest(exitWith(2), { cwd })).outcome, "fail");
});

test("exit 125 means the state cannot be judged, as in git bisect run", async () => {
  const result = await runTest(exitWith(125), { cwd });

  assert.equal(result.outcome, "unresolved");
  assert.equal(result.exitCode, 125);
  assert.equal(result.timedOut, false);
});

test("custom skip codes replace the default", async () => {
  const options = { cwd, skipExitCodes: [3] };

  assert.equal((await runTest(exitWith(3), options)).outcome, "unresolved");
  assert.equal((await runTest(exitWith(125), options)).outcome, "fail");
  assert.equal((await runTest(exitWith(0), options)).outcome, "pass");
});

test("a timeout is unresolved", async () => {
  const result = await runTest([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
    cwd,
    timeoutMs: 200,
  });

  assert.equal(result.outcome, "unresolved");
  assert.equal(result.timedOut, true);
});

function failWith(stream: "stdout" | "stderr", text: string): string[] {
  return [process.execPath, "-e", `process.${stream}.write(${JSON.stringify(text)}); process.exit(1)`];
}

test("with match, only a failure that prints the text counts as a fail", async () => {
  const options = { cwd, match: "expected 5" };

  const same = await runTest(failWith("stdout", "FAIL sum: got -1, expected 5\n"), options);
  assert.equal(same.outcome, "fail");
  assert.equal(same.otherFailure, false);

  const other = await runTest(failWith("stderr", "SyntaxError: unexpected token\n"), options);
  assert.equal(other.outcome, "unresolved", "a different failure cannot be judged");
  assert.equal(other.otherFailure, true);
});

test("with match, the text may be on stderr, and a pass is still a pass", async () => {
  const options = { cwd, match: "expected 5" };

  assert.equal((await runTest(failWith("stderr", "expected 5\n"), options)).outcome, "fail");
  assert.equal((await runTest(exitWith(0), options)).outcome, "pass");
});
