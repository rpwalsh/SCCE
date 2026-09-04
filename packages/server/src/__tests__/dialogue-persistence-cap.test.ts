// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { enqueueDialoguePersistence, dialoguePersistenceTailsSizeForTest } from "../routes.js";

// CRITICAL fix: dialoguePersistenceTails self-cleans each entry once its
// chain resolves (bounded by concurrent in-flight conversations, not
// total historical ones), but a burst of many distinct conversationId
// values arriving faster than real writes can drain previously had no
// explicit ceiling on the map's size. A hard cap now stops tracking
// genuinely new keys once it is reached, without ever dropping the real
// persistence work itself.

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("enqueueDialoguePersistence (real bounded map size)", () => {
  it("CRITICAL fix: never grows the tracking map past its hard cap, even under a burst of distinct conversationIds", () => {
    const pending: Array<{ resolve: (value: void) => void }> = [];
    const cap = 5000;

    for (let i = 0; i < cap; i++) {
      const d = deferred<void>();
      pending.push(d);
      enqueueDialoguePersistence(`conversation.cap-test.${i}`, () => d.promise);
    }
    expect(dialoguePersistenceTailsSizeForTest()).toBe(cap);

    // One more, genuinely new, distinct conversationId while at the cap.
    let ranDirectly = false;
    const overflowResult = enqueueDialoguePersistence("conversation.cap-test.overflow", async () => {
      ranDirectly = true;
    });
    // The map itself must never exceed the cap...
    expect(dialoguePersistenceTailsSizeForTest()).toBe(cap);
    // ...but the real persistence work still genuinely happens, not silently dropped.
    return overflowResult.then(() => {
      expect(ranDirectly).toBe(true);
      // Clean up: resolve every pending deferred so nothing leaks into other tests.
      for (const d of pending) d.resolve();
    });
  });

  it("an existing conversationId's chain keeps working normally even while the map is at its cap", async () => {
    const cap = 5000;
    const pending: Array<{ resolve: (value: void) => void }> = [];
    for (let i = 0; i < cap; i++) {
      const d = deferred<void>();
      pending.push(d);
      enqueueDialoguePersistence(`conversation.cap-existing.${i}`, () => d.promise);
    }
    // Re-enqueue against an already-tracked key -- must still chain (not bypass).
    let secondRan = false;
    const second = enqueueDialoguePersistence("conversation.cap-existing.0", async () => { secondRan = true; });
    expect(dialoguePersistenceTailsSizeForTest()).toBe(cap);
    pending[0]!.resolve();
    await second;
    expect(secondRan).toBe(true);
    for (const d of pending.slice(1)) d.resolve();
  });
});
