import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { execOrThrow } from "../src/util/exec.js";

const MODERN = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

let root: string;
let repo: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "whodunit-mcp-"));
  repo = join(root, "repo");
  await execOrThrow("git", ["init", "-q", repo], { cwd: root });
  await execOrThrow("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  await execOrThrow("git", ["config", "user.name", "test"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "fine\n");
  await writeFile(join(repo, "b.txt"), "fine\n");
  await execOrThrow("git", ["add", "-A"], { cwd: repo });
  await execOrThrow("git", ["commit", "-qm", "base"], { cwd: repo });
  // Two changes; only the one in b.txt breaks the "test".
  await writeFile(join(repo, "a.txt"), "fine, reworded\n");
  await writeFile(join(repo, "b.txt"), "broken\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Message {
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
}

/**
 * A minimal MCP client over the server's real stdio. Every stdout line must
 * parse as JSON: anything else would corrupt the protocol for a real client.
 */
class Client {
  readonly process: ChildProcessWithoutNullStreams;
  readonly messages: Message[] = [];
  private waiters: Array<() => void> = [];
  private nextId = 1;
  readonly exited: Promise<number | null>;

  constructor(env: NodeJS.ProcessEnv = {}) {
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    // Started from the temp dir, outside any repository, as an agent might.
    this.process = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "mcp"], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    this.process.stderr.resume();
    this.exited = new Promise((resolve) => this.process.on("exit", resolve));
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      this.messages.push(JSON.parse(line) as Message);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  write(message: object | string): void {
    this.process.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  /** Send a request and resolve with its response. */
  async request(method: string, params: object = {}): Promise<Message> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return this.waitFor((message) => message.id === id);
  }

  async waitFor(match: (message: Message) => boolean, ms = 20000): Promise<Message> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for a message");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  async close(): Promise<number | null> {
    this.process.stdin.end();
    return this.exited;
  }
}

test("a legacy client gets the version it asked for, or the newest legacy one", async () => {
  const client = new Client();
  try {
    const known = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(known.result?.protocolVersion, "2025-06-18");
    assert.deepEqual(known.result?.capabilities, { tools: {} });
    assert.equal(known.result?.serverInfo.name, "whodunit");
    assert.equal(known.result?.resultType, undefined, "legacy results carry no resultType");

    const unknown = await client.request("initialize", { protocolVersion: "2099-01-01", capabilities: {} });
    assert.equal(unknown.result?.protocolVersion, "2025-11-25");
  } finally {
    await client.close();
  }
});

test("a modern client can discover the server and is held to the version rules", async () => {
  const client = new Client();
  try {
    const discovered = await client.request("server/discover", { _meta: MODERN });
    assert.equal(discovered.result?.resultType, "complete");
    assert.deepEqual(discovered.result?.supportedVersions, ["2026-07-28"]);
    assert.equal(discovered.result?._meta["io.modelcontextprotocol/serverInfo"].name, "whodunit");

    const missing = await client.request("server/discover", {});
    assert.equal(missing.error?.code, -32602);

    const unsupported = await client.request("ping", {
      _meta: { ...MODERN, "io.modelcontextprotocol/protocolVersion": "1999-01-01" },
    });
    assert.equal(unsupported.error?.code, -32022);
    assert.equal(unsupported.error?.data.requested, "1999-01-01");
    assert.ok(unsupported.error?.data.supported.includes("2025-11-25"));
  } finally {
    await client.close();
  }
});

test("lists the three tools with their input schemas", async () => {
  const client = new Client();
  try {
    const listed = await client.request("tools/list", { _meta: MODERN });

    assert.equal(listed.result?.resultType, "complete");
    const tools = listed.result?.tools as Array<{ name: string; inputSchema: { required: string[] } }>;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["whodunit_search", "whodunit_doctor", "whodunit_hunks"],
    );
    assert.deepEqual(tools[0]!.inputSchema.required, ["cwd", "command"]);
  } finally {
    await client.close();
  }
});

test("a search call finds the culprit and reports progress along the way", async () => {
  const client = new Client();
  try {
    const response = await client.request("tools/call", {
      name: "whodunit_search",
      arguments: { cwd: repo, command: ["sh", "-c", "! grep -q broken b.txt"] },
      _meta: { ...MODERN, progressToken: "search-1" },
    });

    assert.equal(response.result?.isError, false);
    const report = response.result?.structuredContent;
    assert.deepEqual(
      report.culprits.map((hunk: { file: string }) => hunk.file),
      ["b.txt"],
    );
    assert.equal(report.minimal, true);
    // The text block is the same report, for clients that only show text.
    assert.deepEqual(JSON.parse(response.result?.content[0].text), report);

    const progress = client.messages.filter((message) => message.method === "notifications/progress");
    assert.ok(progress.length >= 3, "expected progress notifications");
    assert.ok(progress.every((message) => message.params?.progressToken === "search-1"));
    const values = progress.map((message) => message.params?.progress as number);
    assert.deepEqual(values, [...values].sort((a, b) => a - b), "progress must increase");
    // All progress arrives before the response that ends the request.
    const responseAt = client.messages.indexOf(response);
    assert.ok(progress.every((message) => client.messages.indexOf(message) < responseAt));
  } finally {
    await client.close();
  }
});

