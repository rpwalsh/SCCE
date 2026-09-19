// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  applyConsolidatedPromotion,
  forgetConsolidatedPromotion,
  loadConsolidatedPromotion,
  type RelationPromotionModelStore
} from "../relation-promotion-persistence.js";
import {
  compileRelationPromotionModel,
  type RelationObservation,
  type RelationPromotionModel
} from "../relation-promotion.js";
import { createHasher } from "../primitives.js";

// Separation of powers for relation promotion. Ingest decided it per block, re-reading every observation the
// corpus held and re-deciding every seed each time. Consolidation decides once over the whole population, and a
// block prefers that decision -- which is the better-evidenced one, because promotion measures corroboration
// across independent source families and a block sees a few where the corpus holds all of them.

const hasher = createHasher();

function observations(seeds: number, families: readonly string[]): RelationObservation[] {
  return families.flatMap(sourceFamilyId => Array.from({ length: seeds }, (_, index) => ({
    candidateId: `candidate.${sourceFamilyId}.${index}`,
    relationSeedId: `seed.${index}`,
    channel: "source_declared_structured" as const,
    sourceId: `source.${sourceFamilyId}`,
    sourceFamilyId,
    signature: `signature.${index % 3}`
  })));
}

function modelOver(priorObservations: readonly RelationObservation[]): RelationPromotionModel {
  return compileRelationPromotionModel({ candidates: [], priorObservations, hasher });
}

describe("promotion decided over the corpus, applied by the block", () => {
  it("prefers the consolidated decision for a seed it knows", () => {
    // The corpus holds four independent families; the block holds one. Same seeds either way.
    const consolidated = modelOver(observations(6, ["family_a", "family_b", "family_c", "family_d"]));
    const batchModel = modelOver(observations(6, ["family_a"]));
    expect(batchModel.decisions.length).toBeGreaterThan(0);

    const applied = applyConsolidatedPromotion({ batchModel, consolidated });
    const consolidatedBySeed = new Map(consolidated.decisions.map(row => [row.relationSeedId, row]));
    for (const decision of applied.decisions) {
      const preferred = consolidatedBySeed.get(decision.relationSeedId);
      if (preferred) expect(decision).toEqual(preferred);
    }
    // The block alone could not corroborate anything across families; the corpus-wide fit can.
    const batchSources = Math.max(...batchModel.decisions.map(row => row.independentSourceCount));
    const appliedSources = Math.max(...applied.decisions.map(row => row.independentSourceCount));
    expect(appliedSources).toBeGreaterThan(batchSources);
  });

  it("keeps the block's own decision for a seed the corpus has never seen", () => {
    const consolidated = modelOver(observations(3, ["family_a", "family_b"]));
    // Seeds 0-2 are shared; 3-5 exist only in this block.
    const batchModel = modelOver(observations(6, ["family_a", "family_b"]));
    const applied = applyConsolidatedPromotion({ batchModel, consolidated });

    const knownSeeds = new Set(consolidated.decisions.map(row => row.relationSeedId));
    const batchBySeed = new Map(batchModel.decisions.map(row => [row.relationSeedId, row]));
    const novel = applied.decisions.filter(row => !knownSeeds.has(row.relationSeedId));
    expect(novel.length).toBeGreaterThan(0);
    for (const decision of novel) {
      expect(decision).toEqual(batchBySeed.get(decision.relationSeedId));
    }
  });

  it("reports where each decision came from rather than hiding the substitution", () => {
    const consolidated = modelOver(observations(3, ["family_a", "family_b", "family_c"]));
    const batchModel = modelOver(observations(6, ["family_a"]));
    const applied = applyConsolidatedPromotion({ batchModel, consolidated });

    const audit = applied.audit as Record<string, unknown>;
    const report = audit.consolidatedPromotion as Record<string, unknown>;
    expect(report.modelId).toBe(consolidated.id);
    expect(Number(report.decisionsFromConsolidated)).toBeGreaterThan(0);
    expect(Number(report.decisionsFromBatch)).toBeGreaterThan(0);
    expect(
      Number(report.decisionsFromConsolidated) + Number(report.decisionsFromBatch)
    ).toBe(applied.decisions.length);
  });

  it("changes nothing at all when the brain has not been consolidated", () => {
    const batchModel = modelOver(observations(4, ["family_a", "family_b"]));
    expect(applyConsolidatedPromotion({ batchModel, consolidated: undefined })).toBe(batchModel);
    // An empty model is the same case: a fit over nothing must not replace a fit over something.
    const empty = { ...batchModel, decisions: [] };
    expect(applyConsolidatedPromotion({ batchModel, consolidated: empty })).toBe(batchModel);
  });

  it("is fitted the same whether observations arrive as candidates or as priors", () => {
    // The consolidation pass supplies everything as priors, because that is how they are persisted. That must
    // reach the same model the compiler would build from the same rows.
    const rows = observations(5, ["family_a", "family_b", "family_c"]);
    const asPriors = compileRelationPromotionModel({ candidates: [], priorObservations: rows, hasher });
    expect(asPriors.decisions.length).toBe(new Set(rows.map(row => row.relationSeedId)).size);
    expect(asPriors.id).toBe(modelOver(rows).id);
  });
});

describe("the block reads the consolidated fit once", () => {
  it("caches per store, so a block pays no repeat read", async () => {
    let reads = 0;
    const store: RelationPromotionModelStore = {
      async putModel() { /* not used */ },
      async readById() { return undefined; },
      async listRecent() { reads += 1; return []; }
    };
    forgetConsolidatedPromotion(store);
    await loadConsolidatedPromotion(store);
    await loadConsolidatedPromotion(store);
    expect(reads).toBe(1);
  });

  it("treats a store that throws as an unconsolidated brain, never as an ingest failure", async () => {
    const store: RelationPromotionModelStore = {
      async putModel() { /* not used */ },
      async readById() { return undefined; },
      async listRecent() { throw new Error("no such table"); }
    };
    await expect(loadConsolidatedPromotion(store)).resolves.toBeUndefined();
  });
});
