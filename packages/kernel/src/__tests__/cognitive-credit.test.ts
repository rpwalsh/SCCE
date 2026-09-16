// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  buildCognitiveCreditRecord,
  cognitiveCreditObservation,
  cognitiveCreditObservations,
  cognitiveCreditStageObservations,
  withGradedOutcome,
  COGNITIVE_CREDIT_SCHEMA,
  CREDIT_CHAIN_IDS,
  CREDIT_OUTCOME_SOURCE_IDS,
  CREDIT_STAGE_IDS,
  type CognitiveCreditTurnView
} from "../cognitive-credit.js";
import { CALIBRATION_IDS } from "../calibration-spine.js";

const EPISODE = "episode_00mu4ht13r_87cce5ae21c1_ec50df5d0b";

/** Ids and numbers from one real answered turn, in the exact shapes the runtime hands the builder. */
function turnView(overrides: Partial<CognitiveCreditTurnView> = {}): CognitiveCreditTurnView {
  return {
    episodeId: EPISODE,
    conversationId: "conversation.default",
    taskClass: "task.source_bound_qa",
    requestedAuthority: "factual",
    answer: "Kenya's capital and largest city is Nairobi.",
    requirementField: {
      externalTruthAuthority: 0.82,
      sourceDependence: 0.77,
      inferentialDepth: 0.14,
      confidence: 0.63,
      requiredFeatures: [{ id: "requirement.source_citation" }],
      activatedFrameIds: ["frame.capital_of"],
      activatedPatternIds: ["pattern.what_is_the_x_of_y"],
      activatedPhraseUnitIds: [],
      activatedDialogueMoveIds: [],
      activatedConstructIds: ["construct.semantic_answer"],
      activationsUsed: [{ id: "activation.frame.capital_of", weight: 0.8 }]
    },
    operatorActivations: [
      { id: "activation.aaa", operatorId: "operator.cognition.relation_composition.v1", activation: 0.71, active: true, contributingRequirementDimensions: ["sourceDependence"], support: { requirement: 1.28, graph: 0, dialogue: 0.4, construct: 0, outcome: 0 } },
      { id: "activation.bbb", operatorId: "operator.cognition.graph_propagation.v1", activation: 0.21, active: false, contributingRequirementDimensions: [], support: { requirement: 0.1, graph: 0, dialogue: 0, construct: 0, outcome: 0 } }
    ],
    cognitiveProposals: [
      { id: "cognitive_proposal:26c95d6a", quality: { score: 0.79, mmr: 0.84, diversity: 1 }, satisfiedRequirementIds: ["requirement.source_citation"], missedRequirementIds: [] }
    ],
    selectedCandidate: {
      id: "proof:proof_c0329f1c:350:d943fb15",
      kind: "proof-answer",
      proposalId: "cognitive_proposal:26c95d6a",
      scores: { support: 0.91, contradiction: 0.02, faithfulness: 0.88, alphaPressure: 0.3, evidenceCoverage: 1, novelty: 0.1, realizability: 0.86 },
      quality: { truthSupport: 1, coherence: 0.9, directness: 0.9, repetition: 0 }
    },
    judge: { rows: [{ candidateId: "proof:proof_c0329f1c:350:d943fb15", score: 0.78 }] },
    mouth: { trace: { selected: { id: "surface.1", surfaceRealizationId: "surface.realization.9f" } } },
    entailment: {
      claim: { id: "claim_6c0f082b" },
      proof: { id: "proof_c0329f1c" },
      support: 0.91,
      contradiction: 0.02,
      faithfulnessLcb: 0.74,
      confidence: 0.8,
      scores: { support: 0.91 },
      obligations: [{ id: "obligation.subject", status: "satisfied" }],
      mappings: [{ id: "relation.capital_of", status: "bound" }, { id: "relation.largest_city", status: "missing" }],
      transforms: [{ id: "transform.identity" }],
      counterexamples: [],
      missing: []
    },
    field: {
      seeds: [{ nodeId: "node_aaa", feature: "kenya", weight: 1 }],
      active: [{ nodeId: "node_145cc4d1", activation: 0.53 }, { nodeId: "node_0887376d", activation: 0.14 }],
      ppf: [{ nodeId: "node_145cc4d1", mass: 0.4 }]
    },
    retrievalRoles: [{ evidenceId: "evidence_span.3cfead17", nodeId: "node_145cc4d1", role: "anchor", score: 0.66, scoreTraces: [], reason: "title-lead" }],
    evidenceIds: ["evidence_span.3cfead17"],
    timing: { budgetExceeded: [] },
    createdAt: 1_789_586_862_681,
    ...overrides
  };
}

