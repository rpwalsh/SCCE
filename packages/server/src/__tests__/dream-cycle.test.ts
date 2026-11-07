// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDreamCycle } from "../dream-cycle.js";
import type { IngestionCheckpoint } from "@scce/kernel";

const { train } = vi.hoisted(() => ({ train: vi.fn() }));
vi.mock("@scce/adapters-node", () => ({ trainStoredCorpusConstructions: train, LANGUAGE_CORPUS_TRAINING_RECIPE_ID: "fixture.training.recipe" }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("idle construction learning activation", () => {
  it("advances past considered sources without interpreting zero trained batches as exhaustion", async () => {
    vi.useFakeTimers();
    const checkpoints = checkpointStore();
    const refreshAfterBrainActivation = vi.fn();
    const runtime = { storage: { ingestion: checkpoints }, kernel: { refreshAfterBrainActivation } } as unknown as Parameters<typeof startDreamCycle>[0]["runtime"];
    train.mockResolvedValue({ batchesTrained: 0, nextBatchIndex: 0, nextSourceVersionId: "source.skipped", exhausted: false, articlesTrained: 0, bytesTrained: 0, reports: [], batchesFailed: [], stoppedByStorageFailure: false });
    const cycle = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(train.mock.calls[1]![0]).toHaveProperty("afterSourceVersionId", "source.skipped");
      expect(refreshAfterBrainActivation).not.toHaveBeenCalled();
    } finally { cycle.stop(); }
  });

  it("retains the last durable source cursor when a later batch reports incomplete work", async () => {
    vi.useFakeTimers();
    const checkpoints = checkpointStore();
    const runtime = { storage: { ingestion: checkpoints }, kernel: { refreshAfterBrainActivation: vi.fn() } } as unknown as Parameters<typeof startDreamCycle>[0]["runtime"];
    const report = { batchesTrained: 1, nextBatchIndex: 1, nextSourceVersionId: "source.completed", exhausted: false, articlesTrained: 1, bytesTrained: 128, reports: [{ languageConstructions: 2 }], batchesFailed: [], stoppedByStorageFailure: false };
    train.mockResolvedValueOnce(report).mockResolvedValueOnce({ ...report, nextSourceVersionId: "source.incomplete", batchesFailed: [{ sourceVersionId: "source.incomplete", reason: "failed" }] }).mockResolvedValue(report);
    const log = vi.fn();
    const cycle = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log });
    await vi.advanceTimersByTimeAsync(120_000);
    cycle.stop();
    expect(checkpoints.put).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("source cursor retained"));
    const restarted = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(train.mock.calls[2]![0]).toHaveProperty("afterSourceVersionId", "source.completed");
    } finally { restarted.stop(); }
  });

  it("resumes a completed source cursor after a server restart without replaying legacy batch offsets", async () => {
    vi.useFakeTimers();
    const checkpoints = checkpointStore();
    const runtime = { storage: { ingestion: checkpoints }, kernel: { refreshAfterBrainActivation: vi.fn() } } as unknown as Parameters<typeof startDreamCycle>[0]["runtime"];
    train.mockResolvedValue({ batchesTrained: 1, nextBatchIndex: 1, nextSourceVersionId: "source.completed", exhausted: false, articlesTrained: 1, bytesTrained: 128, reports: [{ languageConstructions: 2 }], batchesFailed: [], stoppedByStorageFailure: false });
    const first = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log: vi.fn() });
    await vi.advanceTimersByTimeAsync(60_000);
    first.stop();
    expect(checkpoints.put).toHaveBeenCalledOnce();
    train.mockClear();
    const restarted = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(train).toHaveBeenCalledWith(expect.objectContaining({ afterSourceVersionId: "source.completed" }));
      expect(train.mock.calls[0]![0]).not.toHaveProperty("startBatchIndex");
    } finally { restarted.stop(); }
  });

  it("activates persisted dream constructions before reporting the batch complete", async () => {
    vi.useFakeTimers();
    const refreshAfterBrainActivation = vi.fn(async () => ({ languageIdentities: 1, assignedProfiles: 1 }));
    const log = vi.fn();
    train.mockResolvedValue({ batchesTrained: 1, nextBatchIndex: 1, nextSourceVersionId: "source.completed", exhausted: false, articlesTrained: 1, bytesTrained: 128, reports: [{ languageConstructions: 2 }], batchesFailed: [], stoppedByStorageFailure: false });
    const runtime = { storage: { ingestion: checkpointStore() }, kernel: { refreshAfterBrainActivation } } as unknown as Parameters<typeof startDreamCycle>[0]["runtime"];
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
    train.mockResolvedValue({ batchesTrained: 0, nextBatchIndex: 0, nextSourceVersionId: null, exhausted: true, articlesTrained: 0, bytesTrained: 0, reports: [], batchesFailed: [], stoppedByStorageFailure: false });
    const runtime = { storage: { ingestion: checkpointStore() }, kernel: { refreshAfterBrainActivation } } as unknown as Parameters<typeof startDreamCycle>[0]["runtime"];
    const cycle = startDreamCycle({ runtime, config: { idleMinutes: 1 }, log: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(train).toHaveBeenCalledOnce();
      expect(refreshAfterBrainActivation).not.toHaveBeenCalled();
    } finally { cycle.stop(); }
  });
});

function checkpointStore() {
  const rows = new Map<string, IngestionCheckpoint>();
  return { get: vi.fn(async (id: string) => rows.get(id) ?? null), put: vi.fn(async (row: IngestionCheckpoint) => { rows.set(row.id, row); }) };
}
