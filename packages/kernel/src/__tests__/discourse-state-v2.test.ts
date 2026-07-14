import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDiscourseProvenanceBindingV2,
  createDiscourseTurnObservationV2,
  deriveDialogueCognitiveStateIdV2,
  resolveDiscourseStateV2,
  type DialogueCognitiveStateV2,
  type DiscourseMentionV2,
  type DiscourseReferentV2,
  type DiscourseRouteSignalV2,
  type DiscourseTopicV2,
  type DiscourseTurnObservationV2,
  type ResolveDiscourseStateV2Input
} from "../discourse-state.js";

const ids = {
  conversation: "conv.2f63a010",
  session: "sess.70db0df1",
  scopeA: "scope.72c98f11",
  scopeB: "scope.1bcf09c2",
  roleEntity: "role.143af6e9",
  roleCondition: "role.82c1d044",
  frameEntity: "frame.0a17bd46",
  slotCondition: "slot.2d61cb8a",
  authority: "auth.55f7310c"
} as const;

describe("typed discourse resolver v2", () => {
  it("preserves a referent across different-script surfaces through shared graph and frame ids", () => {
    const referent = makeReferent({ id: "ref.01", nodeIds: ["node.shared"], topicId: "topic.01" });
    const previous = previousState({ referents: [referent], topics: [makeTopic("topic.01", ["node.shared"], [referent.id])], activeTopicIds: ["topic.01"] });
    const firstSurface = "Ada";
    const secondSurface = "에이다";
    const result = resolveWithProof({
      previousState: previous,
      observation: makeObservation({
        id: "obs.02",
        turnId: "turn.02",
        turnIndex: 2,
        scriptProfileId: "script.91a0e382",
        surfaceHash: hash(secondSurface),
        mentions: [makeMention({
          id: "mention.02",
          surfaceHash: hash(secondSurface),
          candidateNodeIds: ["node.shared"],
          learnedFrameIds: [ids.frameEntity]
        })]
      })
    });

    expect(hash(firstSurface)).not.toBe(hash(secondSurface));
    expect(/\p{Script=Hangul}/u.test(secondSurface)).toBe(true);
    expect(result.context.admittedBindings).toHaveLength(1);
    expect(result.context.admittedBindings[0]?.referentId).toBe(referent.id);
    expect(result.context.seedNodeIds).toEqual(["node.shared"]);
    expect(result.context.evidenceIds).toEqual(["evidence.01"]);
    expect(result.context.queryConcatenationUsed).toBe(false);
  });

  it("switches topics from an explicit graph anchor and rejects the prior topic candidate", () => {
    const prior = makeReferent({ id: "ref.01", nodeIds: ["node.01"], topicId: "topic.01" });
    const next = makeReferent({ id: "ref.02", nodeIds: ["node.02"], topicId: "topic.02" });
    const result = resolveWithProof({
      previousState: previousState({
        referents: [prior, next],
        topics: [makeTopic("topic.01", ["node.01"], [prior.id]), makeTopic("topic.02", ["node.02"], [next.id])],
        activeTopicIds: ["topic.01"]
      }),
      observation: makeObservation({
        id: "obs.03",
        turnId: "turn.03",
        turnIndex: 3,
        explicitAnchorNodeIds: ["node.02"],
        mentions: [makeMention({ id: "mention.03", candidateReferentIds: [prior.id, next.id], candidateNodeIds: ["node.02"] })]
      }),
      routeSignals: [
        { mentionId: "mention.03", referentId: prior.id, graphRouteCoherence: 0.8 },
        { mentionId: "mention.03", referentId: next.id, graphRouteCoherence: 1 }
      ]
    });

    expect(result.context.admittedBindings[0]?.referentId).toBe(next.id);
    expect(result.state.activeTopicIds).toEqual(["topic.02"]);
    expect(result.context.evidenceIds).toEqual(["evidence.02"]);
  });

  it("leaves an ambiguous mention unresolved when candidates have no score margin", () => {
    const left = makeReferent({ id: "ref.01", nodeIds: ["node.01"], topicId: "topic.01" });
    const right = makeReferent({ id: "ref.02", nodeIds: ["node.02"], topicId: "topic.01", evidenceIds: ["evidence.01"] });
    const result = resolveWithProof({
      previousState: previousState({ referents: [left, right], topics: [makeTopic("topic.01", ["node.01", "node.02"], [left.id, right.id])], activeTopicIds: ["topic.01"] }),
      observation: makeObservation({
        id: "obs.03",
        turnId: "turn.03",
        turnIndex: 3,
        mentions: [makeMention({ id: "mention.ambiguous", candidateReferentIds: [right.id, left.id] })]
      }),
      routeSignals: [
        { mentionId: "mention.ambiguous", referentId: left.id, graphRouteCoherence: 0.9 },
        { mentionId: "mention.ambiguous", referentId: right.id, graphRouteCoherence: 0.9 }
      ]
    });

    expect(result.context.admittedBindings).toHaveLength(0);
    expect(result.state.bindings[0]?.referentId).toBe(left.id);
    expect(result.state.bindings[0]?.runnerUpMargin).toBe(0);
    expect(result.state.unresolvedMentionIds).toEqual(["mention.ambiguous"]);
  });

  it("inherits only requested ellipsis slots from an admitted referent", () => {
    const referent = makeReferent({
      id: "ref.01",
      nodeIds: ["node.01"],
      topicId: "topic.01",
      slotBindings: [
        { slotId: ids.slotCondition, nodeIds: ["node.condition"], claimIds: ["claim.condition"], evidenceIds: ["evidence.condition"] },
        { slotId: "slot.unrequested", nodeIds: ["node.other"], claimIds: [], evidenceIds: [] }
      ]
    });
    const result = resolveWithProof({
      previousState: previousState({ referents: [referent], topics: [makeTopic("topic.01", ["node.01"], [referent.id])], activeTopicIds: ["topic.01"] }),
      observation: makeObservation({
        id: "obs.03",
        turnId: "turn.03",
        turnIndex: 3,
        requestedSlotIds: [ids.slotCondition],
        mentions: [makeMention({ id: "mention.ellipsis", candidateReferentIds: [referent.id], semanticRoleIds: [ids.roleCondition] })]
      }),
      routeSignals: [{ mentionId: "mention.ellipsis", referentId: referent.id, graphRouteCoherence: 1 }]
    });

    expect(result.context.admittedBindings[0]?.inheritedSlotBindings.map(slot => slot.slotId)).toEqual([ids.slotCondition]);
    expect(result.context.seedNodeIds).toEqual(["node.01", "node.condition"]);
    expect(result.context.claimIds).toEqual(["claim.01", "claim.condition"]);
    expect(result.state.openSlotIds).toEqual([]);
  });

  it("rejects candidates across contradiction and scope boundaries", () => {
    const contradicted = makeReferent({ id: "ref.conflict", nodeIds: ["node.conflict"], topicId: "topic.01", contradictionMass: 0.9 });
    const otherScope = makeReferent({ id: "ref.scope", nodeIds: ["node.scope"], topicId: "topic.01", scopeIds: [ids.scopeB] });
    const result = resolveWithProof({
      previousState: previousState({ referents: [contradicted, otherScope], topics: [makeTopic("topic.01", ["node.conflict", "node.scope"], [contradicted.id, otherScope.id])], activeTopicIds: ["topic.01"] }),
      observation: makeObservation({
        id: "obs.04",
        turnId: "turn.04",
        turnIndex: 4,
        mentions: [
          makeMention({ id: "mention.conflict", candidateReferentIds: [contradicted.id] }),
          makeMention({ id: "mention.scope", candidateReferentIds: [otherScope.id] })
        ]
      }),
      routeSignals: [
        { mentionId: "mention.conflict", referentId: contradicted.id, graphRouteCoherence: 1 },
        { mentionId: "mention.scope", referentId: otherScope.id, graphRouteCoherence: 1 }
      ]
    });

    expect(result.context.admittedBindings).toHaveLength(0);
    expect(result.state.unresolvedMentionIds).toEqual(["mention.conflict", "mention.scope"]);
    expect(result.state.bindings.every(binding => !binding.admitted)).toBe(true);
  });

  it("admits an otherwise supported referent when neither turn nor mention requires a scope", () => {
    const referent = makeReferent({
      id: "ref.unscoped",
      nodeIds: ["node.unscoped"],
      topicId: "topic.unscoped",
      scopeIds: []
    });
    const result = resolveWithProof({
      previousState: previousState({
        referents: [referent],
        topics: [makeTopic("topic.unscoped", ["node.unscoped"], [referent.id])],
        activeTopicIds: ["topic.unscoped"]
      }),
      observation: makeObservation({
        id: "obs.unscoped",
        turnId: "turn.unscoped",
        turnIndex: 4,
        scopeIds: [],
        mentions: [makeMention({
          id: "mention.unscoped",
          candidateReferentIds: [referent.id],
          scopeIds: []
        })]
      }),
      routeSignals: [{
        mentionId: "mention.unscoped",
        referentId: referent.id,
        graphRouteCoherence: 1
      }]
    });

    expect(result.context.admittedBindings).toHaveLength(1);
    expect(result.context.admittedBindings[0]?.referentId).toBe(referent.id);
  });

  it("measures required scope coverage against every required scope", () => {
    const referent = makeReferent({
      id: "ref.partial-scope",
      nodeIds: ["node.partial-scope"],
      topicId: "topic.partial-scope",
      scopeIds: [ids.scopeA]
    });
    const result = resolveWithProof({
      observation: makeObservation({
        id: "obs.partial-scope",
        turnId: "turn.partial-scope",
        scopeIds: [ids.scopeA, ids.scopeB],
        mentions: [makeMention({
          id: "mention.partial-scope",
          candidateReferentIds: [referent.id],
          scopeIds: []
        })]
      }),
      referents: [referent],
      routeSignals: [{ mentionId: "mention.partial-scope", referentId: referent.id, graphRouteCoherence: 1 }],
      config: { minimumScopeFit: 0.75 }
    });

    expect(result.state.bindings[0]?.components.scopePenalty).toBe(0.5);
    expect(result.state.bindings[0]?.admitted).toBe(false);
    expect(result.state.unresolvedMentionIds).toEqual(["mention.partial-scope"]);
  });

  it("selects a hard-admissible referent without comparing its margin to invalid alternatives", () => {
    const invalid = makeReferent({
      id: "ref.invalid",
      nodeIds: ["node.invalid"],
      topicId: "topic.01",
      scopeIds: [ids.scopeB],
      salienceMass: 1
    });
    const valid = makeReferent({
      id: "ref.valid",
      nodeIds: ["node.valid"],
      topicId: "topic.01",
      scopeIds: [ids.scopeA],
      salienceMass: 0.5
    });
    const result = resolveWithProof({
      observation: makeObservation({
        id: "obs.failover",
        turnId: "turn.failover",
        mentions: [makeMention({ id: "mention.failover", candidateReferentIds: [invalid.id, valid.id] })]
      }),
      referents: [invalid, valid],
      routeSignals: [
        { mentionId: "mention.failover", referentId: invalid.id, graphRouteCoherence: 1 },
        { mentionId: "mention.failover", referentId: valid.id, graphRouteCoherence: 0.7 }
      ],
      config: { weights: { scopePenalty: 0 } }
    });

    const binding = result.context.admittedBindings[0];
    const invalidAlternative = binding?.alternatives.find(alternative => alternative.referentId === invalid.id);
    expect(binding?.referentId).toBe(valid.id);
    expect(result.state.unresolvedMentionIds).toEqual([]);
    expect(binding?.runnerUpMargin).toBe(binding?.confidence);
    expect(invalidAlternative?.rawScore).toBeGreaterThan(binding?.rawScore ?? 1);
    expect(result.state.bindings[0]?.alternatives).toContainEqual(expect.objectContaining({
      referentId: invalid.id,
      hardAdmissible: false
    }));
  });

  it("carries open slots, closes only proof-bearing bindings, and refreshes copied referents", () => {
    const referent = makeReferent({
      id: "ref.memory",
      nodeIds: ["node.memory"],
      topicId: "topic.memory",
      salienceMass: 0.2,
      slotBindings: [
        { slotId: "slot.proved", nodeIds: ["node.proved"], claimIds: ["claim.proved"], evidenceIds: ["evidence.proved"] },
        { slotId: "slot.missing-evidence", nodeIds: ["node.unproved"], claimIds: [], evidenceIds: [] },
        { slotId: "slot.missing-payload", nodeIds: [], claimIds: [], evidenceIds: ["evidence.orphan"] }
      ]
    });
    const originalReferent = structuredClone(referent);
    const result = resolveWithProof({
      previousState: previousState({
        referents: [referent],
        topics: [makeTopic("topic.memory", ["node.memory"], [referent.id])],
        activeTopicIds: ["topic.memory"],
        openSlotIds: ["slot.missing-payload", "slot.proved", "slot.missing-evidence"]
      }),
      observation: makeObservation({
        id: "obs.memory",
        turnId: "turn.memory",
        turnIndex: 6,
        requestedSlotIds: [],
        mentions: [makeMention({
          id: "mention.memory",
          candidateReferentIds: [referent.id],
          requestedSlotIds: []
        })]
      }),
      routeSignals: [{ mentionId: "mention.memory", referentId: referent.id, graphRouteCoherence: 1 }]
    });

    const inherited = result.context.admittedBindings[0]?.inheritedSlotBindings;
    expect(inherited).toEqual([{
      slotId: "slot.proved",
      nodeIds: ["node.proved"],
      claimIds: ["claim.proved"],
      evidenceIds: ["evidence.proved"]
    }]);
    expect(result.state.openSlotIds).toEqual(["slot.missing-evidence", "slot.missing-payload"]);
    expect(result.context.evidenceIds).not.toContain("evidence.orphan");
    expect(result.context.seedNodeIds).not.toContain("node.unproved");
    expect(result.state.referents[0]?.lastMentionTurnIndex).toBe(6);
    expect(result.state.referents[0]?.salienceMass).toBeGreaterThan(0.2);
    expect(referent).toEqual(originalReferent);
  });

  it("scores every candidate before retaining the bounded candidate set", () => {
    const referents = Array.from({ length: 40 }, (_, index) => makeReferent({
      id: `ref.${String(index).padStart(2, "0")}`,
      nodeIds: [`node.${String(index).padStart(2, "0")}`],
      topicId: "topic.large"
    }));
    const best = referents[39]!;
    const mentionId = "mention.large";
    const result = resolveWithProof({
      observation: makeObservation({
        id: "obs.large",
        turnId: "turn.large",
        mentions: [makeMention({
          id: mentionId,
          candidateReferentIds: referents.map(referent => referent.id)
        })]
      }),
      referents,
      routeSignals: referents.map(referent => ({
        mentionId,
        referentId: referent.id,
        graphRouteCoherence: referent.id === best.id ? 1 : 0.05
      })),
      config: {
        maxCandidatesPerMention: 32,
        weights: {
          recency: 0,
          salience: 0,
          semanticRoleFit: 0,
          slotFit: 0,
          graphRouteCoherence: 1,
          learnedFrameFit: 0,
          topicContinuity: 0,
          evidenceFit: 0,
          temporalFit: 0
        }
      }
    });

    expect(result.context.admittedBindings[0]?.referentId).toBe(best.id);
    expect(result.state.bindings[0]?.alternatives).toHaveLength(8);
  });

  it("canonicalizes nested set content and binds state identity to canonical content", () => {
    const forward = makeReferent({
      id: "ref.canonical",
      nodeIds: ["node.z", "node.a"],
      topicId: "topic.canonical",
      claimIds: ["claim.z", "claim.a"],
      relationIds: ["relation.z", "relation.a"],
      evidenceIds: ["evidence.z", "evidence.a"],
      sourceVersionIds: ["source.z", "source.a"],
      contradictionIds: ["contradiction.z", "contradiction.a"],
      contradictionMass: 0.4,
      semanticRoleIds: [ids.roleCondition, ids.roleEntity],
      learnedFrameIds: ["frame.z", ids.frameEntity],
      scopeIds: [ids.scopeB, ids.scopeA],
      slotBindings: [
        { slotId: "slot.z", nodeIds: ["node.z", "node.a"], claimIds: ["claim.z", "claim.a"], evidenceIds: ["evidence.z", "evidence.a"] },
        { slotId: "slot.a", nodeIds: ["node.a"], claimIds: ["claim.a"], evidenceIds: ["evidence.a"] }
      ]
    });
    const reversed: DiscourseReferentV2 = {
      ...forward,
      nodeIds: [...forward.nodeIds].reverse(),
      claimIds: [...forward.claimIds].reverse(),
      relationIds: [...forward.relationIds].reverse(),
      evidenceIds: [...forward.evidenceIds].reverse(),
      sourceVersionIds: [...forward.sourceVersionIds].reverse(),
      contradictionIds: [...forward.contradictionIds].reverse(),
      semanticRoleIds: [...forward.semanticRoleIds].reverse(),
      learnedFrameIds: [...forward.learnedFrameIds].reverse(),
      scopeIds: [...forward.scopeIds].reverse(),
      slotBindings: [...forward.slotBindings].reverse().map(binding => ({
        ...binding,
        nodeIds: [...binding.nodeIds].reverse(),
        claimIds: [...binding.claimIds].reverse(),
        evidenceIds: [...binding.evidenceIds].reverse()
      }))
    };
    const topic = {
      ...makeTopic("topic.canonical", ["node.z", "node.a"], [forward.id]),
      claimIds: ["claim.z", "claim.a"],
      evidenceIds: ["evidence.z", "evidence.a"],
      supersedesTopicIds: ["topic.z", "topic.a"]
    };
    const reversedTopic: DiscourseTopicV2 = {
      ...topic,
      anchorNodeIds: [...topic.anchorNodeIds].reverse(),
      referentIds: [...topic.referentIds].reverse(),
      claimIds: [...topic.claimIds].reverse(),
      evidenceIds: [...topic.evidenceIds].reverse(),
      supersedesTopicIds: [...topic.supersedesTopicIds].reverse()
    };
    const observation = makeObservation({
      id: "obs.canonical",
      turnId: "turn.canonical",
      mentions: [makeMention({ id: "mention.canonical", candidateReferentIds: [forward.id] })]
    });
    const signal = [{ mentionId: "mention.canonical", referentId: forward.id, graphRouteCoherence: 1 }];
    const first = resolveWithProof({ observation, referents: [forward], topics: [topic], routeSignals: signal });
    const second = resolveWithProof({ observation, referents: [reversed], topics: [reversedTopic], routeSignals: signal });
    const changed = resolveWithProof({
      observation,
      referents: [{ ...forward, nodeIds: [...forward.nodeIds, "node.changed"] }],
      topics: [topic],
      routeSignals: signal
    });
    expect(second).toEqual(first);
    expect(first.context.seedNodeIds).toEqual(["node.a", "node.z"]);
    expect(changed.state.id).not.toBe(first.state.id);
  });

  it("produces identical scoring and state ids for reordered equivalent inputs", () => {
    const left = makeReferent({ id: "ref.01", nodeIds: ["node.01"], topicId: "topic.01" });
    const right = makeReferent({ id: "ref.02", nodeIds: ["node.02"], topicId: "topic.01", salienceMass: 0.6 });
    const observation = makeObservation({
      id: "obs.05",
      turnId: "turn.05",
      turnIndex: 5,
      mentions: [makeMention({ id: "mention.05", candidateReferentIds: [right.id, left.id] })]
    });
    const signals = [
      { mentionId: "mention.05", referentId: left.id, graphRouteCoherence: 1 },
      { mentionId: "mention.05", referentId: right.id, graphRouteCoherence: 0.7 }
    ];
    const first = resolveWithProof({ observation, referents: [right, left], topics: [makeTopic("topic.01", ["node.02", "node.01"], [right.id, left.id])], routeSignals: signals });
    const second = resolveWithProof({ observation, referents: [left, right], topics: [makeTopic("topic.01", ["node.02", "node.01"], [right.id, left.id])], routeSignals: [...signals].reverse() });

    expect(second).toEqual(first);
    expect(first.state.bindings[0]?.referentId).toBe(left.id);
  });

  it("requires both a current graph route and a content-bound proof receipt", () => {
    const referent = makeReferent({ id: "ref.gated", nodeIds: ["node.gated"], topicId: "topic.gated", salienceMass: 1 });
    const observation = makeObservation({
      turnId: "turn.gated",
      turnIndex: 7,
      mentions: [makeMention({ id: "mention.gated", candidateReferentIds: [referent.id] })]
    });
    const proof = createDiscourseProvenanceBindingV2({
      observationId: observation.id,
      mentionId: "mention.gated",
      referentId: referent.id,
      routeId: "route.gated",
      nodeIds: referent.nodeIds,
      claimIds: referent.claimIds,
      evidenceIds: referent.evidenceIds,
      sourceVersionIds: referent.sourceVersionIds,
      contradictionIds: []
    });
    const topic = makeTopic("topic.gated", referent.nodeIds, [referent.id]);
    const withoutProof = resolveDiscourseStateV2({
      observation,
      referents: [referent],
      topics: [topic],
      routeSignals: [{ mentionId: "mention.gated", referentId: referent.id, graphRouteCoherence: 1 }]
    });
    const withoutRoute = resolveDiscourseStateV2({ observation, referents: [referent], topics: [topic], provenanceBindings: [proof] });

    expect(withoutProof.context.admittedBindings).toEqual([]);
    expect(withoutRoute.context.admittedBindings).toEqual([]);
    expect(withoutProof.context.evidenceIds).toEqual([]);
    expect(withoutRoute.context.seedNodeIds).toEqual([]);
  });

  it("keeps foreign provenance and incoherent contradictions out of context", () => {
    const referent = makeReferent({
      id: "ref.provenance",
      nodeIds: ["node.provenance"],
      topicId: "topic.provenance",
      contradictionIds: ["contradiction.known"],
      contradictionMass: 0
    });
    const observation = makeObservation({
      turnId: "turn.provenance",
      turnIndex: 8,
      mentions: [makeMention({ id: "mention.provenance", candidateReferentIds: [referent.id] })]
    });
    const foreign = createDiscourseProvenanceBindingV2({
      observationId: observation.id,
      mentionId: "mention.provenance",
      referentId: referent.id,
      routeId: "route.provenance",
      nodeIds: ["node.foreign"],
      claimIds: ["claim.foreign"],
      evidenceIds: ["evidence.foreign"],
      sourceVersionIds: ["source.foreign"],
      contradictionIds: ["contradiction.known"]
    });
    const result = resolveDiscourseStateV2({
      observation,
      referents: [referent],
      topics: [makeTopic("topic.provenance", referent.nodeIds, [referent.id])],
      routeSignals: [{ mentionId: "mention.provenance", referentId: referent.id, graphRouteCoherence: 1 }],
      provenanceBindings: [foreign]
    });

    expect(result.context.admittedBindings).toEqual([]);
    expect(result.context.seedNodeIds).toEqual([]);
    expect(result.context.claimIds).toEqual([]);
    expect(result.context.evidenceIds).toEqual([]);
    expect(result.context.sourceVersionIds).toEqual([]);
    expect(result.context.contradictionIds).toEqual([]);
  });

  it("repairs topic backlinks, refreshes admitted topics, and derives observation and state ids from content", () => {
    const selected = makeReferent({ id: "ref.topic-a", nodeIds: ["node.topic-a"], topicId: "topic.a" });
    const other = makeReferent({ id: "ref.topic-b", nodeIds: ["node.topic-b"], topicId: "topic.b" });
    const observation = makeObservation({
      id: "forged.observation.id",
      turnId: "turn.topic",
      turnIndex: 9,
      mentions: [makeMention({ id: "mention.topic", candidateReferentIds: [selected.id] })]
    });
    const result = resolveWithProof({
      observation,
      referents: [selected, other],
      topics: [makeTopic("topic.a", selected.nodeIds, [other.id]), makeTopic("topic.b", other.nodeIds, [selected.id])],
      routeSignals: [{ mentionId: "mention.topic", referentId: selected.id, graphRouteCoherence: 1 }]
    });
    const topicA = result.state.topics.find(topic => topic.id === "topic.a");
    const topicB = result.state.topics.find(topic => topic.id === "topic.b");

    expect(result.state.observationId).toBe(observation.id);
    expect(result.state.id).toBe(deriveDialogueCognitiveStateIdV2(result.state));
    expect(topicA?.referentIds).toEqual([selected.id]);
    expect(topicB?.referentIds).toEqual([other.id]);
    expect(topicA?.lastTurnIndex).toBe(9);
    expect(topicA?.evidenceIds).toContain("evidence.01");
  });
});

