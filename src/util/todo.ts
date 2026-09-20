/** Marker for work a later phase fills in. Keeps the build honest. */
export function notImplemented(phase: number, what: string): never {
  throw new Error(`Not implemented yet (phase ${phase}): ${what}`);
}
