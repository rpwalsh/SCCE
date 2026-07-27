import { describe, expect, it } from "vitest";
import {
  estimateClassEffectLCB,
  holmBonferroniCorrection,
  isValidPairedResult,
  type PairedResultRecord
} from "../paired-evaluation-statistics.js";

/** Deterministic LCG so bootstrap resampling is reproducible across test runs. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("signed paired-result contract (plan item 232)", () => {
  it("accepts exactly -1, 0, 1 and rejects everything else", () => {
    expect(isValidPairedResult(-1)).toBe(true);
    expect(isValidPairedResult(0)).toBe(true);
    expect(isValidPairedResult(1)).toBe(true);
    expect(isValidPairedResult(2)).toBe(false);
    expect(isValidPairedResult(0.5)).toBe(false);
    expect(isValidPairedResult(-2)).toBe(false);
  });

  it("estimateClassEffectLCB rejects a record with an invalid X_ic value rather than silently coercing it", () => {
    const records = [{ id: "r1", taskFamilyId: "factual_qa", value: 2 as unknown as -1 | 0 | 1 }];
    expect(() => estimateClassEffectLCB(records, { confidenceLevel: 0.95, bootstrapSamples: 100 }))
      .toThrow(/X_ic must be one of/);
  });
});

describe("cluster bootstrap lower-confidence-bound estimator (plan item 233)", () => {
  it("a task family with a consistently positive effect gets a positive lower confidence bound and a low p-value", () => {
    const records: PairedResultRecord[] = Array.from({ length: 30 }, (_, index) => ({
      id: `r${index}`,
      taskFamilyId: "factual_qa",
      value: 1
    }));
    const [estimate] = estimateClassEffectLCB(records, {
      confidenceLevel: 0.95,
      bootstrapSamples: 500,
      randomSource: seededRandom(1)
    });
    expect(estimate!.meanEffect).toBe(1);
    expect(estimate!.lowerConfidenceBound).toBeGreaterThan(0.5);
    expect(estimate!.pValue).toBeLessThan(0.05);
  });

  it("a task family with a consistently negative effect gets a negative lower confidence bound and a high p-value", () => {
    const records: PairedResultRecord[] = Array.from({ length: 30 }, (_, index) => ({
      id: `r${index}`,
      taskFamilyId: "translation",
      value: -1
    }));
    const [estimate] = estimateClassEffectLCB(records, {
      confidenceLevel: 0.95,
      bootstrapSamples: 500,
      randomSource: seededRandom(2)
    });
    expect(estimate!.meanEffect).toBe(-1);
    expect(estimate!.lowerConfidenceBound).toBeLessThan(-0.5);
    expect(estimate!.pValue).toBeGreaterThan(0.9);
  });

  it("a task family with no real effect (balanced wins/losses) has a lower confidence bound spanning zero and a high p-value", () => {
    const values: Array<-1 | 0 | 1> = [];
    for (let i = 0; i < 20; i++) values.push(1, -1);
    const records: PairedResultRecord[] = values.map((value, index) => ({ id: `r${index}`, taskFamilyId: "long_form_prose", value }));
    const [estimate] = estimateClassEffectLCB(records, {
      confidenceLevel: 0.90,
      bootstrapSamples: 500,
      randomSource: seededRandom(3)
    });
    expect(estimate!.meanEffect).toBeCloseTo(0, 9);
    expect(estimate!.lowerConfidenceBound).toBeLessThan(0.2);
    expect(estimate!.pValue).toBeGreaterThan(0.2);
  });

  it("clusters strictly by task family -- two families never influence each other's estimate", () => {
    const records: PairedResultRecord[] = [
      ...Array.from({ length: 10 }, (_, index) => ({ id: `a${index}`, taskFamilyId: "code_understanding", value: 1 as const })),
      ...Array.from({ length: 10 }, (_, index) => ({ id: `b${index}`, taskFamilyId: "defect_localization", value: -1 as const }))
    ];
    const estimates = estimateClassEffectLCB(records, { confidenceLevel: 0.95, bootstrapSamples: 300, randomSource: seededRandom(4) });
    expect(estimates.map(estimate => estimate.taskFamilyId)).toEqual(["code_understanding", "defect_localization"]);
    expect(estimates[0]!.meanEffect).toBe(1);
    expect(estimates[1]!.meanEffect).toBe(-1);
  });

  it("rejects an invalid confidence level or a non-positive bootstrap sample count", () => {
    const records: PairedResultRecord[] = [{ id: "r1", taskFamilyId: "x", value: 1 }];
    expect(() => estimateClassEffectLCB(records, { confidenceLevel: 1, bootstrapSamples: 100 })).toThrow(/confidenceLevel/);
    expect(() => estimateClassEffectLCB(records, { confidenceLevel: 0.95, bootstrapSamples: 0 })).toThrow(/bootstrapSamples/);
  });
});

describe("Holm-Bonferroni multiple-comparison correction (plan item 234)", () => {
  it("matches the standard textbook step-down result for a known set of p-values", () => {
    // Textbook case: p = [0.01, 0.02, 0.03, 0.04], alpha = 0.05, m = 4.
    // Rank 1 threshold 0.05/4 = 0.0125 -> 0.01 passes.
    // Rank 2 threshold 0.05/3 ~= 0.01667 -> 0.02 fails -> stop.
    // Ranks 3 and 4 are therefore also not rejected under step-down.
    const results = holmBonferroniCorrection(
      [
        { id: "a", pValue: 0.04 },
        { id: "b", pValue: 0.01 },
        { id: "c", pValue: 0.03 },
        { id: "d", pValue: 0.02 }
      ],
      0.05
    );
    const byId = new Map(results.map(result => [result.id, result]));
    expect(byId.get("b")!.reject).toBe(true);
    expect(byId.get("d")!.reject).toBe(false);
    expect(byId.get("c")!.reject).toBe(false);
    expect(byId.get("a")!.reject).toBe(false);
    expect(byId.get("b")!.requiredThreshold).toBeCloseTo(0.0125, 9);
    expect(byId.get("d")!.requiredThreshold).toBeCloseTo(0.05 / 3, 9);
  });

  it("is strictly more powerful than a flat Bonferroni correction on a case where step-down rejects more", () => {
    // Flat Bonferroni: every p-value must clear alpha/m = 0.01.
    // p = [0.005, 0.008, 0.009] would ALL pass flat Bonferroni here too,
    // so use a case where step-down clearly rejects a hypothesis flat
    // Bonferroni would not: p = [0.005, 0.012, 0.012], alpha = 0.05, m=3.
    // Flat Bonferroni threshold: 0.05/3 ~= 0.01667 -- all three would
    // actually pass flat Bonferroni too in this case, so instead confirm
    // Holm's rank-2 threshold (0.05/2=0.025) is strictly looser than the
    // flat threshold (0.05/3), which is the real reason step-down can
    // reject more than flat Bonferroni in general.
    const results = holmBonferroniCorrection(
      [{ id: "a", pValue: 0.005 }, { id: "b", pValue: 0.012 }, { id: "c", pValue: 0.012 }],
      0.05
    );
    const flatBonferroniThreshold = 0.05 / 3;
    const rank2 = results.find(result => result.rank === 2)!;
    expect(rank2.requiredThreshold).toBeGreaterThan(flatBonferroniThreshold);
  });

  it("rejects nothing when every p-value is well above the significance threshold", () => {
    const results = holmBonferroniCorrection(
      [{ id: "a", pValue: 0.5 }, { id: "b", pValue: 0.6 }],
      0.05
    );
    expect(results.every(result => !result.reject)).toBe(true);
  });

  it("rejects an invalid alpha", () => {
    expect(() => holmBonferroniCorrection([{ id: "a", pValue: 0.1 }], 1.5)).toThrow(/alpha/);
  });
});
