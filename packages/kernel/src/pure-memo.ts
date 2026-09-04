// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/**
 * Bounded memoization for pure text transforms.
 *
 * A CPU profile of one turn (2026-08-18) attributed 13.9% of wall clock to
 * `tidySurfaceText` and 6.8% to `featureSet`, with a further 12.9% in the
 * garbage collector feeding them. Both are deterministic functions of their
 * input called from ~100 and ~190 call sites respectively, re-deriving the
 * same answer for the same string many times inside a single turn: the same
 * candidate surface is tidied by admissibility, by scoring, by excerpt
 * verification, and again by the echo check.
 *
 * Bounded deliberately. The resident language-memory cache in this codebase
 * was byte-budgeted only after an entry-count-only bound let it exhaust the
 * heap; a memo keyed by arbitrary text has exactly that failure mode, so
 * these caches cap entry count AND retained characters, and decline to cache
 * inputs large enough to blow the budget on their own rather than evicting
 * everything else to hold one.
 */

export interface StringMemoOptions {
  /** Maximum entries retained. */
  maxEntries: number;
  /** Inputs longer than this are computed and returned uncached. */
  maxKeyChars: number;
  /** Total input characters retained across all keys. */
  maxTotalChars: number;
}

export interface StringMemo<T> {
  (key: string): T;
  /** Entry count, retained characters, hits and misses -- for tests and diagnostics. */
  stats(): { entries: number; chars: number; hits: number; misses: number; uncacheable: number };
  clear(): void;
}

/**
 * Memoize a pure `string -> T`. Insertion-ordered Map doubles as the LRU:
 * a hit re-inserts the key so eviction takes the least recently used.
 */
export function createStringMemo<T>(compute: (key: string) => T, options: StringMemoOptions): StringMemo<T> {
  const entries = new Map<string, T>();
  let chars = 0;
  let hits = 0;
  let misses = 0;
  let uncacheable = 0;

  const memo = ((key: string): T => {
    if (key.length > options.maxKeyChars) {
      // One oversized input must not evict the working set to store itself.
      uncacheable++;
      return compute(key);
    }
    const cached = entries.get(key);
    if (cached !== undefined || entries.has(key)) {
      hits++;
      entries.delete(key);
      entries.set(key, cached as T);
      return cached as T;
    }
    misses++;
    const value = compute(key);
    entries.set(key, value);
    chars += key.length;
    while (entries.size > options.maxEntries || chars > options.maxTotalChars) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
      chars -= oldest.value.length;
    }
    return value;
  }) as StringMemo<T>;

  memo.stats = () => ({ entries: entries.size, chars, hits, misses, uncacheable });
  memo.clear = () => { entries.clear(); chars = 0; };
  return memo;
}
