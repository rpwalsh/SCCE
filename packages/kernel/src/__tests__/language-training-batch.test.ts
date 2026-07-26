import { describe, expect, it } from "vitest";
import {
  compileLanguageTrainingBatch,
  createClock,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  toJsonValue,
  type EvidenceSpan,
  type GraphNode,
  type Hyperedge,
  type NodeId
} from "../index.js";

describe("shared language training batch", () => {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 140_000, stepMs: 1 });
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "language-training-batch" });
  const language = createLanguageAcquisitionEngine({ idFactory: ids });
  const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

  it("processes input beyond symbolizeData's historical 200k-symbol prefix as bounded model chunks", () => {
    const sentence = "alpha beta gamma delta. ";
    const text = sentence.repeat(Math.ceil(310_000 / sentence.length)).slice(0, 310_000);
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
    const compiled = compileLanguageTrainingBatch({
      runtime,
      hasher,
      batch: {
        streamId: "fixture://large-language-source",
        profile,
        sourceVersionId,
        text,
        evidence: [],
        createdAt: 140_000,
        maxOrder: 3,
        maxCountersPerOrder: 64,
        vocabularyLimit: 512
      }
    });

    const audit = compiled.audit as Record<string, unknown>;
    expect(audit.completeInputCoverage).toBe(true);
    expect(audit.inputUtf16Length).toBe(text.length);
    expect(audit.chunks).toBeGreaterThan(1);
    expect(compiled.models).toHaveLength(audit.chunks as number);
    expect(new Set(compiled.models.map(model => model.streamId)).size).toBe(audit.chunks);
  });

  it("compiles bounded typed-incidence candidate supports on the production training path", () => {
    const text = "Ada built engine.";
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
    const evidence = evidenceSpan(text, sourceVersionId);
    const node = {
      id: "node.ada" as NodeId,
      typeId: "dimension.fixture" as GraphNode["typeId"],
      representation: "Ada",
      alpha: 1,
      evidenceIds: [evidence.id],
      features: [],
      createdAt: 140_000,
      updatedAt: 140_000,
      metadata: {}
    } satisfies GraphNode;
    const hyperedge = {
      schema: "scce.hyperedge.v2",
      id: "hyperedge.ada" as Hyperedge["id"],
      relationId: "relation.built" as Hyperedge["relationId"],
      participantPorts: [{
        portId: "port.ada",
        roleId: "role.opaque",
        nodeId: node.id,
        valueKind: "observable.string",
        realization: "observed",
        evidenceIds: [evidence.id]
      }],
      memberNodeIds: [node.id],
      qualifiers: {},
      modality: {},
      evidenceIds: [evidence.id],
      weightVector: { alpha: 1 },
      temporalScope: {},
      provenanceRefs: [String(evidence.id)],
      createdAt: 140_000,
      updatedAt: 140_000
    } satisfies Hyperedge;
    const compiled = compileLanguageTrainingBatch({
      runtime,
      hasher,
      batch: {
        streamId: "fixture://typed-incidence-training",
        profile,
        sourceVersionId,
        text,
        evidence: [evidence],
        createdAt: 140_000,
        graphSnapshot: { nodes: [node], edges: [], hyperedges: [hyperedge] },
        maxAlignmentCandidateDegree: 2
      }
    });

    expect(compiled.sparseAlignmentCandidateSupports).toHaveLength(1);
    expect(compiled.sparseAlignmentCandidateSupports[0]!.maxCandidateDegree).toBe(2);
    expect(compiled.sparseAlignmentCandidateSupports[0]!.candidates.some(candidate =>
      candidate.supportKinds.includes("exact_observable_anchor"))).toBe(true);
    expect(compiled.sparseAlignmentCandidateSummaries).toHaveLength(1);
    expect(compiled.sparseTransportPlans).toHaveLength(1);
    expect(compiled.sparseTransportPlans[0]!.cells).toHaveLength(
      compiled.sparseAlignmentCandidateSupports[0]!.candidates.length
    );
    expect(compiled.sparseTransportPlans[0]!.globalOptimalityClaimed).toBe(false);
    expect(compiled.typedNullCostModel).toMatchObject({
      schema: "scce.typed_null_alignment_cost_model.v1",
      calibrated: false
    });
    expect(compiled.sparseTransportPlans[0]!.typedNullCostModelId).toBe(
      compiled.typedNullCostModel!.id
    );
    expect(compiled.populationOrderingModel).toMatchObject({
      schema: "scce.population_relative_order_model.v1"
    });
    expect(compiled.sparseTransportPlans[0]!.populationOrderingModelId).toBe(
      compiled.populationOrderingModel!.id
    );
    expect(compiled.crossDocumentAlignmentModel).toMatchObject({
      schema: "scce.cross_document_alignment_consistency.v1"
    });
    expect(compiled.sparseTransportPlans[0]!.crossDocumentAlignmentModelId).toBe(
      compiled.crossDocumentAlignmentModel!.id
    );
    expect(compiled.sparseTransportPlans[0]!.rowMarginals.every(row =>
      row.surfaceNullMass >= 0)).toBe(true);
    expect(compiled.sparseTransportPlans[0]!.columnMarginals.every(column =>
      column.graphImplicitMass >= 0)).toBe(true);
    expect(compiled.transportEvidenceAllocations).toHaveLength(1);
    expect(compiled.transportEvidenceAllocations[0]!.status).toBe("conserved");
    expect(compiled.transportEvidenceAllocations[0]!.totalAllocatedMass).toBeCloseTo(
      compiled.transportEvidenceAllocations[0]!.totalTransportMass,
      12
    );
    expect(JSON.stringify(compiled.audit)).toContain("\"denseMatrixMaterialized\":false");
  });

  function evidenceSpan(text: string, sourceVersionId: ReturnType<typeof ids.sourceVersionId>): EvidenceSpan {
    const sourceId = ids.sourceId("fixture", "fixture://typed-incidence-training");
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
      provenance: toJsonValue({ sourceFamilyId: "family.fixture" }),
      features: [],
      status: "promoted",
      alpha: 1,
      observedAt: 140_000
    };
  }
});
