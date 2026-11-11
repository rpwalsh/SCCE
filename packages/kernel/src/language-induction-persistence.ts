// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { InformationLabel } from "./types.js";
import type { InducedLanguageModel } from "./language-induction.js";
import type { LanguageSegmentationWitnessReference } from "./language-induction-memory.js";

/**
 * Durable archival home for the logical induction model computed by
 * `language-induction.ts`'s engine. The segmentation witness is normalized
 * to a canonical language-pattern manifest reference at write time and
 * restored exactly on cold reads; its full DAG is never copied into this
 * model row. Runtime language behavior must still
 * flow through normal language-memory records; training code projects the
 * model's morphology/syntax/semantic/translation summaries into
 * `LanguagePatternRecord`s when it wants the checkpoint to influence
 * hydration. A stored model alone is only an inspectable checkpoint, not an
 * active surface prior.
 */
export interface InducedLanguageModelRecord {
  id: string;
  model: InducedLanguageModel;
  trainingPlanId: string;
  createdAt: number;
  informationLabel: InformationLabel;
  /**
   * Required when `model.segmentationWitness` is present. The store persists
   * this compact pointer in place of the full witness graph and resolves it
   * through canonical language-pattern archives on cold reads.
   */
  segmentationWitnessReference?: LanguageSegmentationWitnessReference;
}

export interface InducedLanguageModelStore {
  putModel(record: InducedLanguageModelRecord): Promise<void>;
  readById(id: string): Promise<InducedLanguageModelRecord | undefined>;
  /** Most recently persisted models, newest first. */
  listRecent(query?: { limit?: number }): Promise<InducedLanguageModelRecord[]>;
}
