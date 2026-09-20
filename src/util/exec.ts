import { spawn } from "node:child_process";

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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
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
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
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