describe("cognitive credit record", () => {
  it("reconstructs both chains end to end, each stage naming what the next one produced", () => {
    const record = buildCognitiveCreditRecord(turnView());
    const byStage = new Map(record.stages.map(stage => [stage.stageId, stage]));

    // surface -> candidate -> proposal -> operator -> requirement -> activations
    expect(byStage.get(CREDIT_STAGE_IDS.surface)!.upstreamIds).toEqual(byStage.get(CREDIT_STAGE_IDS.candidate)!.ids);
    expect(byStage.get(CREDIT_STAGE_IDS.candidate)!.upstreamIds).toEqual(byStage.get(CREDIT_STAGE_IDS.proposal)!.ids);
    expect(byStage.get(CREDIT_STAGE_IDS.proposal)!.upstreamIds).toEqual(byStage.get(CREDIT_STAGE_IDS.operator)!.ids);
    expect(byStage.get(CREDIT_STAGE_IDS.requirement)!.upstreamIds).toEqual(byStage.get(CREDIT_STAGE_IDS.activation)!.ids);

    // answer fact -> proof -> relation -> activated region -> retrieval decision
    expect(byStage.get(CREDIT_STAGE_IDS.answerFact)!.upstreamIds).toEqual(byStage.get(CREDIT_STAGE_IDS.proof)!.ids);
    expect(byStage.get(CREDIT_STAGE_IDS.proof)!.upstreamIds.every(id => byStage.get(CREDIT_STAGE_IDS.relation)!.ids.includes(id))).toBe(true);
    expect(byStage.get(CREDIT_STAGE_IDS.relation)!.upstreamIds).toEqual(byStage.get(CREDIT_STAGE_IDS.activatedRegion)!.ids);
    expect(byStage.get(CREDIT_STAGE_IDS.activatedRegion)!.upstreamIds.every(id => byStage.get(CREDIT_STAGE_IDS.retrieval)!.ids.includes(id))).toBe(true);

    expect(record.stages.filter(stage => stage.chainId === CREDIT_CHAIN_IDS.surfaceToActivation)).toHaveLength(7);
    expect(record.stages.filter(stage => stage.chainId === CREDIT_CHAIN_IDS.factToRetrieval)).toHaveLength(5);
    expect(record.stages.every(stage => stage.reached)).toBe(true);
  });

  /**
   * The defect this record exists to fix: production wrote candidate.mass with sourceRecordId set to a
   * content-hashed candidate id ("proof:proof_c0329f1c:350:d943fb15"), a value 92 different turns shared, so
   * no observation could be attributed to a turn. Every credit row keys on the episode id instead.
   */
  it("keys every stage row on the episode id, the key events and response_candidate_records already use", () => {
    const record = buildCognitiveCreditRecord(turnView());
    const rows = cognitiveCreditObservations(record);
    expect(rows).toHaveLength(13);
    expect(rows.every(row => row.sourceRecordId === EPISODE)).toBe(true);
    const candidateId = String((turnView().selectedCandidate as Record<string, unknown>).id);
    expect(rows.some(row => row.sourceRecordId === candidateId)).toBe(false);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  });

  it("gives every stage its own calibration id, so a fit can ask one stage at a time", () => {
    const rows = cognitiveCreditStageObservations(buildCognitiveCreditRecord(turnView()));
    const ids = rows.map(row => row.calibrationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(CALIBRATION_IDS.retrievalHybridRecall);
    expect(ids).toContain(CALIBRATION_IDS.operatorOutcome);
    expect(ids).toContain(CALIBRATION_IDS.requirementFieldInference);
    expect(ids).toContain(CALIBRATION_IDS.proposalSelection);
    expect(ids).toContain(CALIBRATION_IDS.relationComposition);
    for (const row of rows) {
      const metadata = row.metadata as Record<string, unknown>;
      expect(metadata.episodeId).toBe(EPISODE);
      expect(typeof metadata.stageId).toBe("string");
      expect(metadata.decidingQuantities && typeof metadata.decidingQuantities).toBe("object");
      // Data, never prose: every deciding quantity is a number.
      expect(Object.values(metadata.decidingQuantities as Record<string, unknown>).every(value => typeof value === "number")).toBe(true);
    }
  });

  it("labels an unsupervised runtime outcome as unsupervised and never as a grade", () => {
    const record = buildCognitiveCreditRecord(turnView());
    expect(record.outcome.source).toBe(CREDIT_OUTCOME_SOURCE_IDS.runtimeSignal);
    expect(record.outcome.supervised).toBe(false);
    expect(record.outcome.graded).toBeNull();
    // Watching itself yields a measured quality, never a class: one turn has no population to split against.
    expect(record.outcome.label).toBe("outcome.unknown");
    // One obligation, satisfied, against the candidate's 0.02 contradiction: mean(1, 0.98).
    expect(record.outcome.reward).toBeCloseTo(0.99, 6);

    const withheld = buildCognitiveCreditRecord(turnView({ answer: "", withheld: { reason: "no_admissible_surface" } }));
    expect(withheld.outcome.reward).toBe(0);
    expect(withheld.outcome.signals.spoke).toBe(false);
    expect(withheld.outcome.signals.withheld).toBe(true);

    // An acquisition motion a gate refused is not a replan, and the turn's reward must not move for it.
    const refused = buildCognitiveCreditRecord(turnView({ runtimeMotion: { status: "awaiting_consent" } }));
    expect(refused.outcome.signals.replanned).toBe(false);
    expect(refused.outcome.reward).toBe(record.outcome.reward);
  });

  it("takes a grader's verdict as a separate, supervised label without overwriting the unsupervised rows", () => {
    const record = buildCognitiveCreditRecord(turnView());
    const graded = withGradedOutcome(record, { suiteId: "suite.capitals", itemId: "kenya", verdict: "wrong", declined: false });
    expect(graded.outcome.source).toBe(CREDIT_OUTCOME_SOURCE_IDS.graded);
    expect(graded.outcome.supervised).toBe(true);
    expect(graded.outcome.label).toBe("outcome.negative");
    // The runtime's own signals survive the stamp; the grade is added, not substituted for them.
    expect(graded.outcome.signals).toEqual(record.outcome.signals);
    const before = cognitiveCreditStageObservations(record);
    const after = cognitiveCreditStageObservations(graded);
    expect(after.every(row => !before.some(prior => prior.id === row.id))).toBe(true);
    expect(after.every(row => row.outcome === false)).toBe(true);

    const correct = withGradedOutcome(record, { suiteId: "suite.capitals", itemId: "kenya", verdict: "correct", declined: false });
    expect(correct.outcome.label).toBe("outcome.positive");
  });

  it("survives a restart: the persisted row rebuilds the record with both chains intact", () => {
    const record = buildCognitiveCreditRecord(turnView());
    const row = cognitiveCreditObservation(record);
    expect(row.calibrationId).toBe(CALIBRATION_IDS.turnCognitiveCredit);
    const rehydrated = JSON.parse(JSON.stringify(row.metadata)) as typeof record;
    expect(rehydrated.schema).toBe(COGNITIVE_CREDIT_SCHEMA);
    expect(rehydrated.episodeId).toBe(EPISODE);
    expect(rehydrated.stages.map(stage => stage.stageId)).toEqual(record.stages.map(stage => stage.stageId));
    expect(cognitiveCreditStageObservations(rehydrated).map(item => item.id)).toEqual(cognitiveCreditStageObservations(record).map(item => item.id));
  });

  it("records a stage the turn never reached rather than leaving a silent gap", () => {
    const record = buildCognitiveCreditRecord(turnView({ retrievalRoles: [], evidenceIds: [], field: { seeds: [], active: [], ppf: [] } }));
    const byStage = new Map(record.stages.map(stage => [stage.stageId, stage]));
    expect(byStage.get(CREDIT_STAGE_IDS.retrieval)!.reached).toBe(false);
    expect(byStage.get(CREDIT_STAGE_IDS.activatedRegion)!.reached).toBe(false);
    expect(byStage.get(CREDIT_STAGE_IDS.candidate)!.reached).toBe(true);
    // The unreached stages still produce rows, so "retrieval found nothing" is a queryable fact.
    expect(cognitiveCreditStageObservations(record)).toHaveLength(12);
  });
});
