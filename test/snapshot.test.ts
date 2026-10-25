import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow } from "../src/util/exec.js";
import { snapshotWorkingTree } from "../src/git/snapshot.js";

let root: string;
let repo: string;

before(async () => {
  // Hide the global and system git config, as on a fresh CI runner or in a
  // container. Each test file runs in its own process, so this stays here.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const name of ["AUTHOR", "COMMITTER"]) {
    delete process.env[`GIT_${name}_NAME`];
    delete process.env[`GIT_${name}_EMAIL`];
  }
  delete process.env.EMAIL;

  root = await mkdtemp(join(tmpdir(), "whodunit-snapshot-"));
  repo = join(root, "repo");
  await execOrThrow("git", ["init", "-q", repo], { cwd: root });
  await writeFile(join(repo, "file.txt"), "before\n");
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow(
    "git",
    ["-c", "user.name=someone", "-c", "user.email=someone@example.com", "commit", "-qm", "base"],
    { cwd: repo },
  );
  // Forbid guessing an identity from the hostname. Without this the test
  // would pass on any machine whose hostname git can turn into an address,
  // which is exactly how the bug hid on a laptop.
  await execOrThrow("git", ["config", "user.useConfigOnly", "true"], { cwd: repo });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a snapshot works in a repo with no git identity configured", async () => {
  await writeFile(join(repo, "file.txt"), "after\n");

  const snapshot = await snapshotWorkingTree(repo, "whodunit: test snapshot");
  try {
    const content = await execOrThrow("git", ["show", `${snapshot.commit}:file.txt`], { cwd: repo });
    assert.equal(content.stdout, "after\n");
  } finally {
    await snapshot.release();
  }
});

test("the snapshot does not touch the user's identity settings", async () => {
  const config = await execOrThrow("git", ["config", "--get-regexp", "^user\\."], { cwd: repo });

  assert.equal(config.stdout.trim(), "user.useconfigonly true");
});
