import { describe, expect, it } from "vitest";
import { compileBoundaryStatistics } from "../boundary-estimator.js";
import {
  CANONICAL_IDENTITY_FIELDS,
  createCanonicalIdentity
} from "../canonical-identity.js";
import {
  compileCanonicalReplayManifest,
  verifyCanonicalReplayManifest
} from "../canonical-replay.js";
import {
  admitStructuredTemporalCoordinates,
  canonicalTemporalCoordinates
} from "../canonical-temporal.js";
import {
  assertRuntimeNormalizationBehavior,
  canonicalNormalizationContract,
  normalizationReplayVector,
  normalizeCanonicalSurface
} from "../normalization-contract.js";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { structuredSemanticCandidates } from "../structured-semantic-candidate.js";
import type { EvidenceId, SourceId, SourceVersionId } from "../types.js";

describe("canonical evidence identity", () => {
  it("pins normalization and grapheme replay across difficult Unicode surfaces", () => {
    const contract = canonicalNormalizationContract();
    assertRuntimeNormalizationBehavior();
    expect(contract).toMatchObject({
      unicodeVersion: "17.0.0",
      normalizationForm: "NFC",
      localePolicy: "locale-independent",
      graphemeAlgorithmVersion: "icu.78.2.uax29.unicode17.und.v1",
      runtimeUnicodeVersion: "17.0",
      runtimeIcuVersion: "78.2"
    });
    for (const row of normalizationReplayVector()) {
      expect(normalizeCanonicalSurface(row.exact, contract)).toBe(row.normalized);
    }
    expect(normalizeCanonicalSurface("\u212A\u017F\u03F4", contract)).toBe("ks\u03B8");
  });

  it("binds occurrence identity to source coordinates, never evidence contributor order", () => {
    const common = {
      documentId: "document.coordinate-bound",
      sourceVersionId: "source-version.1",
      text: "cat",
      evidenceIds: ["evidence.z", "evidence.a"]
    };
    const left = buildSurfaceLattice(common);
    const right = buildSurfaceLattice({
      ...common,
      evidenceIds: [...common.evidenceIds].reverse()
    });
    const changedSource = buildSurfaceLattice({
      ...common,
      sourceVersionId: "source-version.2"
    });
    expect(left.units.map(unit => unit.occurrenceId))
      .toEqual(right.units.map(unit => unit.occurrenceId));
    expect(left.units[0]?.occurrenceId).not.toBe(changedSource.units[0]?.occurrenceId);
  });

  it("keeps exact occurrences separate from normalized surface-form identity", () => {
    const contract = canonicalNormalizationContract();
    const lattice = buildSurfaceLattice({
      documentId: "document.combining",
      text: "e\u0301 é İ ı Σ ς 👩🏽‍💻 العربية 한글",
      evidenceIds: ["evidence.combining"],
      normalizationContract: contract
    });
    const decomposed = lattice.units.find(unit => unit.surface === "e\u0301");
    const composed = lattice.units.find(unit => unit.surface === "é");
    expect(decomposed?.id).not.toBe(composed?.id);
    expect(decomposed?.occurrenceId).not.toBe(composed?.occurrenceId);
    expect(decomposed?.normalized).toBe("é");
    expect(composed?.normalized).toBe("é");
    expect(decomposed?.normalizedFormId).toBe(composed?.normalizedFormId);
    expect(lattice.normalizationContract.id).toBe(contract.id);
    expect(lattice.segmentationForest.normalizationContractId).toBe(contract.id);
  });

  it("keeps observed time independent from source, event, and validity coordinates", () => {
    const mentionOnly = canonicalTemporalCoordinates({
      observedTime: 500,
      eventSurfaceMention: "2026-07-26",
      provenance: { parsed: false }
    });
    const admitted = canonicalTemporalCoordinates({
      sourceTime: 100,
      observedTime: 500,
      eventTime: 200,
      validFrom: 190,
      validTo: 210,
      provenance: { parsed: true, parserModelId: "temporal.model.1" }
    });
    expect(mentionOnly).toMatchObject({
      sourceTime: null,
      observedTime: 500,
      eventTime: null,
      validFrom: null,
      validTo: null,
      eventSurfaceMention: "2026-07-26"
    });
    expect(admitted.observedTime).not.toBe(admitted.eventTime);
    expect(admitted.validFrom).not.toBe(admitted.observedTime);
  });

  it("admits validity only from an authoritative structured field", () => {
    const admitted = admitStructuredTemporalCoordinates({
      observedTime: 500,
      structured: {
        authority: "source_declared",
        sourceType: "database",
        schemaId: "schema.fixture.v1",
        validFrom: 100,
        validTo: 200
      }
    });
    expect(admitted).toMatchObject({
      observedTime: 500,
      validFrom: 100,
      validTo: 200,
      provenance: {
        temporalStatus: "known",
        authority: "source_declared",
        schemaId: "schema.fixture.v1"
      }
    });
    const candidates = structuredSemanticCandidates({
      sourceId: "source.structured" as SourceId,
      sourceVersionId: "version.structured" as SourceVersionId,
      metadata: {
        links: [{ label: "record", target: "fixture://record" }],
        structuredTemporal: {
          authority: "source_declared",
          sourceType: "database",
          schemaId: "schema.fixture.v1",
          validFrom: 100,
          validTo: 200
        }
      },
      observations: [],
      evidenceIds: ["evidence.structured" as EvidenceId],
      observedAt: 500
    });
    expect(candidates[0]?.temporalCoordinates).toMatchObject({
      validFrom: 100,
      validTo: 200
    });
    expect(structuredSemanticCandidates({
      sourceId: "source.free-text" as SourceId,
      sourceVersionId: "version.free-text" as SourceVersionId,
      metadata: {
        links: [{ label: "record", target: "fixture://record" }],
        validFrom: 100
      },
      observations: [],
      evidenceIds: ["evidence.free-text" as EvidenceId],
      observedAt: 500
    })[0]?.temporalCoordinates.validFrom).toBeNull();
  });

  it("declares distinct field contracts for every stable identity class", () => {
    expect(Object.keys(CANONICAL_IDENTITY_FIELDS).sort()).toEqual([
      "admitted_relation",
      "alignment_target_index",
      "canonical_entity",
      "construction",
      "document",
      "evidence_span",
      "mention",
      "model_snapshot",
      "normalized_surface_form",
      "relation_hypothesis",
      "source",
      "surface_form_class",
      "surface_occurrence",
      "unresolved_entity"
    ]);
    const source = createCanonicalIdentity({
      kind: "source",
      fields: { namespace: "fixture", canonicalUri: "FIXTURE://ONE" }
    });
    const document = createCanonicalIdentity({
      kind: "document",
      fields: {
        sourceVersionId: "version.1",
        contentHash: "hash.1",
        logicalPath: "ONE.txt"
      }
    });
    expect(source.id).toMatch(/^source\./u);
    expect(document.id).toMatch(/^document\./u);
    expect(source.id).not.toBe(document.id);
  });

  it("produces byte-identical replay manifests from equivalent shuffled inputs", () => {
    const contract = canonicalNormalizationContract();
    const firstLattice = buildSurfaceLattice({
      documentId: "document.1",
      text: "Alpha βeta.",
      evidenceIds: ["evidence.1"],
      normalizationContract: contract
    });
    const secondLattice = buildSurfaceLattice({
      documentId: "document.2",
      text: "한글 العربية",
      evidenceIds: ["evidence.2"],
      normalizationContract: contract
    });
    const firstStatistics = compileBoundaryStatistics({
      populationId: "population.1",
      normalizationContractId: contract.id,
      observations: [{
        sourceDocumentId: "document.1",
        features: boundaryFeatures(1),
        positiveMass: 1,
        negativeMass: 0,
        supervision: "independent_anchor",
        signalKind: "external_anchor",
        signalId: "anchor.document.1"
      }],
      sourceDocumentIds: ["document.1"]
    });
    const secondStatistics = compileBoundaryStatistics({
      populationId: "population.2",
      normalizationContractId: contract.id,
      observations: [{
        sourceDocumentId: "document.2",
        features: boundaryFeatures(0),
        positiveMass: 0,
        negativeMass: 1,
        supervision: "independent_anchor",
        signalKind: "external_anchor",
        signalId: "anchor.document.2"
      }],
      sourceDocumentIds: ["document.2"]
    });
    const candidates = structuredSemanticCandidates({
      sourceId: "source.1" as SourceId,
      sourceVersionId: "version.1" as SourceVersionId,
      metadata: {
        links: [
          { label: "Alpha", target: "fixture://alpha" },
          { label: "Beta", target: "fixture://beta" }
        ]
      },
      observations: [],
      evidenceIds: ["evidence.1" as EvidenceId],
      observedAt: 500,
      normalizationContract: contract
    });
    const common = {
      corpusManifestId: "corpus.manifest.1",
      codeCommit: "0123456789abcdef",
      configuration: { limits: { paths: 8 }, mode: "deterministic" },
      randomSeed: "seed.1",
      candidates,
      admittedGraph: { nodes: [], edges: [], hyperedges: [] },
      normalizationContract: contract
    };
    const left = compileCanonicalReplayManifest({
      ...common,
      surfaceLattices: [firstLattice, secondLattice],
      boundaryStatistics: [firstStatistics, secondStatistics]
    });
    const right = compileCanonicalReplayManifest({
      ...common,
      surfaceLattices: [secondLattice, firstLattice],
      boundaryStatistics: [secondStatistics, firstStatistics],
      candidates: [...candidates].reverse()
    });
    const changedSeed = compileCanonicalReplayManifest({
      ...common,
      randomSeed: "seed.2",
      surfaceLattices: [firstLattice, secondLattice],
      boundaryStatistics: [firstStatistics, secondStatistics]
    });
    expect(left.canonicalBytes).toBe(right.canonicalBytes);
    expect(left.byteHash).toBe(right.byteHash);
    expect(left.id).toBe(right.id);
    expect(left.surfaceLatticeIds).toEqual(right.surfaceLatticeIds);
    expect(left.segmentationForestIds).toEqual(right.segmentationForestIds);
    expect(left.boundaryStatisticsIds).toEqual(right.boundaryStatisticsIds);
    expect(left.candidateIds).toEqual(right.candidateIds);
    expect(left.id).not.toBe(changedSeed.id);
    expect(() => verifyCanonicalReplayManifest(left)).not.toThrow();
  });

  it("canonicalizes nested unordered graph fields and rejects conflicting identities", () => {
    const node = {
      id: "node.1",
      typeId: "dimension.1",
      representation: {},
      alpha: 1,
      evidenceIds: ["evidence.b", "evidence.a"],
      features: ["z", "a"],
      createdAt: 1,
      updatedAt: 1,
      metadata: {}
    } as never;
    const common = {
      corpusManifestId: "corpus.1",
      codeCommit: "commit.1",
      configuration: {},
      randomSeed: "seed.1",
      surfaceLattices: [],
      boundaryStatistics: [],
      candidates: [],
      admittedGraph: { nodes: [node], edges: [], hyperedges: [] }
    };
    const left = compileCanonicalReplayManifest(common);
    const right = compileCanonicalReplayManifest({
      ...common,
      admittedGraph: {
        nodes: [{
          ...(node as object),
          evidenceIds: ["evidence.a", "evidence.b"],
          features: ["a", "z"]
        } as never],
        edges: [],
        hyperedges: []
      }
    });
    expect(left.admittedGraphHash).toBe(right.admittedGraphHash);
    expect(() => compileCanonicalReplayManifest({
      ...common,
      admittedGraph: {
        nodes: [node, { ...(node as object), alpha: 0.25 } as never],
        edges: [],
        hyperedges: []
      }
    })).toThrow(/conflicting duplicate node identity/u);
    expect(() => compileCanonicalReplayManifest({
      ...common,
      admittedGraph: {
        nodes: [node],
        edges: [{
          id: "edge.missing",
          source: "node.1",
          target: "node.missing",
          relationId: "relation.1",
          alpha: 1,
          weight: 1,
          temporalScope: { status: "atemporal" },
          evidenceIds: [],
          createdAt: 1,
          updatedAt: 1,
          metadata: {}
        } as never],
        hyperedges: []
      }
    })).toThrow(/missing graph node/u);
  });
});

function boundaryFeatures(boundary: number) {
  return {
    whitespaceAdjacent: boundary,
    punctuationAdjacent: 0,
    lineBreakAdjacent: 0,
    scriptTransition: 0,
    structuralBoundary: boundary,
    localTransitionEntropy: 0.5,
    repeatedContextSupport: 0.5,
    crossDocumentRecurrence: 0,
    predictiveCompressionGain: 0,
    stableSubstitutionSupport: 0,
    exactPhraseRecurrence: 0,
    constructionReuse: 0
  };
}
