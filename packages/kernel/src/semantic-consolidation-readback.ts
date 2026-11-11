// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify } from "./primitives.js";
import { jsonRecord, kernelString, kernelStringArray } from "./kernel-answer-primitives.js";
import { surfaceContainsBoundValue } from "./surface-linguistics.js";
import type { GraphEvidenceAssociationPage, ScceStorage } from "./storage.js";
import type { SemanticClaimGraphReference, SemanticClaimObservation } from "./semantic-memory-consolidation.js";
import type { ConstructGraph, EvidenceId, EvidenceSpan, GraphEdge, GraphNode, GraphSlice, Hasher, JsonValue } from "./types.js";

const EVENT_LIMIT = 32;
const EVIDENCE_LIMIT = 80;

function nodeFingerprint(node: GraphNode, hasher: Hasher): string {
  return hasher.digestHex(canonicalStringify({ id: node.id, typeId: node.typeId, representation: node.representation }));
}

function edgeFingerprint(edge: GraphEdge, hasher: Hasher): string {
  return hasher.digestHex(canonicalStringify({ id: edge.id, source: edge.source, target: edge.target,
    relationId: edge.relationId, temporalScope: edge.temporalScope, metadata: edge.metadata }));
}

export function semanticClaimObservationsFromConstruct(input: {
  construct: ConstructGraph;
  graph: GraphSlice;
  evidence: readonly EvidenceSpan[];
  hasher: Hasher;
  observedAt: number;
}): SemanticClaimObservation[] {
  const node = input.construct.nodes.find(candidate => candidate.kind === "construct:semantic_answer");
  if (!node) return [];
  const metadata = jsonRecord(node.metadata);
  const rawFacts = Array.isArray(metadata.selectedFacts) ? metadata.selectedFacts : [];
  const observations: SemanticClaimObservation[] = [];
  for (const rawFact of rawFacts) {
    const fact = jsonRecord(rawFact);
    const subjectId = kernelString(fact.subject);
    const predicate = kernelString(fact.predicate);
    const object = kernelString(fact.object) ?? "";
    if (!subjectId || !predicate) continue;
    const evidenceIds = [...new Set(kernelStringArray(fact.evidenceIds))].sort();
    const subject = input.graph.nodes.find(candidate => String(candidate.id) === fact.sourceNodeId);
    const target = input.graph.nodes.find(candidate => String(candidate.id) === fact.targetNodeId);
    const edge = subject && target ? input.graph.edges.find(candidate => candidate.source === subject.id
      && candidate.target === target.id && String(candidate.relationId) === fact.relationId
      && evidenceIds.every(id => candidate.evidenceIds.some(evidenceId => String(evidenceId) === id))) : undefined;
    const premises = input.evidence.filter(span => evidenceIds.includes(String(span.id)) && span.status === "promoted");
    if (!subject || !target || !edge || !evidenceIds.length || premises.length !== evidenceIds.length) {
      const sourceVersionId = kernelString(fact.sourceVersionId);
      const primary = premises.find(span => String(span.sourceVersionId) === sourceVersionId);
      const sourceId = primary ? String(primary.sourceId) : "";
      observations.push({ id: `semantic_claim_observation_${input.hasher.digestHex(canonicalStringify({ subjectId, predicate, object, sourceId, evidenceIds })).slice(0, 32)}`,
        subjectId, canonicalValue: { predicate, object }, sourceId, ...(sourceVersionId ? { sourceVersionId } : {}), observedAt: input.observedAt, evidenceIds });
      continue;
    }
    if (!premises.every(span => edge.evidenceIds.includes(span.id))) continue;
    const primary = premises.find(span => String(span.sourceVersionId) === fact.sourceVersionId) ?? premises[0]!;
    const sourceId = String(primary.sourceId);
    const sourceVersionId = String(primary.sourceVersionId);
    const graphReference: SemanticClaimGraphReference = {
      schema: "scce.semantic_claim_graph_reference.v1",
      subjectNodeId: String(subject.id), targetNodeId: String(target.id), relationId: String(edge.relationId), edgeId: String(edge.id),
      subjectFingerprint: nodeFingerprint(subject, input.hasher), targetFingerprint: nodeFingerprint(target, input.hasher),
      edgeFingerprint: edgeFingerprint(edge, input.hasher),
      evidenceWitnesses: [...premises].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(span => ({
        evidenceId: String(span.id), sourceId: String(span.sourceId), sourceVersionId: String(span.sourceVersionId),
        contentHash: String(span.contentHash), textHash: input.hasher.digestHex(span.text) }))
    };
    const canonicalValue = { relationId: graphReference.relationId, targetNodeId: graphReference.targetNodeId };
    observations.push({ id: `semantic_claim_observation_${input.hasher.digestHex(canonicalStringify({ graphReference, canonicalValue })).slice(0, 32)}`,
      subjectId, canonicalValue, sourceId, sourceVersionId, observedAt: input.observedAt, evidenceIds, graphReference });
  }
  return observations;
}

