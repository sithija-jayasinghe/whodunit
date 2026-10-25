type Cleanup = () => void | Promise<void>;

const SIGNALS = { SIGINT: 2, SIGTERM: 15 } as const;
type Signal = keyof typeof SIGNALS;

const cleanups: Cleanup[] = [];
let installed = false;
let interrupted = false;

/**
 * Run `cleanup` if whodunit is stopped by Ctrl+C or SIGTERM. Returns a
 * function that unregisters it; call that once the resource is gone.
 *
 * Node's default on these signals is to die on the spot, which skips every
 * `finally` block. That would leave a sandbox worktree in the user's repo and a
 * test process running in the background, so instead we run the cleanups and
 * exit ourselves.
 */
export function onInterrupt(cleanup: Cleanup): () => void {
  install();
  cleanups.push(cleanup);
  return () => {
    const index = cleanups.indexOf(cleanup);
    if (index !== -1) cleanups.splice(index, 1);
  };
}

function install(): void {
  if (installed) return;
  installed = true;
  for (const signal of Object.keys(SIGNALS) as Signal[]) {
    process.on(signal, () => void handle(signal));
  }
}

async function handle(signal: Signal): Promise<void> {
  const code = 128 + SIGNALS[signal];
  // A second Ctrl+C while cleaning up means "stop now", as it does elsewhere.
  if (interrupted) process.exit(code);
  interrupted = true;
  process.stderr.write("\nwhodunit: interrupted, cleaning up...\n");

  // Newest first: a test process is registered after the sandbox it runs in,
  // so it is killed before the sandbox is removed from under it.
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Keep going. One failed cleanup should not strand the rest.
    }
  }
  process.exit(code);
}
