import type { Hunk, Outcome } from "../types.js";

/** Asked to evaluate one candidate subset of hunks. */
export type Probe = (subset: readonly Hunk[]) => Promise<Outcome>;

export interface ProbeEvent {
  /** Count of real test runs so far. Cached answers do not count. */
  probe: number;
  subset: readonly Hunk[];
  /** Size of the candidate set currently being narrowed. */
  of: number;
  outcome: Outcome;
  /** True when the answer came from the cache instead of a test run. */
  cached: boolean;
}

export interface SearchOptions {
  /** Stop after this many real test runs and return the best set found. */
  maxProbes?: number;
  onProbe?: (event: ProbeEvent) => void;
  /** Outcomes already established, so the search does not re-run them. */
  seed?: ReadonlyArray<{ subset: readonly Hunk[]; outcome: Outcome }>;
}

export interface SearchResult {
  /** The smallest set of hunks found that still reproduces the failure. */
  culprits: Hunk[];
  /** How many times the test command actually ran. */
  probes: number;
  /**
   * True when the search ran to completion, meaning removing any single hunk
   * from the result makes the failure go away. False when the probe budget ran
   * out first, in which case the result is a real failing set but not proven
   * minimal.
   */
  minimal: boolean;
}

/** Canonical key for a subset. Order does not affect the patch that is built. */
function keyOf(subset: readonly Hunk[]): string {
  return JSON.stringify(subset.map((hunk) => hunk.id).sort());
}

/** Split a list into `n` roughly equal contiguous parts, dropping empties. */
function partition<T>(items: readonly T[], n: number): T[][] {
  const parts: T[][] = [];
  const size = items.length / n;
  for (let i = 0; i < n; i++) {
    const part = items.slice(Math.round(i * size), Math.round((i + 1) * size));
    if (part.length > 0) parts.push(part);
  }
  return parts;
}

/**
 * Delta debugging (Zeller's ddmin), applied to diff hunks.
 *
 * A plain binary search is not enough here, because hunks are not independent:
 * applying half a change often will not compile, and a failure can need two
 * hunks together. ddmin handles both. It keeps a third outcome, "unresolved",
 * for states it could not judge, and when neither the parts nor their
 * complements reproduce the failure it doubles the granularity rather than
 * giving up.
 *
 * The result is 1-minimal: removing any single hunk from it stops the failure.
 */
export async function ddmin(
  hunks: readonly Hunk[],
  probe: Probe,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const maxProbes = options.maxProbes ?? Number.POSITIVE_INFINITY;
  const cache = new Map<string, Outcome>();
  for (const { subset, outcome } of options.seed ?? []) {
    cache.set(keyOf(subset), outcome);
  }

  let probes = 0;
  let exhausted = false;

  async function evaluate(subset: readonly Hunk[], of: number): Promise<Outcome> {
    const key = keyOf(subset);
    const cached = cache.get(key);
    if (cached !== undefined) {
      options.onProbe?.({ probe: probes, subset, of, outcome: cached, cached: true });
      return cached;
    }
    if (probes >= maxProbes) {
      exhausted = true;
      return "unresolved";
    }
    probes++;
    const outcome = await probe(subset);
    cache.set(key, outcome);
    options.onProbe?.({ probe: probes, subset, of, outcome, cached: false });
    return outcome;
  }

  let current = [...hunks];
  let granularity = 2;

  while (current.length >= 2 && !exhausted) {
    const parts = partition(current, granularity);

    // Does any single part reproduce the failure on its own?
    let narrowed = false;
    for (const part of parts) {
      if ((await evaluate(part, current.length)) === "fail") {
        current = part;
        granularity = 2;
        narrowed = true;
        break;
      }
      if (exhausted) break;
    }
    if (narrowed) continue;
    if (exhausted) break;

    // Does removing any single part keep the failure? If so that part is
    // irrelevant and can go.
    for (const part of parts) {
      const excluded = new Set(part.map((hunk) => hunk.id));
      const complement = current.filter((hunk) => !excluded.has(hunk.id));
      if (complement.length === 0) continue;
      if ((await evaluate(complement, current.length)) === "fail") {
        current = complement;
        granularity = Math.max(granularity - 1, 2);
        narrowed = true;
        break;
      }
      if (exhausted) break;
    }
    if (narrowed) continue;
    if (exhausted) break;

    // Neither worked: the culprits are spread across parts, so look closer.
    if (granularity < current.length) {
      granularity = Math.min(granularity * 2, current.length);
    } else {
      break; // 1-minimal: nothing more can be removed.
    }
  }

  return { culprits: current, probes, minimal: !exhausted };
}
