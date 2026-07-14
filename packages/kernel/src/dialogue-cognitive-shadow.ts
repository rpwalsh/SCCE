import {
  createDiscourseProvenanceBindingV2,
  createDiscourseTurnObservationV2,
  type DialogueCognitiveStateV2,
  type DiscourseProvenanceBindingV2,
  type DiscourseReferentV2,
  type DiscourseRouteSignalV2,
  type DiscourseTopicV2,
  type DiscourseTurnObservationV2
} from "./discourse-state.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import type { GraphEdge, GraphNode, GraphSlice, Hasher, JsonValue, TurnResult } from "./types.js";

export type DialogueCognitiveShadowProjectionV2 =
  | {
    schema: "scce.dialogue_cognitive_shadow_projection.v2";
    status: "observed";
    observation: DiscourseTurnObservationV2;
    referents: DiscourseReferentV2[];
    topics: DiscourseTopicV2[];
    routeSignals: DiscourseRouteSignalV2[];
    provenanceBindings: DiscourseProvenanceBindingV2[];
    audit: JsonValue;
  }
  | {
    schema: "scce.dialogue_cognitive_shadow_projection.v2";
    status: "not_observed";
    reasonId: "proof_identity_missing" | "proof_evidence_missing" | "proof_graph_node_missing";
    audit: JsonValue;
  };

export interface ProjectProofBearingDialogueTurnV2Input {
  conversationId: string;
  sessionId?: string;
  turnId: string;
  turnIndex: number;
  roleId: string;
  surfaceHash: string;
  result: TurnResult;
  graph: GraphSlice;
  previousState?: DialogueCognitiveStateV2;
  hasher: Hasher;
}

/**
 * Projects only identities already admitted by the selected proof/candidate and
 * linked to durable graph nodes. It never receives or interprets surface text.
 */