export interface SemanticConsolidationReadback {
  graph: GraphSlice;
  evidence: EvidenceSpan[];
  eventsRead: number;
  matchedObservations: number;
  recoveredObservations: number;
}

export function emptySemanticConsolidationReadback(): SemanticConsolidationReadback {
  return { graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: { evidenceIds: [] } },
    evidence: [], eventsRead: 0, matchedObservations: 0, recoveredObservations: 0 };
}

function ownedObservation(value: JsonValue): SemanticClaimObservation | undefined {
  const row = jsonRecord(value);
  const reference = jsonRecord(row.graphReference);
  const required = ["subjectNodeId", "targetNodeId", "relationId", "edgeId", "subjectFingerprint", "targetFingerprint", "edgeFingerprint"];
  if (reference.schema !== "scce.semantic_claim_graph_reference.v1" || !required.every(key => kernelString(reference[key])) || !Array.isArray(reference.evidenceWitnesses)) return undefined;
  const witnesses = reference.evidenceWitnesses.map(witness => jsonRecord(witness));
  if (!witnesses.length || witnesses.length > EVIDENCE_LIMIT || !witnesses.every(witness =>
    ["evidenceId", "sourceId", "sourceVersionId", "contentHash", "textHash"].every(key => kernelString(witness[key])))) return undefined;
  const sourceId = kernelString(row.sourceId);
  const sourceVersionId = kernelString(row.sourceVersionId);
  const evidenceIds = kernelStringArray(row.evidenceIds);
  if (!sourceId || !sourceVersionId || !kernelString(row.id) || !kernelString(row.subjectId)
    || typeof row.observedAt !== "number" || !Number.isFinite(row.observedAt)) return undefined;
  if (!witnesses.some(witness => witness.sourceId === sourceId && witness.sourceVersionId === sourceVersionId)
    || canonicalStringify([...new Set(evidenceIds)].sort()) !== canonicalStringify(witnesses.map(witness => String(witness.evidenceId)).sort())) return undefined;
  if (canonicalStringify(row.canonicalValue) !== canonicalStringify({ relationId: reference.relationId, targetNodeId: reference.targetNodeId })) return undefined;
  return row as unknown as SemanticClaimObservation;
}

