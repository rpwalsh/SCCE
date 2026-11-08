// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createDiscourseProvenanceBindingV2, type DiscourseMentionV2, type DiscourseProvenanceBindingV2 } from "./discourse-state.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import { createSourceTextPointCache, sourceTextPointLength, sourceTextPointSlice } from "./source-text-points.js";
import { canonicalGraphemeSegmenter } from "./normalization-contract.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceSpan, Hasher, JsonValue } from "./types.js";

export const SOURCE_REFERENCE_BINDING_SCHEMA = "scce.source_reference_bindings.v1" as const;
export const SOURCE_REFERENCE_BINDING_RECIPE = "kernel.source_reference_bindings.v1" as const;

export type SourceReferenceBasis =
  | { kind: "source_annotated"; annotationSchema: string; annotationId: string }
  | { kind: "qualified_inference"; modelId: string; modelVersion: string; qualificationId: string };

export interface SourceReferenceOccurrenceDeclaration {
  id: string;
  referentId: string;
  propertyId?: string;
  startCodePoint: number;
  endCodePoint: number;
  propertyStartCodePoint?: number;
  propertyEndCodePoint?: number;
  scopeIds?: readonly string[];
  sourceTags?: JsonValue;
}

/** Entity identity and replaceable surface attributes are distinct source observations. */
export interface SourceReferenceBindingDeclaration {
  schema: typeof SOURCE_REFERENCE_BINDING_SCHEMA;
  coordinateSpace: "unicode_code_point";
  sourceTextHash: string;
  basis: SourceReferenceBasis;
  completeReferentIds: readonly string[];
  completeProperties?: readonly { referentId: string; propertyId: string }[];
  occurrences: readonly SourceReferenceOccurrenceDeclaration[];
}

export interface OwnedSourceReferenceOccurrence {
  sourceOccurrenceId: string;
  evidenceId: string;
  contentHash: string;
  evidenceCharStart: number;
  evidenceCharEnd: number;
  mention: DiscourseMentionV2;
  binding: DiscourseProvenanceBindingV2;
  propertyId?: string;
  propertySpan?: { start: number; end: number; surfaceHash: string };
}

export interface OwnedSourceReferenceBindings {
  id: string;
  profileId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceTextHash: string;
  basis: SourceReferenceBasis & { kind: "source_annotated" };
  completeReferentIds: readonly string[];
  completeProperties: readonly { referentId: string; propertyId: string }[];
  occurrences: readonly OwnedSourceReferenceOccurrence[];
}

export interface SourceReferenceProperty {
  patternId: string;
  referentId: string;
  propertyId: string;
  basis: OwnedSourceReferenceBindings["basis"];
  complete: boolean;
  occurrences: readonly OwnedSourceReferenceOccurrence[];
}

export interface SourceReferenceIssue { code: string; occurrenceId?: string }

interface ReferenceWitness {
  occurrenceId: string;
  evidenceId: string;
  contentHash: string;
  surfaceHash: string;
  propertySurfaceHash?: string;
}

const ownedReferenceDocuments = new WeakSet<OwnedSourceReferenceBindings>();

export function compileSourceReferenceBindingPattern(input: {
  declaration: SourceReferenceBindingDeclaration; text: string; profileId: string;
  evidence: readonly EvidenceSpan[]; hasher: Hasher; updatedAt: number;
}): { pattern?: LanguagePatternRecord; bindings?: OwnedSourceReferenceBindings; issues: SourceReferenceIssue[] } {
  if (input.declaration?.sourceTextHash !== input.hasher.digestHex(input.text)) return { issues: [{ code: "source.reference.text_changed" }] };
  const materialized = materialize(input);
  if (!materialized.bindings || !materialized.material) return { issues: materialized.issues };
  const bindings = materialized.bindings;
  const evidenceIds = [...new Set(bindings.occurrences.map(row => row.evidenceId))].sort();
  return { bindings, issues: [], pattern: { id: bindings.id, profileId: input.profileId, patternKind: "semantic_role",
    support: bindings.occurrences.length, entropy: 0, evidenceIds: evidenceIds as EvidenceSpan["id"][], updatedAt: input.updatedAt,
    patternJson: toJsonValue(materialized.material) } };
}

