// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BrainShardProvenanceClass } from "./brain-shards.js";
import type { EvidenceSpan, GraphEdge, GraphNode, JsonValue } from "./types.js";
import type { ProofClaim, ProofEvidenceRecord } from "./semantic-proof-engine.js";

export type ProofBoundaryClass = BrainShardProvenanceClass | "unclassified_exact_evidence" | "none";

export interface EvidenceProofBoundary {
  evidenceId: string;
  sourceVersionId: string;
  forceClass: ProofBoundaryClass;
  exactSourceSemantics: boolean;
  certifiesFactualProof: boolean;
  reason: string;
}

export interface EvidenceLineage {
  /** The source-version identity used when counting independent witnesses. */
  identity: string;
  /** Source versions traversed while resolving this span, including its own. */
  sourceVersionIds: string[];
  /** True when the declared parent links contain a cycle. */
  cyclic: boolean;
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
 * Multiple documents from the same family or source lineage stay one
 * assertion. Two exact, admitted assertions from independent families may
 * support this proof, but they are not written back as a durable world belief
 * here.
 */
export function evidenceProofBoundaries(spans: readonly EvidenceSpan[]): EvidenceProofBoundary[] {
  // EvidenceSpan has source identity and provenance, but no typed proposition
  // identity. It is therefore unsafe to let a raw set of spans promote source
  // assertions: independent documents may assert unrelated propositions. The
  // claim-scoped API below performs the same lineage/family matching after an
  // explicit typed claim binding has been supplied.
  return spans.map(evidenceProofBoundary);
}

/**
 * Resolve source-assertion corroboration for one explicitly typed claim.
 *
 * A span is eligible only when a proof record binds that exact span and its
 * typed subject/relation/object proposition to `claim`. No surface text or
 * topic feature is consulted. Promoted direct evidence keeps the ordinary
 * per-span boundary result; only asserted source records need corroboration.
 */
export function evidenceProofBoundariesForClaim(input: {
  claim: ProofClaim;
  evidence: readonly EvidenceSpan[];
  proofEvidence: readonly ProofEvidenceRecord[];
}): EvidenceProofBoundary[] {
  const boundaries = input.evidence.map(evidenceProofBoundary);
  const boundEvidenceIds = new Set(
    input.proofEvidence
      .filter(record => nonEmpty(record.evidenceSpanId) && proofRecordMatchesClaim(record, input.claim))
      .map(record => String(record.evidenceSpanId))
  );
  const asserted = input.evidence.filter((span, index) =>
    boundaries[index]?.reason === "proof-boundary.source-assertion-not-promoted"
      && boundEvidenceIds.has(String(span.id))
      && eligibleIndependentAssertion(span)
  );
  // Independence labels cannot turn two copies of the same immutable source
  // lineage into two witnesses. Source-version identity is content-derived at
  // ingest, and explicit parent links collapse repackaged descendants and
  // cycles without making any language or topic special.
  // Corroboration requires a one-to-one pairing of independence groups and
  // lineages. Counting each set separately is insufficient: a derived copy
  // may carry a new family label, while an unrelated document may reuse the
  // original family. A bipartite matching chooses only witnesses that are
  // independent on both dimensions.
  const representativeIds = independentLineageRepresentatives(asserted, input.evidence);
  if (representativeIds.size < 2) return boundaries;
  const eligibleIds = new Set(asserted.map(span => String(span.id)));
  return boundaries.map(boundary => {
    if (!eligibleIds.has(boundary.evidenceId)) return boundary;
    if (!representativeIds.has(boundary.evidenceId)) {
      return {
        ...boundary,
        certifiesFactualProof: false,
        reason: "proof-boundary.dependent-source-assertion"
      };
    }
    return {
      ...boundary,
      certifiesFactualProof: true,
      reason: "proof-boundary.independent-source-assertion-corroboration"
    };
  });
}

/** Alias spelling for callers that describe the operation as claim scoping. */
export const claimScopedEvidenceProofBoundaries = evidenceProofBoundariesForClaim;

function proofRecordMatchesClaim(record: ProofEvidenceRecord, claim: ProofClaim): boolean {
  return proofAtomMatchesClaim(record.subject, claim.subject)
    && record.relationId === claim.relationId
    && proofAtomMatchesClaim(record.object, claim.object)
    && scalarMatches(record.quantity, claim.quantity)
    && dateTimeMatches(record.dateTime, claim.dateTime)
    && (record.polarityId ?? "polarity.positive") === (claim.polarityId ?? "polarity.positive")
    && (record.modalityId ?? "modality.asserted") === (claim.modalityId ?? "modality.asserted");
}

function proofAtomMatchesClaim(record: ProofClaim["subject"], claim: ProofClaim["subject"]): boolean {
  // Typed corroboration requires stable IDs. Surfaces are intentionally not a
  // fallback: lexical equality cannot establish proposition identity.
  if (!nonEmpty(record.id) || !nonEmpty(claim.id) || record.id !== claim.id) return false;
  if (!nonEmpty(record.kindId) || !nonEmpty(claim.kindId) || record.kindId !== claim.kindId) return false;
  if ((record.roleId ?? "") !== (claim.roleId ?? "")) return false;
  return true;
}

function scalarMatches(record: ProofClaim["quantity"], claim: ProofClaim["quantity"]): boolean {
  if (!record || !claim) return !record && !claim;
  return record.value === claim.value
    && (record.unitId ?? "") === (claim.unitId ?? "")
    && (record.tolerance ?? 0) === (claim.tolerance ?? 0);
}

function dateTimeMatches(record: ProofClaim["dateTime"], claim: ProofClaim["dateTime"]): boolean {
  if (!record || !claim) return !record && !claim;
  return record.value === claim.value && (record.precisionId ?? "") === (claim.precisionId ?? "");
}

function independentLineageRepresentatives(
  asserted: readonly EvidenceSpan[],
  siblings: readonly EvidenceSpan[]
): Set<string> {
  const dependencyComponents = evidenceDependencyComponents(siblings);
  const candidates = asserted
    .map(span => ({
      span,
      family: dependencyComponents.get(String(span.id)) ?? "",
      lineage: evidenceLineage(span, siblings)
    }))
    .filter(candidate => Boolean(candidate.family && candidate.lineage.identity))
    .sort((left, right) => {
      const lineageOrder = left.lineage.identity.localeCompare(right.lineage.identity);
      if (lineageOrder) return lineageOrder;
      // Prefer the declared root when it is present; otherwise the closest
      // available ancestor represents the lineage. A downstream republisher's
      // label cannot replace the family's identity merely because its span was
      // presented first.
      const leftRoot = String(left.span.sourceVersionId) === left.lineage.identity ? 0 : 1;
      const rightRoot = String(right.span.sourceVersionId) === right.lineage.identity ? 0 : 1;
      return leftRoot - rightRoot
        || left.lineage.sourceVersionIds.length - right.lineage.sourceVersionIds.length
        || String(left.span.id).localeCompare(String(right.span.id));
    });
  // A source lineage and an independence family are two separate caps. A
  // deterministic maximum matching is required when their labels cross (for
  // example L1/F1, L1/F2, L2/F1); greedy set collapse can undercount valid
  // independent witnesses.
  const edgeByLineageFamily = new Map<string, Map<string, (typeof candidates)[number]>>();
  for (const candidate of candidates) {
    const byFamily = edgeByLineageFamily.get(candidate.lineage.identity) ?? new Map<string, (typeof candidates)[number]>();
    const prior = byFamily.get(candidate.family);
    if (!prior || representativeOrder(candidate, prior) < 0) byFamily.set(candidate.family, candidate);
    edgeByLineageFamily.set(candidate.lineage.identity, byFamily);
  }
  const lineages = [...edgeByLineageFamily.keys()].sort();
  const familyToLineage = new Map<string, string>();
  const augment = (lineage: string, visitedFamilies: Set<string>): boolean => {
    const familyEdges = edgeByLineageFamily.get(lineage) ?? new Map<string, (typeof candidates)[number]>();
    const families = [...familyEdges.keys()].sort((left, right) =>
      representativeOrder(familyEdges.get(left)!, familyEdges.get(right)!) || left.localeCompare(right));
    for (const family of families) {
      if (visitedFamilies.has(family)) continue;
      visitedFamilies.add(family);
      const priorLineage = familyToLineage.get(family);
      if (!priorLineage || augment(priorLineage, visitedFamilies)) {
        familyToLineage.set(family, lineage);
        return true;
      }
    }
    return false;
  };
  for (const lineage of lineages) augment(lineage, new Set<string>());

  const representatives = new Set<string>();
  for (const [family, lineage] of familyToLineage) {
    const candidate = edgeByLineageFamily.get(lineage)?.get(family);
    if (candidate) representatives.add(String(candidate.span.id));
  }
  return representatives;
}

function representativeOrder(left: { span: EvidenceSpan; lineage: EvidenceLineage }, right: { span: EvidenceSpan; lineage: EvidenceLineage }): number {
  const leftRoot = String(left.span.sourceVersionId) === left.lineage.identity ? 0 : 1;
  const rightRoot = String(right.span.sourceVersionId) === right.lineage.identity ? 0 : 1;
  return leftRoot - rightRoot
    || left.lineage.sourceVersionIds.length - right.lineage.sourceVersionIds.length
    || String(left.span.id).localeCompare(String(right.span.id));
}

/**
 * Resolve the immutable source lineage carried by evidence provenance.
 *
 * A derivative is one witness for its ultimate source, however many times it
 * was repackaged. Parent links are deliberately read only from the explicit
 * source-version derivation envelope written by ingestion; ordinary metadata
 * and labels cannot create ancestry. If a source declares a cycle, every
 * member of that cycle receives one deterministic identity, so a cycle cannot
 * manufacture independent corroboration.
 */
export function evidenceLineage(span: EvidenceSpan, siblings: readonly EvidenceSpan[] = [span]): EvidenceLineage {
  const parentByVersion = new Map<string, Set<string>>();
  for (const candidate of siblings) {
    const version = String(candidate.sourceVersionId ?? "").trim();
    if (!version) continue;
    const parent = sourceVersionParent(candidate);
    if (!parent) continue;
    const parents = parentByVersion.get(version) ?? new Set<string>();
    parents.add(parent);
    parentByVersion.set(version, parents);
  }

  const ownVersion = String(span.sourceVersionId ?? span.sourceId ?? "").trim();
  if (!ownVersion) return { identity: "", sourceVersionIds: [], cyclic: false };
  const path: string[] = [];
  const pathIndex = new Map<string, number>();
  let current = ownVersion;
  while (true) {
    const seenAt = pathIndex.get(current);
    if (seenAt !== undefined) {
      const cycleMembers = path.slice(seenAt);
      const identity = `lineage-cycle:${[...new Set(cycleMembers)].sort().join("|")}`;
      return { identity, sourceVersionIds: path, cyclic: true };
    }
    pathIndex.set(current, path.length);
    path.push(current);
    const parents = parentByVersion.get(current);
    // Conflicting ancestry claims for one immutable version are not enough to
    // select a parent. Keep that version isolated rather than guessing and
    // accidentally merging independent documentary records.
    if (!parents || parents.size === 0) return { identity: current, sourceVersionIds: path, cyclic: false };
    if (parents.size > 1) return { identity: `lineage-ambiguous:${current}`, sourceVersionIds: path, cyclic: false };
    current = [...parents][0]!;
  }
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
  // A person's workspace and correction streams are two channels from the
  // same origin, not two independent witnesses.  Keep those conversational
  // assertion channels source-qualified even when their labels differ.
  // Access scope and owner-local admission are deliberately not used here:
  // private documentary sources supplied by an owner can still be mutually
  // independent evidence.
  const independenceGroup = firstString(sourceTrust.independenceGroup);
  if (independenceGroup?.startsWith("owner:")) return false;
  return unitInterval(sourceTrust.identity) >= 0.5
    && unitInterval(sourceTrust.integrity) >= 0.7
    && unitInterval(sourceTrust.parserReliability) >= 0.5
    && unitInterval(sourceTrust.directness) >= 0.45
    && unitInterval(sourceTrust.authority) >= 0.4
    && evidenceDependencyGroups(span).length > 0;
}

/**
 * Every declared dependence label is retained. A fresh publisher/family label
 * cannot hide a shared citation chain or source-trust group by appearing first.
 */
export function evidenceDependencyGroups(span: EvidenceSpan): string[] {
  const provenance = objectRecord(span.provenance);
  const trust = objectRecord(span.trustVector);
  const sourceTrust = objectRecord(trust?.sourceTrust);
  const sourceIndependence = objectRecord(provenance?.sourceIndependence);
  const nestedGroups = Array.isArray(sourceIndependence?.dependencyGroupIds)
    ? sourceIndependence.dependencyGroupIds.filter((value): value is string => typeof value === "string")
    : [];
  return [...new Set([
    provenance?.sourceFamilyId,
    provenance?.dependencyFamilyId,
    sourceTrust?.independenceGroup,
    ...nestedGroups
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(value => value.trim()))].sort();
}

/**
 * Resolve transitive source-dependence components. Sharing any declared group
 * joins two spans; connected citation/republisher chains therefore remain one
 * witness even when each copy also declares a unique label.
 */
export function evidenceDependencyComponents(spans: readonly EvidenceSpan[]): Map<string, string> {
  const parent = spans.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const firstByGroup = new Map<string, number>();
  spans.forEach((span, index) => {
    for (const group of evidenceDependencyGroups(span)) {
      const prior = firstByGroup.get(group);
      if (prior === undefined) firstByGroup.set(group, index);
      else union(prior, index);
    }
  });
  const groupsByRoot = new Map<number, Set<string>>();
  spans.forEach((span, index) => {
    const root = find(index);
    const groups = groupsByRoot.get(root) ?? new Set<string>();
    for (const group of evidenceDependencyGroups(span)) groups.add(group);
    groupsByRoot.set(root, groups);
  });
  const result = new Map<string, string>();
  spans.forEach((span, index) => {
    const groups = [...(groupsByRoot.get(find(index)) ?? [])].sort();
    if (groups.length) result.set(String(span.id), `dependency-component:${groups.join("|")}`);
  });
  return result;
}

function sourceVersionParent(span: EvidenceSpan): string | undefined {
  const provenance = objectRecord(span.provenance);
  if (!provenance) return undefined;
  const candidates = [
    provenance.sourceVersionDerivation,
    provenance.derivation,
    objectRecord(provenance.sourceVersion)?.derivation,
    objectRecord(provenance.sourceVersion)?.sourceVersionDerivation
  ];
  for (const candidate of candidates) {
    const record = objectRecord(candidate);
    const parent = firstString(record?.derivedFromSourceVersionId);
    if (parent) return parent;
  }
  return undefined;
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

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
