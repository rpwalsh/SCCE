// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement.

import { describe, expect, it } from "vitest";
import {
  createInMemoryDialogueMemoryStore
} from "../dialogue-learning.js";
import {
  creativeContinuationCandidateFromConstruct,
  creativeContinuationDecision,
  creativeContinuationDecisionFromObservation,
  loadCreativeContinuationPolicy,
  persistCreativeContinuationOffer,
  persistCreativeContinuationPreference,
  rankCreativeContinuations,
  type CreativeContinuationCandidate,
  type CreativeContinuationState
} from "../creative-continuation-learning.js";

describe("creative continuation learning", () => {
  it("reloads owner feedback and changes the structural continuation choice", async () => {
    const store = createInMemoryDialogueMemoryStore();
    const state = continuationState("conversation.owner", "turn.2");
    const linear = candidate("candidate.linear.2", "structure.linear", "mode.extend", "operator.linear", {
      constraintCoverage: 1,
      graphCoherence: 1,
      novelty: 1,
      languageRealizability: 0,
      usefulness: 0,
      risk: 0,
      repetition: 0,
      unsupportedFactualAssertion: 0
    });
    const branching = candidate("candidate.branching.2", "structure.branching", "mode.branch", "operator.branch", {
      constraintCoverage: 0.2,
      graphCoherence: 0.2,
      novelty: 0.1,
      languageRealizability: 1,
      usefulness: 1,
      risk: 0,
      repetition: 0,
      unsupportedFactualAssertion: 0
    });

    const cold = rankCreativeContinuations({ state, candidates: [linear, branching] });
    expect(cold[0]?.candidate.structureId).toBe("structure.linear");

    const rows = await persistCreativeContinuationPreference({
      store,
      preference: {
        state: continuationState(state.conversationId, "turn.1"),
        preferred: candidate("candidate.branching.1", "structure.branching", "mode.branch", "operator.branch", branching.features),
        rejected: candidate("candidate.linear.1", "structure.linear", "mode.extend", "operator.linear", linear.features),
        preferenceKind: "corrected_original",
        sourceRecordId: "outcome.owner.correction",
        sourceTraceId: "trace.owner.correction",
        createdAt: 10
      }
    });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("owner's private continuation text");

    // A fresh policy load models a process restart. Candidate IDs are new,
    // while the typed state and structural IDs remain stable.
    const policy = await loadCreativeContinuationPolicy({
      store,
      state,
      createdAt: 20
    });
    expect(policy.observations).toBe(2);
    expect(policy.ownerScopeId).toBe("conversation.owner");
    const warm = rankCreativeContinuations({ state, candidates: [linear, branching], policy });
    expect(warm[0]?.candidate.structureId).toBe("structure.branching");
    expect(warm[0]?.ownerAdjustment).toBeGreaterThan(0);
    expect(warm[1]?.ownerAdjustment).toBeLessThan(0);
    expect(warm[0]?.source).toBe("pairwise_preference");

    const laterState = { ...state, turnId: "turn.3", discourseStateId: "discourse.state.new" };
    const later = rankCreativeContinuations({ state: laterState, candidates: [linear, branching], policy });
    expect(later[0]?.candidate.structureId).toBe("structure.branching");
  });

  it("keeps structural preference scoped to its owner's typed discourse state", async () => {
    const store = createInMemoryDialogueMemoryStore();
    const stateA = continuationState("conversation.a", "turn.2");
    const stateB = continuationState("conversation.b", "turn.2");
    await persistCreativeContinuationPreference({
      store,
      preference: {
        state: continuationState("conversation.a", "turn.1"),
        preferred: candidate("candidate.branching.a", "structure.branching", "mode.branch", "operator.branch"),
        rejected: candidate("candidate.linear.a", "structure.linear", "mode.extend", "operator.linear"),
        sourceRecordId: "outcome.a",
        createdAt: 30
      }
    });
    const policyB = await loadCreativeContinuationPolicy({ store, state: stateB, createdAt: 31 });
    const rankedB = rankCreativeContinuations({ state: stateB, candidates: [candidate("candidate.linear.b", "structure.linear", "mode.extend", "operator.linear"), candidate("candidate.branching.b", "structure.branching", "mode.branch", "operator.branch")], policy: policyB });
    expect(policyB.observations).toBe(0);
    expect(rankedB.every(row => row.ownerAdjustment === 0)).toBe(true);
  });

  it("projects structural identities and round trips only the offered typed candidates", async () => {
    const store = createInMemoryDialogueMemoryStore();
    const state = continuationState("conversation.offer", "turn.1");
    const first = creativeContinuationCandidateFromConstruct({
      construct: invention("construct.first", "first surface"),
      candidateIndex: 0
    });
    const regenerated = creativeContinuationCandidateFromConstruct({
      construct: invention("construct.first", "a different realized surface"),
      candidateIndex: 0
    });
    expect(regenerated.structureId).toBe(first.structureId);
    expect(regenerated.selectedOutputHash).not.toBe(first.selectedOutputHash);
    const second = creativeContinuationCandidateFromConstruct({
      construct: invention("construct.second", "second surface"),
      candidateIndex: 1
    });
    const decision = creativeContinuationDecision({
      state,
      offered: [first, second],
      selectedCandidateId: first.candidateId
    });
    const offer = await persistCreativeContinuationOffer({ store, decision, sourceRecordId: state.turnId, createdAt: 4 });
    const loaded = (await store.listCalibrationObservations({ sourceRecordId: state.turnId, limit: 4 }))
      .map(creativeContinuationDecisionFromObservation)
      .find(value => value !== undefined);
    expect(offer.finalOutcome).toBe("offered");
    expect(loaded?.selectedContinuationCandidateId).toBe(first.candidateId);
    expect(loaded?.offered.map(candidate => candidate.candidateId)).toEqual([first.candidateId, second.candidateId]);
  });
});