test("bad arguments and failures come back as tool errors the model can read", async () => {
  const client = new Client();
  try {
    const noCommand = await client.request("tools/call", {
      name: "whodunit_doctor",
      arguments: { cwd: repo },
    });
    assert.equal(noCommand.result?.isError, true);
    assert.match(noCommand.result?.content[0].text, /"command" is required/);

    const typo = await client.request("tools/call", {
      name: "whodunit_hunks",
      arguments: { cwd: repo, contxt: 3 },
    });
    assert.match(typo.result?.content[0].text, /Unknown argument "contxt"/);

    const notRepo = await client.request("tools/call", {
      name: "whodunit_hunks",
      arguments: { cwd: root },
    });
    assert.equal(notRepo.result?.isError, true);
    assert.match(notRepo.result?.content[0].text, /Not inside a Git repository/);
  } finally {
    await client.close();
  }
});

test("protocol mistakes get JSON-RPC errors", async () => {
  const client = new Client();
  try {
    const unknownTool = await client.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(unknownTool.error?.code, -32602);

    const unknownMethod = await client.request("resources/list", {});
    assert.equal(unknownMethod.error?.code, -32601);

    client.write("this is not json");
    const parseError = await client.waitFor((message) => message.error?.code === -32700);
    assert.equal(parseError.id, null);
  } finally {
    await client.close();
  }
});

test("closing stdin mid-search stops the test, removes the sandbox and exits", async () => {
  const marker = join(root, "where");
  const client = new Client({ MARK: marker });
  client.write({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "whodunit_doctor",
      arguments: { cwd: repo, command: ["sh", "-c", 'pwd > "$MARK"; sleep 30'] },
    },
  });

  const deadline = Date.now() + 15000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error("the test never started");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sandbox = (await readFile(marker, "utf8")).trim();

  const code = await client.close();

  assert.equal(code, 0);
  assert.equal(existsSync(sandbox), false, `sandbox ${sandbox} was left behind`);
  const worktrees = await execOrThrow("git", ["worktree", "list"], { cwd: repo });
  assert.equal(worktrees.stdout.trim().split("\n").length, 1, worktrees.stdout);
  assert.equal(client.messages.find((message) => message.id === 1), undefined);
});

test("a cancelled request gets no response, and the server keeps serving", async () => {
  const client = new Client();
  try {
    client.write({
      jsonrpc: "2.0",
      id: "slow",
      method: "tools/call",
      params: {
        name: "whodunit_doctor",
        arguments: { cwd: repo, command: ["sh", "-c", "sleep 1"] },
        _meta: { progressToken: "slow" },
      },
    });
    await client.waitFor((message) => message.method === "notifications/progress");
    client.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } });
    const progressBefore = client.messages.length;

    // Longer than the doctor's two one-second runs, so a response would have
    // arrived by now if the cancellation were ignored.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const pong = await client.request("ping");

    assert.deepEqual(pong.result, {});
    assert.equal(client.messages.find((message) => message.id === "slow"), undefined);
    assert.equal(
      client.messages.slice(progressBefore).filter((message) => message.method).length,
      0,
      "no progress after cancellation",
    );
  } finally {
    await client.close();
  }
});

test("cancelling a request stops its test and removes its sandbox", async () => {
  const marker = join(root, "cancel.where");
  const pidFile = join(root, "cancel.pid");
  const client = new Client({ MARK: marker, PID_FILE: pidFile });
  try {
    client.write({
      jsonrpc: "2.0",
      id: "doomed",
      method: "tools/call",
      params: {
        name: "whodunit_doctor",
        arguments: { cwd: repo, command: ["sh", "-c", 'echo $$ > "$PID_FILE"; pwd > "$MARK"; sleep 30'] },
      },
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error("the test never started");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sandbox = (await readFile(marker, "utf8")).trim();
    const testPid = Number((await readFile(pidFile, "utf8")).trim());

    const cancelledAt = Date.now();
    client.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "doomed" } });
    // Well inside the 30 seconds the test would otherwise run.
    while (existsSync(sandbox)) {
      if (Date.now() - cancelledAt > 5000) throw new Error(`sandbox ${sandbox} outlived the cancellation`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.throws(() => process.kill(testPid, 0), "the test process is still running");
    const worktrees = await execOrThrow("git", ["worktree", "list"], { cwd: repo });
    assert.equal(worktrees.stdout.trim().split("\n").length, 1, worktrees.stdout);
    assert.deepEqual((await client.request("ping")).result, {});
    assert.equal(client.messages.find((message) => message.id === "doomed"), undefined);
  } finally {
    await client.close();
  }
});
