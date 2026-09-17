// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

export interface StaleWhileRevalidateCache<T> {
  /** The compiled artifact. Blocks only when none has been compiled yet. */
  get(): Promise<T>;
  /** Whether an artifact is compiled and how old it is, for a caller that wants to report the state rather than infer it. */
  state(): { compiled: boolean; ageMs: number; refreshing: boolean };
}

export interface StaleWhileRevalidateInput<T> {
  ttlMs: number;
  now(): number;
  load(): Promise<T>;
}

/**
 * A compiled artifact served from the last compilation while the next one runs.
 *
 * A plain TTL cache makes whichever caller happens to arrive after the lapse pay the whole compilation, which on
 * the turn path is a response-time cliff rather than a cache: measured 2026-09-16, the calibration refit over
 * 5,000 observations cost 4,860-9,013ms on the turns that landed on its 120s lapse, against a 10s cap. The
 * population those callers read is no staler than it was a second earlier; only the clock moved.
 *
 * A failed refresh keeps the previous artifact rather than replacing it with an error, and is retried at the next
 * lapse. Only the very first caller, which has nothing compiled to serve, sees the failure.
 */
export function createStaleWhileRevalidateCache<T>(input: StaleWhileRevalidateInput<T>): StaleWhileRevalidateCache<T> {
  let compiled: { value: T; compiledAt: number } | undefined;
  let refreshing: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    const startedAt = input.now();
    const pending = input.load().then(
      value => { compiled = { value, compiledAt: startedAt }; },
      () => { if (compiled) compiled = { value: compiled.value, compiledAt: startedAt }; }
    ).finally(() => { if (refreshing === pending) refreshing = undefined; });
    refreshing = pending;
    return pending;
  };

  return {
    async get(): Promise<T> {
      const resident = compiled;
      if (resident && input.now() - resident.compiledAt < input.ttlMs) return resident.value;
      if (resident) {
        void refresh();
        return resident.value;
      }
      await refresh();
      // Nothing compiled and the refresh swallowed its failure only when something was already resident, so a
      // still-empty cache here means the first compile failed: surface it to the caller that has nothing to serve.
      const first = compiled;
      return first ? first.value : await input.load();
    },
    state() {
      return {
        compiled: Boolean(compiled),
        ageMs: compiled ? input.now() - compiled.compiledAt : 0,
        refreshing: Boolean(refreshing)
      };
    }
  };
}
