import { describe, expect, it } from "vitest";
import {
  createDiscourseProvenanceBindingV2,
  createDiscourseInterpretationAdjustmentV2,
  createDiscourseTurnObservationV2,
  dialogueInterpretationAdjustmentsForConversation,
  isDialogueCognitiveStateV2,
  resolveDiscourseStateV2,
  userCorrectionFromOutcome,
  createInMemoryDialogueMemoryStore
} from "../index.js";
import {
  applyDialogueInterpretationAdjustmentsV2,
  dialogueInterpretationAdjustmentsFromMetadata,
  typedDialoguePreselectionV2
} from "../production-turn-runtime.js";
import { createJudge } from "../judge.js";
import { DEFAULT_POLICY } from "../safety.js";
import { createHasher } from "../primitives.js";
import type { EvidenceSpan, GraphSnapshot, JsonValue, TurnResult } from "../types.js";
import type { CandidateField } from "../candidate.js";
import type { ConversationOutcomeRecord } from "../storage.js";
import type { DiscourseReferentV2, DiscourseTopicV2, DiscourseInterpretationAdjustmentV2 } from "../discourse-state.js";
import type { TurnRequirementField } from "../turn-requirements.js";

describe("causal dialogue interpretation feedback", () => {
  it("moves a typed interpretation on a novel turn after correction persistence and reload", async () => {
    const first = resolveTurn("mention.first", 1);
    expect(first.state.bindings[0]?.referentId).toBe("referent.a");

    const outcome: ConversationOutcomeRecord = {
      id: "conversation_outcome.feedback",
      conversationId: "conversation.feedback",
      turnId: "turn.first",
      promptHash: "prompt.first",
      responseHash: "response.first",
      corrected: true,
      requestedConstraintRefs: [],
      satisfiedConstraintRefs: [],
      failedConstraintRefs: [],
      scoreTraceRefs: [],
      createdAt: new Date(10).toISOString()
    };
    const correction = userCorrectionFromOutcome({
      outcome,
      correctionText: "The second referent was intended for this typed role.",
      interpretationCorrection: {
        semanticRoleIds: ["role.event.argument"],
        requestedSlotIds: ["slot.object"],
        learnedFrameIds: ["frame.event"],
        scopeIds: ["scope.local"],
        rejectedReferentIds: ["referent.a"],
        preferredReferentIds: ["referent.b"],
        supportMass: 0.95,
        contradictionMass: 0.95
      },
      now: 11
    });
    const beforeReload = createInMemoryDialogueMemoryStore();
    await beforeReload.putUserCorrection(correction);
    const reloaded = createInMemoryDialogueMemoryStore({
      corrections: await beforeReload.listUserCorrections!({ conversationId: outcome.conversationId })
    });
    const adjustments = await dialogueInterpretationAdjustmentsForConversation(reloaded, outcome.conversationId);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.preferredReferentIds).toEqual(["referent.b"]);

    const withCorrection = resolveTurn("mention.novel", 2, first.state, adjustments);
    const withheld = resolveTurn("mention.novel.withheld", 2, first.state);
    expect(withheld.state.bindings[0]?.referentId).toBe("referent.a");
    expect(withCorrection.state.bindings[0]?.referentId).toBe("referent.b");

    const unrelated = resolveTurn("mention.unrelated", 2, first.state, adjustments, {
      role: "role.different",
      frame: "frame.different",
      slot: "slot.different",
      scope: "scope.different"
    });
    expect(unrelated.state.bindings[0]?.referentId).toBe("referent.a");
  });

  it("changes the production candidate and answer only for a matching proof-bearing typed route", async () => {
    const first = resolveTurn("mention.first", 1);
    const outcome: ConversationOutcomeRecord = {
      id: "conversation_outcome.production_feedback",
      conversationId: "conversation.feedback",
      turnId: "turn.first",
      promptHash: "prompt.first",
      responseHash: "response.first",
      corrected: true,
      requestedConstraintRefs: [],
      satisfiedConstraintRefs: [],
      failedConstraintRefs: [],
      scoreTraceRefs: [],
      createdAt: new Date(10).toISOString()
    };
    const correction = userCorrectionFromOutcome({
      outcome,
      correctionText: "The second typed referent was intended.",
      interpretationCorrection: {
        semanticRoleIds: ["role.event.argument"],
        requestedSlotIds: ["slot.object"],
        learnedFrameIds: ["frame.event"],
        scopeIds: ["scope.local"],
        rejectedReferentIds: ["referent.a"],
        preferredReferentIds: ["referent.b"],
        supportMass: 0.95,
        contradictionMass: 0.95
      },
      now: 11
    });
    const durable = createInMemoryDialogueMemoryStore({ corrections: [correction] });
    const reloaded = createInMemoryDialogueMemoryStore({
      corrections: await durable.listUserCorrections!({ conversationId: outcome.conversationId })
    });
    const adjustments = (await dialogueInterpretationAdjustmentsForConversation(reloaded, outcome.conversationId)) as DiscourseInterpretationAdjustmentV2[];
    const persistedAdjustmentId = adjustments[0]!.id;
    const unrelatedLoadedAdjustment = createDiscourseInterpretationAdjustmentV2({
      semanticRoleIds: ["role.unrelated"],
      requestedSlotIds: ["slot.unrelated"],
      learnedFrameIds: ["frame.unrelated"],
      scopeIds: ["scope.unrelated"],
      rejectedReferentIds: ["referent.a"],
      preferredReferentIds: ["referent.b"],
      supportMass: 1,
      contradictionMass: 1,
      correctionIds: ["correction.unrelated"]
    });

    const matching = productionSelection(first.state, [...adjustments, unrelatedLoadedAdjustment]);
    const withheld = productionSelection(first.state, []);
    const unrelated = productionSelection(first.state, adjustments, {
      role: "role.unrelated",
      frame: "frame.unrelated",
      slot: "slot.unrelated",
      scope: "scope.unrelated"
    });
    const partial = productionSelection(first.state, adjustments, {
      role: "role.event.argument",
      frame: "frame.unrelated",
      slot: "slot.object",
      scope: "scope.unrelated"
    });

    expect(matching.selected.id).toBe("candidate.b");
    expect(matching.selected.answer).toBe("answer B");
    expect(matching.selected.selectionAdjustment).toBeGreaterThan(0);
    expect(matching.selected.audit).toMatchObject({
      typedDialogueSelection: { adjustmentIds: [persistedAdjustmentId] }
    });
    expect(matching.preselection.observation).toMatchObject({
      learnedFrameIds: ["frame.event"],
      mentions: [{ semanticRoleIds: ["role.event.argument"], learnedFrameIds: ["frame.event"], requestedSlotIds: ["slot.object"], scopeIds: ["scope.local"] }]
    });
    expect(matching.preselection.candidates.map(candidate => candidate.proofEvidenceIds)).toEqual([["evidence.a"], ["evidence.b"]]);
    expect(matching.preselection.candidates.map(candidate => candidate.referentId)).toEqual(["referent.a", "referent.b"]);
    expect(withheld.selected.id).toBe("candidate.a");
    expect(unrelated.selected.id).toBe("candidate.a");
    expect(partial.selected.id).toBe("candidate.a");
  });

  it("retains the newest 128 persisted corrections in chronological order", async () => {
    const corrections = Array.from({ length: 130 }, (_, index) => userCorrectionFromOutcome({
      outcome: {
        id: `conversation_outcome.overflow.${index}`,
        conversationId: "conversation.overflow",
        turnId: `turn.${index}`,
        promptHash: `prompt.${index}`,
        responseHash: `response.${index}`,
        requestedConstraintRefs: [],
        satisfiedConstraintRefs: [],
        failedConstraintRefs: [],
        scoreTraceRefs: [],
        createdAt: new Date(index).toISOString()
      },
      correctionText: `typed correction ${index}`,
      interpretationCorrection: {
        semanticRoleIds: ["role.overflow"],
        requestedSlotIds: ["slot.overflow"],
        learnedFrameIds: ["frame.overflow"],
        scopeIds: ["scope.overflow"],
        rejectedReferentIds: [`referent.rejected.${index}`],
        preferredReferentIds: [`referent.preferred.${index}`],
        supportMass: 0.5,
        contradictionMass: 0.5
      },
      now: index + 1
    }));
    const store = createInMemoryDialogueMemoryStore({ corrections });
    const adjustments = await dialogueInterpretationAdjustmentsForConversation(store, "conversation.overflow");

    expect(adjustments).toHaveLength(128);
    expect(adjustments[0]?.preferredReferentIds).toEqual(["referent.preferred.2"]);
    expect(adjustments.at(-1)?.preferredReferentIds).toEqual(["referent.preferred.129"]);
    expect(adjustments.map(adjustment => adjustment.preferredReferentIds[0])).toEqual(
      Array.from({ length: 128 }, (_, index) => `referent.preferred.${index + 2}`)
    );
  });

  it("preserves correction recency when production metadata refreshes an existing adjustment", () => {
    const earlier = createDiscourseInterpretationAdjustmentV2({
      ...interpretationCorrection("referent.earlier"),
      correctionIds: ["correction.earlier"]
    });
    const later = createDiscourseInterpretationAdjustmentV2({
      ...interpretationCorrection("referent.later"),
      correctionIds: ["correction.later"]
    });
    const previousState = {
      ...resolveTurn("mention.metadata", 1).state,
      interpretationAdjustments: [earlier, later]
    };

    const merged = dialogueInterpretationAdjustmentsFromMetadata({
      dialogue: { interpretationAdjustments: [earlier] }
    } as unknown as JsonValue, previousState);

    expect(merged.map(adjustment => adjustment.id)).toEqual([later.id, earlier.id]);
  });

  it("preserves legacy preference JSON and wraps it explicitly when adding typed feedback", () => {
    const outcome = feedbackOutcome("conversation_outcome.legacy", "conversation.legacy");
    const arrayDelta = userCorrectionFromOutcome({
      outcome,
      correctionText: "legacy array",
      preferenceDelta: ["legacy", 3]
    });
    expect(arrayDelta.preferenceDeltaJson).toEqual(["legacy", 3]);

    const primitiveDelta = userCorrectionFromOutcome({
      outcome: { ...outcome, id: "conversation_outcome.legacy.typed" },
      correctionText: "legacy primitive with typed feedback",
      preferenceDelta: 7,
      interpretationCorrection: interpretationCorrection("referent.preferred")
    });
    expect(primitiveDelta.preferenceDeltaJson).toMatchObject({
      legacyPreferenceDelta: 7,
      interpretationAdjustment: { schema: "scce.discourse_interpretation_adjustment.v2" }
    });
  });

  it("validates default-hashed adjustments independently of a custom state hasher", () => {
    const adjustment = userCorrectionFromOutcome({
      outcome: feedbackOutcome("conversation_outcome.custom_hasher", "conversation.custom_hasher"),
      correctionText: "typed custom state hasher correction",
      interpretationCorrection: interpretationCorrection("referent.custom")
    });
    const storedAdjustment = (adjustment.preferenceDeltaJson as Record<string, unknown>).interpretationAdjustment as DiscourseInterpretationAdjustmentV2;
    const customStateHasher = {
      digestHex(input: string | Uint8Array) {
        return `custom.${createHasher().digestHex(input)}`;
      }
    };
    const resolved = resolveTurn("mention.custom.hasher", 1, undefined, [storedAdjustment], undefined, customStateHasher);

    expect(resolved.state.interpretationAdjustments).toEqual([storedAdjustment]);
    expect(isDialogueCognitiveStateV2(resolved.state, customStateHasher)).toBe(true);
  });
});

