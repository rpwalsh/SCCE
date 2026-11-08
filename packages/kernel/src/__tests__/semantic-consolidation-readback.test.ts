// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, toJsonValue } from "../primitives.js";
import { consolidateSemanticClaims } from "../semantic-memory-consolidation.js";
import { readSemanticConsolidationGraph, semanticClaimObservationsFromConstruct } from "../semantic-consolidation-readback.js";
import { resolveRequestValueBinding } from "../semantic-answer-construct.js";
import { createSemanticProofSystem, PROOF_CONTRADICTION_THRESHOLD } from "../semantic-proof-system.js";
import type { ScceStorage } from "../storage.js";
import type { ConstructGraph, EvidenceSpan, GraphEdge, GraphNode, GraphSlice, ScceEvent } from "../types.js";

const hasher = createHasher();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture() {
  const evidence: EvidenceSpan[] = [];
  const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
  const events: ScceEvent[] = [];
  function observe(value: number, sourceVersionId: string, sourceId = sourceVersionId, subjectNodeId = "canonical.xylor") {
    const id = `evidence.${sourceVersionId}`;
    const text = `Xylor-7 decomposes at ${value} degrees Celsius.`;
    const span = { id, sourceId, sourceVersionId, contentHash: hasher.digestHex(text), text, textPreview: text,
      status: "promoted", alpha: 0.9, provenance: {}, observedAt: 10 } as unknown as EvidenceSpan;
    evidence.push(span);
    const subject = { id: subjectNodeId, typeId: "entity", representation: { label: "Xylor-7", certifiesFactualProof: false },
      evidenceIds: [id], metadata: {}, alpha: 0.9, features: [], createdAt: 10, updatedAt: 10 } as unknown as GraphNode;
    const target = { ...subject, id: `value.${value}`, representation: { text, value, certifiesFactualProof: false } } as unknown as GraphNode;
    if (!graph.nodes.some(node => node.id === subject.id)) graph.nodes.push(subject);
    if (!graph.nodes.some(node => node.id === target.id)) graph.nodes.push(target);
    const edge = { id: `edge.${sourceVersionId}`, source: subject.id, target: target.id, relationId: "relation.decomposes",
      evidenceIds: [id], metadata: { forceClass: "direct_evidence" }, temporalScope: { status: "atemporal" },
      alpha: 0.9, weight: 0.9, createdAt: 10, updatedAt: 10 } as unknown as GraphEdge;
    graph.edges.push(edge);
    const construct = { nodes: [{ kind: "construct:semantic_answer", metadata: { selectedFacts: [{
      subject: "Xylor-7", predicate: "decomposes at", object: `${value} degrees Celsius`, sourceNodeId: subject.id,
      targetNodeId: target.id, relationId: edge.relationId, sourceVersionId, evidenceIds: [id], forceClass: "direct_evidence"
    }] } }] } as unknown as ConstructGraph;
    const observations = semanticClaimObservationsFromConstruct({ construct, graph, evidence, hasher, observedAt: 11 });
    return { span, subject, target, edge, construct, observations };
  }
  function persist(observations: ReturnType<typeof semanticClaimObservationsFromConstruct>) {
    events.push({ id: `event.${events.length}`, episodeId: `episode.${events.length}`, t: 12,
      typeId: "SemanticClaimsConsolidated", payload: toJsonValue(consolidateSemanticClaims(observations)), parents: [], hash: "fixture" } as ScceEvent);
  }
  const storage = { events: { readRange: async () => events }, evidence: {
    getEvidenceBatch: async (ids: string[]) => evidence.filter(span => ids.includes(String(span.id)))
  }, graph: { getSlice: async () => graph } } as unknown as Pick<ScceStorage, "events" | "evidence" | "graph">;
  const read = (requestText = "At what temperature does Xylor-7 decompose?") =>
    readSemanticConsolidationGraph({ storage, requestText, beforeT: 20, hasher });
  return { evidence, graph, events, observe, persist, storage, read };
}

function boundValue(read: Awaited<ReturnType<typeof readSemanticConsolidationGraph>>) {
  return resolveRequestValueBinding({ requestText: "At what temperature does Xylor-7 decompose?", evidence: read.evidence,
    resolvers: [{ id: "current.canonical.graph", resolve: () => {
      const edge = read.graph.edges[0];
      const target = read.graph.nodes.find(node => node.id === edge?.target);
      const value = (target?.representation as { value?: number } | undefined)?.value;
      return value === undefined ? undefined : { value: String(value), evidenceIds: edge!.evidenceIds.map(String) };
    } }] });
}

