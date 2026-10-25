import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execOrThrow } from "../src/util/exec.js";

const posixOnly = { skip: process.platform === "win32" ? "uses POSIX signals" : false };

let root: string;
let repo: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "whodunit-interrupt-"));
  repo = join(root, "repo");
  await execOrThrow("git", ["init", "-q", repo], { cwd: root });
  await execOrThrow("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  await execOrThrow("git", ["config", "user.name", "test"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "before\n");
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "base"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "after\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Resolve once `path` exists, or reject after `ms`. */
async function waitForFile(path: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} mid-search removes the sandbox and exits`, posixOnly, async () => {
    // The test command records where it runs, then hangs, so the signal lands
    // while the sandbox is in use. That is the moment a user reaches for Ctrl+C.
    const marker = join(root, `${signal}.where`);
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    // Resolve tsx from here: the child runs inside the fixture repo, where a
    // bare "tsx" specifier would not be found.
    const tsx = import.meta.resolve("tsx");
    const child = spawn(
      process.execPath,
      ["--import", tsx, cli, "--", "sh", "-c", 'pwd > "$MARK"; sleep 30'],
      { cwd: repo, env: { ...process.env, MARK: marker }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

    await waitForFile(marker, 15000);
    // Give the shell a moment to finish writing the path.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sandbox = (await readFile(marker, "utf8")).trim();
    assert.ok(existsSync(sandbox), "the sandbox should exist while the test runs");

    child.kill(signal);
    const code = await exited;

    assert.equal(code, signal === "SIGINT" ? 130 : 143);
    // The killed test run must not be read as a result.
    assert.doesNotMatch(stdout, /CANNOT SEARCH|Found it|Narrowed/, stdout);
    assert.equal(existsSync(sandbox), false, `sandbox ${sandbox} was left behind`);
    const worktrees = await execOrThrow("git", ["worktree", "list"], { cwd: repo });
    assert.equal(worktrees.stdout.trim().split("\n").length, 1, worktrees.stdout);
  });
}
