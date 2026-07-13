import { describe, expect, it } from "vitest";
import {
  calibratedScore,
  createScoreTrace,
  featureScore,
  provisionalHeuristicScore,
  scoreTraceId
} from "./score-trace.js";

describe("score trace contract", () => {
  it("creates feature score traces with deterministic ids", () => {
    const trace = featureScore({
      value: 0.62,
      range: [0, 1],
      meaning: "candidate semantic fit",
      inputs: ["support", "questionFit"],
      provenance: ["candidate.ts:factScore"],
      idSeed: "feature-seed-1"
    });
    expect(trace.id).toBe(scoreTraceId("feature", "feature-seed-1"));
    expect(trace.kind).toBe("feature");
    expect(trace.calibrated).toBe(false);
  });

  it("rejects invalid ranges", () => {
    expect(() => createScoreTrace({
      kind: "feature",
      value: 0.3,
      range: [1, 0],
      meaning: "invalid",
      inputs: [],
      provenance: []
    })).toThrow(/Invalid ScoreTrace range/);
  });

  it("requires calibration id for calibrated probabilities", () => {
    expect(() => createScoreTrace({
      kind: "calibrated_probability",
      value: 0.77,
      range: [0, 1],
      meaning: "answer confidence",
      inputs: ["support"],
      provenance: ["kernel.ts"],
      calibrated: true
    })).toThrow(/must include calibrationId/);
  });

  it("requires failure modes for provisional heuristics", () => {
    expect(() => provisionalHeuristicScore({
      value: 0.51,
      range: [0, 1],
      meaning: "legacy blend",
      inputs: ["heuristicA"],
      provenance: ["legacy"],
      failureModes: []
    })).toThrow(/must include failure modes/);
  });

  it("accepts calibrated score with id and calibrated flag", () => {
    const trace = calibratedScore({
      value: 0.81,
      range: [0, 1],
      meaning: "retrieval success probability",
      inputs: ["bm25", "vector", "graph"],
      provenance: ["retrieval.ts:hybridRecall"],
      calibrationId: "cal.retrieval.v1"
    });
    expect(trace.kind).toBe("calibrated_probability");
    expect(trace.calibrated).toBe(true);
    expect(trace.calibrationId).toBe("cal.retrieval.v1");
  });
});