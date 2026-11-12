// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { sentenceSegments, lexicalSurfaceSymbols, type SemanticInductionFactors } from "./semantic-induction-factors.js";
import { SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK } from "./unicode-segmentation.js";
import { clamp01 } from "./primitives.js";
import { sourceTextReplayDigest as digest,
  sourceTextReplayFail as fail, sourceTextReplayJson as exact, sourceTextReplayRecord as record,
  sourceTextReplaySnapshot as snapshot, packSourceTextReplayRecipe, unpackSourceTextReplayRecipe,
  type SourceTextReplayEnvelope } from "./source-text-replay.js";
import { validateSourceTextReplayBindingSetReference,
  type ResolvedSourceTextReplayBindingSet, type SourceTextReplayBindingSetReference } from "./source-text-replay-binding-set.js";
import type { LanguageInductionDocument } from "./language-induction.js";
import type { Hasher } from "./types.js";

export const SEMANTIC_SOURCE_REPLAY_SCHEMA = "scce.semantic_source_replay.storage.v1";
interface StoredFactors {
  schema: typeof SEMANTIC_SOURCE_REPLAY_SCHEMA; reducer: "kernel.semantic_sentences.exact_source.v1";
  bindingSet: SourceTextReplayBindingSetReference; header: Omit<SemanticInductionFactors, "documents" | "sentences">;
  hypotheses: Array<SemanticInductionFactors["sentences"][number]["hypotheses"]>;
  expectedLogicalDigest: string; digest: string;
}
function sentences(documents: readonly LanguageInductionDocument[], hasher: Hasher) {
  return documents.flatMap((document, documentIndex) => sentenceSegments(document.text, hasher).map((sourceSentence, ordinal) => {
    const sentence = sourceSentence.replaceAll(SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK, "");
    return { documentIndex, sentence, symbols: lexicalSurfaceSymbols(sentence, `${document.id}.frame.${ordinal}`, hasher)
      .filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char))) };
  }));
}
function restore(recipe: StoredFactors, context: ResolvedSourceTextReplayBindingSet): SemanticInductionFactors {
  if (exact(recipe.bindingSet) !== exact(validateSourceTextReplayBindingSetReference(context.bindingSet))) return fail();
  const documents = context.documents, derived = sentences(documents, context.hasher);
  const track = documents.some(document => document.sourceWindow !== undefined);
  const headers = documents.map(document => ({ id: document.id, sourceId: document.sourceFamilyId ?? document.id,
    evidenceIds: [...(document.evidenceIds ?? [])], trust: clamp01(document.trust ?? 0.5),
    ...(track ? { sourceWindow: { ...(document.sourceWindow ?? { ownerDocumentId: document.id, startUtf16: 0, endUtf16: document.text.length }) } } : {}) }));
  if (track !== recipe.header.trackSourceWindows || derived.length !== recipe.hypotheses.length) return fail();
  recipe.hypotheses.forEach((hypotheses, index) => {
    const indices = new Set<number>();
    if (!Array.isArray(hypotheses) || derived[index]!.symbols.length < 2 && hypotheses.length !== 0) return fail();
    for (const hypothesis of hypotheses) {
      if (!Array.isArray(hypothesis) || hypothesis.length !== 3 || !Number.isSafeInteger(hypothesis[0]) || hypothesis[0] < 0
        || hypothesis[0] >= derived[index]!.symbols.length || indices.has(hypothesis[0]) || !Number.isFinite(hypothesis[1])
        || hypothesis[1] < 0 || hypothesis[1] > 1 || !Number.isFinite(hypothesis[2])) return fail();
      indices.add(hypothesis[0]);
    }
  });
  const result = { ...recipe.header, documents: headers,
    sentences: derived.map((sentence, index) => ({ ...sentence, hypotheses: snapshot(recipe.hypotheses[index]!) })) };
  const { digest: expected, ...body } = result;
  if (digest(body, context.hasher) !== expected || digest(result, context.hasher) !== recipe.expectedLogicalDigest) return fail();
  return result;
}
function validated(value: unknown, hasher: Hasher): StoredFactors {
  const recipe = snapshot(unpackSourceTextReplayRecipe(value, SEMANTIC_SOURCE_REPLAY_SCHEMA, hasher)) as StoredFactors;
  if (!record(recipe) || Object.keys(recipe).sort().join(",") !== "bindingSet,digest,expectedLogicalDigest,header,hypotheses,reducer,schema"
    || recipe.schema !== SEMANTIC_SOURCE_REPLAY_SCHEMA || recipe.reducer !== "kernel.semantic_sentences.exact_source.v1"
    || !record(recipe.header) || Object.keys(recipe.header).sort().join(",") !== "digest,lexicalClasses,maxFrames,schema,trackSourceWindows"
    || recipe.header.schema !== "scce.semantic_induction_factors.v1"
    || !Array.isArray(recipe.header.lexicalClasses) || !Number.isFinite(recipe.header.maxFrames)
    || typeof recipe.header.trackSourceWindows !== "boolean" || !Array.isArray(recipe.hypotheses)
    || typeof recipe.expectedLogicalDigest !== "string") return fail();
  validateSourceTextReplayBindingSetReference(recipe.bindingSet);
  const { digest: expected, ...body } = recipe;
  if (digest(body, hasher) !== expected) return fail();
  return recipe;
}

/** Stores measured posteriors unchanged; source arithmetic restores text/symbols, never inference. */
export function encodeSemanticSourceReplay(factors: SemanticInductionFactors, input: ResolvedSourceTextReplayBindingSet): SourceTextReplayEnvelope {
  const logical = snapshot(factors), { sentences: original, documents: _documents, ...header } = logical;
  if (logical.schema !== "scce.semantic_induction_factors.v1" || !Array.isArray(original)) return fail();
  const bindingSet = validateSourceTextReplayBindingSetReference(input.bindingSet);
  const body = { schema: SEMANTIC_SOURCE_REPLAY_SCHEMA, reducer: "kernel.semantic_sentences.exact_source.v1" as const, bindingSet, header,
    hypotheses: original.map(row => snapshot(row.hypotheses)), expectedLogicalDigest: digest(logical, input.hasher) } as const;
  const recipe: StoredFactors = { ...body, digest: digest(body, input.hasher) };
  const stored = packSourceTextReplayRecipe(recipe, input.hasher);
  if (exact(restore(validated(stored, input.hasher), input)) !== exact(logical)) return fail();
  return stored;
}

export function semanticSourceReplayBindingSetReference(value: unknown, hasher: Hasher): SourceTextReplayBindingSetReference {
  return validated(value, hasher).bindingSet;
}

export function decodeSemanticSourceReplay(value: unknown, context: ResolvedSourceTextReplayBindingSet): SemanticInductionFactors {
  return restore(validated(value, context.hasher), context);
}
