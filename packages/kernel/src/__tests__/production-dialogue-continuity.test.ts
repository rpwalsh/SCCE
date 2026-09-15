import { describe, expect, it } from "vitest";
import {
  createDiscoursePlanningHandoffV2,
  deriveDialogueCognitiveStateIdV2,
  type DialogueCognitiveStateV2
} from "../discourse-state.js";
import { createHasher } from "../primitives.js";
import { typedDialoguePreselectionV2 } from "../production-turn-runtime.js";
import { createDialogueCognitiveMemoryV2 } from "../dialogue-cognitive-memory.js";
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";

describe("production dialogue continuity", () => {
  it("keeps a typed expansion handoff causal across a cold restart", async () => {
    const state = cognitiveState();
    const store = createInMemoryDialogueMemoryStore();
    const warmMemory = createDialogueCognitiveMemoryV2({ store, hasher: createHasher() });
    await warmMemory.persist(state, 10, null);
    const warm = createDiscoursePlanningHandoffV2({
      state,
      dialogueDependence: 0.86,
      inferentialDepth: 0.8
    });
    // A fresh memory instance models a process restart; only the durable
    // interaction-state record is available to rebuild the handoff.
    const coldMemory = createDialogueCognitiveMemoryV2({ store, hasher: createHasher() });
    const coldState = await coldMemory.latest(state.conversationId);
    const cold = createDiscoursePlanningHandoffV2({
      state: coldState,
      dialogueDependence: 0.86,
      inferentialDepth: 0.8
    });

    expect(cold).toEqual(warm);
    expect(cold?.expansionMass).toBeGreaterThanOrEqual(0.72);
    expect(createDiscoursePlanningHandoffV2({ state: undefined })).toBeUndefined();
  });

  it("resolves a restored referent by stable evidence when graph node ids are new", () => {
    const state = cognitiveState();
    const result = typedDialoguePreselectionV2({
      conversationId: state.conversationId,
      turnId: "turn.followup",
      turnIndex: 2,
      roleId: "session.role.owner",
      surfaceHash: "hash.followup",
      requirementField: {
        requiredFeatures: [],
        activatedFrameIds: ["frame.explain"],
        activatedPatternIds: [],
        activatedPhraseUnitIds: [],
        activatedDialogueMoveIds: [],
        activatedConstructIds: []
      } as never,
      entailment: {
        evidenceIds: ["evidence.prior"],
        mappings: [{
          id: "mapping.followup",
          obligationId: "slot.explanation",
          kind: "claim",
          claimText: "typed claim",
          evidenceIds: ["evidence.prior"],
          sourceVersionIds: ["source.prior"]
        }]
      } as never,
      graph: {
        nodes: [{ id: "node.rehydrated", evidenceIds: ["evidence.prior"] }]
      } as never,
      selectedEvidence: [{ id: "evidence.prior", sourceVersionId: "source.prior" }] as never,
      previousState: state,
      hasher: createHasher()
    });

    expect(result.observation.mentions[0]?.candidateReferentIds).toEqual(["referent.prior"]);
    expect(result.candidates[0]?.referentId).toBe("referent.prior");
  });
});

function cognitiveState(): DialogueCognitiveStateV2 {
  const content: Omit<DialogueCognitiveStateV2, "schema" | "id" | "audit"> = {
    conversationId: "conversation.continuity",
    observationId: "observation.prior",
    turnId: "turn.prior",
    turnIndex: 1,
    activeTopicIds: ["topic.prior"],
    referents: [{
      schema: "scce.discourse_referent.v2",
      id: "referent.prior",
      topicId: "topic.prior",
      introducedTurnId: "turn.prior",
      introducedTurnIndex: 1,
      lastMentionTurnIndex: 1,
      nodeIds: ["node.prior"],
      claimIds: ["claim.prior"],
      relationIds: ["relation.prior"],
      evidenceIds: ["evidence.prior"],
      sourceVersionIds: ["source.prior"],
      contradictionIds: [],
      semanticRoleIds: ["role.subject"],
      learnedFrameIds: ["frame.prior"],
      scopeIds: [],
      slotBindings: [{ slotId: "slot.prior", nodeIds: ["node.prior"], claimIds: ["claim.prior"], evidenceIds: ["evidence.prior"] }],
      salienceMass: 0.9,
      evidenceSupportMass: 0.9,
      contradictionMass: 0,
      authorityClassId: "authority.direct"
    }],
    topics: [{
      schema: "scce.discourse_topic.v2",
      id: "topic.prior",
      statusId: "topic.active",
      anchorNodeIds: ["node.prior"],
      referentIds: ["referent.prior"],
      claimIds: ["claim.prior"],
      evidenceIds: ["evidence.prior"],
      supersedesTopicIds: [],
      salienceMass: 0.9,
      lastTurnIndex: 1
    }],
    bindings: [],
    unresolvedMentionIds: [],
    openSlotIds: ["slot.explanation"],
    preferenceSnapshotIds: [],
    correctionIds: [],
    historyDigestIds: ["observation.prior"],
    queryConcatenationUsed: false
  };
  return {
    schema: "scce.dialogue_cognitive_state.v2",
    id: deriveDialogueCognitiveStateIdV2(content),
    ...content,
    audit: {}
  };
}
