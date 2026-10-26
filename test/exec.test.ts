import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec } from "../src/util/exec.js";

const posixOnly = { skip: process.platform === "win32" ? "uses sh" : false };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a timeout returns promptly even when a grandchild holds the pipes", posixOnly, async () => {
  // `npm test` behaves like this: the shell we spawn starts a long-running
  // child that inherits stdout. Killing only the shell leaves that child
  // holding the pipe open, and we would wait out its full runtime.
  const startedAt = Date.now();
  const result = await exec("sh", ["-c", "sleep 30; echo done"], { timeoutMs: 300 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 5000, `took ${elapsed}ms to return after a 300ms timeout`);
});

test("a timeout kills every process the command started", posixOnly, async () => {
  // The grandchild lets go of our pipes, so the call returns as soon as the
  // shell dies. What matters here is that it does not keep running behind us.
  const result = await exec("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!; wait"], {
    timeoutMs: 300,
  });
  const grandchild = Number(result.stdout.trim());

  assert.equal(result.timedOut, true);
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, `no pid in ${JSON.stringify(result.stdout)}`);
  // SIGKILL is delivered asynchronously; give the kernel a moment to reap.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(isAlive(grandchild), false, `grandchild ${grandchild} survived the timeout`);
});

test("Ctrl+C kills a grouped child instead of orphaning it", posixOnly, async () => {
  // A child in its own process group is out of reach of the terminal's
  // Ctrl+C, so whodunit has to pass the signal on before it exits.
  const dir = await mkdtemp(join(tmpdir(), "whodunit-exec-"));
  const pidFile = join(dir, "pid");
  const script = `
    import { exec } from ${JSON.stringify(new URL("../src/util/exec.ts", import.meta.url).href)};
    setTimeout(() => process.kill(process.pid, "SIGINT"), 300);
    await exec("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $! > \\"$PID_FILE\\"; wait"], {
      timeoutMs: 60000,
      env: { PID_FILE: ${JSON.stringify(pidFile)} },
    });
  `;
  try {
    const result = await exec(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeoutMs: 10000 },
    );
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());

    assert.equal(result.timedOut, false, "whodunit did not exit on SIGINT");
    assert.ok(Number.isInteger(grandchild) && grandchild > 0, "sh did not record a pid");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isAlive(grandchild), false, `grandchild ${grandchild} outlived Ctrl+C`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a command that finishes in time is not marked as timed out", async () => {
  const result = await exec(process.execPath, ["-e", "console.log('ok')"], { timeoutMs: 5000 });

  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "ok");
});

test("an abort kills the whole tree and rejects instead of returning", posixOnly, async () => {
  const controller = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), "whodunit-exec-"));
  const pidFile = join(dir, "pid");
  try {
    const running = exec("sh", ["-c", 'sleep 30 >/dev/null 2>&1 & echo $! > "$PID_FILE"; wait'], {
      env: { PID_FILE: pidFile },
      signal: controller.signal,
    });
    const deadline = Date.now() + 5000;
    while (!(await readFile(pidFile, "utf8").catch(() => "")).trim()) {
      if (Date.now() > deadline) throw new Error("sh never recorded a pid");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());

    const startedAt = Date.now();
    controller.abort();
    await assert.rejects(running, { name: "AbortError" });

    assert.ok(Date.now() - startedAt < 5000, "the abort did not take effect promptly");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isAlive(grandchild), false, `grandchild ${grandchild} survived the abort`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an already-aborted signal never starts the command", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(exec(process.execPath, ["-e", ""], { signal: controller.signal }), {
    name: "AbortError",
  });
});
