// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { decideRuntimeCoherence, RUNTIME_COHERENCE_DIMENSION_IDS } from "../runtime-coherence.js";
import type { EvidenceSpan, SemanticEntailmentResult } from "../types.js";

function span(id: string, mediaType: string): EvidenceSpan {
  return {
    id, sourceId: "source.fixture", sourceVersionId: "source_version.fixture", chunkId: "chunk.1",
    contentHash: "sha256_fixture", mediaType, byteStart: 0, byteEnd: 10, charStart: 0, charEnd: 10,
    text: "Ada Lovelace wrote the first published algorithm.",
    textPreview: "Ada Lovelace wrote the first published algorithm.",
    languageHints: {}, scriptHints: {}, trustVector: {}, provenance: { uri: "wikipedia://enwiki/pages/974/Ada_Lovelace" },
    features: [], status: "promoted", alpha: 0.9, observedAt: 1
  } as unknown as EvidenceSpan;
}

const entailment = {
  claim: { id: "claim.1", text: "who wrote the first algorithm" },
  force: "inferred", support: 0.8, contradiction: 0, evidenceIds: ["evidence.1"], boundaries: [],
  proof: { id: "proof.1" }
} as unknown as SemanticEntailmentResult;

describe("a recall turn that had its evidence must not answer with silence", () => {
  it("treats an empty answer with admitted evidence as a mouth-surface failure", () => {
    const decision = decideRuntimeCoherence({
      requestText: "Complete this sentence: Ada Lovelace wrote the first ____ algorithm.",
      answerText: "",
      evidence: [span("evidence.1", "text/x-wiki")],
      entailment,
      assistantForce: "learned_corpus_answer"
    });

    expect(decision.failedDimensionIds).toContain(RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface);
    expect(decision.emitAllowed).toBe(false);
  });

  it("leaves an abstention alone: no evidence and no answer is the honest outcome", () => {
    const decision = decideRuntimeCoherence({
      requestText: "Complete this sentence: the corpus does not contain ____.",
      answerText: "",
      evidence: [],
      entailment: { ...entailment, evidenceIds: [], support: 0 } as unknown as SemanticEntailmentResult,
      assistantForce: "insufficient_support"
    });

    expect(decision.failedDimensionIds).not.toContain(RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface);
  });

  it("leaves a creative turn that could not realize a surface to its own path", () => {
    const decision = decideRuntimeCoherence({
      requestText: "Invent something inspired by these notes",
      answerText: "",
      evidence: [span("evidence.1", "text/x-wiki")],
      entailment,
      assistantForce: "creative_answer"
    });

    expect(decision.failedDimensionIds).not.toContain(RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface);
  });
});
