// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import type { EpisodeId, ScceEvent, ScceStorage } from "@scce/kernel";
import { TurnApplication } from "../turn-application.js";
import { TurnTaskRegistry } from "../turn-task-registry.js";

export function taskStorage() {
  const events: ScceEvent[] = [];
  const storage = { events: {
    append: vi.fn(async (event: ScceEvent) => { events.push(structuredClone(event)); }),
    readEpisode: vi.fn(async (id: EpisodeId) => structuredClone(events.filter(event => event.episodeId === id)))
  } } as unknown as ScceStorage;
  return { events, storage };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
describe("local turn application", () => {
  it("commits intent before execution and executes concurrent retries only once", async () => {
    const { events, storage } = taskStorage();
    const done = deferred<{ status: number; value: { answer: string } }>();
    const execute = vi.fn(async () => {
      expect(events).toHaveLength(2);
      expect(JSON.parse(String((events[1]!.payload as Record<string, unknown>).frameJsonText)).phase).toBe("application.turn.claimed");
      return done.promise;
    });
    const app = new TurnApplication({ registry: new TurnTaskRegistry(storage), scope: "state-A", execute });
    const task = await app.reserve();
    const requests = await Promise.all(Array.from({ length: 8 }, () => app.start(task.taskId, { text: "Привет 한국어 🧭" })));
    expect(requests.every(result => result.taskId === task.taskId)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(app.start(task.taskId, { text: "another request" })).rejects.toMatchObject({ code: "CONFLICT" });
    done.resolve({ status: 200, value: { answer: "你好!" } });
    await vi.waitFor(async () => expect((await app.get(task.taskId))?.status).toBe("succeeded"));
    const replay = new TurnApplication({ registry: new TurnTaskRegistry(storage), scope: "state-A", execute });
    expect((await replay.start(task.taskId, { text: "Привет 한국어 🧭" })).status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never executes without durable intent and never calls a later write proof of a lost earlier event", async () => {
    const { storage } = taskStorage();
    const execute = vi.fn();
    const registry = new TurnTaskRegistry(storage), app = new TurnApplication({ registry, scope: "state", execute });
    const reserved = await app.reserve();
    vi.mocked(storage.events.append).mockRejectedValueOnce(new Error("disk full"));
    await expect(app.start(reserved.taskId, { text: "do work" })).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
    await expect(app.cancel(reserved.taskId)).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
    registry.append(reserved.taskId, { type: "cancelled" });
    await registry.drain(reserved.taskId);
    expect(execute).not.toHaveBeenCalled();
    expect((await registry.get(reserved.taskId))?.persistence).toBe("pending");
    await expect(new TurnTaskRegistry(storage).get(reserved.taskId)).rejects.toThrow("sequence");
  });

  it("marks a claimed turn interrupted after restart and refuses to execute it again", async () => {
    const { storage } = taskStorage();
    const pending = deferred<{ status: number; value: null }>();
    const execute = vi.fn(() => pending.promise);
    const original = new TurnApplication({ registry: new TurnTaskRegistry(storage), scope: "state", execute });
    const reserved = await original.reserve();
    await original.start(reserved.taskId, { text: "long work" });
    const restarted = new TurnApplication({ registry: new TurnTaskRegistry(storage), scope: "state", execute });
    expect((await restarted.start(reserved.taskId, { text: "long work" })).status).toBe("interrupted");
    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 200, value: null });
  });

  it("keeps cancellation separate from subscription disposal and replays after an exact sequence", async () => {
    const { storage } = taskStorage();
    const pending = deferred<{ status: number; value: null }>();
    let signal: AbortSignal | undefined;
    const app = new TurnApplication({ registry: new TurnTaskRegistry(storage), scope: "state",
      execute: async (_input, control) => { signal = control.signal; return pending.promise; } });
    const task = await app.reserve();
    await app.start(task.taskId, { text: "wait" });
    const subscriber = new AbortController();
    const updates = app.updates(task.taskId, 1, subscriber.signal);
    const replay = await updates.next();
    if (replay.done) throw new Error("missing replay");
    expect(replay.value.frames.map(frame => frame.sequence)).toEqual([2]);
    subscriber.abort(); await updates.return(undefined);
    expect(signal?.aborted).toBe(false);
    expect((await app.cancel(task.taskId)).persistence).toBe("durable");
    expect(signal?.aborted).toBe(true);
    pending.resolve({ status: 200, value: null });
    await vi.waitFor(async () => expect((await app.get(task.taskId))?.status).toBe("cancelled"));
    const other = new TurnApplication({ registry: new TurnTaskRegistry(storage), scope: "other", execute: vi.fn() });
    expect(await other.get(task.taskId)).toBeUndefined();
  });

  it("bounds reservations and validates before executing", async () => {
    const { storage } = taskStorage();
    const execute = vi.fn(), app = new TurnApplication({ registry: new TurnTaskRegistry(storage), scope: "state", execute });
    for (let index = 0; index < 128; index++) await app.reserve();
    await expect(app.reserve()).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await expect(app.start("unknown", { text: " " })).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("claims once across callers sharing the same coordinator and freezes the submitted input", async () => {
    const { storage } = taskStorage();
    const registry = new TurnTaskRegistry(storage), pending = deferred<{ status: number; value: null }>();
    const received: string[] = [];
    const execute = vi.fn(async (input: { text: string }) => { received.push(input.text); return pending.promise; });
    const first = new TurnApplication({ registry, scope: "state", execute });
    const second = new TurnApplication({ registry, scope: "state", execute });
    const task = await first.reserve();
    const input = { text: "original" };
    const requests = [first.start(task.taskId, input), second.start(task.taskId, { text: "original" })];
    input.text = "mutated";
    await Promise.all(requests);
    expect(received).toEqual(["original"]);
    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 200, value: null });
  });

  it("still stops computation when a progress write has failed", async () => {
    const { storage } = taskStorage();
    const registry = new TurnTaskRegistry(storage), pending = deferred<{ status: number; value: null }>();
    let signal: AbortSignal | undefined;
    const app = new TurnApplication({ registry, scope: "state", execute: async (_input, control) => { signal = control.signal; return pending.promise; } });
    const task = await app.reserve(); await app.start(task.taskId, { text: "work" });
    vi.mocked(storage.events.append).mockRejectedValueOnce(new Error("disk full"));
    registry.append(task.taskId, { type: "progress", phase: "working" }); await registry.drain(task.taskId);
    await expect(app.cancel(task.taskId)).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
    expect(signal?.aborted).toBe(true);
    pending.resolve({ status: 200, value: null });
  });
});
