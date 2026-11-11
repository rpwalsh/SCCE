// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildConstructionAlgebra,
  compileLanguageTrainingBatch,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createInventionConstruct,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  featureSet,
  inventionConstructNode,
  realizeDerivation,
  searchTargetConditionedDerivation,
  toJsonValue,
  type CandidateSurface,
  type ConstructGraph,
  type EvidenceId,
  type EvidenceSpan,
  type FieldState,
  type GraphNode,
  type Hyperedge,
  type InformationLabel,
  type LanguageProfile,
  type NodeId,
  type SourceVersion,
  type SourceVersionId
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();

describe("fresh-source construction composition after PostgreSQL restart", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "cold-restores learned operators and Mouth speaks a novel evidence-owned composition",
    async () => {
      const schema = `scce_fresh_composition_${randomUUID().replaceAll("-", "")}`;
      const clock = createClock({ fixedTime: 210_000, stepMs: 1 });
      const hasher = createHasher();
      const ids = createIdFactory({
        hasher,
        clock,
        deterministicReplay: true,
        namespace: "postgres-fresh-source-composition"
      });
      const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
      const language = createLanguageAcquisitionEngine({ idFactory: ids });
      const informationAccess = {
        tenantId: "fixture.fresh-composition",
        principalId: "fixture.owner",
        compartments: [] as string[],
        maximumExportClass: "restricted" as const
      };
      const informationLabel: InformationLabel = {
        tenantId: informationAccess.tenantId,
        principals: [informationAccess.principalId],
        compartments: [],
        exportClass: "restricted",
        mergePolicy: "isolated"
      };
      let writer: PostgresStorageAdapter | undefined = createPostgresStorageAdapter({
        url: liveDatabaseUrl!, schema, informationAccess
      });
      let reader: PostgresStorageAdapter | undefined;
      try {
        await writer.migrate();
        const parentText = "Ada frames.";
        const parentEvidence = await evidenceForFamilies({
          storage: writer, ids, text: parentText, prefix: "parent", informationLabel
        });
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
        const parent = train({
          text: parentText,
          evidence: parentEvidence,
          nodes: [parentNode],
          hyperedges: [hyperedge({
            id: "hyperedge.parent",
            relationId: "relation.parent",
            evidence: parentEvidence,
            participant: { nodeId: parentNode.id, roleId: "relation.leaf" }
          })],
          runtime,
          language,
          hasher
        });

        const leafText = "Nova";
        const leafEvidence = await evidenceForFamilies({
          storage: writer, ids, text: leafText, prefix: "leaf", informationLabel
        });
        const leaf = train({
          text: leafText,
          evidence: leafEvidence,
          nodes: [],
          hyperedges: [hyperedge({ id: "hyperedge.leaf", relationId: "relation.leaf", evidence: leafEvidence })],
          runtime,
          language,
          hasher
        });
        expect(parent.compiled.reversibleConstructions.length).toBeGreaterThan(0);
        expect(leaf.compiled.reversibleConstructions.length).toBeGreaterThan(0);

        const warmAlgebra = buildConstructionAlgebra({
          constructions: [
            ...parent.compiled.reversibleConstructions,
            ...leaf.compiled.reversibleConstructions
          ],
          maxRecursionDepth: 3
        });
        const warmComposition = warmAlgebra.composed.find(record => {
          const realization = realizeDerivation({ constructionId: record.id, algebra: warmAlgebra });
          return realization.status === "resolved" && realization.text === "Nova frames";
        });
        expect(warmComposition).toBeDefined();
        const constructionIds = new Set([
          warmComposition!.baseConstructionId,
          ...warmComposition!.ports.map(port => port.childConstructionId)
        ]);
        const constructionPatterns = [...parent.compiled.patterns, ...leaf.compiled.patterns]
          .filter(pattern => constructionIds.has(pattern.id))
          .map(pattern => ({ ...pattern, informationLabel }));
        expect(constructionPatterns).toHaveLength(constructionIds.size);
        await writer.model.putLanguageProfiles?.([
          { ...parent.profile, informationLabel },
          { ...leaf.profile, informationLabel }
        ]);
        await writer.languageMemory.putLanguagePatterns?.(constructionPatterns);

        await writer.close();
        writer = undefined;
        reader = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema, informationAccess });
        const coldPatterns = await reader.languageMemory.listLanguagePatterns({
          patternIds: [...constructionIds],
          limit: constructionIds.size,
          maxTotalJsonBytes: 8 * 1024 * 1024,
          requireComplete: true
        });
        expect(coldPatterns).toHaveLength(constructionIds.size);
        const allEvidenceIds = [...new Set([...parentEvidence, ...leafEvidence].map(row => row.id))];
        const coldEvidence = await reader.evidence.getEvidenceBatch(allEvidenceIds);
        expect(coldEvidence).toHaveLength(allEvidenceIds.length);
        const coldProfiles = await reader.model.listLanguageProfiles({ limit: 16 });
        const coldProfile = coldProfiles.find(profile => profile.id === parent.profile.id);
        expect(coldProfile).toBeDefined();

        const coldRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
        const coldState = coldRuntime.hydrate({
          models: [],
          patterns: coldPatterns,
          constructionEvidence: coldEvidence
        });
        expect(coldState.importedReversibleConstructions).toHaveLength(constructionIds.size);
        const algebra = buildConstructionAlgebra({
          constructions: coldState.importedReversibleConstructions ?? [],
          maxRecursionDepth: 3
        });
        const derived = searchTargetConditionedDerivation({
          target: {
            parts: [
              {
                id: "part.parent",
                relationId: "relation.parent",
                roles: [{ roleId: "relation.leaf", valueKind: "observable.string" }],
                evidenceIds: parentEvidence.map(row => String(row.id))
              }
            ],
            audit: { source: "postgres-cold-composition-live" }
          },
          algebra
        });
        expect(derived.text).toBe("Nova frames");
        expect(derived.coveredPartIds).toEqual(["part.parent"]);
        expect([parentText, leafText]).not.toContain(derived.text);
        expect(derived.evidenceIds).toEqual(expect.arrayContaining(allEvidenceIds.map(String)));
        const composition = algebra.composed.find(record => record.id === derived.bestConstructionId);
        expect(composition).toBeDefined();
        expect(algebra.operators.get(composition!.baseConstructionId)?.resultType).toBe("relation.parent");
        expect(composition!.ports.map(port => algebra.operators.get(port.childConstructionId)?.resultType))
          .toEqual(["relation.leaf"]);

        const construct = inventionConstruct(derived.text, derived.evidenceIds as EvidenceId[], ids);
        const candidate = derivationCandidate(derived.text, derived.evidenceIds as EvidenceId[], construct);
        const field = emptyField();
        const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
          text: derived.text,
          evidence: coldEvidence,
          nodes: [],
          field,
          createdAt: 210_000
        });
        const spoken = await createMouth({
          languageMemory: coldRuntime,
          correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
          hashText: text => hasher.digestHex(text)
        }).speak({
          construct,
          field,
          languageProfile: coldProfile!,
          evidence: coldEvidence,
          entailment: { ...entailment, force: "invented", evidenceIds: candidate.evidenceIds },
          languageMemory: coldState,
          selectedCandidate: candidate,
          requestedAuthority: "creative"
        });
        expect(spoken.text).toBe(derived.text);
        expect(spoken.force).toBe("creative");
        expect(spoken.evidenceRefs).toEqual(expect.arrayContaining(allEvidenceIds));
        expect(spoken.surfaceValid).toBe(true);
        expect(JSON.stringify(spoken.realizationTrace.selected.audit)).toContain("proof-carrying-construction");
      } finally {
        const cleanup = reader ?? writer ?? createPostgresStorageAdapter({
          url: liveDatabaseUrl!, schema, informationAccess
        });
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await reader?.close().catch(() => undefined);
        await writer?.close().catch(() => undefined);
        if (!reader && !writer) await cleanup.close().catch(() => undefined);
      }
    }
  );
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
  const profile = input.language.acquire({ sourceVersionId, text: input.text, createdAt: 210_000 });
  const compiled = compileLanguageTrainingBatch({
    runtime: input.runtime,
    hasher: input.hasher,
    batch: {
      streamId: `fixture://${sourceVersionId}`,
      profile,
      sourceVersionId,
      text: input.text,
      evidence: input.evidence,
      createdAt: 210_000,
      graphSnapshot: { nodes: input.nodes, edges: [], hyperedges: input.hyperedges },
      maxAlignmentCandidateDegree: 8
    }
  });
  return { profile, compiled };
}