export function projectProofBearingDialogueTurnV2(
  input: ProjectProofBearingDialogueTurnV2Input
): DialogueCognitiveShadowProjectionV2 {
  const proof = input.result.entailment.proof;
  if (!proof.id || !proof.claimId || String(proof.claimId) !== String(input.result.entailment.claim.id)) {
    return notObserved("proof_identity_missing", { turnId: input.turnId });
  }
  const selectedEvidenceIds = selectedProofEvidenceIds(input.result);
  if (!selectedEvidenceIds.length) {
    return notObserved("proof_evidence_missing", { proofId: String(proof.id), turnId: input.turnId });
  }
  const selectedEvidenceSet = new Set(selectedEvidenceIds);
  const routedNodeIds = new Set([
    ...input.result.field.seeds.filter(row => row.weight > 0).map(row => String(row.nodeId)),
    ...input.result.field.active.filter(row => row.activation > 0).map(row => String(row.nodeId)),
    ...input.result.field.ppf.filter(row => row.mass > 0).map(row => String(row.nodeId))
  ]);
  const graphNodes = input.graph.nodes
    .filter(node => routedNodeIds.has(String(node.id))
      && node.evidenceIds.some(id => selectedEvidenceSet.has(String(id))))
    .sort((left, right) => compareIds(String(left.id), String(right.id)));
  if (!graphNodes.length) {
    return notObserved("proof_graph_node_missing", {
      proofId: String(proof.id),
      turnId: input.turnId,
      evidenceIds: selectedEvidenceIds
    });
  }

  const nodeById = new Map(graphNodes.map(node => [String(node.id), node]));
  const evidenceById = new Map(input.result.evidence.map(span => [String(span.id), span]));
  const graphEdges = input.graph.edges.filter(edge => (
    nodeById.has(String(edge.source))
    || nodeById.has(String(edge.target))
    || edge.evidenceIds.some(id => selectedEvidenceSet.has(String(id)))
  ));
  const graphHyperedges = input.graph.hyperedges.filter(edge => (
    edge.memberNodeIds.some(id => nodeById.has(String(id)))
    && edge.provenanceRefs.some(id => selectedEvidenceSet.has(String(id)))
  ));
  const previousReferents = input.previousState?.referents ?? [];
  const previousTopics = new Map((input.previousState?.topics ?? []).map(topic => [topic.id, topic]));
  const referents = graphNodes.map(node => graphNodeReferent({
    node,
    graphEdges,
    graphHyperedges,
    selectedEvidenceSet,
    evidenceById,
    result: input.result,
    previous: previousReferents.find(referent => referent.nodeIds.includes(String(node.id))),
    previousTopics,
    turnId: input.turnId,
    turnIndex: input.turnIndex
  }));
  const referentByNodeId = new Map<string, DiscourseReferentV2>();
  for (const referent of referents) {
    for (const nodeId of referent.nodeIds) referentByNodeId.set(nodeId, referent);
  }
  const topics = mergeProjectedTopics(referents.map(referent => graphNodeTopic({
    referent,
    previous: previousTopics.get(referent.topicId),
    proofClaimId: String(proof.claimId),
    turnIndex: input.turnIndex
  })));

  const mentionDrafts = input.result.entailment.mappings.flatMap(mapping => {
    const evidenceIds = intersectIds(mapping.evidenceIds.map(String), selectedEvidenceIds);
    if (!evidenceIds.length) return [];
    const candidateNodeIds = graphNodes
      .filter(node => node.evidenceIds.some(id => evidenceIds.includes(String(id))))
      .map(node => String(node.id));
    if (!candidateNodeIds.length) return [];
    const sourceVersionIds = canonicalIds([
      ...mapping.sourceVersionIds.map(String),
      ...evidenceIds.map(id => String(evidenceById.get(id)?.sourceVersionId ?? ""))
    ]);
    const sourceIdentityIds = canonicalIds([
      String(proof.id),
      String(proof.claimId),
      mapping.id,
      mapping.obligationId,
      ...evidenceIds,
      ...sourceVersionIds,
      ...candidateNodeIds
    ]);
    const id = `disc2.mention.${input.hasher.digestHex(canonicalStringify(sourceIdentityIds)).slice(0, 32)}`;
    return [{
      schema: "scce.discourse_mention.v2" as const,
      id,
      sourceIdentityIds,
      kindId: mapping.id,
      surfaceHash: input.hasher.digestHex(canonicalStringify(sourceIdentityIds)),
      semanticRoleIds: [],
      requestedSlotIds: [mapping.obligationId],
      learnedFrameIds: [],
      candidateNodeIds: canonicalIds(candidateNodeIds),
      candidateReferentIds: canonicalIds(candidateNodeIds.map(nodeId => referentByNodeId.get(nodeId)?.id ?? "")),
      scopeIds: sourceVersionIds
    }];
  });
  const observation = createDiscourseTurnObservationV2({
    conversationId: input.conversationId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    turnId: input.turnId,
    turnIndex: input.turnIndex,
    roleId: input.roleId,
    surfaceHash: input.surfaceHash,
    learnedFrameIds: [],
    requestedSlotIds: canonicalIds(mentionDrafts.flatMap(mention => mention.requestedSlotIds)),
    explicitAnchorNodeIds: canonicalIds(graphNodes.map(node => String(node.id))),
    scopeIds: canonicalIds(referents.flatMap(referent => referent.sourceVersionIds)),
    mentions: mentionDrafts
  }, input.hasher);
  const routeSignals: DiscourseRouteSignalV2[] = [];
  const provenanceBindings: DiscourseProvenanceBindingV2[] = [];
  for (const mention of observation.mentions) {
    for (const referentId of mention.candidateReferentIds) {
      const referent = referents.find(candidate => candidate.id === referentId);
      if (!referent) continue;
      const evidenceIds = intersectIds(referent.evidenceIds, selectedEvidenceIds)
        .filter(id => mention.sourceIdentityIds?.includes(id));
      const sourceVersionIds = canonicalIds(evidenceIds.map(id => String(evidenceById.get(id)?.sourceVersionId ?? "")));
      if (!evidenceIds.length || !sourceVersionIds.length) continue;
      routeSignals.push({
        mentionId: mention.id,
        referentId: referent.id,
        graphRouteCoherence: graphRouteCoherence(referent, graphNodes, graphEdges, input.result),
        evidenceFit: clamp01(evidenceIds.length / Math.max(1, mention.candidateNodeIds.length)),
        ...(input.previousState?.activeTopicIds.includes(referent.topicId) ? { topicContinuity: 1 } : {}),
        contradictionPressure: referent.contradictionMass,
        scopeFit: clamp01(sourceVersionIds.length / Math.max(1, mention.scopeIds.length))
      });
      provenanceBindings.push(createDiscourseProvenanceBindingV2({
        observationId: observation.id,
        mentionId: mention.id,
        referentId: referent.id,
        routeId: String(proof.id),
        nodeIds: canonicalIds(referent.nodeIds.filter(id => mention.candidateNodeIds.includes(id))),
        claimIds: [String(proof.claimId)],
        evidenceIds,
        sourceVersionIds,
        contradictionIds: [...referent.contradictionIds]
      }, input.hasher));
    }
  }
  return {
    schema: "scce.dialogue_cognitive_shadow_projection.v2",
    status: "observed",
    observation,
    referents,
    topics,
    routeSignals,
    provenanceBindings,
    audit: toJsonValue({
      status: "observed",
      proofId: String(proof.id),
      claimId: String(proof.claimId),
      evidenceIds: selectedEvidenceIds,
      graphNodeIds: graphNodes.map(node => String(node.id)),
      observationId: observation.id,
      mentionIds: observation.mentions.map(mention => mention.id),
      routeSignalCount: routeSignals.length,
      provenanceBindingIds: provenanceBindings.map(binding => binding.id),
      queryConcatenationUsed: false
    })
  };
}

