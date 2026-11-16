// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { documentedPath, documentedRepositoryFamily, documentedSourceHash } from "./source-document-reference.js";
import { informationLabelAllowsRead, joinInformationLabels } from "./information-flow.js";
import { createHasher } from "./primitives.js";
import type { EvidenceStore } from "./storage.js";
import type { ContentHash, EvidenceSpan, InformationAccessContext, InformationLabel, JsonValue, SourceVersion, SourceVersionId } from "./types.js";

export interface SourceProjectionEvidenceBinding {
  readonly schema: "scce.source_projection_evidence_binding.v1";
  readonly documentationEvidenceId: string;
  readonly documentationSourceVersionId: string;
  readonly documentationOriginalSourceVersionId: string;
  readonly canonicalEvidenceIds: readonly string[];
  readonly canonicalSourceVersionId: string;
  readonly canonicalOriginalSourceVersionId: string;
  readonly canonicalUri: string;
  readonly relativePath: string;
  readonly sourceFamily: string;
  readonly sourceContentHash: string;
}

interface Witness { span: EvidenceSpan; documentation: EvidenceSpan }
// This is an in-process ownership result, never an assertion accepted from serialized provenance.
const documentationByCanonicalProvenance = new WeakMap<object, Witness>();

export function sourceProjectionDocumentation(span: EvidenceSpan): EvidenceSpan | undefined {
  if (!span.provenance || typeof span.provenance !== "object") return undefined;
  const witness = documentationByCanonicalProvenance.get(span.provenance);
  return witness && sameSpan(witness.span, span) && witness.span.informationLabel === span.informationLabel ? witness.documentation : undefined;
}

const object = (value: JsonValue | undefined): Record<string, JsonValue> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const hash = (value: unknown): ContentHash | undefined => {
  if (typeof value !== "string") return undefined;
  const raw = value.replace(/^sha256[_:]/u, "");
  return /^[a-f0-9]{64}$/u.test(raw) ? `sha256_${raw}` as ContentHash : undefined;
};
const projection = (value: { metadata: JsonValue }) => object(value.metadata).projection;
const sourceAsSpan = (source: SourceVersion): Pick<EvidenceSpan, "provenance"> => ({ provenance: source.metadata });
const reference = (span: Pick<EvidenceSpan, "provenance">) => ({ path: documentedPath(span), family: documentedRepositoryFamily(span), hash: hash(documentedSourceHash(span)) });
const equalReference = (left: ReturnType<typeof reference>, right: ReturnType<typeof reference>) =>
  Boolean(left.path && left.family && left.hash && left.path === right.path && left.family === right.family && left.hash === right.hash);
const sameSpan = (a: EvidenceSpan, b: EvidenceSpan) => a.id === b.id && a.sourceId === b.sourceId && a.sourceVersionId === b.sourceVersionId
  && a.contentHash === b.contentHash && a.byteStart === b.byteStart && a.byteEnd === b.byteEnd && a.charStart === b.charStart
  && a.charEnd === b.charEnd && a.text === b.text && a.status === b.status;
const ownedDerivation = (source: SourceVersion): source is SourceVersion & { derivation: NonNullable<SourceVersion["derivation"]> } => {
  const value = source.derivation;
  return Boolean(value && value.kind === "extracted-text" && value.originalCoordinateSpace === "source-bytes"
    && typeof value.transformId === "string" && value.transformId.trim() && typeof value.derivedFromSourceVersionId === "string"
    && value.derivedFromSourceVersionId && Array.isArray(value.redactionMap) && value.redactionMap.length === 0);
};

