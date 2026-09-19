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
 * Per-seed count of independent source families the consolidated fit saw.
 *
 * This replaces an earlier `applyConsolidatedPromotion` that preferred the consolidated DECISION for any seed
 * it covered. That was wrong: a block contributing a family the consolidation never saw is exactly the case
 * where a refused seed should cross the independence gate, and preferring the stored verdict discarded that
 * evidence until the next consolidation. The comment there claimed the consolidated decision "strictly
 * dominates"; it does not, and nothing in the code established it.
 *
 * What a consolidated model can be trusted for is what it actually measured: which families supported each
 * seed. Fed to relationPromotionNeedsPriors, that answers whether reading the observation table could change
 * any verdict this batch is responsible for -- without the database aggregate, and without overriding anything.
 * Verdicts stay identical to the path that reads priors.
 */
export function consolidatedSourceFamilyCounts(
  model: RelationPromotionModel | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const decision of model?.decisions ?? []) {
    // The families the fit actually used, both sides of its source-disjoint split.
    const families = new Set([...decision.fitSourceFamilyIds, ...decision.holdoutSourceFamilyIds]);
    counts.set(decision.relationSeedId, Math.max(families.size, decision.independentSourceCount));
  }
  return counts;
}
