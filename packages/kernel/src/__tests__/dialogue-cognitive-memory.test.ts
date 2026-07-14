import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import {
  createDiscourseProvenanceBindingV2,
  deriveDialogueCognitiveStateIdV2
} from "../discourse-state.js";
import {
  createDialogueCognitiveMemoryV2,
  dialogueCognitiveStateFromInteractionRecordV2,
  dialogueCognitiveStateInteractionRecordV2
} from "../dialogue-cognitive-memory.js";
import type { DialogueCognitiveStateV2 } from "../discourse-state.js";
import type { InteractionStateRecord } from "../storage.js";
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";

describe("durable dialogue cognitive memory v2", () => {
  it("round-trips a content-bound state without query concatenation", () => {
    const state = cognitiveState();
    const record = dialogueCognitiveStateInteractionRecordV2({ state, createdAt: 7, hasher: createHasher() });

    expect(dialogueCognitiveStateFromInteractionRecordV2(record, createHasher())).toEqual(state);
    expect(record.featureRefs).toContain("노드.01");
    expect(record.signalRefs).toContain("binding.01");
    expect((record.stateJson as { queryConcatenationUsed: boolean }).queryConcatenationUsed).toBe(false);
  });

  it("rejects altered identity, routing receipts, and concatenating state", () => {
    const record = dialogueCognitiveStateInteractionRecordV2({ state: cognitiveState(), createdAt: 7, hasher: createHasher() });

    expect(dialogueCognitiveStateFromInteractionRecordV2({ ...record, turnId: "turn.other" }, createHasher())).toBeUndefined();
    expect(dialogueCognitiveStateFromInteractionRecordV2({ ...record, featureRefs: [] }, createHasher())).toBeUndefined();
    expect(dialogueCognitiveStateFromInteractionRecordV2({
      ...record,
      stateJson: { ...(record.stateJson as Record<string, unknown>), queryConcatenationUsed: true } as never
    }, createHasher())).toBeUndefined();
  });

  it("persists and loads the newest valid state while skipping corrupt rows", async () => {
    const rows: InteractionStateRecord[] = [];
    const memory = createDialogueCognitiveMemoryV2({
      hasher: createHasher(),
      store: {
        async compareAndPutInteractionState(record, condition) {
          rows.unshift(record);
          return { stored: true, currentStateId: condition.nextStateId, currentTurnIndex: condition.nextTurnIndex, reason: "stored" };
        },
        async listInteractionStates(query) {
          return rows.filter(row => !query?.conversationId || row.conversationId === query.conversationId)
            .slice(0, query?.limit);
        }
      }
    });
    const state = cognitiveState();
    await memory.persist(state, 7, null);
    rows.unshift({ ...rows[0]!, id: "corrupt" });

    await expect(memory.latest(state.conversationId)).resolves.toEqual(state);
  });

  it("rejects a stale predecessor without replacing the current state", async () => {
    const store = createInMemoryDialogueMemoryStore();
    const memory = createDialogueCognitiveMemoryV2({ hasher: createHasher(), store });
    const first = cognitiveState();
    const second = cognitiveState({ turnId: "turn.02", turnIndex: 2 });
    const stale = cognitiveState({ turnId: "turn.03", turnIndex: 3 });

    expect((await memory.persist(first, 7, null)).result).toMatchObject({ stored: true, currentTurnIndex: 1 });
    expect((await memory.persist(second, 8, first)).result).toMatchObject({ stored: true, currentTurnIndex: 2 });
    expect((await memory.persist(stale, 9, first)).result).toMatchObject({
      stored: false,
      currentStateId: second.id,
      currentTurnIndex: 2,
      reason: "state_conflict"
    });
    await expect(memory.latest(first.conversationId)).resolves.toEqual(second);
  });

  it("selects by durable timestamp when a store returns records out of order", async () => {
    const older = cognitiveState();
    const newer = cognitiveState({ turnId: "turn.02", turnIndex: 2 });
    const rows = [
      dialogueCognitiveStateInteractionRecordV2({ state: older, createdAt: 11, hasher: createHasher() }),
      dialogueCognitiveStateInteractionRecordV2({ state: newer, createdAt: 7, hasher: createHasher() }),
      {
        id: "interaction.dialogue.v1",
        conversationId: older.conversationId,
        turnId: "turn.v1",
        stateJson: { schema: "scce.dialogue.state.v1" },
        featureRefs: [],
        signalRefs: [],
        createdAt: 99
      }
    ];
    const memory = createDialogueCognitiveMemoryV2({
      hasher: createHasher(),
      store: {
        async compareAndPutInteractionState() { throw new Error("not used"); },
        async listInteractionStates() { return rows; }
      }
    });

    await expect(memory.latest(older.conversationId)).resolves.toEqual(newer);
  });

  it("uses durable timestamp only to break a valid equal-turn-index tie", async () => {
    const first = cognitiveState({ turnId: "turn.same-a", turnIndex: 4 });
    const second = cognitiveState({ turnId: "turn.same-b", turnIndex: 4 });
    const rows = [
      dialogueCognitiveStateInteractionRecordV2({ state: second, createdAt: 13, hasher: createHasher() }),
      dialogueCognitiveStateInteractionRecordV2({ state: first, createdAt: 7, hasher: createHasher() })
    ];
    const memory = createDialogueCognitiveMemoryV2({
      hasher: createHasher(),
      store: {
        async compareAndPutInteractionState() { throw new Error("not used"); },
        async listInteractionStates() { return rows; }
      }
    });

    await expect(memory.latest(first.conversationId)).resolves.toEqual(second);
  });

  it("rejects inconsistent referent, topic, binding, and turn links", () => {
    const valid = cognitiveState();
    const extraTopic = { ...valid.topics[0]!, id: "topic.extra", referentIds: [valid.referents[0]!.id] };
    const rejects = [
      reidentify({ ...valid, referents: [{ ...valid.referents[0]!, topicId: "topic.missing" }] }),
      reidentify({ ...valid, topics: [{ ...valid.topics[0]!, referentIds: [] }] }),
      reidentify({ ...valid, topics: [...valid.topics, extraTopic] }),
      reidentify({ ...valid, bindings: [{ ...valid.bindings[0]!, topicId: "topic.missing" }] }),
      reidentify({ ...valid, referents: [{ ...valid.referents[0]!, lastMentionTurnIndex: 2 }] }),
      reidentify({ ...valid, unresolvedMentionIds: ["mention.01"] }),
      { ...valid, id: "state.forged" }
    ];

    for (const state of rejects) {
      expect(() => dialogueCognitiveStateInteractionRecordV2({
        state: state as DialogueCognitiveStateV2,
        createdAt: 7,
        hasher: createHasher()
      })).toThrow("invalid dialogue cognitive state v2");
    }
  });
});

