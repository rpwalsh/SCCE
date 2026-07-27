import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createTypedIngestProjector,
  graphFromStructuredSemanticCandidates,
  semanticCandidatesByChannel,
  toJsonValue,
  type EvidenceSpan,
  type SourceId,
  type SourceVersionId
} from "../index.js";

describe("semantic candidate channels and provenance", () => {
  const clock = createClock({ fixedTime: 100, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({
    clock,
    hasher,
    deterministicReplay: true,
    namespace: "semantic-candidate-channels"
  });

  it("separates declared, anchor, cross-document, and weak-free channels", () => {
    const sourceId = "source.channels" as SourceId;
    const sourceVersionId = "version.channels" as SourceVersionId;
    const channels = semanticCandidatesByChannel({
      sourceId,
      sourceVersionId,
      metadata: toJsonValue({
        stateMarkers: [{ marker: "document-ready", support: 0.9 }],
        links: [
          { label: "one", target: "fixture://target" },
          { label: "two", target: "fixture://target" }
        ],
        crossDocumentRelations: [{
          participants: [{ value: "alpha" }, { value: 7 }],
          structure: { arity: 2 },
          support: 0.7,
          alternatives: [{ participantOrder: [1, 0] }]
        }],
        weakFreeSurfaceRelations: [{
          participants: [{ value: "left" }, { value: "right" }],
          structure: { recurrence: 3 },
          assumptions: [{ id: "assumption.surface_alignment" }],
          transformations: [{ id: "transform.substitution" }],
          support: 0.4
        }]
      }),
      observations: [],
      evidenceIds: ["evidence.channels" as EvidenceSpan["id"]],
      observedAt: 100,
      producerModelId: "candidate.model.fixture",
      producerSnapshotId: "candidate.snapshot.fixture",
      sourceDependencyGroupIds: ["dependency.family.fixture"],
      hasher
    });

    expect(channels.source_declared_structured.some(candidate =>
      candidate.kind === "state_marker" && candidate.participants.length === 0)).toBe(true);
    expect(channels.anchor_derived.some(candidate => candidate.kind === "link")).toBe(true);
    expect(channels.cross_document_induced.some(candidate =>
      candidate.kind === "repeated_reference")).toBe(true);
    expect(channels.cross_document_induced.some(candidate =>
      candidate.kind === "opaque_induced_relation")).toBe(true);
    expect(channels.weak_free_surface).toHaveLength(1);
    const portIds = Object.values(channels).flat()
      .flatMap(candidate => candidate.participants.map(participant => participant.portId));
    expect(new Set(portIds).size).toBe(portIds.length);
    for (const candidate of Object.values(channels).flat()) {
      expect(candidate.schema).toBe("scce.semantic_candidate.v2");
      expect(candidate.channel).toBe(candidate.provenance.extractionChannel);
      expect(candidate.provenance.exactEvidenceIds).toEqual(["evidence.channels"]);
      expect(candidate.provenance.sourceIndependence).toEqual({
        independentSourceCount: 1,
        dependencyGroupIds: ["dependency.family.fixture"],
        estimate: 1
      });
      expect(candidate.provenance.producer).toEqual({
        modelId: "candidate.model.fixture",
        snapshotId: "candidate.snapshot.fixture"
      });
      expect(candidate.provenance.admissionState).toBe("proposed");
    }
    for (const candidate of [
      ...channels.cross_document_induced.filter(row => row.kind === "opaque_induced_relation"),
      ...channels.weak_free_surface
    ]) {
      expect(candidate.relationSeedId).toMatch(/^relation_seed\.opaque\./);
      expect(candidate.relationSeedId).not.toMatch(/link|date|target/i);
      expect(candidate.participants.every(participant =>
        participant.valueKind.startsWith("observable."))).toBe(true);
    }
  });

  it("does not directly admit a zero-arity declaration without exact evidence", () => {
    const channels = semanticCandidatesByChannel({
      sourceId: "source.no-evidence" as SourceId,
      sourceVersionId: "version.no-evidence" as SourceVersionId,
      metadata: toJsonValue({ stateMarkers: [{ marker: "ready" }] }),
      observations: [],
      evidenceIds: [],
      observedAt: 100,
      hasher
    });
    const graph = graphFromStructuredSemanticCandidates({
      candidates: channels.source_declared_structured,
      observedAt: 100,
      ids,
      hasher
    });

    expect(channels.source_declared_structured).toHaveLength(1);
    expect(graph).toEqual({ nodes: [], edges: [], hyperedges: [] });
  });

  it("produces and promotes source-declared zero-arity observations through typed ingestion", () => {
    const text = "document state";
    const evidence = evidenceFor("fixture://zero-arity", text);
    const projection = createTypedIngestProjector({ idFactory: ids, hasher }).project({
      sourceId: evidence.sourceId,
      sourceVersionId: evidence.sourceVersionId,
      uri: "fixture://zero-arity",
      mediaType: "text/plain",
      text,
      metadata: toJsonValue({
        stateMarkers: [{ marker: "ready" }],
        sourceEvents: [{ event: "snapshot-opened" }]
      }),
      evidence: [evidence],
      observedAt: 100
    });
    const zeroArity = projection.semanticCandidates.filter(candidate =>
      candidate.participants.length === 0);

    expect(zeroArity.map(candidate => candidate.kind).sort())
      .toEqual(["source_event", "state_marker"]);
    expect(projection.graphHyperedges.filter(edge =>
      edge.participantPorts.length === 0)).toHaveLength(2);
    expect(projection.graphHyperedges.filter(edge =>
      edge.participantPorts.length === 0)
      .every(edge => edge.memberNodeIds.length === 0)).toBe(true);
    expect(JSON.stringify(projection.diagnostics)).toContain(
      "\"candidateChannelsEvaluatedSeparately\":true"
    );

    const graph = graphFromStructuredSemanticCandidates({
      candidates: zeroArity,
      observedAt: 100,
      ids,
      hasher
    });
    expect(graph.hyperedges).toHaveLength(2);
    expect(graph.hyperedges.every(edge =>
      edge.participantPorts.length === 0
      && edge.memberNodeIds.length === 0)).toBe(true);
  });

  function evidenceFor(uri: string, text: string): EvidenceSpan {
    const sourceId = ids.sourceId("semantic-candidate-channels", uri);
    const sourceVersionId = ids.sourceVersionId(text);
    const contentHash = ids.contentHash(text);
    return {
      id: ids.evidenceId({
        sourceVersionId,
        byteStart: 0,
        byteEnd: Buffer.byteLength(text),
        spanHash: contentHash
      }),
      sourceId,
      sourceVersionId,
      chunkId: ids.chunkId({
        sourceVersionId,
        byteStart: 0,
        byteEnd: Buffer.byteLength(text),
        chunkHash: contentHash
      }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: Buffer.byteLength(text),
      charStart: 0,
      charEnd: [...text].length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ uri }),
      features: [],
      status: "promoted",
      alpha: 1,
      observedAt: 100
    };
  }
});
