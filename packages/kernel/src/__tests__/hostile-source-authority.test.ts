import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createSemanticEntailmentEngine,
  evidenceProofBoundariesForClaim,
  featureSet,
  type EvidenceSpan,
  type JsonValue,
  type ProofClaim,
  type ProofEvidenceRecord,
  type SourceVersionId
} from "../index.js";

/**
 * This is deliberately domain-neutral. The proposition could be any typed
 * owner-supplied assertion; the fixture only exercises source identity,
 * lineage, polarity, and the proof boundary.
 */
describe("hostile source authority mixtures", () => {
  const claim = typedClaim("claim.hostile-mixture", "polarity.positive");

  it("keeps repeated source assertions qualified while independent contrary measurements win", () => {
    const ownerRoot = sourceSpan({
      version: "version.owner.root",
      family: "publisher:owner-campaign",
      epistemicState: "asserted",
      text: "The source asserts the typed proposition."
    });
    const ownerCopies = Array.from({ length: 24 }, (_, index) => sourceSpan({
      version: `version.owner.copy.${index}`,
      family: `publisher:republisher.${index}`,
      parent: String(ownerRoot.sourceVersionId),
      epistemicState: "asserted",
      text: "A derived source repeats the typed proposition."
    }));
    const contrary = [
      sourceSpan({ version: "version.regulator", family: "regulator:report", epistemicState: "promoted", polarity: "polarity.negative", text: "An independent report refutes the typed proposition." }),
      sourceSpan({ version: "version.measurement.a", family: "measurement:a", epistemicState: "promoted", polarity: "polarity.negative", text: "An independent measurement refutes the typed proposition." }),
      sourceSpan({ version: "version.measurement.b", family: "measurement:b", epistemicState: "promoted", polarity: "polarity.negative", text: "A second independent measurement refutes the typed proposition." }),
      sourceSpan({ version: "version.measurement.c", family: "measurement:c", epistemicState: "promoted", polarity: "polarity.negative", text: "A third independent measurement refutes the typed proposition." })
    ];
    const evidence = [ownerRoot, ...ownerCopies, ...contrary];
    const ownerBoundaries = evidenceProofBoundariesForClaim({
      claim,
      evidence: [ownerRoot, ...ownerCopies],
      proofEvidence: evidence.map(span => typedRecord(span, claim, "polarity.positive"))
    });

    // Repetition and relabeling identify the source's assertion; they do not
    // become independent world witnesses merely because each copy has a new
    // source version and publisher label.
    expect(ownerBoundaries.filter(boundary => boundary.certifiesFactualProof)).toHaveLength(0);
    expect(ownerBoundaries.filter(boundary => !boundary.certifiesFactualProof)).toHaveLength(25);

    const clock = createClock({ fixedTime: 100, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "hostile-source-authority" });
    const result = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "the typed proposition",
      evidence,
      nodes: [],
      field: emptyField(),
      createdAt: clock.now(),
      proofClaims: [claim]
    });

    expect(result.verdict).toBe("contradicted");
    expect(result.truthState).toBe("truth.contradicted");
    expect(result.evidenceIds.map(String)).toEqual(expect.arrayContaining(contrary.map(span => String(span.id))));
    expect(result.evidenceIds.map(String)).not.toContain(String(ownerRoot.id));
    expect(result.boundaries).toContain("proof-boundary.source-assertion-not-promoted");
    expect(JSON.stringify(result.proof.confidence)).toContain("polarity_policy_contradiction");
  });

  it("does not let a citation cycle manufacture a second typed witness", () => {
    const first = sourceSpan({ version: "version.citation.a", family: "citation:a", parent: "version.citation.b", epistemicState: "asserted" });
    const second = sourceSpan({ version: "version.citation.b", family: "citation:b", parent: "version.citation.a", epistemicState: "asserted" });
    const independent = sourceSpan({ version: "version.citation.independent", family: "citation:independent", epistemicState: "asserted" });
    const boundaries = evidenceProofBoundariesForClaim({
      claim,
      evidence: [first, second, independent],
      proofEvidence: [first, second, independent].map(span => typedRecord(span, claim, "polarity.positive"))
    });
    expect(boundaries.filter(boundary => boundary.certifiesFactualProof)).toHaveLength(2);
    expect(boundaries.filter(boundary => boundary.reason === "proof-boundary.dependent-source-assertion")).toHaveLength(1);
    expect(boundaries.find(boundary => boundary.evidenceId === String(independent.id))?.certifiesFactualProof).toBe(true);
  });
});

