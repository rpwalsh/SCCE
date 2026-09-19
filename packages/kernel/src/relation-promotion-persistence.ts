// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { RelationPromotionDecision, RelationPromotionModel } from "./relation-promotion.js";
import type { InformationLabel } from "./types.js";

/**
 * A relation promotion model fitted over the whole corpus, persisted so ingest does not refit one.
 *
 * Until now nothing persisted a promotion model: all four call sites compiled one in process and used it
 * immediately to decide which candidates became graph edges. That is why every block re-read the observation
 * table and re-decided every seed in the corpus -- measured live at 172k observations and 171,836 seeds per
 * block, with throughput falling from 576 to 85 sources an hour as the table grew.
 */
export interface RelationPromotionModelRecord {
  id: string;
  model: RelationPromotionModel;
  /** What produced it: a consolidation pass over the whole corpus, or a single batch. */
  basis: string;
  observationCount: number;
  createdAt: number;
  informationLabel: InformationLabel;
}

export interface RelationPromotionModelStore {
  putModel(record: RelationPromotionModelRecord): Promise<void>;
  readById(id: string): Promise<RelationPromotionModelRecord | undefined>;
  listRecent(query?: { limit?: number }): Promise<RelationPromotionModelRecord[]>;
}

/**
 * Read once per process, for the same reason the segmentation population is: a block must not pay a database
 * read for something only the offline consolidation pass changes.
 */
const consolidatedByStore = new WeakMap<object, Promise<RelationPromotionModel | undefined>>();

export function loadConsolidatedPromotion(
  store: RelationPromotionModelStore | undefined
): Promise<RelationPromotionModel | undefined> {
  if (!store) return Promise.resolve(undefined);
  const cached = consolidatedByStore.get(store);
  if (cached) return cached;
  const pending = store.listRecent({ limit: 1 })
    .then(records => records[0]?.model)
    // A brain that has not been consolidated has none, and the batch decides alone, exactly as before.
    .catch(() => undefined);
  consolidatedByStore.set(store, pending);
  return pending;
}

export function forgetConsolidatedPromotion(store: RelationPromotionModelStore | undefined): void {
  if (store) consolidatedByStore.delete(store);
}

/**
 * The batch's own decisions, overridden per seed by the consolidated model's wherever it has one.
 *
 * A consolidated decision was reached over every source family the corpus holds; a batch decision was reached
 * over the handful in one block. For the same seed the first strictly dominates, so preferring it is not a
 * weaker verdict but a better-evidenced one -- and it is what lets ingest stop reading the observation table.
 *
 * Seeds the consolidated model has never seen keep the batch's decision, so a seed whose evidence arrives
 * entirely within one block is decided exactly as before.
 */
export function applyConsolidatedPromotion(input: {
  batchModel: RelationPromotionModel;
  consolidated: RelationPromotionModel | undefined;
}): RelationPromotionModel {
  const consolidated = input.consolidated;
  if (!consolidated?.decisions.length) return input.batchModel;
  const bySeed = new Map<string, RelationPromotionDecision>(
    consolidated.decisions.map(decision => [decision.relationSeedId, decision])
  );
  let fromConsolidated = 0;
  let flippedToPromoted = 0;
  let flippedToRefused = 0;
  const decisions = input.batchModel.decisions.map(decision => {
    const preferred = bySeed.get(decision.relationSeedId);
    if (!preferred) return decision;
    fromConsolidated += 1;
    if (preferred.promoted && !decision.promoted) flippedToPromoted += 1;
    if (!preferred.promoted && decision.promoted) flippedToRefused += 1;
    return preferred;
  });
  return {
    ...input.batchModel,
    decisions,
    audit: {
      ...(input.batchModel.audit && typeof input.batchModel.audit === "object"
        && !Array.isArray(input.batchModel.audit)
        ? input.batchModel.audit
        : {}),
      consolidatedPromotion: {
        modelId: consolidated.id,
        decisionsFromConsolidated: fromConsolidated,
        decisionsFromBatch: decisions.length - fromConsolidated,
        flippedToPromoted,
        flippedToRefused
      }
    }
  };
}
