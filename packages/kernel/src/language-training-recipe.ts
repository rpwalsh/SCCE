// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const LANGUAGE_TRAINING_BATCH_RECIPE_ID = "kernel.language_training_batch.v7" as const;
export const CREATIVE_SOURCE_UTTERANCE_RECIPE_ID = "kernel.creative_source_utterance.v1" as const;
export const CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID = "kernel.creative_source_utterance.v2" as const;
export const CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID = "kernel.creative_source_surface_acquisition.v1" as const;
export const LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT = 150_000;
export const LANGUAGE_TRAINING_MIN_CHUNK_UTF16_LENGTH = Math.floor(LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT * 0.75) - 1;
