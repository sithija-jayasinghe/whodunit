/**
 * Recognising "the same failure" without being told what it looks like.
 *
 * Applying a subset of hunks can break the code in a new way: an import that
 * no longer resolves, a function used before the hunk that defines it. That
 * exits non-zero just like the failure being hunted, and a search that trusts
 * the exit code will blame whichever hunk caused the crash.
 *
 * So the failure is fingerprinted. The signature is every line the failing
 * run printed that the passing baseline did not, minus lines any error would
 * print. A later failing run counts as the same failure only if it prints at
 * least one of those lines. Numbers are ignored when comparing, so
 * "got $65.45" and "got $72.10" are the same assertion failing.
 */

interface Output {
  stdout: string;
  stderr: string;
}

/**
 * Lines that turn up whenever anything goes wrong, so they cannot tell one
 * failure from another: stack frames, tracebacks, runtime version footers.
 */
const NOISE = [
  /^at\s/, // JavaScript stack frame
  /^File ".*", line #/, // Python stack frame
  /^Traceback \(most recent call last\):$/,
  /^Node\.js v#/,
  /^node:internal/,
  /^[\^~\s]+$/, // the caret under a quoted source line
  /^npm (ERR!|error)/,
];

/** The comparable form of a line: trimmed, single-spaced, digits as #. */
function normalize(line: string): string {
  return line.trim().replace(/\s+/g, " ").replace(/\d+/g, "#");
}

function lines(output: Output): string[] {
  return `${output.stdout}\n${output.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The lines that identify `current`'s failure, as printed. Empty when it
 * printed nothing the passing `baseline` did not, in which case only the
 * exit code can be used.
 */
export function failureSignature(baseline: Output, current: Output): string[] {
  const passing = new Set(lines(baseline).map(normalize));
  const seen = new Set<string>();
  const signature: string[] = [];
  for (const line of lines(current)) {
    const key = normalize(line);
    if (passing.has(key) || seen.has(key) || NOISE.some((noise) => noise.test(key))) continue;
    seen.add(key);
    signature.push(line);
  }
  return signature;
}

/** True when `output` prints at least one line of the signature. */
export function matchesSignature(output: Output, signature: readonly string[]): boolean {
  const wanted = new Set(signature.map(normalize));
  return lines(output).some((line) => wanted.has(normalize(line)));
}