/** Reconstruct the discourse bindings only after the stored source witnesses match current evidence. */
export function sourceReferenceBindingsFromPatterns(input: {
  patterns: readonly LanguagePatternRecord[]; evidence: readonly EvidenceSpan[]; hasher: Hasher;
}): { bindings: OwnedSourceReferenceBindings[]; issues: SourceReferenceIssue[] } {
  const bindings: OwnedSourceReferenceBindings[] = [], issues: SourceReferenceIssue[] = [];
  for (const pattern of input.patterns) {
    const record = object(pattern.patternJson);
    if (record.schema !== SOURCE_REFERENCE_BINDING_SCHEMA) continue;
    const declaration = record.declaration as unknown as SourceReferenceBindingDeclaration;
    const rebuilt = materialize({ declaration, profileId: pattern.profileId, evidence: input.evidence, hasher: input.hasher });
    const expectedEvidence = rebuilt.bindings ? [...new Set(rebuilt.bindings.occurrences.map(row => row.evidenceId))].sort() : [];
    if (!rebuilt.bindings || !rebuilt.material || rebuilt.bindings.id !== pattern.id
      || canonicalStringify(rebuilt.material) !== canonicalStringify(Object.fromEntries(Object.keys(rebuilt.material).map(key => [key, record[key]])))
      || canonicalStringify(expectedEvidence) !== canonicalStringify([...pattern.evidenceIds].map(String).sort())) {
      issues.push(...(rebuilt.issues.length ? rebuilt.issues : [{ code: "source.reference.ownership_changed" }]));
      continue;
    }
    bindings.push(rebuilt.bindings);
  }
  return { bindings, issues };
}

export function sourceReferencePropertiesForSpan(input: {
  documents: readonly OwnedSourceReferenceBindings[]; sourceVersionId: string; startCodePoint: number; endCodePoint: number;
}): SourceReferenceProperty[] {
  return input.documents.flatMap(document => {
    if (!ownedReferenceDocuments.has(document) || document.sourceVersionId !== input.sourceVersionId) return [];
    const matching = document.occurrences.filter(row => row.propertyId && row.propertySpan?.start === input.startCodePoint
      && row.propertySpan.end === input.endCodePoint);
    const keys = [...new Set(matching.map(row => canonicalStringify([row.binding.referentId, row.propertyId])))];
    return keys.map(key => {
      const anchor = matching.find(row => canonicalStringify([row.binding.referentId, row.propertyId]) === key)!;
      const referentId = anchor.binding.referentId, propertyId = anchor.propertyId!;
      return { patternId: document.id, referentId, propertyId, basis: document.basis,
        complete: document.completeProperties.some(row => row.referentId === referentId && row.propertyId === propertyId),
        occurrences: document.occurrences.filter(row => row.binding.referentId === referentId && row.propertyId === propertyId) };
    });
  });
}

export function sourceReferencePropertyByIdentity(input: {
  documents: readonly OwnedSourceReferenceBindings[]; patternId: string; referentId: string; propertyId: string;
}): SourceReferenceProperty | undefined {
  const document = input.documents.find(row => ownedReferenceDocuments.has(row) && row.id === input.patternId);
  if (!document) return undefined;
  const occurrences = document.occurrences.filter(row => row.binding.referentId === input.referentId && row.propertyId === input.propertyId);
  return occurrences.length ? { patternId: document.id, referentId: input.referentId, propertyId: input.propertyId, basis: document.basis,
    complete: document.completeProperties.some(row => row.referentId === input.referentId && row.propertyId === input.propertyId), occurrences } : undefined;
}

