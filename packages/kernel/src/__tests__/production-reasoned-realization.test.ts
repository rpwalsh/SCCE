import { describe, expect, it } from "vitest";
import { reasonedRealizationPreservesContract, sourceIndependentDialogueRequirements, sourceIndependentDialogueSurfaceAcceptable } from "../production-turn-runtime.js";
import { compileRealizationContract } from "../semantic-answer-construct.js";
import type { EvidenceId } from "../types.js";

function fixture() {
  const contract = compileRealizationContract("", {
    subject: "Mira", predicate: "crossed", object: "the river",
    sourceNodeId: "node.甲", targetNodeId: "node.乙", relationId: "relation.丙",
    evidenceIds: ["evidence.丁"], forceClass: "inference",
    score: 0.9, activation: 0.9, overlap: 0.9, support: 0.9
  });
  return {
    requestedAuthority: "reasoned" as const,
    requirementField: { sourceDependence: 0.2, semanticPreservation: 0.2, inferentialDepth: 0.8, dialogueDependence: 0.7 },
    spoken: { text: "Mira crossed the river.", surfaceValid: true, evidenceRefs: ["evidence.丁" as EvidenceId] },
    realizationContract: contract
  };
}

describe("production reasoned source fallback boundary", () => {
  it("routes learned source-independent dialogue without requiring novelty", () => {
    const field = { dialogueDependence: 0.8, externalTruthAuthority: 0.2, sourceDependence: 0.1, semanticPreservation: 0.1 };
    expect(sourceIndependentDialogueRequirements(field)).toBe(true);
    expect(sourceIndependentDialogueRequirements({ ...field, sourceDependence: 0.9 })).toBe(false);
    expect(sourceIndependentDialogueRequirements({ ...field, externalTruthAuthority: 0.9 })).toBe(false);
    expect(sourceIndependentDialogueRequirements({ ...field, semanticPreservation: 0.9 })).toBe(false);
    expect(sourceIndependentDialogueRequirements({ ...field, dialogueDependence: 0 })).toBe(false);
  });

  it("keeps a valid brief source-free dialogue surface out of source-excerpt recovery", () => {
    const field = { dialogueDependence: 0.8, externalTruthAuthority: 0.1, sourceDependence: 0.05, semanticPreservation: 0.2 };
    const spoken = { text: "I can help you think that through.", surfaceValid: true, evidenceRefs: [] as EvidenceId[] };
    expect(sourceIndependentDialogueSurfaceAcceptable({
      requestedAuthority: "reasoned",
      requirementField: field,
      spoken,
      selectedEvidenceCount: 0
    })).toBe(true);
    expect(sourceIndependentDialogueSurfaceAcceptable({
      requestedAuthority: "reasoned",
      requirementField: field,
      spoken,
      selectedEvidenceCount: 1
    })).toBe(false);
    expect(sourceIndependentDialogueSurfaceAcceptable({
      requestedAuthority: "reasoned",
      requirementField: { ...field, sourceDependence: 0.8 },
      spoken,
      selectedEvidenceCount: 0
    })).toBe(false);
    expect(sourceIndependentDialogueSurfaceAcceptable({
      requestedAuthority: "reasoned",
      requirementField: field,
      spoken: { ...spoken, evidenceRefs: ["evidence.ä¸" as EvidenceId] },
      selectedEvidenceCount: 0
    })).toBe(false);
  });
  it("preserves a valid reasoned surface that satisfies its selected meaning and cites its evidence", () => {
    const input = fixture();
    // Evidence wording differs; substring equality is not the proof contract.
    const evidenceText = "Mira crossed the river during the afternoon.";
    expect(evidenceText.includes(input.spoken.text)).toBe(false);
    expect(reasonedRealizationPreservesContract(input)).toBe(true);
  });

  it("retains exact-source fallback for factual and source-preserving tasks", () => {
    const input = fixture();
    expect(reasonedRealizationPreservesContract({ ...input, requestedAuthority: "factual" })).toBe(false);
    for (const dimension of ["semanticPreservation", "sourceDependence"] as const) {
      expect(reasonedRealizationPreservesContract({ ...input, requirementField: { ...input.requirementField, [dimension]: 0.9 } })).toBe(false);
    }
  });

  it("rejects invalid output, unsupported additions, missing bindings and unrelated source prose", () => {
    const input = fixture();
    expect(reasonedRealizationPreservesContract({ ...input, spoken: { ...input.spoken, surfaceValid: false } })).toBe(false);
    expect(reasonedRealizationPreservesContract({ ...input, spoken: { ...input.spoken, evidenceRefs: [] } })).toBe(false);
    expect(reasonedRealizationPreservesContract({ ...input, realizationContract: undefined })).toBe(false);
    for (const text of ["Mira crossed the river and won a prize.", "A computer game features moving balls.", "Mira crossed."]) {
      expect(reasonedRealizationPreservesContract({ ...input, spoken: { ...input.spoken, text } })).toBe(false);
    }
  });
});
