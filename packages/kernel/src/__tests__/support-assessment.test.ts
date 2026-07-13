import { describe, expect, it } from "vitest";
import { assessClaimSupport, isReplayableFormalProof, type FormalProofReplay } from "../support-assessment.js";

describe("claim support assessment", () => {
  it("keeps contradiction mass separate from support and exposes a belief interval", () => {
    const result = assessClaimSupport({
      evidence: [
        { evidenceId: "support-1", polarity: "support", sourceReliability: 1, directness: 1, freshness: 1, extractionReliability: 1, sourceDiversity: 1 },
        { evidenceId: "against-1", polarity: "contradiction", sourceReliability: 0.5, directness: 1, freshness: 1, extractionReliability: 1, sourceDiversity: 1 },
        { evidenceId: "unknown-1", polarity: "unknown", sourceReliability: 0.25, directness: 1, freshness: 1, extractionReliability: 1, sourceDiversity: 1 }
      ],
      semanticAlignmentEstablished: true,
      uncertaintyFloor: 0
    });

    expect(result.category).toBe("semantic_support");
    expect(result.supportMass).toBe(1);
    expect(result.contradictionMass).toBe(0.5);
    expect(result.uncertaintyMass).toBe(0.25);
    expect(result.belief).toBeCloseTo(1 / 1.75);
    expect(result.plausibility).toBeCloseTo(1.25 / 1.75);
    expect(result.contradictionRatio).toBeCloseTo(0.5 / 1.75);
    expect(result.limitations).toContain("contradiction-mass-present");
  });

  it("does not call a fixed support score formal proof", () => {
    const result = assessClaimSupport({
      evidence: [{ evidenceId: "support-1", polarity: "support", sourceReliability: 1, directness: 1, freshness: 1, extractionReliability: 1, sourceDiversity: 1 }],
      semanticAlignmentEstablished: true,
      formalProofReplay: { axioms: ["A"], rules: ["modus"], substitutions: {}, steps: [{ rule: "modus", premises: ["missing"], conclusion: "B" }], replayVerified: true }
    });
    expect(result.category).toBe("semantic_support");
    expect(result.formalProofReplay).toBeUndefined();
    expect(result.limitations).toContain("formal-proof-replay-not-verified");
  });

  it("promotes only a mechanically replayable derivation to formal proof", () => {
    const proof: FormalProofReplay = {
      axioms: ["A", "A->B"],
      rules: ["modus-ponens"],
      substitutions: {},
      steps: [{ rule: "modus-ponens", premises: ["A", "A->B"], conclusion: "B" }],
      replayVerified: true
    };
    expect(isReplayableFormalProof(proof)).toBe(true);
    expect(assessClaimSupport({ evidence: [], formalProofReplay: proof, uncertaintyFloor: 0 }).category).toBe("formal_proof");
  });

  it("rejects invalid evidence and calibration values", () => {
    expect(() => assessClaimSupport({ evidence: [{ evidenceId: "bad", polarity: "support", sourceReliability: 2, directness: 1, freshness: 1, extractionReliability: 1, sourceDiversity: 1 }] })).toThrow(/within \[0, 1\]/u);
    expect(() => assessClaimSupport({ evidence: [], calibration: { calibrationId: "cal", targetEvent: "correct", probability: Number.NaN, reliable: true } })).toThrow(/within \[0, 1\]/u);
  });
});