function feedbackOutcome(id: string, conversationId: string): ConversationOutcomeRecord {
  return {
    id,
    conversationId,
    turnId: `${id}.turn`,
    promptHash: `${id}.prompt`,
    responseHash: `${id}.response`,
    requestedConstraintRefs: [],
    satisfiedConstraintRefs: [],
    failedConstraintRefs: [],
    scoreTraceRefs: [],
    createdAt: new Date(10).toISOString()
  };
}

function interpretationCorrection(preferredReferentId: string) {
  return {
    semanticRoleIds: ["role.custom"],
    requestedSlotIds: ["slot.custom"],
    learnedFrameIds: ["frame.custom"],
    scopeIds: ["scope.custom"],
    rejectedReferentIds: ["referent.rejected"],
    preferredReferentIds: [preferredReferentId],
    supportMass: 0.7,
    contradictionMass: 0.6
  };
}

function productionSelection(
  previousState: ReturnType<typeof resolveDiscourseStateV2>["state"],
  adjustments: readonly DiscourseInterpretationAdjustmentV2[],
  ids = { role: "role.event.argument", frame: "frame.event", slot: "slot.object", scope: "scope.local" }
) {
  const selectedEvidence = [evidence("evidence.a", "Source A proof.", ids.scope), evidence("evidence.b", "Source B proof.", ids.scope)];
  const requirementField = requirementFieldFor(ids);
  const entailment = {
    mappings: [{
      id: "mapping.typed",
      obligationId: ids.slot,
      kind: "role",
      status: "satisfied",
      claimText: "typed claim",
      relation: "role_path",
      evidenceIds: ["evidence.a", "evidence.b"],
      sourceVersionIds: [ids.scope],
      support: 0.9,
      contradiction: 0,
      audit: {}
    }],
    evidenceIds: ["evidence.a", "evidence.b"]
  } as unknown as TurnResult["entailment"];
  const graph = {
    nodes: [
      graphNode("node.a", "evidence.a"),
      graphNode("node.b", "evidence.b")
    ],
    edges: [],
    hyperedges: []
  } as unknown as GraphSnapshot;
  const preselection = typedDialoguePreselectionV2({
    conversationId: "conversation.feedback",
    turnId: "turn.novel",
    turnIndex: 2,
    roleId: "session.role.owner",
    surfaceHash: "surface.novel",
    requirementField,
    entailment,
    graph,
    selectedEvidence,
    previousState,
    hasher: createHasher()
  });
  const field: CandidateField = {
    candidates: [candidate("candidate.a", "answer A", "evidence.a"), candidate("candidate.b", "answer B", "evidence.b")],
    surfaceMass: [
      { candidateId: "candidate.a", mass: 0.5, reason: "fixture" },
      { candidateId: "candidate.b", mass: 0.5, reason: "fixture" }
    ],
    audit: {},
    scoreTrace: []
  };
  const adjusted = applyDialogueInterpretationAdjustmentsV2({ field, candidates: preselection.candidates, adjustments });
  return {
    ...createJudge({ random: () => 0 }).select({ field: adjusted, policy: DEFAULT_POLICY, requestedAuthority: "factual", requirementField }),
    preselection
  };
}