function continuationState(conversationId: string, turnId: string): CreativeContinuationState {
  return {
    schema: "scce.creative_continuation_state.v1",
    conversationId,
    turnId,
    discourseStateId: "discourse.state.owner",
    semanticFrameId: "semantic.frame.continuation",
    languageId: "language.owner",
    goalId: "goal.continue"
  };
}

function candidate(candidateId: string, structureId: string, continuationModeId: string, semanticOperatorId: string, features?: CreativeContinuationCandidate["features"]): CreativeContinuationCandidate {
  return {
    candidateId,
    structureId,
    continuationModeId,
    semanticOperatorId,
    features: features ?? {
      constraintCoverage: 0.7,
      graphCoherence: 0.7,
      novelty: 0.5,
      languageRealizability: 0.8,
      usefulness: 0.8,
      risk: 0.1,
      repetition: 0.1,
      unsupportedFactualAssertion: 0
    },
    selectedOutputHash: `hash.${candidateId}`
  };
}

function invention(id: string, proposalSurface: string) {
  return {
    id,
    artifactKindIds: ["artifact.algorithm"],
    basisEvidenceIds: [],
    basisPriorIds: ["prior.graph-transform"],
    supportScore: 0.7,
    noveltyScore: 0.6,
    riskScore: 0.1,
    proposalSurface,
    trace: {
      constraintCoverage: 0.8,
      graphCoherence: 0.7,
      novelty: 0.6,
      languageRealizability: 0.8,
      usefulness: 0.7,
      risk: 0.1,
      repetition: 0.1,
      unsupportedFactualAssertion: 0,
      proposalRealization: { path: "mouth_realization_deferred" },
      structuralSemanticPlan: { id: "semantic.plan.algorithm", sourceBundleIds: ["bundle.algorithm"], events: [{ kind: "event.compose" }] },
      selectedGraphEdgeIds: ["edge.algorithm"],
      selectedLanguagePriorIds: ["prior.graph-transform"]
    }
  };
}
