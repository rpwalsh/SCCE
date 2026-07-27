import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import {
  graphTemporalScopeFromCanonical,
  unknownGraphTemporalScope
} from "./graph-temporal.js";
import { CANONICAL_TEMPORAL_SCHEMA } from "./canonical-temporal.js";
import type {
  GraphEdge,
  GraphNode,
  Hasher,
  Hyperedge,
  HyperedgeId,
  JsonValue,
  NodeId,
  RelationId
} from "./types.js";

export const TYPED_INCIDENCE_GRAPH_SCHEMA = "scce.typed_incidence_graph.v1" as const;

export interface TypedIncidenceRelationNode {
  id: NodeId;
  hyperedgeId: HyperedgeId;
  relationId: RelationId;
  qualifiers: JsonValue;
  modality: JsonValue;
  temporalScope: JsonValue;
  evidenceIds: Hyperedge["evidenceIds"];
  provenanceRefs: string[];
  informationLabel?: Hyperedge["informationLabel"];
}

export interface TypedParticipantIncidence {
  id: string;
  relationNodeId: NodeId;
  hyperedgeId: HyperedgeId;
  participantNodeId: NodeId | null;
  portId: string;
  roleId: string;
  valueKind: string;
  realization: "observed" | "omitted";
  evidenceIds: Hyperedge["evidenceIds"];
}

export interface TypedIncidenceGraph {
  schema: typeof TYPED_INCIDENCE_GRAPH_SCHEMA;
  id: string;
  sourceHyperedgeIds: HyperedgeId[];
  relationNodes: TypedIncidenceRelationNode[];
  incidences: TypedParticipantIncidence[];
  audit: JsonValue;
}

export interface ActivationIncidenceProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
  incidenceGraph: TypedIncidenceGraph;
}