function requirementFieldFor(ids: { role: string; frame: string; slot: string; scope: string }): TurnRequirementField {
  return {
    externalTruthAuthority: 0.5,
    sourceDependence: 0.5,
    noveltyDemand: 0,
    inferentialDepth: 0,
    semanticPreservation: 0,
    surfaceTransformation: 0,
    executableArtifactDemand: 0,
    actionCommitment: 0,
    dialogueDependence: 0.5,
    uncertaintyTolerance: 0.5,
    formatConstraintStrength: 0,
    audienceAdaptation: 0,
    brevityDetailBalance: 0.5,
    temporalReasoningDemand: 0,
    causalReasoningDemand: 0,
    counterfactualDemand: 0,
    requiredFeatures: [{ origin: { semanticRoleId: ids.role } } as never],
    prohibitedFeatures: [],
    activatedFrameIds: [ids.frame],
    activatedPatternIds: [],
    activatedPhraseUnitIds: [],
    activatedDialogueMoveIds: [],
    activatedConstructIds: [],
    confidence: 1,
    trace: {}
  };
}

function candidate(id: string, answer: string, evidenceId: string) {
  return {
    id,
    kind: "proof-answer" as const,
    answer,
    force: "proved" as const,
    evidenceIds: [evidenceId as EvidenceSpan["id"]],
    scores: {
      support: 0.7,
      contradiction: 0,
      faithfulness: 0.8,
      alphaPressure: 0,
      actionability: 0.7,
      evidenceCoverage: 0.8,
      novelty: 0.2,
      realizability: 0.8
    },
    boundaries: [],
    audit: {}
  };
}

