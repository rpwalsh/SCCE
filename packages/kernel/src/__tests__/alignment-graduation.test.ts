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
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("unseen-family alignment graduation", () => {
  it("runs candidates through held-out recovery, promotion, and construction", () => {
    const hasher = createHasher();
    const clock = createClock({ fixedTime: 200_000, stepMs: 1 });
    const ids = createIdFactory({
      clock,
      hasher,
      deterministicReplay: true,
      namespace: "alignment-graduation"
    });
    const text = "Ada writes";
    const evidence = ["a", "b", "c"].map(family =>
      evidenceSpan(ids, text, family));
    const profileSourceVersionId = evidence[0]!.sourceVersionId;
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({
      sourceVersionId: profileSourceVersionId,
      text,
      createdAt: 200_000
    });
    const node = {
      id: "node.ada" as NodeId,
      typeId: "dimension.fixture" as GraphNode["typeId"],
      representation: "Ada",
      alpha: 1,
      evidenceIds: evidence.map(row => row.id),
      features: [],
      createdAt: 200_000,
      updatedAt: 200_000,
      metadata: {}
    } satisfies GraphNode;
    const hyperedge = {
      schema: "scce.hyperedge.v2",
      id: "hyperedge.writes" as Hyperedge["id"],
      relationId: "relation.writes" as Hyperedge["relationId"],
      participantPorts: [{
        portId: "port.writer",
        roleId: "role.opaque.writer",
        nodeId: node.id,
        valueKind: "observable.string",
        realization: "observed",
        evidenceIds: evidence.map(row => row.id)
      }],
      memberNodeIds: [node.id],
      qualifiers: {},
      modality: {},
      evidenceIds: evidence.map(row => row.id),
      weightVector: { alpha: 1 },
      temporalScope: {},
      provenanceRefs: evidence.map(row => String(row.id)),
      createdAt: 200_000,
      updatedAt: 200_000
    } satisfies Hyperedge;
    const compiled = compileLanguageTrainingBatch({
      runtime: createLanguageMemoryRuntime({ idFactory: ids, hasher }),
      hasher,
      batch: {
        streamId: "fixture://alignment-graduation",
        profile,
        sourceVersionId: profileSourceVersionId,
        text: evidence.map(row => row.text).join("\n"),
        evidence,
        createdAt: 200_000,
        graphSnapshot: {
          nodes: [node],
          edges: [],
          hyperedges: [hyperedge]
        },
        maxAlignmentCandidateDegree: 8
      }
    });

    expect(compiled.alignmentHeldoutEvaluation.artifacts.length)
      .toBeGreaterThan(0);
    expect(compiled.alignmentHeldoutEvaluation.candidateRecall).toMatchObject({
      minimum: 1,
      perfectCount: expect.any(Number)
    });
    expect(compiled.alignmentHeldoutEvaluation.calibrationObservations.length)
      .toBeGreaterThan(0);
    expect(compiled.alignmentPromotionModel.decisions.some(row =>
      row.promoted)).toBe(true);
    expect(compiled.reversibleConstructions.length).toBeGreaterThan(0);
    expect(compiled.reversibleConstructionPatterns.length).toBe(
      compiled.reversibleConstructions.length
    );
    expect(compiled.reversibleConstructions.every(construction =>
      construction.executableDirections[0] === "interpretation"
      && construction.executableDirections[1] === "realization")).toBe(true);
  });
});

function evidenceSpan(
  ids: ReturnType<typeof createIdFactory>,
  text: string,
  family: string
): EvidenceSpan {
  const sourceVersionId = ids.sourceVersionId(
    `${family}\u001f${text}`
  ) as SourceVersionId;
  const sourceId = ids.sourceId("fixture", `fixture://${family}`);
  const contentHash = ids.contentHash(`${family}\u001f${text}`);
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
    provenance: toJsonValue({ sourceFamilyId: `family.${family}` }),
    features: [],
    status: "promoted",
    alpha: 1,
    observedAt: 200_000
  };
}
