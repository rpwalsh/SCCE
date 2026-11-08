// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalCorpusSourceSystemId } from "./corpus-registry.js";
import { canonicalStringify } from "./primitives.js";
import type { Hasher, SourceId, SourceVersionId } from "./types.js";

// Stream identity survives upgrades of derived construction compilers.
const SOURCE_LANGUAGE_TRAINING_IDENTITY_RECIPE_ID = "kernel.language_training_batch.v3" as const;

export function sourceLanguageTrainingStreamId(input: { sourceId: SourceId; sourceVersionId: SourceVersionId; sourceSystem: string; hasher: Hasher; identityRecipe?: string }): string {
  return `source.language.training.${input.hasher.digestHex(canonicalStringify({
    schema: "scce.source_language_training_identity.v1", sourceId: input.sourceId, sourceVersionId: input.sourceVersionId,
    sourceSystem: canonicalCorpusSourceSystemId(input.sourceSystem), compilerRecipe: input.identityRecipe ?? SOURCE_LANGUAGE_TRAINING_IDENTITY_RECIPE_ID
  }))}`;
}

export function canonicalNgramModelId(input: { streamId: string; profileId: string; sourceVersionId: SourceVersionId; sourceSystem?: string; languageHint: string; order: number; hasher: Hasher }): string {
  return `ngram_model_${input.hasher.digestHex(canonicalStringify({ schema: "scce.canonical_ngram_model.v1", streamId: input.streamId,
    sourceSystem: input.sourceSystem ? canonicalCorpusSourceSystemId(input.sourceSystem) : null, profileId: input.profileId,
    languageHint: input.languageHint, order: input.order, sourceVersionId: input.sourceVersionId }))}`;
}
