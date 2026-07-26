import { describe, expect, it } from "vitest";
import { createAlphaFieldEngine } from "../field.js";
import {
  liftHyperedgesToTypedIncidenceGraph,
  projectTypedIncidencesForActivation
} from "../typed-incidence-graph.js";
import type {
  EvidenceId,
  GraphNode,
  Hyperedge,
  NodeId
} from "../types.js";

describe("typed incidence graph", () => {
  it("losslessly lifts arbitrary and zero-arity hyperedges without binary flattening", () => {
    const relation = hyperedge("hyperedge.event", [
      port("port.actor", "role.actor", "node.actor"),
      port("port.theme", "role.theme", "node.theme"),
      port("port.time", "role.time", "node.time"),
      port("port.implicit", "role.implicit", null)
    ], {
      qualifier: "preserved"
    });
    const zero = hyperedge("hyperedge.state", [], { state: "present" });
    const graph = liftHyperedgesToTypedIncidenceGraph({
      hyperedges: [relation, zero]
    });

    expect(graph.schema).toBe("scce.typed_incidence_graph.v1");
    expect(graph.relationNodes).toHaveLength(2);
    expect(graph.incidences).toHaveLength(4);
    expect(graph.incidences.filter(row => row.realization === "omitted")).toHaveLength(1);
    expect(graph.relationNodes.find(row => String(row.hyperedgeId) === "hyperedge.event"))
      .toMatchObject({
        hyperedgeId: "hyperedge.event",
        qualifiers: { qualifier: "preserved" }
      });
    expect(graph.relationNodes.find(row => String(row.hyperedgeId) === "hyperedge.state"))
      .toMatchObject({
        hyperedgeId: "hyperedge.state",
        qualifiers: { state: "present" }
      });
    expect(graph.audit).toMatchObject({
      binaryParticipantFlattening: false,
      preservesHyperedgeIdentity: true,
      preservesQualifiers: true
    });
  });

  it("activates across reversible typed incidences without participant cliques", () => {
    const nodes = [
      node("node.actor", ["anchor"]),
      node("node.theme", ["theme"]),
      node("node.time", ["time"])
    ];
    const source = hyperedge("hyperedge.event", [
      port("port.actor", "role.actor", "node.actor"),
      port("port.theme", "role.theme", "node.theme"),
      port("port.time", "role.time", "node.time"),
      port("port.implicit", "role.implicit", null)
    ], { kind: "event" });
    const projection = projectTypedIncidencesForActivation({
      nodes,
      edges: [],
      hyperedges: [source]
    });

    expect(projection.edges).toHaveLength(3);
    expect(projection.edges.every(edge =>
      String(edge.source).startsWith("node.incidence_relation."))).toBe(true);
    expect(projection.edges.some(edge =>
      String(edge.source) === "node.actor" && String(edge.target) === "node.theme")).toBe(false);

    const field = createAlphaFieldEngine().activate({
      text: "anchor",
      nodes,
      edges: [],
      hyperedges: [source]
    });
    const mass = new Map(field.ppf.map(row => [String(row.nodeId), row.mass]));

    expect(mass.get("node.actor")).toBeGreaterThan(0);
    expect(mass.get("node.theme")).toBeGreaterThan(0);
    expect(mass.get("node.time")).toBeGreaterThan(0);
    expect(field.ppfDiagnostics).toMatchObject({
      typedIncidence: {
        hyperedgeCount: 1,
        incidenceCount: 4,
        omittedIncidenceCount: 1,
        binaryParticipantFlattening: false
      }
    });
  });
});

function node(id: string, features: string[]): GraphNode {
  return {
    id: id as NodeId,
    typeId: "dimension.test" as GraphNode["typeId"],
    representation: id,
    alpha: 1,
    evidenceIds: ["evidence.test" as EvidenceId],
    features,
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function port(
  portId: string,
  roleId: string,
  nodeId: string | null
): Hyperedge["participantPorts"][number] {
  return {
    portId,
    roleId,
    nodeId: nodeId as NodeId | null,
    valueKind: "test",
    realization: nodeId === null ? "omitted" : "observed",
    evidenceIds: ["evidence.test" as EvidenceId]
  };
}

function hyperedge(
  id: string,
  participantPorts: Hyperedge["participantPorts"],
  qualifiers: Hyperedge["qualifiers"]
): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: id as Hyperedge["id"],
    relationId: "relation.event" as Hyperedge["relationId"],
    participantPorts,
    memberNodeIds: participantPorts
      .filter(port => port.nodeId !== null)
      .map(port => port.nodeId as NodeId),
    qualifiers,
    modality: { asserted: true },
    evidenceIds: ["evidence.test" as EvidenceId],
    weightVector: { alpha: 1 },
    temporalScope: { validFrom: 1 },
    provenanceRefs: ["evidence.test"],
    createdAt: 1,
    updatedAt: 1
  };
}