/** Events recover live canonical dependencies; their value text never becomes a new fact. */
export async function readSemanticConsolidationGraph(input: {
  storage: Pick<ScceStorage, "events" | "evidence" | "graph">;
  requestText: string;
  beforeT: number;
  hasher: Hasher;
  evidenceOwnerIds?: ReadonlySet<string>;
  sourceVersionAllowlist?: ReadonlySet<string>;
}): Promise<SemanticConsolidationReadback> {
  const result = emptySemanticConsolidationReadback();
  const events = (await input.storage.events.readRange({ typeId: "SemanticClaimsConsolidated", beforeT: input.beforeT, limit: EVENT_LIMIT })).slice(0, EVENT_LIMIT);
  result.eventsRead = events.length;
  const observations = new Map<string, SemanticClaimObservation>();
  const evidenceIds = new Set<string>();
  for (const event of events) {
    if (event.typeId !== "SemanticClaimsConsolidated" || event.t > input.beforeT || !Array.isArray(event.payload)) continue;
    for (const rawResult of event.payload.slice(0, EVIDENCE_LIMIT)) {
      const row = jsonRecord(rawResult);
      if (!Array.isArray(row.claims)) continue;
      for (const rawClaim of row.claims.slice(0, EVIDENCE_LIMIT)) {
        const claim = jsonRecord(rawClaim);
        if (!Array.isArray(claim.supportingObservations)) continue;
        for (const rawObservation of claim.supportingObservations.slice(0, EVIDENCE_LIMIT)) {
          if (observations.size >= EVIDENCE_LIMIT) break;
          const observation = ownedObservation(rawObservation);
          if (!observation || !surfaceContainsBoundValue(input.requestText, observation.subjectId)) continue;
          if (input.evidenceOwnerIds && !observation.evidenceIds.every(id => input.evidenceOwnerIds!.has(id))) continue;
          const next = new Set([...evidenceIds, ...observation.evidenceIds]);
          if (next.size > EVIDENCE_LIMIT) continue;
          for (const id of observation.evidenceIds) evidenceIds.add(id);
          observations.set(observation.id, observation);
        }
      }
    }
  }
  result.matchedObservations = observations.size;
  if (!observations.size) return result;
  const current = await input.storage.evidence.getEvidenceBatch([...evidenceIds] as EvidenceId[]);
  const live = new Map(current.map(span => [String(span.id), span]));
  const valid = [...observations.values()].filter(observation => observation.graphReference!.evidenceWitnesses.every(witness => {
    const span = live.get(witness.evidenceId);
    return span?.status === "promoted" && (!input.sourceVersionAllowlist || input.sourceVersionAllowlist.has(String(span.sourceVersionId)))
      && String(span.sourceId) === witness.sourceId
      && String(span.sourceVersionId) === witness.sourceVersionId && String(span.contentHash) === witness.contentHash
      && input.hasher.digestHex(span.text) === witness.textHash;
  }));
  if (!valid.length) return result;
  const validIds = [...new Set(valid.flatMap(observation => observation.evidenceIds))] as EvidenceId[];
  const graph = await input.storage.graph.getSlice({ evidenceIds: validIds, evidenceBoundOnly: true, radius: 0, limitNodes: 64, limitEdges: 128 });
  const nodes = new Map(graph.nodes.map(node => [String(node.id), node]));
  const edges = new Map(graph.edges.map(edge => [String(edge.id), edge]));
  const associationPages = new Map<string, Promise<GraphEvidenceAssociationPage>>();
  const recovered: SemanticClaimObservation[] = [];
  for (const observation of valid) {
    const reference = observation.graphReference!;
    const subject = nodes.get(reference.subjectNodeId);
    const target = nodes.get(reference.targetNodeId);
    const edge = edges.get(reference.edgeId);
    if (!subject || !target || !edge || edge.source !== subject.id || edge.target !== target.id
      || String(edge.relationId) !== reference.relationId
      || nodeFingerprint(subject, input.hasher) !== reference.subjectFingerprint
      || nodeFingerprint(target, input.hasher) !== reference.targetFingerprint
      || edgeFingerprint(edge, input.hasher) !== reference.edgeFingerprint) continue;
    let carriesEvidence = observation.evidenceIds.every(id => edge.evidenceIds.some(evidenceId => String(evidenceId) === id));
    if (input.storage.graph.listEvidenceForOwner) {
      let pending = associationPages.get(String(edge.id));
      if (!pending) {
        pending = input.storage.graph.listEvidenceForOwner({
          ownerKind: "edge",
          ownerId: String(edge.id),
          limit: EVIDENCE_LIMIT,
          maxDecodedBytes: 1024 * 1024
        });
        associationPages.set(String(edge.id), pending);
      }
      const page = await pending;
      const pageIds = new Set(page.associations.map(association => String(association.evidenceId)));
      const missing = observation.evidenceIds.filter(id => !pageIds.has(id));
      carriesEvidence = missing.length === 0;
      if (missing.length && page.coverage.completeness === "partial" && input.storage.graph.getEvidenceAssociationMembership) {
        const memberships = await Promise.all(missing.map(evidenceId => input.storage.graph.getEvidenceAssociationMembership!({
          ownerKind: "edge",
          ownerId: String(edge.id),
          evidenceId: evidenceId as EvidenceId
        })));
        carriesEvidence = memberships.every(membership => membership.present
          && membership.coverage.completeness === "complete"
          && membership.coverage.scope === "authorized_membership");
      }
      // A missing row from a partial page is never treated as absence. Without a complete direct lookup the
      // observation remains unqualified and cannot re-enter the proof graph.
    }
    if (carriesEvidence) recovered.push(observation);
  }
  const recoveredIds = new Set(recovered.flatMap(observation => observation.evidenceIds));
  result.evidence = current.filter(span => recoveredIds.has(String(span.id)));
  const recoveredNodes = new Set(recovered.flatMap(observation => [observation.graphReference!.subjectNodeId, observation.graphReference!.targetNodeId]));
  const recoveredEdges = new Set(recovered.map(observation => observation.graphReference!.edgeId));
  result.graph = { ...graph,
    nodes: graph.nodes.filter(node => recoveredNodes.has(String(node.id))).map(node => ({ ...node, evidenceIds: node.evidenceIds.filter(id => recoveredIds.has(String(id))) })),
    edges: graph.edges.filter(edge => recoveredEdges.has(String(edge.id))).map(edge => ({ ...edge, evidenceIds: edge.evidenceIds.filter(id => recoveredIds.has(String(id))) })),
    hyperedges: [], query: { ...graph.query, evidenceIds: result.evidence.map(span => span.id) } };
  result.recoveredObservations = recovered.length;
  return result;
}
