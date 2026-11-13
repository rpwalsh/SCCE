// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { constructionSourceExampleStorageJson as exact } from "./construction-source-example-storage.js";
import type { LanguageInductionDocument } from "./language-induction.js";
import type { LanguageSegmentationWitness } from "./source-segmentation-witness.js";
import type { EvidenceId, Hasher, SourceVersionId } from "./types.js";

export interface SourceTextReplayOwner { text: string; sourceVersionId: SourceVersionId | null }
/** One authenticated logical text view decoded from the segmentation witness. */
export interface SourceTextReplayView {
  documentId: string;
  ownerDocumentId: string;
  sourceVersionId: SourceVersionId | null;
  startUtf16: number;
  endUtf16: number;
  text: string;
}
export interface SourceTextReplayContext {
  owners: ReadonlyMap<string, SourceTextReplayOwner>;
  views: ReadonlyMap<string, SourceTextReplayView>;
  hasher: Hasher;
}
export interface SourceTextReplayBinding {
  id: string; sourceVersionId: SourceVersionId | null; sourceFamilyId: string | null; evidenceIds: EvidenceId[]; trust: number | null;
  ownerDocumentId: string; startUtf16: number; endUtf16: number; windowed: boolean; textDigest: string; ownerTextDigest: string;
}
const keys = "endUtf16,evidenceIds,id,ownerDocumentId,ownerTextDigest,sourceFamilyId,sourceVersionId,startUtf16,textDigest,trust,windowed";
export const sourceTextReplayJson = exact;
export const sourceTextReplayFail = (): never => { throw Error("invalid or unavailable exact source text replay"); };
export function sourceTextReplaySnapshot<T>(value: T): T {
  try { return JSON.parse(exact(value)) as T; } catch { return sourceTextReplayFail(); }
}
export const sourceTextReplayRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const sourceTextReplayDigest = (value: unknown, hasher: Hasher): string => hasher.digestHex(exact(value));
export interface SourceTextReplayEnvelope { schema: string; recipeJson: string; digest: string }
/** Opaque JSON text preserves NUL/lone UTF-16 inside PostgreSQL JSONB strings. */
export function packSourceTextReplayRecipe<T extends { schema: string }>(value: T, hasher: Hasher): SourceTextReplayEnvelope {
  const recipeJson = exact(value);
  return { schema: value.schema, recipeJson, digest: hasher.digestHex(recipeJson) };
}
export function unpackSourceTextReplayRecipe(value: unknown, schema: string, hasher: Hasher): unknown {
  const row = sourceTextReplayRecord(value);
  if (!row || Object.keys(row).sort().join(",") !== "digest,recipeJson,schema" || row.schema !== schema
    || typeof row.recipeJson !== "string" || row.recipeJson.length > 64 * 1024 * 1024
    || hasher.digestHex(row.recipeJson) !== row.digest) return sourceTextReplayFail();
  try { return JSON.parse(row.recipeJson); } catch { return sourceTextReplayFail(); }
}
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const digest = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const splitsSurrogate = (text: string, position: number): boolean => position > 0 && position < text.length
  && /[\uD800-\uDBFF]/u.test(text[position - 1]!) && /[\uDC00-\uDFFF]/u.test(text[position]!);

/**
 * Project the already-validated segmentation witness into the sole downstream
 * source-text view registry. The physical archive owns projection deltas;
 * replay consumers reference these decoded views and never store another copy.
 */
export function sourceTextReplayViewsFromSegmentationWitness(
  witness: LanguageSegmentationWitness
): ReadonlyMap<string, SourceTextReplayView> {
  const views = new Map<string, SourceTextReplayView>();
  for (const document of witness.populations.flatMap(population => population.documents)) {
    if (views.has(document.documentId)) return sourceTextReplayFail();
    views.set(document.documentId, {
      documentId: document.documentId,
      ownerDocumentId: document.ownerDocumentId,
      sourceVersionId: (document.sourceVersionId ?? null) as SourceVersionId | null,
      startUtf16: document.sourceUtf16Start,
      endUtf16: document.sourceUtf16End,
      text: document.text
    });
  }
  return views;
}

function exactSourceTextReplayView(input: {
  id: string;
  sourceVersionId: SourceVersionId | null;
  ownerDocumentId: string;
  startUtf16: number;
  endUtf16: number;
  textDigest?: string;
}, context: SourceTextReplayContext): SourceTextReplayView {
  const owner = context.owners.get(input.ownerDocumentId) ?? sourceTextReplayFail();
  const view = context.views.get(input.id) ?? sourceTextReplayFail();
  if (typeof owner.text !== "string" || owner.sourceVersionId !== input.sourceVersionId
    || view.documentId !== input.id || view.ownerDocumentId !== input.ownerDocumentId
    || view.sourceVersionId !== input.sourceVersionId || view.startUtf16 !== input.startUtf16
    || view.endUtf16 !== input.endUtf16 || view.endUtf16 > owner.text.length
    || view.text.length !== view.endUtf16 - view.startUtf16
    || splitsSurrogate(owner.text, view.startUtf16) || splitsSurrogate(owner.text, view.endUtf16)
    || input.textDigest !== undefined && sourceTextReplayDigest(view.text, context.hasher) !== input.textDigest) {
    return sourceTextReplayFail();
  }
  return view;
}

