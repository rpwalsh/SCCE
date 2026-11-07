// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createScopedEventWrites } from "../scoped-event-writes.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createEventFactory } from "../events.js";
import type { EpisodeId, ScceEvent } from "../types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}
function eventFactory() {
  const clock = createClock({ fixedTime: 1, stepMs: 1 }), hasher = createHasher();
  const factory = createEventFactory({ clock, hasher, idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }) });
  return (text: string) => factory.create({ episodeId: text.split(".")[0] as EpisodeId, typeId: "OwnerAsked", payload: { text } });
}
const labels = (events: ScceEvent[]) => events.map(event => (event.payload as { text: string }).text);

describe("request-owned event persistence", () => {
  it("keeps overlapping episodes in distinct durable batches", async () => {
    const batches: string[][] = [], singles: string[] = [];
    const writer = createScopedEventWrites({ append: async event => { singles.push(...labels([event])); },
      appendBatch: async events => { batches.push(labels(events)); }, failedFlushDuringRunFailure: error => { throw error; } });
    const event = eventFactory(), startedA = deferred(), startedB = deferred(), finishA = deferred(), finishB = deferred();
    const a = writer.withBufferedWrites(async () => { await writer.append(event("A.1")); startedA.resolve(); await finishA.promise; await writer.append(event("A.2")); });
    await startedA.promise;
    const b = writer.withBufferedWrites(async () => { await writer.append(event("B.1")); startedB.resolve(); await finishB.promise; await writer.append(event("B.2")); });
    await startedB.promise;
    expect(batches).toEqual([]);
    finishA.resolve(); await a;
    expect(batches).toEqual([["A.1", "A.2"]]);
    finishB.resolve(); await b;
    expect(batches).toEqual([["A.1", "A.2"], ["B.1", "B.2"]]);
    expect(singles).toEqual([]);
  });

  it("shares one batch for nested work and leaves empty operations empty", async () => {
    const batches: string[][] = [], singles: string[] = [];
    const writer = createScopedEventWrites({ append: async event => { singles.push(...labels([event])); },
      appendBatch: async events => { batches.push(labels(events)); }, failedFlushDuringRunFailure: error => { throw error; } });
    const event = eventFactory();
    await writer.append(event("outside"));
    expect(await writer.withBufferedWrites(async () => 17)).toBe(17);
    await writer.withBufferedWrites(async () => {
      await writer.append(event("A.1"));
      await writer.withBufferedWrites(async () => { await writer.append(event("A.nested")); });
      await writer.append(event("A.2"));
    });
    expect(singles).toEqual(["outside"]);
    expect(batches).toEqual([["A.1", "A.nested", "A.2"]]);
  });

  it("persists detached work after the parent batch without mutating its snapshot", async () => {
    const calls: string[] = [], batchStarted = deferred(), finishBatch = deferred(), releaseLate = deferred();
    const writer = createScopedEventWrites({ append: async event => { calls.push(`single:${labels([event]).join()}`); },
      appendBatch: async events => { batchStarted.resolve(); await finishBatch.promise; calls.push(`batch:${labels(events).join()}`); },
      failedFlushDuringRunFailure: error => { throw error; } });
    const event = eventFactory();
    let late!: Promise<ScceEvent>;
    const parent = writer.withBufferedWrites(async () => {
      await writer.append(event("A.parent"));
      late = releaseLate.promise.then(() => writer.append(event("A.late")));
    });
    await batchStarted.promise;
    releaseLate.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toEqual([]);
    finishBatch.resolve(); await parent; await late;
    expect(calls).toEqual(["batch:A.parent", "single:A.late"]);
  });

  it("preserves the original operation failure and reports a separate persistence failure", async () => {
    const runError = new Error("operation failed"), writeError = new Error("write failed"), failures: unknown[] = [];
    const batches: string[][] = [];
    const writer = createScopedEventWrites({ append: async () => undefined,
      appendBatch: async events => { batches.push(labels(events)); throw writeError; },
      failedFlushDuringRunFailure: error => { failures.push(error); } });
    const event = eventFactory();
    await expect(writer.withBufferedWrites(async () => { await writer.append(event("A.failed")); throw runError; })).rejects.toBe(runError);
    expect(batches).toEqual([["A.failed"]]);
    expect(failures).toEqual([writeError]);
    await expect(writer.withBufferedWrites(async () => { await writer.append(event("B.failed")); })).rejects.toBe(writeError);
    expect(batches).toEqual([["A.failed"], ["B.failed"]]);
  });
});