function cognitiveState(overrides: Partial<Pick<DialogueCognitiveStateV2, "turnId" | "turnIndex">> = {}): DialogueCognitiveStateV2 {
  const turnId = overrides.turnId ?? "turn.01";
  const turnIndex = overrides.turnIndex ?? 1;
  const observationId = `observation.${turnId}`;
  const referent: DialogueCognitiveStateV2["referents"][number] = {
      schema: "scce.discourse_referent.v2",
      id: "referent.01",
      topicId: "topic.01",
      introducedTurnId: turnId,
      introducedTurnIndex: 1,
      lastMentionTurnIndex: turnIndex,
      nodeIds: ["노드.01"],
      claimIds: ["claim.01"],
      relationIds: ["relation.01"],
      evidenceIds: ["evidence.01"],
      sourceVersionIds: ["source.01"],
      contradictionIds: [],
      semanticRoleIds: ["role.01"],
      learnedFrameIds: ["frame.01"],
      scopeIds: [],
      slotBindings: [{ slotId: "slot.01", nodeIds: ["노드.01"], claimIds: ["claim.01"], evidenceIds: ["evidence.01"] }],
      salienceMass: 0.8,
      evidenceSupportMass: 0.9,
      contradictionMass: 0,
      authorityClassId: "authority.01"
  };
  const provenance = createDiscourseProvenanceBindingV2({
    observationId,
    mentionId: "mention.01",
    referentId: referent.id,
    routeId: `route.${turnId}`,
    nodeIds: referent.nodeIds,
    claimIds: referent.claimIds,
    evidenceIds: referent.evidenceIds,
    sourceVersionIds: referent.sourceVersionIds,
    contradictionIds: referent.contradictionIds
  });
  const content: Omit<DialogueCognitiveStateV2, "schema" | "id" | "audit"> = {
    conversationId: "conversation.01",
    observationId,
    turnId,
    turnIndex,
    activeTopicIds: ["topic.01"],
    referents: [referent],
    topics: [{
      schema: "scce.discourse_topic.v2",
      id: "topic.01",
      statusId: "status.01",
      anchorNodeIds: ["노드.01"],
      referentIds: ["referent.01"],
      claimIds: ["claim.01"],
      evidenceIds: ["evidence.01"],
      supersedesTopicIds: [],
      salienceMass: 0.8,
      lastTurnIndex: turnIndex
    }],
    bindings: [{
      schema: "scce.discourse_binding.v2",
      id: "binding.01",
      mentionId: "mention.01",
      referentId: "referent.01",
      topicId: "topic.01",
      provenanceBindings: [provenance],
      inheritedSlotBindings: [],
      components: {
        recency: 1,
        salience: 0.8,
        semanticRoleFit: 1,
        slotFit: 0.5,
        graphRouteCoherence: 1,
        learnedFrameFit: 1,
        topicContinuity: 1,
        evidenceFit: 0.9,
        temporalFit: 0.5,
        contradictionPenalty: 0,
        scopePenalty: 0,
        topicSwitchPenalty: 0
      },
      rawScore: 0.8,
      confidence: 0.8,
      runnerUpMargin: 0.8,
      admitted: true,
      reasonIds: ["reason.01"],
      alternatives: []
    }],
    unresolvedMentionIds: [],
    openSlotIds: ["slot.01"],
    preferenceSnapshotIds: [],
    correctionIds: [],
    historyDigestIds: [observationId],
    queryConcatenationUsed: false
  };
  return {
    schema: "scce.dialogue_cognitive_state.v2",
    id: deriveDialogueCognitiveStateIdV2(content),
    ...content,
    audit: { sourceId: "audit.01" }
  };
}

function reidentify(state: DialogueCognitiveStateV2): DialogueCognitiveStateV2 {
  const { schema: _schema, id: _id, audit, ...content } = state;
  return { schema: "scce.dialogue_cognitive_state.v2", id: deriveDialogueCognitiveStateIdV2(content), ...content, audit };
}