function selectedProofEvidenceIds(result: TurnResult): string[] {
  const proofIds = result.entailment.proof.evidenceIds.map(String);
  const entailmentIds = result.entailment.evidenceIds.map(String);
  const resultIds = result.evidence.map(span => String(span.id));
  const selectedCandidateIds = jsonIdArray(result.selectedCandidate, "evidenceIds");
  const certificateIds = jsonIdArray(result.proofCarryingAnswer, "citedSpanIds");
  if (!proofIds.length || !entailmentIds.length || !resultIds.length || !selectedCandidateIds.length || !certificateIds.length) return [];
  return proofIds.filter(id => entailmentIds.includes(id)
    && resultIds.includes(id)
    && selectedCandidateIds.includes(id)
    && certificateIds.includes(id));
}

function graphNodeReferent(input: {
  node: GraphNode;
  graphEdges: readonly GraphEdge[];
  graphHyperedges: GraphSlice["hyperedges"];
  selectedEvidenceSet: ReadonlySet<string>;
  evidenceById: ReadonlyMap<string, TurnResult["evidence"][number]>;
  result: TurnResult;
  previous?: DiscourseReferentV2;
  previousTopics: ReadonlyMap<string, DiscourseTopicV2>;
  turnId: string;
  turnIndex: number;
}): DiscourseReferentV2 {
  const nodeId = String(input.node.id);
  const evidenceIds = canonicalIds(input.node.evidenceIds.map(String).filter(id => input.selectedEvidenceSet.has(id)));
  const sourceVersionIds = canonicalIds(evidenceIds.map(id => String(input.evidenceById.get(id)?.sourceVersionId ?? "")));
  const relatedEdges = input.graphEdges.filter(edge => String(edge.source) === nodeId || String(edge.target) === nodeId);
  const relatedHyperedges = input.graphHyperedges.filter(edge => edge.memberNodeIds.some(id => String(id) === nodeId));
  const contradictionIds = canonicalIds([
    ...(input.previous?.contradictionIds ?? []),
    ...input.result.entailment.counterexamples
      .filter(counterexample => counterexample.evidenceIds.some(id => evidenceIds.includes(String(id))))
      .map(counterexample => counterexample.id)
  ]);
  const previousTopic = input.previous ? input.previousTopics.get(input.previous.topicId) : undefined;
  const topicId = previousTopic?.id ?? nodeId;
  const mappingSlots = input.result.entailment.mappings.flatMap(mapping => {
    const mappingEvidenceIds = intersectIds(mapping.evidenceIds.map(String), evidenceIds);
    return mappingEvidenceIds.length
      ? [{ slotId: mapping.obligationId, nodeIds: [nodeId], claimIds: [String(input.result.entailment.proof.claimId)], evidenceIds: mappingEvidenceIds }]
      : [];
  });
  const salienceMass = clamp01(Math.max(
    input.node.alpha,
    ...input.result.field.active.filter(row => String(row.nodeId) === nodeId).map(row => row.activation),
    ...input.result.field.ppf.filter(row => String(row.nodeId) === nodeId).map(row => row.mass)
  ));
  return {
    schema: "scce.discourse_referent.v2",
    id: input.previous?.id ?? nodeId,
    topicId,
    introducedTurnId: input.previous?.introducedTurnId ?? input.turnId,
    introducedTurnIndex: input.previous?.introducedTurnIndex ?? input.turnIndex,
    lastMentionTurnIndex: input.turnIndex,
    nodeIds: canonicalIds([...(input.previous?.nodeIds ?? []), nodeId]),
    claimIds: canonicalIds([...(input.previous?.claimIds ?? []), String(input.result.entailment.proof.claimId)]),
    relationIds: canonicalIds([
      ...(input.previous?.relationIds ?? []),
      ...relatedEdges.map(edge => String(edge.relationId)),
      ...relatedHyperedges.map(edge => String(edge.relationId))
    ]),
    evidenceIds: canonicalIds([...(input.previous?.evidenceIds ?? []), ...evidenceIds]),
    sourceVersionIds: canonicalIds([...(input.previous?.sourceVersionIds ?? []), ...sourceVersionIds]),
    contradictionIds,
    semanticRoleIds: [...(input.previous?.semanticRoleIds ?? [])],
    learnedFrameIds: [...(input.previous?.learnedFrameIds ?? [])],
    scopeIds: canonicalIds([...(input.previous?.scopeIds ?? []), ...sourceVersionIds]),
    slotBindings: canonicalSlotBindings([...(input.previous?.slotBindings ?? []), ...mappingSlots]),
    salienceMass: Math.max(input.previous?.salienceMass ?? 0, salienceMass),
    evidenceSupportMass: Math.max(input.previous?.evidenceSupportMass ?? 0, clamp01(input.result.entailment.support)),
    contradictionMass: contradictionIds.length
      ? Math.max(input.previous?.contradictionMass ?? 0, clamp01(input.result.entailment.contradiction))
      : 0,
    authorityClassId: String(input.result.entailment.proof.verdict)
  };
}

