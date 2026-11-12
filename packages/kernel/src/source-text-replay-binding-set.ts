// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  sourceTextReplayDigest as digest,
  sourceTextReplayFail as fail,
  sourceTextReplayJson as exact,
  sourceTextReplayRecord as record,
  sourceTextReplaySnapshot as snapshot,
  validateSourceTextReplayBindings,
  type SourceTextReplayBinding
} from "./source-text-replay.js";
import type { Hasher } from "./types.js";
import type { LanguageInductionDocument } from "./language-induction.js";

export const SOURCE_TEXT_REPLAY_BINDING_SET_SCHEMA = "scce.source_text_replay_binding_set.v1" as const;
export const SOURCE_TEXT_REPLAY_BINDING_SET_REFERENCE_SCHEMA = "scce.source_text_replay_binding_set_ref.v1" as const;
export const SOURCE_TEXT_REPLAY_BINDING_SET_ID_PREFIX = "source_text_replay_bindings_" as const;

export interface SourceTextReplayBindingSetDocument {
  documentId: string;
  trust: number | null;
  windowed: boolean;
}

/** One physical row per model/profile/manifest population. No source body or witness-owned metadata is repeated. */
export interface SourceTextReplayBindingSet {
  schema: typeof SOURCE_TEXT_REPLAY_BINDING_SET_SCHEMA;
  modelId: string;
  profileId: string;
  manifestPatternId: string;
  manifestDigest: string;
  documents: SourceTextReplayBindingSetDocument[];
  expectedDocumentsDigest: string;
}

/** Recipes retain only this content-addressed identifier; the row and manifest are access checked by the adapter. */
export interface SourceTextReplayBindingSetReference {
  schema: typeof SOURCE_TEXT_REPLAY_BINDING_SET_REFERENCE_SCHEMA;
  id: string;
}

/** Exact documents loaded from the referenced binding set and its canonical witness. */
export interface ResolvedSourceTextReplayBindingSet {
  bindingSet: SourceTextReplayBindingSetReference;
  documents: readonly LanguageInductionDocument[];
  hasher: Hasher;
}

const setKeys = "documents,expectedDocumentsDigest,manifestDigest,manifestPatternId,modelId,profileId,schema";
const documentKeys = "documentId,trust,windowed";
const referenceKeys = "id,schema";
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function validateSourceTextReplayBindingSet(value: unknown): SourceTextReplayBindingSet {
  const copy = snapshot(value), root = record(copy);
  if (!root || Object.keys(root).sort().join(",") !== setKeys
    || root.schema !== SOURCE_TEXT_REPLAY_BINDING_SET_SCHEMA
    || !nonempty(root.modelId) || !nonempty(root.profileId) || !nonempty(root.manifestPatternId)
    || !sha256(root.manifestDigest) || !sha256(root.expectedDocumentsDigest)
    || !Array.isArray(root.documents)) return fail();
  const ids = new Set<string>();
  for (const value of root.documents) {
    const document = record(value);
    if (!document || Object.keys(document).sort().join(",") !== documentKeys
      || !nonempty(document.documentId) || ids.has(document.documentId)
      || !(document.trust === null || typeof document.trust === "number" && Number.isFinite(document.trust))
      || typeof document.windowed !== "boolean") return fail();
    ids.add(document.documentId);
  }
  return copy as SourceTextReplayBindingSet;
}

export function sourceTextReplayBindingSetDigest(value: unknown, hasher: Hasher): string {
  return digest(validateSourceTextReplayBindingSet(value), hasher);
}

export function sourceTextReplayBindingSetId(value: unknown, hasher: Hasher): string {
  return `${SOURCE_TEXT_REPLAY_BINDING_SET_ID_PREFIX}${sourceTextReplayBindingSetDigest(value, hasher)}`;
}

export function validateSourceTextReplayBindingSetReference(value: unknown): SourceTextReplayBindingSetReference {
  const copy = snapshot(value), root = record(copy);
  if (!root || Object.keys(root).sort().join(",") !== referenceKeys
    || root.schema !== SOURCE_TEXT_REPLAY_BINDING_SET_REFERENCE_SCHEMA
    || typeof root.id !== "string"
    || !new RegExp(`^${SOURCE_TEXT_REPLAY_BINDING_SET_ID_PREFIX}[a-f0-9]{64}$`, "u").test(root.id)) return fail();
  return copy as SourceTextReplayBindingSetReference;
}

export function sourceTextReplayBindingSetReference(
  value: SourceTextReplayBindingSet,
  hasher: Hasher
): SourceTextReplayBindingSetReference {
  return { schema: SOURCE_TEXT_REPLAY_BINDING_SET_REFERENCE_SCHEMA, id: sourceTextReplayBindingSetId(value, hasher) };
}

export function createSourceTextReplayBindingSet(input: {
  modelId: string;
  profileId: string;
  manifestPatternId: string;
  manifestDigest: string;
  bindings: readonly SourceTextReplayBinding[];
}, hasher: Hasher): SourceTextReplayBindingSet {
  const bindings = validateSourceTextReplayBindings(input.bindings);
  return validateSourceTextReplayBindingSet({
    schema: SOURCE_TEXT_REPLAY_BINDING_SET_SCHEMA,
    modelId: input.modelId,
    profileId: input.profileId,
    manifestPatternId: input.manifestPatternId,
    manifestDigest: input.manifestDigest,
    documents: bindings.map(binding => ({ documentId: binding.id, trust: binding.trust, windowed: binding.windowed })),
    expectedDocumentsDigest: digest(bindings, hasher)
  });
}

/** Verify the content-addressed row and the exact witness-derived bindings before any replay recipe consumes them. */
export function resolveSourceTextReplayBindingSet(input: {
  reference: SourceTextReplayBindingSetReference;
  bindingSet: SourceTextReplayBindingSet;
  bindings: readonly SourceTextReplayBinding[];
  hasher: Hasher;
}): SourceTextReplayBinding[] {
  const reference = validateSourceTextReplayBindingSetReference(input.reference);
  const bindingSet = validateSourceTextReplayBindingSet(input.bindingSet);
  if (sourceTextReplayBindingSetId(bindingSet, input.hasher) !== reference.id) return fail();
  const bindings = validateSourceTextReplayBindings(input.bindings);
  const documents = bindings.map(binding => ({ documentId: binding.id, trust: binding.trust, windowed: binding.windowed }));
  if (digest(bindings, input.hasher) !== bindingSet.expectedDocumentsDigest
    || exact(documents) !== exact(bindingSet.documents)) return fail();
  return snapshot(bindings);
}