function evidence(id: string, text: string, sourceVersionId: string): EvidenceSpan {
  return { id, sourceId: `source.${id}`, sourceVersionId, chunkId: `chunk.${id}`, contentHash: `hash.${id}`, mediaType: "text/plain", byteStart: 0, byteEnd: text.length, charStart: 0, charEnd: text.length, text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [id], status: "promoted", alpha: 0.9, observedAt: 1 } as unknown as EvidenceSpan;
}

function graphNode(id: string, evidenceId: string) {
  return { id, typeId: "dimension.fixture", representation: {}, alpha: 0.9, evidenceIds: [evidenceId], features: [id], createdAt: 1, updatedAt: 1, metadata: {} };
}

function resolveTurn(
  mentionId: string,
  turnIndex: number,
  previousState?: ReturnType<typeof resolveDiscourseStateV2>["state"],
  interpretationAdjustments: Parameters<typeof resolveDiscourseStateV2>[0]["interpretationAdjustments"] = [],
  ids = { role: "role.event.argument", frame: "frame.event", slot: "slot.object", scope: "scope.local" },
  hasher = createHasher()
) {
  const observation = createDiscourseTurnObservationV2({
    conversationId: "conversation.feedback",
    turnId: `turn.${mentionId}`,
    turnIndex,
    roleId: "session.role.owner",
    surfaceHash: `surface.${mentionId}`,
    learnedFrameIds: [ids.frame],
    requestedSlotIds: [ids.slot],
    explicitAnchorNodeIds: [],
    scopeIds: [ids.scope],
    mentions: [
      {
        schema: "scce.discourse_mention.v2",
        id: mentionId,
        span: { start: 0, end: 6 },
        kindId: "mention.typed",
        surfaceHash: `mention.${mentionId}`,
        semanticRoleIds: [ids.role],
        requestedSlotIds: [ids.slot],
        learnedFrameIds: [ids.frame],
        candidateNodeIds: [],
        candidateReferentIds: ["referent.a", "referent.b"],
        scopeIds: [ids.scope]
      }
    ]
  }, hasher);
  const referents = [referent("referent.a", "node.a", "claim.a"), referent("referent.b", "node.b", "claim.b")];
  const topics = [topic("topic.a", "referent.a", "node.a", "claim.a"), topic("topic.b", "referent.b", "node.b", "claim.b")];
  const provenanceBindings = referents.map(item => createDiscourseProvenanceBindingV2({
    observationId: observation.id,
    mentionId,
    referentId: item.id,
    routeId: `route.${item.id}`,
    nodeIds: item.nodeIds,
    claimIds: item.claimIds,
    evidenceIds: item.evidenceIds,
    sourceVersionIds: item.sourceVersionIds,
    contradictionIds: []
  }, hasher));
  return resolveDiscourseStateV2({
    observation,
    previousState,
    referents,
    topics,
    interpretationAdjustments,
    routeSignals: referents.map(item => ({ mentionId, referentId: item.id, graphRouteCoherence: 1, evidenceFit: 1, scopeFit: 1 })),
    provenanceBindings,
    hasher
  });
}