export function liftHyperedgesToTypedIncidenceGraph(input: {
  hyperedges: readonly Hyperedge[];
  hasher?: Hasher;
}): TypedIncidenceGraph {
  const hasher = input.hasher ?? createHasher();
  const hyperedges = [...input.hyperedges].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)));
  const relationNodes: TypedIncidenceRelationNode[] = [];
  const incidences: TypedParticipantIncidence[] = [];
  for (const hyperedge of hyperedges) {
    const relationNodeId = incidenceRelationNodeId(hasher, hyperedge.id);
    relationNodes.push({
      id: relationNodeId,
      hyperedgeId: hyperedge.id,
      relationId: hyperedge.relationId,
      qualifiers: hyperedge.qualifiers,
      modality: hyperedge.modality,
      temporalScope: hyperedge.temporalScope,
      evidenceIds: [...hyperedge.evidenceIds],
      provenanceRefs: [...hyperedge.provenanceRefs],
      ...(hyperedge.informationLabel ? { informationLabel: hyperedge.informationLabel } : {})
    });
    for (const port of hyperedge.participantPorts) {
      incidences.push({
        id: `incidence.${hasher.digestHex(canonicalStringify([
          hyperedge.id,
          port.portId,
          port.roleId
        ])).slice(0, 40)}`,
        relationNodeId,
        hyperedgeId: hyperedge.id,
        participantNodeId: port.nodeId,
        portId: port.portId,
        roleId: port.roleId,
        valueKind: port.valueKind,
        realization: port.realization,
        evidenceIds: [...port.evidenceIds]
      });
    }
  }
  const canonical = {
    schema: TYPED_INCIDENCE_GRAPH_SCHEMA,
    sourceHyperedgeIds: hyperedges.map(hyperedge => hyperedge.id),
    relationNodes,
    incidences
  };
  return {
    ...canonical,
    id: `incidence_graph.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      projection: "kernel.typed_incidence_graph.lossless.v1",
      hyperedgeCount: hyperedges.length,
      relationNodeCount: relationNodes.length,
      incidenceCount: incidences.length,
      observedIncidenceCount: incidences.filter(row => row.realization === "observed").length,
      omittedIncidenceCount: incidences.filter(row => row.realization === "omitted").length,
      binaryParticipantFlattening: false,
      preservesHyperedgeIdentity: true,
      preservesQualifiers: true
    })
  };
}

export function projectTypedIncidencesForActivation(input: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  hyperedges: readonly Hyperedge[];
  hasher?: Hasher;
}): ActivationIncidenceProjection {
  const hasher = input.hasher ?? createHasher();
  const incidenceGraph = liftHyperedgesToTypedIncidenceGraph({
    hyperedges: input.hyperedges,
    hasher
  });
  const sourceHyperedgeById = new Map(input.hyperedges.map(hyperedge => [
    String(hyperedge.id),
    hyperedge
  ]));
  const relationNodes: GraphNode[] = incidenceGraph.relationNodes.map(relationNode => {
    const source = sourceHyperedgeById.get(String(relationNode.hyperedgeId))!;
    return {
      id: relationNode.id,
      typeId: `dimension.incidence_relation.${hasher.digestHex(String(relationNode.relationId)).slice(0, 24)}` as GraphNode["typeId"],
      representation: toJsonValue({
        schema: "scce.incidence_relation_node.v1",
        hyperedgeId: relationNode.hyperedgeId,
        relationId: relationNode.relationId,
        qualifiers: relationNode.qualifiers,
        modality: relationNode.modality,
        temporalScope: relationNode.temporalScope
      }),
      alpha: hyperedgeAlpha(source),
      evidenceIds: [...relationNode.evidenceIds],
      features: [
        "typed-incidence:relation",
        `relation:${String(relationNode.relationId)}`,
        `arity:${source.participantPorts.length}`,
        ...source.participantPorts.map(port => `role:${port.roleId}`)
      ],
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      metadata: toJsonValue({
        schema: "scce.incidence_relation_node.v1",
        hyperedgeId: relationNode.hyperedgeId,
        qualifiers: relationNode.qualifiers,
        modality: relationNode.modality,
        temporalScope: relationNode.temporalScope,
        provenanceRefs: relationNode.provenanceRefs
      }),
      ...(relationNode.informationLabel ? { informationLabel: relationNode.informationLabel } : {})
    };
  });
  const observedEdges: GraphEdge[] = incidenceGraph.incidences
    .filter((incidence): incidence is TypedParticipantIncidence & { participantNodeId: NodeId } =>
      incidence.realization === "observed" && incidence.participantNodeId !== null)
    .map(incidence => {
      const source = sourceHyperedgeById.get(String(incidence.hyperedgeId))!;
      const relationId = `relation.incidence.${hasher.digestHex(canonicalStringify([
        source.relationId,
        incidence.roleId
      ])).slice(0, 32)}` as RelationId;
      return {
        id: `edge.${hasher.digestHex(incidence.id).slice(0, 40)}` as GraphEdge["id"],
        source: incidence.relationNodeId,
        target: incidence.participantNodeId,
        relationId,
        alpha: hyperedgeAlpha(source),
        weight: hyperedgeAlpha(source),
        temporalScope: graphTemporalScope(source),
        evidenceIds: [...incidence.evidenceIds],
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        metadata: toJsonValue({
          schema: "scce.typed_participant_incidence.v1",
          incidenceId: incidence.id,
          hyperedgeId: incidence.hyperedgeId,
          portId: incidence.portId,
          roleId: incidence.roleId,
          valueKind: incidence.valueKind,
          realization: incidence.realization,
          reversibleForActivation: true
        }),
        ...(source.informationLabel ? { informationLabel: source.informationLabel } : {})
      };
    });
  return {
    nodes: dedupeById([...input.nodes, ...relationNodes]),
    edges: dedupeById([...input.edges, ...observedEdges]),
    incidenceGraph
  };
}

export function isTypedParticipantIncidenceEdge(edge: GraphEdge): boolean {
  return Boolean(edge.metadata
    && typeof edge.metadata === "object"
    && !Array.isArray(edge.metadata)
    && edge.metadata.schema === "scce.typed_participant_incidence.v1");
}

function incidenceRelationNodeId(hasher: Hasher, hyperedgeId: HyperedgeId): NodeId {
  return `node.incidence_relation.${hasher.digestHex(String(hyperedgeId)).slice(0, 40)}` as NodeId;
}

function hyperedgeAlpha(hyperedge: Hyperedge): number {
  const value = hyperedge.weightVector
    && typeof hyperedge.weightVector === "object"
    && !Array.isArray(hyperedge.weightVector)
    ? hyperedge.weightVector.alpha
    : undefined;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.5;
}

function graphTemporalScope(hyperedge: Hyperedge): GraphEdge["temporalScope"] {
  const value = hyperedge.temporalScope
    && typeof hyperedge.temporalScope === "object"
    && !Array.isArray(hyperedge.temporalScope)
    ? hyperedge.temporalScope
    : {};
  if (value.schema === CANONICAL_TEMPORAL_SCHEMA) {
    return graphTemporalScopeFromCanonical(value as never);
  }
  if (typeof value.validFrom === "number" && Number.isFinite(value.validFrom)) {
    return {
      status: "known",
      validFrom: value.validFrom,
      ...(typeof value.validTo === "number" && Number.isFinite(value.validTo)
        ? { validTo: value.validTo }
        : {}),
      provenance: toJsonValue({ migratedFromLegacyHyperedgeScope: true })
    };
  }
  return unknownGraphTemporalScope(1, {
    reason: "source relation has no admitted validity interval",
    hyperedgeId: hyperedge.id
  });
}

function dedupeById<T extends { id: unknown }>(values: readonly T[]): T[] {
  return [...new Map(values.map(value => [String(value.id), value])).values()];
}