function graphNodeTopic(input: {
  referent: DiscourseReferentV2;
  previous?: DiscourseTopicV2;
  proofClaimId: string;
  turnIndex: number;
}): DiscourseTopicV2 {
  return {
    schema: "scce.discourse_topic.v2",
    id: input.referent.topicId,
    statusId: input.referent.authorityClassId,
    anchorNodeIds: canonicalIds([...(input.previous?.anchorNodeIds ?? []), ...input.referent.nodeIds]),
    referentIds: canonicalIds([...(input.previous?.referentIds ?? []), input.referent.id]),
    claimIds: canonicalIds([...(input.previous?.claimIds ?? []), input.proofClaimId]),
    evidenceIds: canonicalIds([...(input.previous?.evidenceIds ?? []), ...input.referent.evidenceIds]),
    ...(input.previous?.parentTopicId ? { parentTopicId: input.previous.parentTopicId } : {}),
    supersedesTopicIds: [...(input.previous?.supersedesTopicIds ?? [])],
    salienceMass: Math.max(input.previous?.salienceMass ?? 0, input.referent.salienceMass),
    lastTurnIndex: input.turnIndex
  };
}

function mergeProjectedTopics(topics: readonly DiscourseTopicV2[]): DiscourseTopicV2[] {
  const byId = new Map<string, DiscourseTopicV2>();
  for (const topic of topics) {
    const previous = byId.get(topic.id);
    byId.set(topic.id, previous ? {
      ...topic,
      anchorNodeIds: canonicalIds([...previous.anchorNodeIds, ...topic.anchorNodeIds]),
      referentIds: canonicalIds([...previous.referentIds, ...topic.referentIds]),
      claimIds: canonicalIds([...previous.claimIds, ...topic.claimIds]),
      evidenceIds: canonicalIds([...previous.evidenceIds, ...topic.evidenceIds]),
      supersedesTopicIds: canonicalIds([...previous.supersedesTopicIds, ...topic.supersedesTopicIds]),
      salienceMass: Math.max(previous.salienceMass, topic.salienceMass),
      lastTurnIndex: Math.max(previous.lastTurnIndex, topic.lastTurnIndex)
    } : topic);
  }
  return [...byId.values()].sort((left, right) => compareIds(left.id, right.id));
}