function referent(id: string, nodeId: string, claimId: string): DiscourseReferentV2 {
  return {
    schema: "scce.discourse_referent.v2",
    id,
    topicId: id.replace("referent", "topic"),
    introducedTurnId: "turn.first",
    introducedTurnIndex: 1,
    lastMentionTurnIndex: 1,
    nodeIds: [nodeId],
    claimIds: [claimId],
    relationIds: ["relation.event"],
    evidenceIds: [`evidence.${id}`],
    sourceVersionIds: [`source.${id}`],
    contradictionIds: [],
    semanticRoleIds: ["role.event.argument"],
    learnedFrameIds: ["frame.event"],
    scopeIds: ["scope.local"],
    slotBindings: [{ slotId: "slot.object", nodeIds: [nodeId], claimIds: [claimId], evidenceIds: [`evidence.${id}`] }],
    salienceMass: 0.7,
    evidenceSupportMass: 0.9,
    contradictionMass: 0,
    authorityClassId: "authority.source"
  };
}

function topic(id: string, referentId: string, nodeId: string, claimId: string): DiscourseTopicV2 {
  return {
    schema: "scce.discourse_topic.v2",
    id,
    statusId: "topic.active",
    anchorNodeIds: [nodeId],
    referentIds: [referentId],
    claimIds: [claimId],
    evidenceIds: [`evidence.${referentId}`],
    supersedesTopicIds: [],
    salienceMass: 0.7,
    lastTurnIndex: 1
  };
}