async function evidenceForFamilies(input: {
  storage: PostgresStorageAdapter;
  ids: ReturnType<typeof createIdFactory>;
  text: string;
  prefix: string;
  informationLabel: InformationLabel;
}): Promise<EvidenceSpan[]> {
  const rows: EvidenceSpan[] = [];
  for (const family of ["a", "b", "c"]) {
    const sourcePrefix = `${input.prefix}.${family}\n`;
    const bytes = Buffer.from(sourcePrefix + input.text, "utf8");
    const contentHash = await input.storage.blobs.put(bytes, "text/plain");
    const uri = `fixture://${input.prefix}.${family}`;
    const sourceVersionId = input.ids.sourceVersionId(bytes) as SourceVersionId;
    const source: SourceVersion = {
      sourceId: input.ids.sourceId("fixture", uri),
      sourceVersionId,
      namespace: "fixture",
      canonicalUri: uri,
      contentHash,
      mediaType: "text/plain",
      observedAt: 210_000,
      byteLength: bytes.byteLength,
      sourceTrust: {
        identity: 1,
        integrity: 1,
        parserReliability: 1,
        directness: 1,
        authority: 1,
        freshness: 1,
        independenceGroup: `family.${input.prefix}.${family}`,
        accessScope: "owner_private",
        licenseStatus: "owner_authorized"
      },
      metadata: {},
      informationLabel: input.informationLabel
    };
    await input.storage.evidence.putSourceVersion(source);
    const byteStart = Buffer.byteLength(sourcePrefix, "utf8");
    const textBytes = Buffer.from(input.text, "utf8");
    const spanHash = await input.storage.blobs.put(textBytes, "text/plain");
    const row: EvidenceSpan = {
      id: input.ids.evidenceId({ sourceVersionId, byteStart, byteEnd: byteStart + textBytes.byteLength, spanHash }),
      sourceId: source.sourceId,
      sourceVersionId,
      chunkId: input.ids.chunkId({ sourceVersionId, byteStart, byteEnd: byteStart + textBytes.byteLength, chunkHash: spanHash }),
      contentHash: spanHash,
      mediaType: "text/plain",
      byteStart,
      byteEnd: byteStart + textBytes.byteLength,
      charStart: sourcePrefix.length,
      charEnd: sourcePrefix.length + input.text.length,
      text: input.text,
      textPreview: input.text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ sourceFamilyId: `family.${input.prefix}.${family}` }),
      features: featureSet(input.text, 96),
      status: "promoted",
      alpha: 1,
      observedAt: 210_000,
      informationLabel: input.informationLabel
    };
    await input.storage.evidence.putEvidenceSpan(row);
    rows.push(row);
  }
  return rows;
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

