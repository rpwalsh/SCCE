// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { TurnResult } from "@scce/kernel";
import { compactTurnResult } from "../routes.js";

describe("compact turn result", () => {
  it("keeps the user surface and bounded proof while excluding internal working state", () => {
    const oversized = "x".repeat(250_000);
    const result = {
      episodeId: "episode.compact.fixture",
      answer: "A bounded answer.",
      epistemicForce: "invented",
      assistantForce: "creative_answer",
      requestedAuthority: "creative",
      evidence: [],
      entailment: {
        claim: {},
        verdict: "entailed",
        semanticVerdict: "entailed",
        force: "invented",
        support: 0,
        contradiction: 0,
        faithfulnessLcb: 1,
        confidence: {},
        scores: {},
        obligations: [],
        mappings: [],
        transforms: [],
        counterexamples: [],
        missing: [],
        proof: {
          id: "proof.compact.fixture",
          claimId: "claim.compact.fixture",
          verdict: "invented",
          confidence: {},
          proofGraph: { nodes: [], edges: [] },
          evidenceIds: [],
          transformIds: [],
          scores: {},
          validatorVersion: "fixture",
          createdAt: 1
        },
        evidenceIds: [],
        boundaries: []
      },
      learningNeeds: [],
      truthState: {},
      evidenceForce: "creative",
      guardFlags: {},
      calibrationStatus: "uncalibrated",
      proofCarryingAnswer: { supportedSentences: 1, totalSentences: 1, grounding: "invented" },
      runtimeMotion: { status: "held_for_review", heldSources: [{ id: "held.fixture", snippet: oversized }] },
      actionGraph: { summary: "kept", oversized },
      functionalCognition: { selectedGoal: { id: "goal.fixture", oversized } },
      selectedCandidate: { id: "candidate.fixture", oversized },
      judge: { selected: "candidate.fixture", oversized },
      answerRevision: { status: "accepted", oversized },
      runtimeCoherence: { emitAllowed: true, oversized },
      events: Array.from({ length: 100 }, (_, index) => ({
        id: `event.${index}`,
        episodeId: "episode.compact.fixture",
        typeId: "FixtureEvent",
        t: index,
        parents: [],
        payload: { oversized }
      })),
      field: { oversized },
      cognitiveProposals: { oversized },
      workingMemory: { oversized },
      constructGraph: { oversized },
      validationGraph: { oversized },
      emissionGraph: { oversized },
      forecast: { oversized },
      scoreTraces: []
    } as unknown as TurnResult;

    const projected = compactTurnResult(result);
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject({
      episodeId: "episode.compact.fixture",
      answer: "A bounded answer.",
      assistantForce: "creative_answer",
      runtimeMotion: { status: "held_for_review" },
      diagnostics: { selectedCandidate: { id: "candidate.fixture" } }
    });
    expect(projected).toHaveProperty("evidence");
    expect(projected).toHaveProperty("entailment.proof");
    expect(projected).toHaveProperty("proofCarryingAnswer");
    expect(projected).not.toHaveProperty("field");
    expect(projected).not.toHaveProperty("cognitiveProposals");
    expect(projected).not.toHaveProperty("workingMemory");
    expect(projected).not.toHaveProperty("constructGraph");
    expect(projected.events).toHaveLength(64);
    expect(serialized.length).toBeLessThan(50_000);
    expect(serialized).not.toContain(oversized);
  });
});
