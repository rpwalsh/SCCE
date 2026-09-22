// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { alignmentEventPayloadFor } from "../wikipedia-v3-ingestor.js";

describe("alignment event provenance retention", () => {
  const payload = {
    schema: "scce.sparse_alignment_candidate_batch.v1",
    alignmentAlternativeSetIds: ["set.a", "set.b"],
    alignmentAlternativeSets: [{ id: "set.a", hypotheses: [{ rank: 1 }] }, { id: "set.b", hypotheses: [{ rank: 1 }] }],
    transportEvidenceAllocationIds: ["alloc.a"],
    transportEvidenceAllocations: [{ id: "alloc.a", cells: [] }],
    alignmentPromotionModel: { id: "promotion.fixture" },
    alignmentCalibrationModel: { id: "calibration.fixture" },
    canonicalReplay: { id: "replay.fixture" }
  };

  it("stores the plan-bearing sets and allocations as counts by default and keeps ids, models and replay", () => {
    const stored = alignmentEventPayloadFor(payload, false);
    expect(stored).not.toHaveProperty("alignmentAlternativeSets");
    expect(stored).not.toHaveProperty("transportEvidenceAllocations");
    expect(stored.alignmentAlternativeSetIds).toEqual(["set.a", "set.b"]);
    expect(stored.transportEvidenceAllocationIds).toEqual(["alloc.a"]);
    expect(stored.alignmentAlternativeSetCount).toBe(2);
    expect(stored.transportEvidenceAllocationCount).toBe(1);
    expect(stored.alignmentPromotionModel).toEqual({ id: "promotion.fixture" });
    expect(stored.alignmentCalibrationModel).toEqual({ id: "calibration.fixture" });
    expect(stored.canonicalReplay).toEqual({ id: "replay.fixture" });
    expect(stored.alignmentProvenanceRetained).toBe(false);
  });

  it("retains the full bodies only when the corpus opts in", () => {
    const stored = alignmentEventPayloadFor(payload, true);
    expect(stored).toMatchObject(payload);
    expect(stored.alignmentProvenanceRetained).toBe(true);
  });
});
