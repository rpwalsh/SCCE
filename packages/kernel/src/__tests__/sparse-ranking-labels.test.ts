import { describe, expect, it } from "vitest";
import { pairwiseLabelFromEntailment, type PairwiseLabelCandidate } from "../sparse-ranking-labels.js";
import type { EvidenceId, SemanticEntailmentResult } from "../index.js";

describe("pairwiseLabelFromEntailment (plan items 26-27)", () => {
  it("prefers certified evidence over the unused candidate pool on an entailed verdict", () => {
    const label = pairwiseLabelFromEntailment({
      entailment: entailmentFixture({ verdict: "entailed", evidenceIds: ["evidence:a"], faithfulnessLcb: 0.72 }),
      candidatePoolEvidenceIds: ["evidence:a", "evidence:b", "evidence:c"] as EvidenceId[]
    });
    expect(label?.preferredEvidenceIds.map(String)).toEqual(["evidence:a"]);
    expect(label?.rejectedEvidenceIds.map(String)).toEqual(["evidence:b", "evidence:c"]);
    expect(label?.weight).toBeCloseTo(0.72);
  });

  it("inverts the label on a contradicted verdict, pushing away from the contradicted evidence", () => {
    const label = pairwiseLabelFromEntailment({
      entailment: entailmentFixture({ verdict: "contradicted", evidenceIds: ["evidence:bad"], faithfulnessLcb: 0.5 }),
      candidatePoolEvidenceIds: ["evidence:bad", "evidence:good"] as EvidenceId[]
    });
    expect(label?.preferredEvidenceIds.map(String)).toEqual(["evidence:good"]);
    expect(label?.rejectedEvidenceIds.map(String)).toEqual(["evidence:bad"]);
  });

  it("returns no label for an underdetermined or unknown verdict", () => {
    for (const verdict of ["underdetermined", "unknown"] as const) {
      const label = pairwiseLabelFromEntailment({
        entailment: entailmentFixture({ verdict, evidenceIds: ["evidence:a"], faithfulnessLcb: 0.9 }),
        candidatePoolEvidenceIds: ["evidence:a", "evidence:b"] as EvidenceId[]
      });
      expect(label).toBeUndefined();
    }
  });

  it("returns no label when the candidate pool leaves nothing to contrast against", () => {
    const label = pairwiseLabelFromEntailment({
      entailment: entailmentFixture({ verdict: "entailed", evidenceIds: ["evidence:a"], faithfulnessLcb: 0.9 }),
      candidatePoolEvidenceIds: ["evidence:a"] as EvidenceId[]
    });
    expect(label).toBeUndefined();
  });

  it("returns no label when the entailment itself certified no evidence", () => {
    const label = pairwiseLabelFromEntailment({
      entailment: entailmentFixture({ verdict: "entailed", evidenceIds: [], faithfulnessLcb: 0.9 }),
      candidatePoolEvidenceIds: ["evidence:a", "evidence:b"] as EvidenceId[]
    });
    expect(label).toBeUndefined();
  });

  it("has no parameter through which an FTRL score or ranking could be passed in", () => {
    // Structural guarantee for item 27: the input type only accepts a
    // SemanticEntailmentResult and a candidate pool of EvidenceIds.
    // TypeScript would reject an extra `rankerScore`/`ftrlScore` field
    // here at compile time -- this test exists to keep that guarantee
    // visible and regression-checked, not to re-verify the type system.
    const input: Parameters<typeof pairwiseLabelFromEntailment>[0] = {
      entailment: entailmentFixture({ verdict: "entailed", evidenceIds: ["evidence:a"], faithfulnessLcb: 0.9 }),
      candidatePoolEvidenceIds: ["evidence:a", "evidence:b"] as EvidenceId[]
    };
    expect(Object.keys(input).sort()).toEqual(["candidatePoolEvidenceIds", "entailment"]);
    const label: PairwiseLabelCandidate | undefined = pairwiseLabelFromEntailment(input);
    expect(label?.source).toBe("proof_certification");
  });
});

function entailmentFixture(input: {
  verdict: SemanticEntailmentResult["verdict"];
  evidenceIds: string[];
  faithfulnessLcb: number;
}): SemanticEntailmentResult {
  return {
    claim: { id: "claim:fixture" as never, text: "fixture", normalized: "fixture", features: ["sym:fixture"], polarity: 1 },
    verdict: input.verdict,
    semanticVerdict: input.verdict,
    force: "observed",
    support: 0.8,
    contradiction: input.verdict === "contradicted" ? 0.8 : 0.05,
    faithfulnessLcb: input.faithfulnessLcb,
    confidence: {
      verdict: input.verdict,
      support: 0.8,
      contradiction: 0.05,
      faithfulnessLcb: input.faithfulnessLcb,
      supportingEvidence: input.evidenceIds.length,
      sourceVersions: [],
      structuralCoverage: 1,
      roleCoverage: 1,
      relationCompatibility: 1,
      transformationSupport: 1,
      causalMass: 0.2,
      stability: 1,
      satisfiedObligations: 0,
      requiredObligations: 0
    },
    scores: { structuralCoverage: 1, roleCoverage: 1, relationCompatibility: 1, transformationSupport: 1, causalMass: 0.2, faithfulnessLCB: input.faithfulnessLcb, contradiction: 0.05, stability: 1 },
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    evidenceIds: input.evidenceIds as EvidenceId[],
    boundaries: [],
    proof: {
      id: "proof:fixture" as never,
      claimId: "claim:fixture" as never,
      verdict: "observed",
      confidence: {},
      proofGraph: { nodes: [{ id: "claim", kind: "claim", label: "fixture", metadata: {} }], edges: [] },
      evidenceIds: input.evidenceIds as EvidenceId[],
      transformIds: [],
      scores: {},
      validatorVersion: "test",
      createdAt: 1000
    }
  };
}