function resolveWithProof(input: ResolveDiscourseStateV2Input) {
  const observation = createDiscourseTurnObservationV2(input.observation);
  const referentById = new Map<string, DiscourseReferentV2>();
  for (const referent of input.previousState?.referents ?? []) referentById.set(referent.id, referent);
  for (const referent of input.referents ?? []) referentById.set(referent.id, referent);
  const referents = [...referentById.values()];
  const topicById = new Map<string, DiscourseTopicV2>();
  for (const topic of input.previousState?.topics ?? []) topicById.set(topic.id, topic);
  for (const topic of input.topics ?? []) topicById.set(topic.id, topic);
  for (const referent of referents) {
    if (!topicById.has(referent.topicId)) {
      const topicReferents = referents.filter(row => row.topicId === referent.topicId);
      topicById.set(referent.topicId, makeTopic(
        referent.topicId,
        topicReferents.flatMap(row => row.nodeIds),
        topicReferents.map(row => row.id)
      ));
    }
  }
  const routeSignals = input.routeSignals?.length
    ? [...input.routeSignals]
    : observation.mentions.flatMap(mention => candidateReferents(mention, referents).map(referent => ({
      mentionId: mention.id,
      referentId: referent.id,
      graphRouteCoherence: 1
    } satisfies DiscourseRouteSignalV2)));
  const provenanceBindings = routeSignals.flatMap(signal => {
    const referent = referentById.get(signal.referentId);
    if (!referent) return [];
    const slots = referent.slotBindings.filter(slot => slot.evidenceIds.length > 0 && slot.nodeIds.length + slot.claimIds.length > 0);
    return [createDiscourseProvenanceBindingV2({
      observationId: observation.id,
      mentionId: signal.mentionId,
      referentId: signal.referentId,
      routeId: `route.${observation.id}.${signal.mentionId}.${signal.referentId}`,
      nodeIds: [...referent.nodeIds, ...slots.flatMap(slot => slot.nodeIds)],
      claimIds: [...referent.claimIds, ...slots.flatMap(slot => slot.claimIds)],
      evidenceIds: [...referent.evidenceIds, ...slots.flatMap(slot => slot.evidenceIds)],
      sourceVersionIds: referent.sourceVersionIds,
      contradictionIds: referent.contradictionIds
    })];
  });
  return resolveDiscourseStateV2({
    ...input,
    observation,
    topics: [...topicById.values()],
    routeSignals,
    provenanceBindings
  });
}

