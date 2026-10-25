import { spawn, type ChildProcess } from "node:child_process";

import { onInterrupt } from "./interrupt.js";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Feed this to stdin, then close it. */
  input?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command and resolve with its result. Never rejects on a non-zero exit
 * code -- callers decide what a failure means. Rejects only if the process
 * could not be spawned at all.
 */
export function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // With a timeout, lead a new process group so the timeout can kill
    // everything the command started and not just the command. See killTree.
    const detached = options.timeoutMs !== undefined && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      detached,
    });
    let interrupted = false;
    if (detached) {
      // The terminal only signals its foreground process group, so a child
      // leading its own group never hears Ctrl+C. Pass it on, and wait for the
      // child to die so nothing is still running when the sandbox goes.
      const off = onInterrupt(
        () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            interrupted = true;
            child.once("exit", () => done());
            killTree(child);
          }),
      );
      child.once("exit", off);
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killTree(child);
            // Anything that escaped the group could still hold our pipes open
            // and keep "close" from firing. We have given up on its output.
            child.stdout.destroy();
            child.stderr.destroy();
          }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // Killed because whodunit is exiting. Its exit code says nothing about
      // the test, so never report it: the caller would take it as a failure
      // and carry on while the cleanup runs.
      if (interrupted) return;
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

/**
 * Kill `child` and every process it started.
 *
 * Test commands are rarely one process: `npm test` runs a shell, which runs
 * node, which may run workers. Killing only the top one leaves the rest running
 * and still holding stdout, so a timeout would wait out the full test anyway.
 * On POSIX the child leads its own process group, and a negative pid signals
 * the whole group. Windows has no groups, so taskkill walks the tree instead.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // The group is already gone.
  }
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Like {@link exec}, but throws when the command exits non-zero. */
export async function execOrThrow(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new CommandError(
      `${command} ${args.join(" ")} exited ${result.exitCode}${detail ? `\n${detail}` : ""}`,
      result,
    );
  }
  return result;
}
