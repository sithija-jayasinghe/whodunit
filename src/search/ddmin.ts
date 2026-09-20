import type { Hunk, Outcome } from "../types.js";
import { notImplemented } from "../util/todo.js";

/** Asked to evaluate one candidate subset of hunks. */
export type Probe = (subset: readonly Hunk[]) => Promise<Outcome>;

export interface SearchResult {
  /** The smallest set of hunks that still reproduces the failure. */
  culprits: Hunk[];
  /** How many times the test command actually ran. */
  probes: number;
}

/**
 * PHASE 3
 *
 * Delta debugging (Zeller's ddmin), applied to diff hunks.
 *
 * A plain binary search is not enough here, because hunks are not independent:
 * applying half a change often will not compile. ddmin handles that with a
 * third outcome -- "unresolved" -- and by widening the granularity instead of
 * giving up, so it still converges on a minimal failing set.
 */
export async function ddmin(_hunks: readonly Hunk[], _probe: Probe): Promise<SearchResult> {
  return notImplemented(3, "delta-debugging search over hunks");
}
