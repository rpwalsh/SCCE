import type { InformationLabel } from "./types.js";
import type { InducedLanguageModel } from "./language-induction.js";

export const INDUCED_LANGUAGE_MODEL_SCHEMA_V1 = "scce.induced_language_model.v1";

/**
 * Durable archival home for the full induction model computed by
 * `language-induction.ts`'s engine. Runtime language behavior must still
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
}

export interface InducedLanguageModelStore {
  putModel(record: InducedLanguageModelRecord): Promise<void>;
  readById(id: string): Promise<InducedLanguageModelRecord | undefined>;
  /** Most recently persisted models, newest first. */
  listRecent(query?: { limit?: number }): Promise<InducedLanguageModelRecord[]>;
}