function graphRouteCoherence(
  referent: DiscourseReferentV2,
  graphNodes: readonly GraphNode[],
  graphEdges: readonly GraphEdge[],
  result: TurnResult
): number {
  const nodeIds = new Set(referent.nodeIds);
  return clamp01(Math.max(
    ...graphNodes.filter(node => nodeIds.has(String(node.id))).map(node => node.alpha),
    ...graphEdges.filter(edge => nodeIds.has(String(edge.source)) || nodeIds.has(String(edge.target)))
      .map(edge => clamp01(edge.alpha * edge.weight)),
    ...result.field.active.filter(row => nodeIds.has(String(row.nodeId))).map(row => row.activation),
    0
  ));
}

function canonicalSlotBindings(bindings: DiscourseReferentV2["slotBindings"]): DiscourseReferentV2["slotBindings"] {
  const bySlot = new Map<string, DiscourseReferentV2["slotBindings"][number]>();
  for (const binding of bindings) {
    const previous = bySlot.get(binding.slotId);
    bySlot.set(binding.slotId, {
      slotId: binding.slotId,
      nodeIds: canonicalIds([...(previous?.nodeIds ?? []), ...binding.nodeIds]),
      claimIds: canonicalIds([...(previous?.claimIds ?? []), ...binding.claimIds]),
      evidenceIds: canonicalIds([...(previous?.evidenceIds ?? []), ...binding.evidenceIds])
    });
  }
  return [...bySlot.values()].sort((left, right) => compareIds(left.slotId, right.slotId));
}

function notObserved(
  reasonId: Extract<DialogueCognitiveShadowProjectionV2, { status: "not_observed" }>["reasonId"],
  audit: Record<string, JsonValue>
): DialogueCognitiveShadowProjectionV2 {
  return {
    schema: "scce.dialogue_cognitive_shadow_projection.v2",
    status: "not_observed",
    reasonId,
    audit: toJsonValue({ status: "not_observed", reasonId, ...audit, queryConcatenationUsed: false })
  };
}

function jsonIdArray(value: JsonValue | undefined, key: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidate = (value as Record<string, JsonValue>)[key];
  return Array.isArray(candidate) ? canonicalIds(candidate.filter((item): item is string => typeof item === "string")) : [];
}

function intersectIds(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return canonicalIds(left.filter(id => rightSet.has(id)));
}

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))].sort(compareIds);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
