import type { InformationLabel } from "./types.js";
import type { InducedLanguageModel } from "./language-induction.js";

export const INDUCED_LANGUAGE_MODEL_SCHEMA_V1 = "scce.induced_language_model.v1";

/**
 * Part B step 3: persist the *full* induction model computed by
 * `language-induction.ts`'s engine, not only its audit summary.
 * `training-runtime.ts` and `production-turn-runtime.ts` both already
 * compute a complete `InducedLanguageModel` (n-grams, morphology rules,
 * syntax templates, semantic frame candidates, translation seeds) via
 * `trainingOrchestrator.plan()`, but until this store existed the object
 * was discarded after the turn -- only its JSON audit counts reached a
 * durable event. This is the durable home for the real thing.
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
