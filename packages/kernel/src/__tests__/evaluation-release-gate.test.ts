// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { evaluateReleaseGate } from "../evaluation-release-gate.js";
import { assertPreregisteredTaskClassIds, isPreregisteredTaskClassId, PREREGISTERED_TASK_CLASSES } from "../evaluation-task-classes.js";
import type { PairedResultRecord } from "../paired-evaluation-statistics.js";

// Plan items 231, 235, 238-239: preregistered task classes as real
// config, and the real evaluation release gate wiring
// unsupported-rate/exact-anchor-accuracy/cycle-accuracy in as hard
// requirements (never advisory).

describe("PREREGISTERED_TASK_CLASSES (plan item 231)", () => {
  it("declares all 13 named task classes with unique real ids", () => {
    expect(PREREGISTERED_TASK_CLASSES).toHaveLength(13);
    const ids = PREREGISTERED_TASK_CLASSES.map(taskClass => taskClass.id);
    expect(new Set(ids).size).toBe(13);
  });

  it("isPreregisteredTaskClassId is a real, checkable membership test", () => {
    expect(isPreregisteredTaskClassId("factual_qa")).toBe(true);
    expect(isPreregisteredTaskClassId("not_a_real_class")).toBe(false);
  });

  it("assertPreregisteredTaskClassIds throws naming every unregistered id, not a generic error", () => {
    expect(() => assertPreregisteredTaskClassIds(["factual_qa", "made_up_class", "another_fake"]))
      .toThrow(/made_up_class.*another_fake|another_fake.*made_up_class/);
    expect(() => assertPreregisteredTaskClassIds(["factual_qa", "translation"])).not.toThrow();
  });
});

const passingMetrics = { unsupportedRate: 0.02, exactAnchorAccuracy: 0.98, cycleAccuracy: 0.97 };
const thresholds = { maxUnsupportedRate: 0.05, minExactAnchorAccuracy: 0.9, minCycleAccuracy: 0.9 };

describe("evaluateReleaseGate (plan item 235: hard requirements, never advisory)", () => {
  it("passes a synthetic run whose metrics clear every real threshold", () => {
    const result = evaluateReleaseGate(passingMetrics, thresholds);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("plan item 238: fails a synthetic run that passes quality but violates the unsupported-rate threshold", () => {
    const result = evaluateReleaseGate({ ...passingMetrics, unsupportedRate: 0.12 }, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failures.map(failure => failure.id)).toContain("unsupported_rate");
    expect(result.failures.find(failure => failure.id === "unsupported_rate")?.reason).toMatch(/0\.12.*0\.05/);
  });

  it("plan item 239: fails a synthetic run that regresses exact-anchor accuracy even with high raw quality elsewhere", () => {
    const result = evaluateReleaseGate({ ...passingMetrics, exactAnchorAccuracy: 0.6 }, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failures.map(failure => failure.id)).toEqual(["exact_anchor_accuracy"]);
  });

  it("fails on a cycle-accuracy regression the same way", () => {
    const result = evaluateReleaseGate({ ...passingMetrics, cycleAccuracy: 0.5 }, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failures.map(failure => failure.id)).toEqual(["cycle_accuracy"]);
  });

  it("reports every real violation at once, not just the first", () => {
    const result = evaluateReleaseGate({ unsupportedRate: 0.5, exactAnchorAccuracy: 0.1, cycleAccuracy: 0.1 }, thresholds);
    expect(result.failures.map(failure => failure.id).sort()).toEqual(["cycle_accuracy", "exact_anchor_accuracy", "unsupported_rate"]);
  });

  it("rejects an out-of-range metric rather than silently clamping it", () => {
    expect(() => evaluateReleaseGate({ ...passingMetrics, unsupportedRate: 1.5 }, thresholds)).toThrow(/\[0, 1\]/);
  });

  it("also enforces class-effect significance as a hard requirement when paired results are supplied", () => {
    const strongClass: PairedResultRecord[] = Array.from({ length: 30 }, (_, index) => ({ id: `s${index}`, taskFamilyId: "factual_qa", value: 1 }));
    const weakClass: PairedResultRecord[] = Array.from({ length: 30 }, (_, index) => ({
      id: `w${index}`, taskFamilyId: "translation", value: index % 3 === 0 ? 1 : index % 3 === 1 ? -1 : 0
    }));
    const result = evaluateReleaseGate(
      passingMetrics,
      { ...thresholds, classEffect: { alpha: 0.05, lcbOptions: { confidenceLevel: 0.95, bootstrapSamples: 500, randomSource: mulberry32(42) } } },
      [...strongClass, ...weakClass]
    );
    expect(result.classEffects?.map(estimate => estimate.taskFamilyId).sort()).toEqual(["factual_qa", "translation"]);
    // The uniformly-successful class must reject the null; the noisy,
    // near-zero-mean class is not expected to.
    expect(result.failures.some(failure => failure.id === "class_effect:factual_qa")).toBe(false);
  });

  it("rejects paired results naming an unregistered task class instead of silently accepting it", () => {
    expect(() => evaluateReleaseGate(
      passingMetrics,
      { ...thresholds, classEffect: { alpha: 0.05, lcbOptions: { confidenceLevel: 0.95, bootstrapSamples: 50 } } },
      [{ id: "x", taskFamilyId: "not_a_real_class", value: 1 }]
    )).toThrow(/unregistered task class/);
  });

  it("CRITICAL fix: rejects an out-of-range threshold instead of a gate that can structurally never fail", () => {
    expect(() => evaluateReleaseGate(passingMetrics, { ...thresholds, maxUnsupportedRate: 2 })).toThrow(/\[0, 1\]/);
    expect(() => evaluateReleaseGate(passingMetrics, { ...thresholds, minCycleAccuracy: -1 })).toThrow(/\[0, 1\]/);
    expect(() => evaluateReleaseGate(passingMetrics, { ...thresholds, minExactAnchorAccuracy: Number.NaN })).toThrow(/\[0, 1\]/);
  });

  it("CRITICAL fix: rejects an invalid classEffect.alpha", () => {
    expect(() => evaluateReleaseGate(passingMetrics, { ...thresholds, classEffect: { alpha: 0, lcbOptions: { confidenceLevel: 0.95, bootstrapSamples: 50 } } }, [])).toThrow(/alpha/);
    expect(() => evaluateReleaseGate(passingMetrics, { ...thresholds, classEffect: { alpha: 1, lcbOptions: { confidenceLevel: 0.95, bootstrapSamples: 50 } } }, [])).toThrow(/alpha/);
  });

  it("CRITICAL fix: a configured classEffect requirement with no pairedResults no longer silently passes", () => {
    expect(() => evaluateReleaseGate(
      passingMetrics,
      { ...thresholds, classEffect: { alpha: 0.05, lcbOptions: { confidenceLevel: 0.95, bootstrapSamples: 50 } } }
      // pairedResults omitted entirely
    )).toThrow(/pairedResults/);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
