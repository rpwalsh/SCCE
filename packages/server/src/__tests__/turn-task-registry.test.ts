import { describe, expect, it } from "vitest";
import type { EpisodeId, ScceEvent, ScceStorage } from "@scce/kernel";
import { TurnTaskRegistry } from "../turn-task-registry.js";

function storageFixture(): ScceStorage {
  const events: ScceEvent[] = [];
  return {
    events: {
      append: async (event: ScceEvent) => {
        events.push(event);
      },
      appendBatch: async (batch: ScceEvent[]) => {
        events.push(...batch);
      },
      readEpisode: async (episodeId: EpisodeId) => events.filter(event => event.episodeId === episodeId),
      readRange: async () => [...events],
      latestLedgerHash: async () => events.at(-1)?.hash ?? ""
    }
  } as unknown as ScceStorage;
}

describe("turn task registry", () => {
  it("persists replayable long-running frames and recovers a terminal receipt", async () => {
    const storage = storageFixture();
    const live = new TurnTaskRegistry(storage);
    const created = live.create({ requestId: "request.fixture", observedAt: 10 });
    live.markRunning(created.taskId);
    live.append(created.taskId, { type: "progress", phase: "graph.resolve" });
    live.append(created.taskId, { type: "result", status: 200, value: { answer: "complete" } });
    await live.drain(created.taskId);

    const liveSnapshot = await live.get(created.taskId);
    expect(liveSnapshot).toMatchObject({
      status: "succeeded",
      persistence: "durable",
      latestSequence: 3
    });

    const recovered = await new TurnTaskRegistry(storage).get(created.taskId);
    expect(recovered).toMatchObject({
      schema: "scce.turn_task.v1",
      status: "succeeded",
      persistence: "durable",
      latestSequence: 3
    });
    expect(recovered?.frames.map(frame => frame.type)).toEqual([
      "accepted",
      "progress",
      "result"
    ]);
  });

  it("keeps disconnect separate from explicit cancellation", () => {
    const registry = new TurnTaskRegistry(storageFixture());
    const task = registry.create({ requestId: "request.cancel" });
    const signal = registry.controller(task.taskId)?.signal;
    expect(signal?.aborted).toBe(false);

    const cancelled = registry.cancel(task.taskId, "user stopped the task");
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled?.frames.at(-1)).toMatchObject({
      type: "cancelled",
      error: "user stopped the task"
    });
  });
});