/** Ordered metadata references authenticated source views; the recipe contains no source body or projection delta. */
export function captureSourceTextReplayBindings(documents: readonly LanguageInductionDocument[], context: SourceTextReplayContext): SourceTextReplayBinding[] {
  const bindings = documents.map(document => {
    const ownerDocumentId = document.sourceWindow?.ownerDocumentId ?? document.id;
    const owner = context.owners.get(ownerDocumentId) ?? sourceTextReplayFail();
    const startUtf16 = document.sourceWindow?.startUtf16 ?? 0, endUtf16 = document.sourceWindow?.endUtf16 ?? owner.text.length;
    const sourceVersionId = document.sourceVersionId ?? null;
    const view = exactSourceTextReplayView({ id: document.id, sourceVersionId, ownerDocumentId, startUtf16, endUtf16 }, context);
    if (view.text !== document.text) return sourceTextReplayFail();
    return { id: document.id, sourceVersionId: document.sourceVersionId ?? null, sourceFamilyId: document.sourceFamilyId ?? null,
      evidenceIds: [...(document.evidenceIds ?? [])], trust: document.trust ?? null, ownerDocumentId, startUtf16, endUtf16,
      windowed: document.sourceWindow !== undefined, textDigest: sourceTextReplayDigest(document.text, context.hasher),
      ownerTextDigest: sourceTextReplayDigest(owner.text, context.hasher) };
  });
  // The same validation applies to producer inputs and cold stored references.
  restoreSourceTextReplayDocuments(bindings, context);
  return sourceTextReplaySnapshot(bindings);
}

export function validateSourceTextReplayBindings(value: unknown): SourceTextReplayBinding[] {
  const bindings = sourceTextReplaySnapshot(value);
  if (!Array.isArray(bindings)) return sourceTextReplayFail();
  for (const binding of bindings) {
    const row = sourceTextReplayRecord(binding);
    if (!row || Object.keys(row).sort().join(",") !== keys || typeof row.id !== "string" || !row.id
      || typeof row.ownerDocumentId !== "string" || !row.ownerDocumentId || !nullableString(row.sourceVersionId)
      || !nullableString(row.sourceFamilyId) || !Array.isArray(row.evidenceIds) || !row.evidenceIds.every(id => typeof id === "string")
      || !(row.trust === null || typeof row.trust === "number" && Number.isFinite(row.trust))
      || !natural(row.startUtf16) || !natural(row.endUtf16) || row.endUtf16 < row.startUtf16
      || typeof row.windowed !== "boolean" || !digest(row.textDigest) || !digest(row.ownerTextDigest)) return sourceTextReplayFail();
  }
  return bindings as SourceTextReplayBinding[];
}

/** Validate reference shape before an adapter performs any owner reads. */
export function sourceTextReplayOwnerIds(bindings: unknown): string[] {
  return [...new Set(validateSourceTextReplayBindings(bindings).map(binding => binding.ownerDocumentId))];
}

export function restoreSourceTextReplayDocuments(value: unknown, context: SourceTextReplayContext): LanguageInductionDocument[] {
  return validateSourceTextReplayBindings(value).map(binding => {
    const owner = context.owners.get(binding.ownerDocumentId) ?? sourceTextReplayFail();
    if (typeof owner.text !== "string" || owner.sourceVersionId !== binding.sourceVersionId || binding.endUtf16 > owner.text.length
      || splitsSurrogate(owner.text, binding.startUtf16) || splitsSurrogate(owner.text, binding.endUtf16)
      || !binding.windowed && (binding.ownerDocumentId !== binding.id || binding.startUtf16 !== 0 || binding.endUtf16 !== owner.text.length)
      || sourceTextReplayDigest(owner.text, context.hasher) !== binding.ownerTextDigest) return sourceTextReplayFail();
    const text = exactSourceTextReplayView(binding, context).text;
    return { id: binding.id, text, evidenceIds: [...binding.evidenceIds],
      ...(binding.sourceVersionId !== null ? { sourceVersionId: binding.sourceVersionId } : {}),
      ...(binding.sourceFamilyId !== null ? { sourceFamilyId: binding.sourceFamilyId } : {}),
      ...(binding.trust !== null ? { trust: binding.trust } : {}),
      ...(binding.windowed ? { sourceWindow: { ownerDocumentId: binding.ownerDocumentId, startUtf16: binding.startUtf16, endUtf16: binding.endUtf16 } } : {}) };
  });
}
