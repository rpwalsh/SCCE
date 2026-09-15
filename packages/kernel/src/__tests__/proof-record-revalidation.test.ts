import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createSemanticEntailmentEngine,
  type EvidenceSpan,
  type FieldState,
  type ProofClaim,
  type ProofEvidenceRecord,
  type SourceVersionId
} from "../index.js";

describe("structured proof record revalidation", () => {
  it("does not let a caller-carried typed record bind an unrelated source span", () => {
    const clock = createClock({ fixedTime: 100, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "proof-record-revalidation" });
    const span = directSpan();
    const claim = typedClaim();
    const forged: ProofEvidenceRecord = {
      id: "proof.forged",
      forceClass: "direct_evidence",
      sourceVersionId: String(span.sourceVersionId),
      evidenceSpanId: String(span.id),
      subject: claim.subject,
      relationId: claim.relationId,
      object: claim.object,
      polarityId: claim.polarityId,
      modalityId: claim.modalityId
    };

    const result = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "request.surface",
      evidence: [span],
      nodes: [],
      field: emptyField(),
      createdAt: clock.now(),
      proofClaims: [claim],
      proofEvidence: [forged]
    });
    expect(result.force).not.toBe("proved");
    expect(JSON.stringify(result.proof.scores)).toContain("unsupported_prior_only");
    expect(JSON.stringify(result.proof.scores)).toContain("unknown_force_class");
  });
});

function directSpan(): EvidenceSpan {
  const text = "surface.source";
  return {
    id: "evidence.actual" as EvidenceSpan["id"],
    sourceId: "source.actual" as EvidenceSpan["sourceId"],
    sourceVersionId: "version.actual" as SourceVersionId,
    chunkId: "chunk.actual" as EvidenceSpan["chunkId"],
    contentHash: "hash.actual" as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: Buffer.byteLength(text),
    charStart: 0,
    charEnd: text.length,
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
        independenceGroup: "source.actual",
        accessScope: "fixture",
        licenseStatus: "fixture"
      }
    },
    provenance: {
      provenanceClass: "direct_evidence",
      uri: "fixture://actual",
      sourceVersionId: "version.actual",
      byteRange: [0, Buffer.byteLength(text)],
      charRange: [0, text.length]
    },
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}

function typedClaim(): ProofClaim {
  return {
    id: "claim.request",
    subject: { id: "entity.request", kindId: "kind.entity", roleId: "role.subject" },
    relationId: "relation.request",
    object: { id: "value.request", kindId: "kind.value", roleId: "role.object" },
    polarityId: "polarity.positive",
    modalityId: "modality.asserted"
  };
}

function emptyField(): FieldState {
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
      surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
      contradictionMass: 0,
      bondedLeakage: 0
    }
  };
}