function materialize(input: {
  declaration: SourceReferenceBindingDeclaration; profileId: string; evidence: readonly EvidenceSpan[]; hasher: Hasher;
}): { bindings?: OwnedSourceReferenceBindings; material?: Record<string, JsonValue>; issues: SourceReferenceIssue[] } {
  const value = input.declaration;
  const reject = (code: string, occurrenceId?: string) => ({ issues: [{ code, ...(occurrenceId ? { occurrenceId } : {}) }] });
  if (!value || value.schema !== SOURCE_REFERENCE_BINDING_SCHEMA || value.coordinateSpace !== "unicode_code_point"
    || !nonempty(value.sourceTextHash) || !Array.isArray(value.occurrences) || !Array.isArray(value.completeReferentIds)
    || value.completeReferentIds.some(id => !nonempty(id)) || (value.completeProperties !== undefined && !Array.isArray(value.completeProperties))) return reject("source.reference.invalid_declaration");
  if (value.basis?.kind !== "source_annotated") return reject("source.reference.inference_qualification_unavailable");
  if (!nonempty(value.basis.annotationSchema) || !nonempty(value.basis.annotationId)) return reject("source.reference.annotation_identity_missing");
  const evidence = input.evidence.filter(row => row.status === "promoted");
  const points = createSourceTextPointCache();
  const boundaries = new Map<string, ReadonlySet<number>>();
  const isBoundary = (span: EvidenceSpan, offset: number) => {
    let known = boundaries.get(String(span.id));
    if (!known) {
      const found = new Set<number>([span.charStart]);
      let cursor = span.charStart;
      for (const grapheme of canonicalGraphemeSegmenter().segment(span.text)) {
        for (const _point of grapheme.segment) cursor++;
        found.add(cursor);
      }
      known = found;
      boundaries.set(String(span.id), known);
    }
    return known.has(offset);
  };
  const witnessed: Array<{ raw: SourceReferenceOccurrenceDeclaration; span: EvidenceSpan; witness: ReferenceWitness }> = [];
  const ids = new Set<string>();
  for (const raw of value.occurrences) {
    if (!raw || !nonempty(raw.id) || ids.has(raw.id) || !nonempty(raw.referentId) || !range(raw.startCodePoint, raw.endCodePoint)) return reject("source.reference.invalid_occurrence", raw?.id);
    ids.add(raw.id);
    const owners = evidence.filter(span => span.charStart <= raw.startCodePoint && span.charEnd >= raw.endCodePoint);
    if (owners.length !== 1) return reject("source.reference.ambiguous_or_missing_evidence", raw.id);
    const span = owners[0]!;
    const surface = sourceTextPointSlice(span.text, raw.startCodePoint - span.charStart, raw.endCodePoint - span.charStart, points);
    if (!surface || sourceTextPointLength(span.text, points) !== span.charEnd - span.charStart
      || !isBoundary(span, raw.startCodePoint) || !isBoundary(span, raw.endCodePoint)) return reject("source.reference.coordinates_changed", raw.id);
    let propertySurfaceHash: string | undefined;
    if (raw.propertyId !== undefined) {
      const start = raw.propertyStartCodePoint ?? raw.startCodePoint, end = raw.propertyEndCodePoint ?? raw.endCodePoint;
      if (!nonempty(raw.propertyId) || !range(start, end) || start < raw.startCodePoint || end > raw.endCodePoint
        || !isBoundary(span, start) || !isBoundary(span, end)) return reject("source.reference.invalid_property", raw.id);
      propertySurfaceHash = input.hasher.digestHex(sourceTextPointSlice(span.text, start - span.charStart, end - span.charStart, points));
    } else if (raw.propertyStartCodePoint !== undefined || raw.propertyEndCodePoint !== undefined) return reject("source.reference.property_identity_missing", raw.id);
    if (raw.scopeIds !== undefined && (!Array.isArray(raw.scopeIds) || raw.scopeIds.some((id: unknown) => !nonempty(id)))) return reject("source.reference.invalid_scope", raw.id);
    witnessed.push({ raw, span, witness: { occurrenceId: raw.id, evidenceId: String(span.id), contentHash: String(span.contentHash),
      surfaceHash: input.hasher.digestHex(surface), ...(propertySurfaceHash ? { propertySurfaceHash } : {}) } });
  }
  if (!witnessed.length) return reject("source.reference.no_observations");
  const first = witnessed[0]!.span;
  if (witnessed.some(row => row.span.sourceId !== first.sourceId || row.span.sourceVersionId !== first.sourceVersionId)) return reject("source.reference.foreign_owner");
  const observedReferents = new Set(witnessed.map(row => row.raw.referentId));
  if (value.completeReferentIds.some(id => !observedReferents.has(id))) return reject("source.reference.unobserved_complete_referent");
  const completeProperties = value.completeProperties ?? [];
  if (completeProperties.some(row => !row || !nonempty(row.referentId) || !nonempty(row.propertyId)
    || !witnessed.some(witness => witness.raw.referentId === row.referentId && witness.raw.propertyId === row.propertyId))) return reject("source.reference.unobserved_complete_property");
  const owner = { sourceId: String(first.sourceId), sourceVersionId: String(first.sourceVersionId) };
  const material = toJsonValue({ schema: SOURCE_REFERENCE_BINDING_SCHEMA, recipe: SOURCE_REFERENCE_BINDING_RECIPE, profileId: input.profileId,
    ...owner, declaration: value, witnesses: witnessed.map(row => row.witness) }) as Record<string, JsonValue>;
  const id = opaque(input.hasher, "source.reference.bindings", material);
  const referent = (raw: string) => opaque(input.hasher, "source.reference.referent", [owner, raw]);
  const occurrences = witnessed.map(({ raw, span, witness }): OwnedSourceReferenceOccurrence => {
    const referentId = referent(raw.referentId), nodeId = opaque(input.hasher, "source.reference.node", [owner, raw.referentId]);
    const mention: DiscourseMentionV2 = { schema: "scce.discourse_mention.v2", id: opaque(input.hasher, "source.reference.mention", [owner, value.basis, raw.id]),
      span: { start: raw.startCodePoint, end: raw.endCodePoint }, kindId: "source.reference.mention", surfaceHash: witness.surfaceHash,
      semanticRoleIds: raw.propertyId ? [raw.propertyId] : [], requestedSlotIds: [], learnedFrameIds: [id], candidateNodeIds: [nodeId],
      candidateReferentIds: [referentId], scopeIds: [...(raw.scopeIds ?? [])] };
    const binding = createDiscourseProvenanceBindingV2({ observationId: id, mentionId: mention.id, referentId, routeId: id,
      nodeIds: [nodeId], claimIds: [], evidenceIds: [String(span.id)], sourceVersionIds: [String(span.sourceVersionId)], contradictionIds: [] }, input.hasher);
    return { sourceOccurrenceId: raw.id, evidenceId: String(span.id), contentHash: String(span.contentHash), evidenceCharStart: span.charStart, evidenceCharEnd: span.charEnd, mention, binding,
      ...(raw.propertyId ? { propertyId: raw.propertyId, propertySpan: { start: raw.propertyStartCodePoint ?? raw.startCodePoint,
        end: raw.propertyEndCodePoint ?? raw.endCodePoint, surfaceHash: witness.propertySurfaceHash! } } : {}) };
  });
  const bindings: OwnedSourceReferenceBindings = { id, profileId: input.profileId, ...owner, sourceTextHash: value.sourceTextHash,
    basis: { ...value.basis }, completeReferentIds: value.completeReferentIds.map(referent),
    completeProperties: completeProperties.map(row => ({ referentId: referent(row.referentId), propertyId: row.propertyId })), occurrences };
  freezeOwned(bindings);
  ownedReferenceDocuments.add(bindings);
  return { bindings, material, issues: [] };
}

function opaque(hasher: Hasher, prefix: string, value: unknown): string { return `${prefix}.${hasher.digestHex(canonicalStringify(toJsonValue(value)))}`; }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function range(start: unknown, end: unknown): boolean { return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number(start) >= 0 && Number(end) > Number(start); }
function object(value: unknown): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function freezeOwned(value: object): void { for (const child of Object.values(value)) if (child && typeof child === "object") freezeOwned(child); Object.freeze(value); }