function candidateReferents(mention: DiscourseMentionV2, referents: readonly DiscourseReferentV2[]): DiscourseReferentV2[] {
  if (mention.candidateReferentIds.length) {
    const ids = new Set(mention.candidateReferentIds);
    return referents.filter(referent => ids.has(referent.id));
  }
  if (mention.candidateNodeIds.length) {
    const ids = new Set(mention.candidateNodeIds);
    const matches = referents.filter(referent => referent.nodeIds.some(id => ids.has(id)));
    if (matches.length) return matches;
  }
  return [...referents];
}

function makeObservation(patch: Partial<DiscourseTurnObservationV2> = {}): DiscourseTurnObservationV2 {
  const observation: DiscourseTurnObservationV2 = {
    schema: "scce.discourse_turn_observation.v2",
    id: "obs.01",
    conversationId: ids.conversation,
    sessionId: ids.session,
    turnId: "turn.01",
    turnIndex: 2,
    roleId: "role.owner",
    surfaceHash: hash("surface.01"),
    languageProfileId: "lang.1f833b01",
    scriptProfileId: "script.a85c9e11",
    learnedFrameIds: [ids.frameEntity],
    requestedSlotIds: [],
    explicitAnchorNodeIds: [],
    scopeIds: [ids.scopeA],
    mentions: [makeMention()],
    ...patch
  };
  const { schema: _schema, id: _id, ...content } = observation;
  return createDiscourseTurnObservationV2(content);
}

