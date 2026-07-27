import { describe, expect, it } from "vitest";
import { runtimeMotionCandidateField, type RuntimeReplanMotion } from "../runtime-motion.js";
import { createHasher } from "../primitives.js";
import type { CandidateField, CandidateSurface } from "../candidate-contract.js";

describe("runtimeMotionCandidateField (plan item: kernel-training sessionBound investigation)", () => {
  it("adds the runtime-motion continuation alongside the base field's candidates instead of discarding them", () => {
    const hasher = createHasher();
    const realAnswer: CandidateSurface = {
      id: "candidate:real-answer",
      kind: "proof-answer",
      answer: "The release codename is Aster.",
      force: "observed",
      evidenceIds: ["evidence:aster" as CandidateSurface["evidenceIds"][number]],
      scores: {
        support: 0.6,
        contradiction: 0,
        faithfulness: 0.9,
        alphaPressure: 0.2,
        actionability: 0.4,
        evidenceCoverage: 0.9,
        novelty: 0.1,
        realizability: 1
      },
      boundaries: [],
      audit: { source: "fixture" }
    };
    const base: CandidateField = {
      candidates: [realAnswer],
      surfaceMass: [{ candidateId: realAnswer.id, mass: 0.8, reason: "fixture" }],
      audit: { source: "fixture-base" },
      scoreTrace: []
    };
    const motion: RuntimeReplanMotion = {
      schema: "scce.runtime_motion.learn_hydrate_replan.v1",
      motionId: "motion.learn_hydrate_replan",
      guardId: "guard:fixture",
      attempt: 1,
      trigger: "coherence_support_failure",
      requestedAuthority: "factual",
      parentEpisodeId: "episode:fixture",
      queryHash: "hash:fixture",
      connectorConfigured: false,
      status: "unavailable",
      searchResultCount: 0,
      fetchedSourceCount: 0,
      ingestedSourceCount: 0,
      ingestedEvidenceCount: 0,
      sourceUris: [],
      sourceSurfaces: [],
      failures: []
    };

    const result = runtimeMotionCandidateField({
      base,
      requestText: "The release codename is Aster",
      authority: "factual",
      motion,
      hasher
    });

    // The base field's real candidate must survive so the judge can still
    // weigh it -- an unavailable/failed acquisition attempt is context for
    // the replan, not grounds to discard an answer the field already had.
    expect(result.candidates.map(candidate => candidate.id)).toContain(realAnswer.id);
    expect(result.candidates.length).toBe(base.candidates.length + 1);
    expect(result.candidates.some(candidate => candidate.kind === "dialogue-continuation")).toBe(true);
    expect(result.surfaceMass.map(row => row.candidateId)).toContain(realAnswer.id);
  });
});
