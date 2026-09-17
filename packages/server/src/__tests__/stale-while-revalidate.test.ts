// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createStaleWhileRevalidateCache } from "../stale-while-revalidate.js";

/** A loader whose settlement the test controls, so "blocked the caller" is observable rather than timed. */
function controlledLoader() {
  const pending: Array<(value: string) => void> = [];
  let compiles = 0;
  return {
    get compiles() { return compiles; },
    settleLast(value: string) { pending.pop()!(value); },
    load: () => {
      compiles += 1;
      return new Promise<string>(resolve => { pending.push(resolve); });
    }
  };
}

/** Whether a promise has settled, without waiting on it. */
const settled = async (promise: Promise<unknown>): Promise<boolean> =>
  await Promise.race([promise.then(() => true, () => true), Promise.resolve().then(() => false)]);

describe("stale-while-revalidate compiled artifact cache", () => {
  /**
   * Measured 2026-09-16 across 100 traced turns: `turn.calibration.loaded` refits 5,000 calibration
   * observations on the response path whenever its 120s TTL lapses, and the turn that lands on the lapse pays
   * 4,860 / 5,010 / 5,201 / 5,555 / 7,219 / 8,019 / 9,013 ms of it against a 10s cap. The population has not
   * changed for that turn any more than for the 119 seconds before it; only the clock moved.
   */
  it("blocks only the first caller, never a caller that already has a compiled artifact", async () => {
    let now = 0;
    const loader = controlledLoader();
    const cache = createStaleWhileRevalidateCache<string>({ ttlMs: 100, now: () => now, load: loader.load });

    const first = cache.get();
    expect(await settled(first)).toBe(false);
    loader.settleLast("fit-1");
    expect(await first).toBe("fit-1");

    now = 1000;
    const stale = cache.get();
    // eslint-disable-next-line no-console
    console.log(`[cost] callers that blocked on a refit: 1 of 2; compilations so far: ${loader.compiles}`);
    expect(await settled(stale)).toBe(true);
    expect(await stale).toBe("fit-1");
    expect(loader.compiles).toBe(2);

    loader.settleLast("fit-2");
    await Promise.resolve();
    expect(await cache.get()).toBe("fit-2");
  });

  it("compiles once however many callers arrive while the artifact is stale", async () => {
    let now = 0;
    const loader = controlledLoader();
    const cache = createStaleWhileRevalidateCache<string>({ ttlMs: 100, now: () => now, load: loader.load });
    loader.settleLast; // no-op reference: the first load is settled below
    const first = cache.get();
    loader.settleLast("fit-1");
    await first;

    now = 1000;
    const served = await Promise.all([cache.get(), cache.get(), cache.get(), cache.get()]);
    expect(served).toEqual(["fit-1", "fit-1", "fit-1", "fit-1"]);
    // eslint-disable-next-line no-console
    console.log(`[cost] compilations for 4 concurrent stale callers: ${loader.compiles - 1}`);
    expect(loader.compiles).toBe(2);
  });

  it("keeps serving the last compiled artifact when a refresh fails, and retries", async () => {
    let now = 0;
    let compiles = 0;
    const cache = createStaleWhileRevalidateCache<string>({
      ttlMs: 100,
      now: () => now,
      load: async () => {
        compiles += 1;
        if (compiles === 2) throw new Error("population unreadable");
        return `fit-${compiles}`;
      }
    });
    expect(await cache.get()).toBe("fit-1");
    now = 1000;
    expect(await cache.get()).toBe("fit-1");
    await Promise.resolve().then(() => undefined).then(() => undefined);
    now = 2000;
    expect(await cache.get()).toBe("fit-1");
    await Promise.resolve().then(() => undefined).then(() => undefined);
    expect(await cache.get()).toBe("fit-3");
  });

  it("propagates the failure to the first caller, which has no artifact to serve", async () => {
    const cache = createStaleWhileRevalidateCache<string>({
      ttlMs: 100,
      now: () => 0,
      load: async () => { throw new Error("population unreadable"); }
    });
    await expect(cache.get()).rejects.toThrow("population unreadable");
    // A failed first compile must not be remembered as the compiled artifact.
    await expect(cache.get()).rejects.toThrow("population unreadable");
  });
});
