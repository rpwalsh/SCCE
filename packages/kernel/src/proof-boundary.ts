// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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

/**
 * An assertion is knowledge *about a source*, not yet knowledge that its
 * proposition holds in the world.  Ingestion stamps this state itself; it is
 * deliberately not a caller-controlled trust hint.
 */
export type EvidenceEpistemicState = "asserted" | "corroborated" | "promoted" | "legacy_unclassified";

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
    const epistemicState = evidenceEpistemicState(span);
    if (epistemicState === "asserted") {
      return {
        evidenceId: String(span.id),
        sourceVersionId: String(span.sourceVersionId),
        forceClass,
        exactSourceSemantics,
        certifiesFactualProof: false,
        reason: "proof-boundary.source-assertion-not-promoted"
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
  const boundaries = evidenceProofBoundaries(spans);
  const certified = new Set(boundaries.filter(boundary => boundary.certifiesFactualProof).map(boundary => boundary.evidenceId));
  return spans.filter(span => certified.has(String(span.id)));
}

/**
 * Resolve a proof boundary over the evidence set selected for one claim.
 * Multiple documents from the same family stay one assertion. Two exact,
 * admitted assertions from independent families may support this proof, but
 * they are not written back as a durable world belief here.
 */
export function evidenceProofBoundaries(spans: readonly EvidenceSpan[]): EvidenceProofBoundary[] {
  const boundaries = spans.map(evidenceProofBoundary);
  const asserted = spans.filter((span, index) =>
    boundaries[index]?.reason === "proof-boundary.source-assertion-not-promoted"
      && eligibleIndependentAssertion(span)
  );
  const families = new Set(asserted.map(evidenceIndependenceGroup));
  if (families.size < 2) return boundaries;
  const eligibleIds = new Set(asserted.map(span => String(span.id)));
  return boundaries.map(boundary => eligibleIds.has(boundary.evidenceId)
    ? {
        ...boundary,
        certifiesFactualProof: true,
        reason: "proof-boundary.independent-source-assertion-corroboration"
      }
    : boundary);
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

export function evidenceEpistemicState(span: EvidenceSpan): EvidenceEpistemicState {
  const tagged = epistemicStateFrom(span.provenance) ?? epistemicStateFrom(span.trustVector);
  return tagged ?? "legacy_unclassified";
}

function epistemicStateFrom(value: JsonValue | undefined): EvidenceEpistemicState | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const state = record.epistemicState;
  if (state === "asserted" || state === "corroborated" || state === "promoted") return state;
  for (const key of ["metadata", "provenance", "source", "sourceVersion", "original"]) {
    const nested = epistemicStateFrom(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function eligibleIndependentAssertion(span: EvidenceSpan): boolean {
  if (span.status !== "promoted" || !hasExactSourceSemantics(span)) return false;
  const trust = objectRecord(span.trustVector);
  const sourceTrust = objectRecord(trust?.sourceTrust);
  if (!sourceTrust) return false;
  return unitInterval(sourceTrust.identity) >= 0.5
    && unitInterval(sourceTrust.integrity) >= 0.7
    && unitInterval(sourceTrust.parserReliability) >= 0.5
    && unitInterval(sourceTrust.directness) >= 0.45
    && unitInterval(sourceTrust.authority) >= 0.4
    && Boolean(evidenceIndependenceGroup(span));
}

function evidenceIndependenceGroup(span: EvidenceSpan): string {
  const trust = objectRecord(span.trustVector);
  const sourceTrust = objectRecord(trust?.sourceTrust);
  const group = sourceTrust?.independenceGroup;
  return typeof group === "string" && group.trim() ? group.trim() : "";
}

function unitInterval(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
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