function makeMention(patch: Partial<DiscourseMentionV2> = {}): DiscourseMentionV2 {
  return {
    schema: "scce.discourse_mention.v2",
    id: "mention.01",
    span: { start: 0, end: 4 },
    kindId: "mention.4a18b79c",
    surfaceHash: hash("mention.01"),
    semanticRoleIds: [ids.roleEntity],
    requestedSlotIds: [],
    learnedFrameIds: [ids.frameEntity],
    candidateNodeIds: [],
    candidateReferentIds: [],
    scopeIds: [ids.scopeA],
    ...patch
  };
}

function makeReferent(patch: Partial<DiscourseReferentV2> & Pick<DiscourseReferentV2, "id" | "nodeIds" | "topicId">): DiscourseReferentV2 {
  const { id, nodeIds, topicId, evidenceIds, contradictionIds, contradictionMass, ...overrides } = patch;
  const index = id.endsWith("02") ? 2 : 1;
  const coherentContradictionMass = contradictionMass ?? 0;
  return {
    schema: "scce.discourse_referent.v2",
    id,
    topicId,
    introducedTurnId: "turn.01",
    introducedTurnIndex: 1,
    lastMentionTurnIndex: 1,
    nodeIds,
    claimIds: [`claim.0${index}`],
    relationIds: ["relation.01"],
    evidenceIds: evidenceIds ?? [`evidence.0${index}`],
    sourceVersionIds: [`source-version.0${index}`],
    contradictionIds: contradictionIds ?? (coherentContradictionMass > 0 ? [`contradiction.${id}`] : []),
    semanticRoleIds: [ids.roleEntity, ids.roleCondition],
    learnedFrameIds: [ids.frameEntity],
    scopeIds: [ids.scopeA],
    slotBindings: [],
    salienceMass: 0.9,
    evidenceSupportMass: 0.9,
    contradictionMass: coherentContradictionMass,
    authorityClassId: ids.authority,
    ...overrides
  };
}

