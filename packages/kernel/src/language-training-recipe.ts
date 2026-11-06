// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const LANGUAGE_TRAINING_BATCH_RECIPE_ID = "kernel.language_training_batch.v3" as const;
export const LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT = 150_000;
export const LANGUAGE_TRAINING_MIN_CHUNK_UTF16_LENGTH = Math.floor(LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT * 0.75) - 1;
