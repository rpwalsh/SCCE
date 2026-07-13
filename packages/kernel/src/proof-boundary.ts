import type { BrainShardProvenanceClass } from "./brain-shards.js";
import type { EvidenceSpan, GraphEdge, GraphNode, JsonValue } from "./types.js";

export type ProofBoundaryClass = BrainShardProvenanceClass | "unclassified_exact_evidence" | "none";

export interface EvidenceProofBoundary {
  evidenceId: string;
  sourceVersionId: string;
  forceClass: ProofBoundaryClass;
  exactSourceSemantics: boolean;
  certifiesFactualProof: boolean;
  reason: string;
}

const PRIOR_CLASSES = new Set<string>([
  "learned_language_prior",
  "learned_concept_prior",
  "learned_program_prior",
  "unknown_prior"
]);

export function evidenceProofBoundary(span: EvidenceSpan): EvidenceProofBoundary {
  const forceClass = proofBoundaryClass(span.provenance, span.trustVector, span.languageHints, span.scriptHints);
  const exact = Boolean(span.id && span.sourceVersionId);
  const exactSourceSemantics = hasExactSourceSemantics(span);
  if (!exact) {
    return {
      evidenceId: String(span.id ?? ""),
      sourceVersionId: String(span.sourceVersionId ?? ""),
      forceClass,
      exactSourceSemantics,
      certifiesFactualProof: false,
      reason: "proof-boundary.missing-exact-evidence-or-source-version"
    };
  }
  if (forceClass === "direct_evidence") {
    if (!exactSourceSemantics) {
      return {
        evidenceId: String(span.id),
        sourceVersionId: String(span.sourceVersionId),
        forceClass,
        exactSourceSemantics,
        certifiesFactualProof: false,
        reason: "proof-boundary.direct-evidence-missing-exact-source-span"
      };
    }
    return {
      evidenceId: String(span.id),
      sourceVersionId: String(span.sourceVersionId),
      forceClass,
      exactSourceSemantics,
      certifiesFactualProof: span.status === "promoted",
      reason: span.status === "promoted" ? "proof-boundary.direct-evidence" : "proof-boundary.direct-evidence-not-promoted"
    };
  }
  if (forceClass === "profile_excerpt_evidence") {
    return {
      evidenceId: String(span.id),
      sourceVersionId: String(span.sourceVersionId),
      forceClass,
      exactSourceSemantics,
      certifiesFactualProof: false,
      reason: "proof-boundary.profile-excerpt-not-external-evidence"
    };
  }
  if (isLearnedPriorClass(forceClass)) {
    return {
      evidenceId: String(span.id),
      sourceVersionId: String(span.sourceVersionId),
      forceClass,
      exactSourceSemantics,
      certifiesFactualProof: false,
      reason: `proof-boundary.prior-not-evidence:${forceClass}`
    };
  }
  return {
    evidenceId: String(span.id),
    sourceVersionId: String(span.sourceVersionId),
    forceClass: "unclassified_exact_evidence",
    exactSourceSemantics,
    certifiesFactualProof: exactSourceSemantics && span.status === "promoted",
    reason: !exactSourceSemantics ? "proof-boundary.unclassified-evidence-missing-exact-source-span" : span.status === "promoted" ? "proof-boundary.exact-versioned-evidence" : "proof-boundary.exact-evidence-not-promoted"
  };
}

export function certifyingEvidence(spans: readonly EvidenceSpan[]): EvidenceSpan[] {
  return spans.filter(span => evidenceProofBoundary(span).certifiesFactualProof);
}

export function graphNodePriorClass(node: GraphNode): ProofBoundaryClass {
  return proofBoundaryClass(node.metadata, node.representation);
}

export function graphEdgePriorClass(edge: GraphEdge): ProofBoundaryClass {
  return proofBoundaryClass(edge.metadata);
}

export function isLearnedPriorClass(value: string | undefined): boolean {
  return Boolean(value && PRIOR_CLASSES.has(value));
}

export function proofBoundaryClass(...values: readonly JsonValue[]): ProofBoundaryClass {
  for (const value of values) {
    const found = findForceClass(value);
    if (found) return found;
  }
  return "none";
}

function findForceClass(value: JsonValue | undefined): ProofBoundaryClass | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  for (const key of ["forceClass", "provenanceClass"]) {
    const raw = record[key];
    if (typeof raw === "string" && isKnownBoundaryClass(raw)) return raw;
  }
  for (const key of ["metadata", "provenance", "descriptor", "source", "sourceVersion", "original"]) {
    const nested = record[key];
    const found = findForceClass(nested);
    if (found) return found;
  }
  return undefined;
}

function isKnownBoundaryClass(value: string): value is ProofBoundaryClass {
  return value === "direct_evidence" || value === "profile_excerpt_evidence" || value === "learned_language_prior" || value === "learned_concept_prior" || value === "learned_program_prior" || value === "unknown_prior";
}

function hasExactSourceSemantics(span: EvidenceSpan): boolean {
  const provenance = objectRecord(span.provenance) ?? {};
  const trust = objectRecord(span.trustVector) ?? {};
  const original = objectRecord(provenance.original) ?? objectRecord(provenance.originalSource) ?? objectRecord(trust.original) ?? objectRecord(trust.originalSource);
  const source = objectRecord(provenance.source) ?? objectRecord(trust.source);
  const locator = firstString(
    provenance.uri,
    provenance.canonicalUri,
    provenance.sourceUri,
    provenance.originalSourceUri,
    provenance.url,
    source?.uri,
    source?.canonicalUri,
    source?.sourceUri,
    source?.url,
    original?.uri,
    original?.canonicalUri,
    original?.sourceUri,
    original?.url
  );
  const version = firstString(
    provenance.sourceVersionId,
    provenance.originalSourceVersionId,
    provenance.revisionId,
    provenance.contentHash,
    provenance.chunkHash,
    source?.sourceVersionId,
    source?.revisionId,
    source?.contentHash,
    original?.sourceVersionId,
    original?.revisionId,
    original?.contentHash
  );
  const hasRange =
    hasNumberPair(provenance.byteRange) ||
    hasNumberPair(provenance.charRange) ||
    hasNumberPair(provenance.originalByteRange) ||
    hasNumberPair(provenance.originalCharRange) ||
    hasNumberPair(source?.byteRange) ||
    hasNumberPair(source?.charRange) ||
    hasNumberPair(original?.byteRange) ||
    hasNumberPair(original?.charRange);
  return Boolean(locator && version && hasRange);
}

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, JsonValue>;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function hasNumberPair(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.length >= 2 && orderedNumbers(value[0], value[1]);
}

function orderedNumbers(start: unknown, end: unknown): boolean {
  return typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) && end >= start;
}