function typedClaim(id: string, polarityId: string): ProofClaim {
  return {
    id,
    subject: { id: "entity.hostile", kindId: "kind.entity", roleId: "role.subject" },
    relationId: "relation.hostile.typed",
    object: { id: "value.hostile", kindId: "kind.value", roleId: "role.object" },
    polarityId,
    modalityId: "modality.asserted"
  };
}

function typedRecord(span: EvidenceSpan, claim: ProofClaim, polarityId: string): ProofEvidenceRecord {
  return typedRecordFields(String(span.sourceVersionId), claim, polarityId);
}

function typedRecordFields(version: string, claim: ProofClaim, polarityId: string): ProofEvidenceRecord {
  return {
    id: `record:${version}`,
    forceClass: "direct_evidence",
    sourceVersionId: version,
    evidenceSpanId: `evidence:${version}`,
    subject: claim.subject,
    relationId: claim.relationId,
    object: claim.object,
    polarityId,
    modalityId: claim.modalityId
  };
}

function sourceSpan(input: {
  version: string;
  family: string;
  parent?: string;
  epistemicState: "asserted" | "promoted";
  polarity?: string;
  text?: string;
}): EvidenceSpan {
  const text = input.text ?? "A source reports the typed proposition.";
  const byteLength = Buffer.byteLength(text, "utf8");
  const proofRecord = typedRecordFields(input.version, typedClaim("claim.hostile-mixture", input.polarity ?? "polarity.positive"), input.polarity ?? "polarity.positive");
  return {
    id: `evidence:${input.version}` as EvidenceSpan["id"],
    sourceId: `source:${input.version}` as EvidenceSpan["sourceId"],
    sourceVersionId: input.version as SourceVersionId,
    chunkId: `chunk:${input.version}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${input.version}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: byteLength,
    charStart: 0,
    charEnd: [...text].length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: {
      sourceTrust: {
        identity: 0.95,
        integrity: 0.95,
        parserReliability: 0.95,
        directness: 0.95,
        authority: 0.95,
        freshness: 0.95,
        independenceGroup: input.family,
        accessScope: "owner_private",
        licenseStatus: "owner_authorized"
      }
    },
    provenance: {
      provenanceClass: "direct_evidence",
      epistemicState: input.epistemicState,
      uri: `fixture://${input.version}`,
      sourceVersionId: input.version,
      byteRange: [0, byteLength],
      charRange: [0, [...text].length],
      ...(input.parent ? {
        sourceVersionDerivation: {
          kind: "extracted-text",
          transformId: "fixture.copy",
          derivedFromSourceVersionId: input.parent,
          originalCoordinateSpace: "extracted-text-utf8",
          redactionMap: []
        }
      } : {}),
      proofEvidence: proofRecord as unknown as JsonValue
    },
    features: featureSet(text, 32),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}

function emptyField() {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    causalMass: [],
    alphaTrace: {
      alpha: 0.5,
      thresholds: { virtual: 0.2, visible: 0.4, bonded: 0.6, structural: 0.8 },
      relations: [],
      adjacency: matrix,
      laplacian: matrix,
      normalizedLaplacian: matrix,
      surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0.4 },
      contradictionMass: 0,
      bondedLeakage: 0
    }
  };
}
