// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  buildConstructionAlgebra,
  compileLanguageTrainingBatch,
  createClock,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  realizeDerivation,
  toJsonValue,
  type EvidenceSpan,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("fresh-source construction composition", () => {
  it("constructs a novel evidence-owned surface from newly learned typed operators", () => {
    const hasher = createHasher();
    const ids = createIdFactory({
      hasher,
      clock: createClock({ fixedTime: 210_000, stepMs: 1 }),
      deterministicReplay: true,
      namespace: "fresh-source-construction-composition"
    });
    const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const language = createLanguageAcquisitionEngine({ idFactory: ids });

    const parentText = "Ada frames";
    const parentEvidence = evidenceForFamilies(ids, parentText, "parent");
    const parentNode = {
      id: "node.parent.ada" as NodeId,
      typeId: "dimension.fixture" as GraphNode["typeId"],
      representation: "Ada",
      alpha: 1,
      evidenceIds: parentEvidence.map(row => row.id),
      features: [],
      createdAt: 210_000,
      updatedAt: 210_000,
      metadata: {}
    } satisfies GraphNode;
    const parentEdge = hyperedge({
      id: "hyperedge.parent",
      relationId: "relation.parent",
      evidence: parentEvidence,
      participant: {
        nodeId: parentNode.id,
        roleId: "relation.leaf"
      }
    });
    const parent = train({
      text: parentText,
      evidence: parentEvidence,
      nodes: [parentNode],
      hyperedges: [parentEdge],
      runtime,
      language,
      hasher
    });

    const leafText = "Nova";
    const leafEvidence = evidenceForFamilies(ids, leafText, "leaf");
    const leafEdge = hyperedge({
      id: "hyperedge.leaf",
      relationId: "relation.leaf",
      evidence: leafEvidence
    });
    const leaf = train({
      text: leafText,
      evidence: leafEvidence,
      nodes: [],
      hyperedges: [leafEdge],
      runtime,
      language,
      hasher
    });

    expect(parent.reversibleConstructions.length).toBeGreaterThan(0);
    expect(leaf.reversibleConstructions.length).toBeGreaterThan(0);
    const algebra = buildConstructionAlgebra({
      constructions: [
        ...parent.reversibleConstructions,
        ...leaf.reversibleConstructions
      ],
      maxRecursionDepth: 3
    });
    const selected = algebra.composed.find(record => {
      const parentOperator = algebra.operators.get(record.baseConstructionId);
      return parentOperator?.resultType === "relation.parent"
        && record.ports.some(port =>
          algebra.operators.get(port.childConstructionId)?.resultType
            === "relation.leaf");
    });
    expect(selected).toBeDefined();

    const realized = realizeDerivation({
      constructionId: selected!.id,
      algebra
    });
    expect(realized.status).toBe("resolved");
    if (realized.status !== "resolved") throw new Error(realized.reason);
    expect(realized.text).toBe("Nova frames");
    expect([parentText, leafText]).not.toContain(realized.text);
    expect(realized.evidenceIds).toEqual(expect.arrayContaining([
      ...parentEvidence.map(row => String(row.id)),
      ...leafEvidence.map(row => String(row.id))
    ]));
    expect(realized.derivation.children).toHaveLength(1);
  });
});

function train(input: {
  text: string;
  evidence: EvidenceSpan[];
  nodes: GraphNode[];
  hyperedges: Hyperedge[];
  runtime: ReturnType<typeof createLanguageMemoryRuntime>;
  language: ReturnType<typeof createLanguageAcquisitionEngine>;
  hasher: ReturnType<typeof createHasher>;
}) {
  const sourceVersionId = input.evidence[0]!.sourceVersionId;
  const profile = input.language.acquire({
    sourceVersionId,
    text: input.text,
    createdAt: 210_000
  });
  return compileLanguageTrainingBatch({
    runtime: input.runtime,
    hasher: input.hasher,
    batch: {
      streamId: `fixture://${sourceVersionId}`,
      profile,
      sourceVersionId,
      text: input.text,
      evidence: input.evidence,
      createdAt: 210_000,
      graphSnapshot: {
        nodes: input.nodes,
        edges: [],
        hyperedges: input.hyperedges
      },
      maxAlignmentCandidateDegree: 8
    }
  });
}

function hyperedge(input: {
  id: string;
  relationId: string;
  evidence: EvidenceSpan[];
  participant?: { nodeId: NodeId; roleId: string };
}): Hyperedge {
  const evidenceIds = input.evidence.map(row => row.id);
  return {
    schema: "scce.hyperedge.v2",
    id: input.id as Hyperedge["id"],
    relationId: input.relationId as Hyperedge["relationId"],
    participantPorts: input.participant ? [{
      portId: `${input.id}.port`,
      roleId: input.participant.roleId,
      nodeId: input.participant.nodeId,
      valueKind: "observable.string",
      realization: "observed",
      evidenceIds
    }] : [],
    memberNodeIds: input.participant ? [input.participant.nodeId] : [],
    qualifiers: {},
    modality: {},
    evidenceIds,
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: evidenceIds.map(String),
    createdAt: 210_000,
    updatedAt: 210_000
  };
}

function evidenceForFamilies(
  ids: ReturnType<typeof createIdFactory>,
  text: string,
  prefix: string
): EvidenceSpan[] {
  return ["a", "b", "c"].map(family => {
    const sourceVersionId = ids.sourceVersionId(
      `${prefix}.${family}\u001f${text}`
    ) as SourceVersionId;
    const sourceId = ids.sourceId("fixture", `fixture://${prefix}.${family}`);
    const contentHash = ids.contentHash(`${prefix}.${family}\u001f${text}`);
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
      provenance: toJsonValue({
        sourceFamilyId: `family.${prefix}.${family}`
      }),
      features: [],
      status: "promoted",
      alpha: 1,
      observedAt: 210_000
    };
  });
}