/** Resolve the same exact path/family/raw-hash reference the source-owned program lane already consumes. */
export async function resolveCanonicalSourceProjectionEvidence(input: {
  readonly store: EvidenceStore;
  readonly evidence: readonly EvidenceSpan[];
  readonly informationAccess?: InformationAccessContext;
}): Promise<{ evidence: EvidenceSpan[]; contextEvidenceIds: string[]; bindings: SourceProjectionEvidenceBinding[]; refusals: Array<{ evidenceId: string; reason: string }> }> {
  const result = { evidence: [] as EvidenceSpan[], contextEvidenceIds: [] as string[], bindings: [] as SourceProjectionEvidenceBinding[], refusals: [] as Array<{ evidenceId: string; reason: string }> };
  const candidates = input.evidence.filter(span => object(span.provenance).projection === "code_adjacent_prose" && reference(span).hash);
  const { store, informationAccess } = input;
  if (!candidates.length) return { ...result, evidence: [...input.evidence] };
  if (!informationAccess || !store.sourceVersionById || !store.sourceVersionsByContentHashes || !store.listEvidenceBackedSourceVersions) {
    return { ...result, evidence: [...input.evidence], refusals: candidates.map(span => ({ evidenceId: String(span.id), reason: "source_projection.owner_reader_unavailable" })) };
  }
  const allowed = (label: InformationLabel | undefined): label is InformationLabel => {
    if (!label) return false;
    try { return informationLabelAllowsRead(label, informationAccess); } catch { return false; }
  };
  const hasher = createHasher(), fresh = await store.getEvidenceBatch(candidates.map(span => span.id));
  const owners = await store.sourceVersionsForEvidence(fresh.map(span => span.id));
  const versions = new Map<string, Promise<SourceVersion | null>>();
  const version = (id: SourceVersionId) => {
    let pending = versions.get(id); if (!pending) { pending = store.sourceVersionById!(id); versions.set(id, pending); } return pending;
  };
  const matchedByHash = await store.sourceVersionsByContentHashes([...new Set(candidates.flatMap(span => reference(span).hash ?? []))]);
  const replacements = new Map<string, EvidenceSpan[]>();
  for (const previous of candidates) {
    const fail = (reason: string) => result.refusals.push({ evidenceId: String(previous.id), reason });
    const doc = fresh.find(span => span.id === previous.id), owner = owners.find(source => source.sourceVersionId === previous.sourceVersionId);
    const ref = reference(previous);
    if (!doc || !sameSpan(previous, doc) || doc.status !== "promoted" || object(doc.provenance).projection !== "code_adjacent_prose"
      || !equalReference(ref, reference(doc)) || !allowed(doc.informationLabel) || !owner
      || owner.sourceId !== doc.sourceId || !allowed(owner.informationLabel) || projection(owner) !== "code_adjacent_prose"
      || owner.role !== "evidence-derivative" || !ownedDerivation(owner)
      || !equalReference(ref, reference(sourceAsSpan(owner)))) {
      fail("source_projection.documentation_owner_mismatch"); continue;
    }
    const original = await version(owner.derivation.derivedFromSourceVersionId);
    if (!original || original.role !== "original" || original.sourceId !== owner.sourceId || original.canonicalUri !== owner.canonicalUri
      || original.contentHash !== ref.hash || !allowed(original.informationLabel) || !equalReference(ref, reference(sourceAsSpan(original)))) {
      fail("source_projection.original_owner_mismatch"); continue;
    }
    const rawOwners = matchedByHash.filter(source => source.contentHash === ref.hash && source.canonicalUri === owner.canonicalUri
      && source.role === "evidence-derivative" && projection(source) === "code_surface_tokens" && ownedDerivation(source)
      && equalReference(ref, reference(sourceAsSpan(source))));
    if (rawOwners.length !== 1) { fail("source_projection.canonical_owner_ambiguous"); continue; }
    const selected = rawOwners[0]!, raw = await version(selected.sourceVersionId);
    if (!raw || raw.sourceId !== selected.sourceId || raw.contentHash !== ref.hash || raw.canonicalUri !== owner.canonicalUri
      || raw.role !== "evidence-derivative" || projection(raw) !== "code_surface_tokens" || !ownedDerivation(raw)
      || !allowed(raw.informationLabel) || !equalReference(ref, reference(sourceAsSpan(raw)))) {
      fail("source_projection.canonical_owner_mismatch"); continue;
    }
    const rawOriginal = await version(raw.derivation.derivedFromSourceVersionId);
    if (!rawOriginal || rawOriginal.role !== "original" || rawOriginal.sourceId !== raw.sourceId || rawOriginal.contentHash !== ref.hash
      || rawOriginal.byteLength !== raw.byteLength || rawOriginal.byteLength !== original.byteLength
      || rawOriginal.canonicalUri !== raw.canonicalUri || !allowed(rawOriginal.informationLabel)
      || !equalReference(ref, reference(sourceAsSpan(rawOriginal)))) { fail("source_projection.canonical_original_mismatch"); continue; }
    const inventory = await store.listEvidenceBackedSourceVersions({ sourceVersionIds: [raw.sourceVersionId], limit: 1, orderBySourceVersionId: true });
    const entry = inventory[0];
    if (inventory.length !== 1 || !entry || entry.sourceVersionId !== raw.sourceVersionId || entry.contentHash !== raw.contentHash
      || entry.canonicalUri !== raw.canonicalUri || entry.byteLength !== raw.byteLength || !Number.isSafeInteger(entry.promotedSpanCount)
      || entry.promotedSpanCount < 1) { fail("source_projection.evidence_inventory_mismatch"); continue; }
    const spans = (await store.searchEvidence({ sourceVersionId: raw.sourceVersionId, status: "promoted", limit: entry.promotedSpanCount })).map(row => row.span);
    if (spans.length !== entry.promotedSpanCount || new Set(spans.map(span => span.id)).size !== spans.length || spans.some(span =>
      span.status !== "promoted" || span.sourceId !== raw.sourceId || span.sourceVersionId !== raw.sourceVersionId || !allowed(span.informationLabel)
      || !equalReference(ref, reference(span)) || ![span.byteStart, span.byteEnd, span.charStart, span.charEnd].every(Number.isSafeInteger)
      || span.byteStart < 0 || span.byteEnd > raw.byteLength
      || span.byteEnd - span.byteStart !== new TextEncoder().encode(span.text).length
      || span.charEnd - span.charStart !== [...span.text].length || hash(span.contentHash) !== `sha256_${hasher.digestHex(span.text)}`)) {
      fail("source_projection.canonical_evidence_mismatch"); continue;
    }
    let joined: InformationLabel;
    try { joined = joinInformationLabels([doc.informationLabel!, owner.informationLabel!, original.informationLabel!, raw.informationLabel!, rawOriginal.informationLabel!, ...spans.map(span => span.informationLabel!)]); }
    catch { fail("source_projection.information_merge_denied"); continue; }
    if (!allowed(joined)) { fail("source_projection.information_merge_denied"); continue; }
    const documentation = Object.freeze({ ...doc, provenance: structuredClone(doc.provenance) });
    const canonical = spans.map(span => {
      const { retrievalWindow: _window, ...identity } = span;
      const bound = { ...identity, informationLabel: joined, provenance: { ...object(span.provenance) } };
      documentationByCanonicalProvenance.set(bound.provenance, { span: { ...bound }, documentation }); return bound;
    });
    replacements.set(String(doc.id), canonical); result.contextEvidenceIds.push(String(doc.id));
    result.bindings.push({ schema: "scce.source_projection_evidence_binding.v1", documentationEvidenceId: String(doc.id),
      documentationSourceVersionId: String(owner.sourceVersionId), documentationOriginalSourceVersionId: String(original.sourceVersionId),
      canonicalEvidenceIds: canonical.map(span => String(span.id)), canonicalSourceVersionId: String(raw.sourceVersionId),
      canonicalOriginalSourceVersionId: String(rawOriginal.sourceVersionId), canonicalUri: raw.canonicalUri,
      relativePath: ref.path!, sourceFamily: ref.family!, sourceContentHash: ref.hash! });
  }
  const seen = new Set<string>();
  // Canonical spans are the factual claim basis; the documentation IDs/ownership relation remain graph context.
  result.evidence = input.evidence.flatMap(span => replacements.get(String(span.id)) ?? [span]).filter(span => {
    if (seen.has(String(span.id))) return false; seen.add(String(span.id)); return true;
  });
  return result;
}
