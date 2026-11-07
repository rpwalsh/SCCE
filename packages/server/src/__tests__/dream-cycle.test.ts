// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDreamCycle } from "../dream-cycle.js";

const { train } = vi.hoisted(() => ({ train: vi.fn() }));
vi.mock("@scce/adapters-node", () => ({ trainStoredCorpusConstructions: train }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("idle construction learning activation", () => {
  it("activates persisted dream constructions before reporting the batch complete", async () => {
    vi.useFakeTimers();
    const refreshAfterBrainActivation = vi.fn(async () => ({ languageIdentities: 1, assignedProfiles: 1 }));
    const log = vi.fn();
    train.mockResolvedValue({ batchesTrained: 1, nextBatchIndex: 1, articlesTrained: 1, reports: [{ languageConstructions: 2 }] });
    const runtime = { storage: {}, kernel: { refreshAfterBrainActivation } } as unknown as Parameters<typeof startDreamCycle>[0]["runtime"];
    const cycle = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(train).toHaveBeenCalledOnce();
      expect(refreshAfterBrainActivation).toHaveBeenCalledOnce();
      expect(refreshAfterBrainActivation.mock.invocationCallOrder[0]).toBeLessThan(log.mock.invocationCallOrder[0]!);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("+2 constructions"));
    } finally { cycle.stop(); }
  });

  it("does not invalidate resident memory when no stored batch was trained", async () => {
    vi.useFakeTimers();
    const refreshAfterBrainActivation = vi.fn();
    train.mockResolvedValue({ batchesTrained: 0, nextBatchIndex: 0, articlesTrained: 0, reports: [] });
    const runtime = { storage: {}, kernel: { refreshAfterBrainActivation } } as unknown as Parameters<typeof startDreamCycle>[0]["runtime"];
    const cycle = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(train).toHaveBeenCalledOnce();
      expect(refreshAfterBrainActivation).not.toHaveBeenCalled();
    } finally { cycle.stop(); }
  });
});