function inventionConstruct(text: string, evidenceIds: EvidenceId[], ids: ReturnType<typeof createIdFactory>): ConstructGraph {
  const claimId = "claim.postgres.cold.composition";
  const invention = {
    ...createInventionConstruct({
      id: "invention.postgres.cold.composition",
      title: "Cold restored construction composition",
      proposalSurface: text,
      artifactKindIds: ["artifact.prose"],
      basisEvidenceIds: evidenceIds,
      basisPriorIds: [],
      noveltyScore: 1,
      supportScore: 1,
      riskScore: 0
    }),
    trace: toJsonValue({
      source: "target-conditioned-construction-algebra",
      claimBasis: [
        {
          id: "claim.postgres.cold.composition.sources",
          surface: "learned parent and leaf construction evidence",
          force: "observed",
          evidenceIds,
          kind: "factual_premise"
        },
        { id: claimId, surface: text, force: "invented", evidenceIds: [], kind: "invention" }
      ],
      proposalRealization: { path: "proof-carrying-construction", evidenceIds }
    })
  };
  return {
    id: ids.constructId({ fixture: "postgres-cold-composition" }),
    episodeId: ids.episodeId(),
    forceVector: {},
    nodes: [inventionConstructNode(invention)],
    edges: [],
    artifacts: []
  };
}

function derivationCandidate(text: string, evidenceIds: EvidenceId[], construct: ConstructGraph): CandidateSurface {
  const inventionNode = construct.nodes.find(node => node.kind === "construct:invention")!;
  return {
    id: "candidate.postgres.cold.composition",
    kind: "creative-candidate",
    answer: text,
    force: "invented",
    evidenceIds,
    scores: {
      support: 1,
      contradiction: 0,
      faithfulness: 1,
      alphaPressure: 1,
      actionability: 1,
      evidenceCoverage: 1,
      novelty: 1,
      realizability: 1,
      constraintCoverage: 1,
      graphCoherence: 1,
      languageRealizability: 1,
      usefulness: 1,
      risk: 0,
      repetition: 0,
      unsupportedFactualAssertion: 0,
      creativeSelectionScore: 1
    },
    constructIds: [String(inventionNode.id)],
    claimBases: ["invented"],
    boundaries: ["evidence-owned-construction-algebra"],
    audit: toJsonValue({
      source: "target-conditioned-construction-algebra",
      derivation: { schema: "scce.generative_derivation.proof.v1", path: "proof-carrying-construction" },
      claimBases: [{ claimId: "claim.postgres.cold.composition", basis: "invented", evidenceIds: [] }]
    })
  };
}

function emptyField(): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    ppfDiagnostics: {},
    alphaTrace: {
      alpha: 1,
      thresholds: { virtual: 0.49, visible: 0.7, bonded: 0.8366600265340756, structural: 0.51 },
      relations: [],
      adjacency: matrix,
      laplacian: matrix,
      normalizedLaplacian: matrix,
      surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 1, risk: 0, actionability: 1 },
      contradictionMass: 0,
      bondedLeakage: 0
    },
    causalMass: []
  };
}
