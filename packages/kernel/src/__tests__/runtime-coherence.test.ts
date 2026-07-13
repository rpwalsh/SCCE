import { describe, expect, it } from "vitest";
import {
  RUNTIME_COHERENCE_DIMENSION_IDS,
  decideRuntimeCoherence,
  type RuntimeCoherenceInput
} from "../runtime-coherence.js";
import type { CounterfactualWorld } from "../counterfactual-cognition.js";
import type { EvidenceSpan, SemanticEntailmentResult } from "../types.js";

describe("runtime coherence governor", () => {
  it("blocks mouth output that leaks raw source markup", () => {
    const decision = decideRuntimeCoherence({
      ...baseInput(),
      answerText: "Ada Lovelace [[File:portrait.jpg|alt=portrait]] was known for work on engines.",
      assistantForce: "source_grounded_answer"
    });
    expect(decision.emitAllowed).toBe(false);
    expect(decision.assistantForceAfter).toBe("insufficient_support");
    expect(decision.failedDimensionIds).toContain(RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface);
    expect(decision.influenceIds.length).toBeGreaterThan(0);
  });

  it("demotes source-grounded force when counterfactual stability fails", () => {
    const decision = decideRuntimeCoherence({
      ...baseInput(),
      assistantForce: "source_grounded_answer",
      counterfactual: counterfactualWorld({ failedPressure: 0.9 })
    });
    expect(decision.emitAllowed).toBe(true);
    expect(decision.demotionRequired).toBe(true);
    expect(decision.assistantForceAfter).toBe("reasoned_answer");
    expect(decision.failedDimensionIds).toContain(RUNTIME_COHERENCE_DIMENSION_IDS.counterfactualStability);
  });

  it("prevents learned language priors from certifying factual truth", () => {
    const decision = decideRuntimeCoherence({
      ...baseInput({ evidence: [evidence("learned_language_prior")] }),
      assistantForce: "learned_corpus_answer"
    });
    expect(decision.demotionRequired).toBe(true);
    expect(decision.assistantForceAfter).toBe("insufficient_support");
    expect(decision.failedDimensionIds).toContain(RUNTIME_COHERENCE_DIMENSION_IDS.languagePriorLeakage);
  });
});

function baseInput(overrides: Partial<RuntimeCoherenceInput> = {}): RuntimeCoherenceInput {
  return {
    requestText: "who was ada lovelace?",
    answerText: "Ada Lovelace was a mathematician and writer.",
    evidence: [evidence("direct_evidence")],
    entailment: entailment({ support: 0.72, contradiction: 0.08 }),
    assistantForce: "source_grounded_answer",
    readiness: { ready: true, missing: [], warnings: [], risk: 0.12, audit: {} },
    ...overrides
  };
}

function evidence(forceClass: string): EvidenceSpan {
  return {
    id: "evidence_test" as EvidenceSpan["id"],
    sourceId: "source_test" as EvidenceSpan["sourceId"],
    sourceVersionId: "source_version_test" as EvidenceSpan["sourceVersionId"],
    chunkId: "chunk_test" as EvidenceSpan["chunkId"],
    contentHash: "sha256_test" as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: 12,
    charStart: 0,
    charEnd: 12,
    text: "Ada evidence",
    textPreview: "Ada evidence",
    languageHints: {},
    scriptHints: {},
    trustVector: { forceClass },
    provenance: { title: "Ada Lovelace", forceClass },
    features: ["ada", "lovelace"],
    status: "promoted",
    alpha: 0.8,
    observedAt: 0
  };
}

function entailment(input: { support: number; contradiction: number }): SemanticEntailmentResult {
  return {
    claim: { id: "claim_test" as SemanticEntailmentResult["claim"]["id"], text: "test claim", normalized: "test claim", createdAt: 0 },
    verdict: "unknown",
    semanticVerdict: "unknown",
    force: "observed",
    support: input.support,
    contradiction: input.contradiction,
    faithfulnessLcb: 0.6,
    confidence: { p50: input.support, p90: Math.min(1, input.support + 0.1), p99: Math.min(1, input.support + 0.2) },
    scores: {},
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    proof: {
      id: "proof_test" as SemanticEntailmentResult["proof"]["id"],
      claimId: "claim_test" as SemanticEntailmentResult["proof"]["claimId"],
      steps: [],
      evidenceIds: [],
      verifierVersion: "test",
      verdict: "unknown",
      confidence: input.support,
      createdAt: 0
    },
    evidenceIds: [],
    boundaries: []
  } as unknown as SemanticEntailmentResult;
}

function counterfactualWorld(input: { failedPressure: number }): CounterfactualWorld {
  return {
    id: "counterfactual_world_test",
    variables: [],
    interventions: [],
    effect: [{ nodeId: "node_test" as CounterfactualWorld["effect"][number]["nodeId"], effect: 0.2, lower: -0.1, upper: 0.4, pathSupport: 0.01 }],
    constraints: [{ id: "effect-path-support", passed: false, pressure: input.failedPressure, message: "fixture" }],
    explanation: [],
    audit: {}
  };
}
