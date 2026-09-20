import { test } from "node:test";
import assert from "node:assert/strict";

import { ddmin, type Probe } from "../src/search/ddmin.js";
import type { Hunk, Outcome } from "../src/types.js";

function hunk(n: number): Hunk {
  return {
    id: `file.ts:${n}`,
    file: "file.ts",
    index: n,
    patch: `@@ -${n} +${n} @@\n-old${n}\n+new${n}\n`,
    removed: 1,
    added: 1,
    oldStart: n,
    newStart: n,
    atomic: false,
  };
}

function hunks(count: number): Hunk[] {
  return Array.from({ length: count }, (_, i) => hunk(i));
}

/**
 * An oracle that fails only when every hunk in `required` is present.
 * `unbuildable` marks subsets the probe cannot judge, standing in for a patch
 * that will not apply or a state that will not compile.
 */
function oracle(
  required: readonly number[],
  options: { unbuildable?: (ids: ReadonlySet<string>) => boolean } = {},
): { probe: Probe; calls: string[][] } {
  const calls: string[][] = [];
  const probe: Probe = async (subset) => {
    const ids = new Set(subset.map((h) => h.id));
    calls.push([...ids].sort());
    if (options.unbuildable?.(ids)) return "unresolved";
    return required.every((n) => ids.has(`file.ts:${n}`)) ? "fail" : "pass";
  };
  return { probe, calls };
}

/** Removing any single hunk must stop the failure. */
async function assertOneMinimal(result: readonly Hunk[], probe: Probe) {
  for (const dropped of result) {
    const reduced = result.filter((h) => h.id !== dropped.id);
    const outcome: Outcome = await probe(reduced);
    assert.notEqual(outcome, "fail", `${dropped.id} was not actually needed`);
  }
}

test("finds a single culprit among thirty and proves it minimal", async () => {
  for (const culprit of [0, 7, 15, 29]) {
    const { probe } = oracle([culprit]);
    const result = await ddmin(hunks(30), probe);

    assert.equal(result.culprits.length, 1, `culprit ${culprit}: expected exactly one`);
    assert.equal(result.culprits[0]!.id, `file.ts:${culprit}`);
    assert.equal(result.minimal, true);
    await assertOneMinimal(result.culprits, probe);
  }
});

test("needs far fewer runs than testing each change one at a time", async () => {
  const { probe } = oracle([23]);
  const result = await ddmin(hunks(30), probe);
  assert.equal(result.culprits[0]!.id, "file.ts:23");
  assert.ok(
    result.probes <= 15,
    `took ${result.probes} probes for 30 hunks; linear search would take 30`,
  );
});

test("finds a pair of hunks that only fail together", async () => {
  // The case a plain bisect cannot handle: neither hunk breaks anything alone.
  const { probe } = oracle([3, 19]);
  const result = await ddmin(hunks(24), probe);

  const ids = result.culprits.map((h) => h.id).sort();
  assert.deepEqual(ids, ["file.ts:19", "file.ts:3"]);
  assert.equal(result.minimal, true);
  await assertOneMinimal(result.culprits, probe);
});

test("works when some states cannot be judged", async () => {
  // Any subset that takes hunk 12 without hunk 11 fails to build, the way a
  // call site can be applied without its new function.
  const { probe } = oracle([17], {
    unbuildable: (ids) => ids.has("file.ts:12") && !ids.has("file.ts:11"),
  });
  const result = await ddmin(hunks(28), probe);

  assert.equal(result.culprits.length, 1);
  assert.equal(result.culprits[0]!.id, "file.ts:17");
  await assertOneMinimal(result.culprits, probe);
});

test("never probes the same subset twice", async () => {
  const { probe, calls } = oracle([9]);
  const result = await ddmin(hunks(32), probe);

  const seen = calls.map((ids) => JSON.stringify(ids));
  assert.equal(new Set(seen).size, seen.length, "a subset was tested more than once");
  assert.equal(result.probes, calls.length, "probe count must match real runs");
});

test("seeded outcomes are not re-run", async () => {
  const all = hunks(16);
  const { probe, calls } = oracle([4]);
  await ddmin(all, probe, {
    seed: [
      { subset: [], outcome: "pass" },
      { subset: all, outcome: "fail" },
    ],
  });

  const full = JSON.stringify(all.map((h) => h.id).sort());
  assert.ok(!calls.some((ids) => JSON.stringify(ids) === full), "full set was re-tested");
});

test("a probe budget returns a real failing set, marked not minimal", async () => {
  const { probe } = oracle([21]);
  const result = await ddmin(hunks(40), probe, { maxProbes: 3 });

  assert.equal(result.minimal, false, "must not claim minimality it did not prove");
  assert.equal(result.probes, 3);
  assert.equal(await probe(result.culprits), "fail", "the partial answer must still reproduce");
});

test("a single hunk needs no probes at all", async () => {
  const { probe } = oracle([0]);
  const result = await ddmin(hunks(1), probe);
  assert.equal(result.culprits.length, 1);
  assert.equal(result.probes, 0);
  assert.equal(result.minimal, true);
});

test("reports progress for every run", async () => {
  const events: string[] = [];
  const { probe } = oracle([5]);
  const result = await ddmin(hunks(16), probe, {
    onProbe: (event) => events.push(`${event.subset.length}/${event.of} ${event.outcome}`),
  });

  assert.ok(events.length >= result.probes);
  assert.ok(events.every((line) => /^\d+\/\d+ (pass|fail|unresolved)$/.test(line)));
});