describe("semantic consolidation recovers the canonical source graph", () => {
  it("recovers a value after restart without writing a parallel fact or upgrading proof status", async () => {
    const f = fixture();
    f.persist(f.observe(417, "version.a", "source.lab").observations);
    f.events.splice(0, f.events.length, ...copy(f.events));
    f.evidence.splice(0, f.evidence.length, ...copy(f.evidence));
    f.graph.nodes = copy(f.graph.nodes);
    f.graph.edges = copy(f.graph.edges);
    const before = JSON.stringify(f.graph);
    const read = await f.read();
    expect(read.recoveredObservations).toBe(1);
    expect(boundValue(read)?.value).toBe("417");
    expect(read.graph.nodes.map(node => node.id)).toEqual(f.graph.nodes.map(node => node.id));
    expect(read.graph.nodes.every(node => (node.representation as { certifiesFactualProof: boolean }).certifiesFactualProof === false)).toBe(true);
    expect(JSON.stringify(f.graph)).toBe(before);
    f.events.push(...copy(f.events));
    expect((await f.read()).graph).toEqual(read.graph);
    expect((await f.read()).recoveredObservations).toBe(1);
  });

  it.each(["removed", "quarantined", "changed_text", "changed_source", "changed_graph", "forged_value"])("rejects stale or wrong-value dependencies: %s", async mutation => {
    const f = fixture();
    const first = f.observe(417, "version.a");
    const premise = { ...first.span, id: "evidence.premise" as EvidenceSpan["id"] };
    f.evidence.push(premise);
    first.edge.evidenceIds.push(premise.id);
    const facts = (first.construct.nodes[0]!.metadata as { selectedFacts: Array<{ evidenceIds: string[] }> }).selectedFacts;
    facts[0]!.evidenceIds.push(String(premise.id));
    f.persist(semanticClaimObservationsFromConstruct({ construct: first.construct, graph: f.graph, evidence: f.evidence, hasher, observedAt: 11 }));
    expect((await f.read()).recoveredObservations).toBe(1);
    if (mutation === "removed") f.evidence.splice(f.evidence.indexOf(premise), 1);
    if (mutation === "quarantined") premise.status = "quarantined";
    if (mutation === "changed_text") premise.text = premise.text.replace("417", "431");
    if (mutation === "changed_source") premise.sourceId = "other.owner" as EvidenceSpan["sourceId"];
    if (mutation === "changed_graph") first.target.representation = { value: 431 };
    if (mutation === "forged_value") {
      const payload = f.events[0]!.payload as unknown as Array<{ claims: Array<{ supportingObservations: Array<{ canonicalValue: unknown }> }> }>;
      payload[0]!.claims[0]!.supportingObservations[0]!.canonicalValue = { relationId: first.edge.relationId, targetNodeId: "invented.value.431" };
    }
    const read = await f.read();
    expect(read.evidence).toEqual([]);
    expect(boundValue(read)).toBeUndefined();
  });

  it("preserves per-source contradictions and does not count versions of one source as independent owners", async () => {
    const f = fixture();
    const first = f.observe(417, "version.a", "source.lab");
    const repeat = f.observe(417, "version.a2", "source.lab");
    const other = f.observe(431, "version.b", "source.other");
    const consolidated = consolidateSemanticClaims([...first.observations, ...repeat.observations, ...other.observations]);
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]!.contradictory).toBe(true);
    const equal = consolidated[0]!.claims.find(claim => (claim.canonicalValue as { targetNodeId: string }).targetNodeId === "value.417")!;
    expect(equal.sourceIds).toEqual(["source.lab"]);
    expect(equal.sourceVersionIds).toEqual(["version.a", "version.a2"]);
    expect(equal.supportingObservations.map(observation => observation.evidenceIds)).toEqual([["evidence.version.a"], ["evidence.version.a2"]]);
    f.persist([...first.observations, ...repeat.observations, ...other.observations]);
    const read = await f.read();
    const proof = createSemanticProofSystem({ hasher }).prove({ claimText: first.span.text, evidence: read.evidence, nodes: read.graph.nodes });
    expect(proof.contradiction).toBeGreaterThan(PROOF_CONTRADICTION_THRESHOLD);
    expect(new Set(read.evidence.map(span => String(span.sourceId)))).toEqual(new Set(["source.lab", "source.other"]));
  });

  it("keeps homonyms separate and makes legacy or invented prose audit-only", async () => {
    const f = fixture();
    const first = f.observe(417, "version.a", "source.a", "canonical.a");
    const other = f.observe(431, "version.b", "source.b", "canonical.b");
    expect(consolidateSemanticClaims([...first.observations, ...other.observations])).toHaveLength(2);
    const { graphReference: _reference, ...unbound } = first.observations[0]!;
    f.persist([unbound]);
    expect((await f.read()).evidence).toEqual([]);
    expect((await f.read("Tell me about an unrelated subject")).evidence).toEqual([]);
    const read = await readSemanticConsolidationGraph({ storage: f.storage, requestText: "Xylor-7", beforeT: 20, hasher,
      evidenceOwnerIds: new Set(["evidence.foreign"]) });
    expect(read.evidence).toEqual([]);
  });
});