function makeTopic(id: string, anchorNodeIds: string[], referentIds: string[]): DiscourseTopicV2 {
  return {
    schema: "scce.discourse_topic.v2",
    id,
    statusId: "topic.status.19e4c210",
    anchorNodeIds,
    referentIds,
    claimIds: [],
    evidenceIds: [],
    supersedesTopicIds: [],
    salienceMass: 0.9,
    lastTurnIndex: 1
  };
}

function previousState(input: {
  referents: DiscourseReferentV2[];
  topics: DiscourseTopicV2[];
  activeTopicIds: string[];
  openSlotIds?: string[];
}): DialogueCognitiveStateV2 {
  const content: Omit<DialogueCognitiveStateV2, "schema" | "id" | "audit"> = {
    conversationId: ids.conversation,
    sessionId: ids.session,
    observationId: "disc2.observation.previous",
    turnId: "turn.01",
    turnIndex: 1,
    activeTopicIds: input.activeTopicIds,
    referents: input.referents,
    topics: input.topics,
    bindings: [],
    unresolvedMentionIds: [],
    openSlotIds: input.openSlotIds ?? [],
    preferenceSnapshotIds: [],
    correctionIds: [],
    historyDigestIds: ["disc2.observation.previous"],
    queryConcatenationUsed: false
  };
  return {
    schema: "scce.dialogue_cognitive_state.v2",
    id: deriveDialogueCognitiveStateIdV2(content),
    ...content,
    audit: null
  };
}

function hash(value: string): string {
  return `sha256_${createHash("sha256").update(value).digest("hex")}`;
}
