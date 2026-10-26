import { test } from "node:test";
import assert from "node:assert/strict";

import { failureSignature, matchesSignature } from "../src/runner/signature.js";

const run = (stdout: string, stderr = "") => ({ stdout, stderr });

test("the signature is what the failing run printed and the passing run did not", () => {
  const baseline = run("running 3 checks\nall passed in 12ms\n");
  const current = run("running 3 checks\n", "FAIL total: expected $70.36, got $65.45\n");

  assert.deepEqual(failureSignature(baseline, current), ["FAIL total: expected $70.36, got $65.45"]);
});

test("numbers do not have to match, so the same failure with other values counts", () => {
  const signature = failureSignature(run(""), run("FAIL total: expected $70.36, got $65.45\n"));

  assert.equal(matchesSignature(run("FAIL total: expected $70.36, got $72.10\n"), signature), true);
  assert.equal(matchesSignature(run("", "ReferenceError: DEFAULT_TAX_RATE is not defined\n"), signature), false);
});

test("lines the passing run also printed are not part of the signature", () => {
  const baseline = run("Test suite started at 10:01:02\n");
  const current = run("Test suite started at 10:01:09\nFAIL total\n");

  assert.deepEqual(failureSignature(baseline, current), ["FAIL total"]);
});

test("a failure that prints nothing new has no signature", () => {
  assert.deepEqual(failureSignature(run("checking\n"), run("checking\n")), []);
});

test("whitespace and blank lines are ignored", () => {
  const signature = failureSignature(run(""), run("\n\n   FAIL   total  \n"));

  assert.deepEqual(signature, ["FAIL   total"]);
  assert.equal(matchesSignature(run("FAIL total\n"), signature), true);
});

test("stack frames and runtime banners do not make a crash look like the failure", () => {
  // Both of these went through Node's uncaught-error path, so they share the
  // stack frames and the version footer. Only the error line tells them apart.
  const assertion = run("", [
    "AssertionError: total: expected 70.36, got 65.45",
    "    at check (file:///work/test.js:14:11)",
    "    at node:internal/modules/esm/module_job:271:25",
    "Node.js v22.23.2",
  ].join("\n"));
  const crash = run("", [
    "ReferenceError: DEFAULT_TAX_RATE is not defined",
    "    at check (file:///work/test.js:14:11)",
    "    at node:internal/modules/esm/module_job:271:25",
    "Node.js v22.23.2",
  ].join("\n"));

  const signature = failureSignature(run(""), assertion);

  assert.deepEqual(signature, ["AssertionError: total: expected 70.36, got 65.45"]);
  assert.equal(matchesSignature(crash, signature), false);
});
