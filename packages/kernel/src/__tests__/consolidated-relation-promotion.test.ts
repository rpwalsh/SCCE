// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  consolidatedSourceFamilyCounts,
  forgetConsolidatedPromotion,
  loadConsolidatedPromotion,
  type RelationPromotionModelStore
} from "../relation-promotion-persistence.js";
import {
  compileRelationPromotionModel,
  relationPromotionNeedsPriors,
  RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES,
  type RelationObservation,
  type RelationPromotionModel
} from "../relation-promotion.js";
import { createHasher } from "../primitives.js";

// A consolidated fit tells a block whether reading the observation table could change any verdict, using the
// families it already measured. It must NEVER stand in for a verdict: an earlier version preferred the stored
// decision for any seed it covered, which discarded a block's new source family until the next consolidation.

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

describe("a consolidated fit answers the guard, never the verdict", () => {
  it("reports the families it measured per seed", () => {
    const consolidated = modelOver(observations(4, ["family_a", "family_b", "family_c"]));
    const counts = consolidatedSourceFamilyCounts(consolidated);
    expect(counts.size).toBe(consolidated.decisions.length);
    for (const decision of consolidated.decisions) {
      const families = new Set([...decision.fitSourceFamilyIds, ...decision.holdoutSourceFamilyIds]);
      expect(counts.get(decision.relationSeedId)).toBeGreaterThanOrEqual(families.size);
    }
  });

  it("lets a block's NEW family reach the gate instead of freezing the stored refusal", () => {
    // THE BUG. Consolidation saw three families and refused for insufficient independence. The next block
    // carries a fourth. The stored refusal must not win: the guard has to say priors could matter, so the
    // block compiles the union and the seed gets a real decision.
    const known = ["family_a", "family_b", "family_c"];
    const consolidated = modelOver(observations(4, known));
    for (const decision of consolidated.decisions) {
      expect(decision.promoted).toBe(false);
      expect(decision.reasons).toContain("insufficient_independent_sources");
    }
    expect(known.length).toBeLessThan(RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES);

    const batch = observations(4, ["family_d"]);
    const needsPriors = relationPromotionNeedsPriors({
      batch,
      familyCountsOnFile: consolidatedSourceFamilyCounts(consolidated)
    });
    expect(needsPriors).toBe(true);
  });

  it("still skips the read when no seed in the block could reach the gate", () => {
    // One family in the corpus and one in the block cannot reach four, so the table read changes nothing and
    // is skipped. This is the case that took throughput from 576 to 85 sources an hour when it was not.
    const consolidated = modelOver(observations(6, ["family_a"]));
    const needsPriors = relationPromotionNeedsPriors({
      batch: observations(6, ["family_a"]),
      familyCountsOnFile: consolidatedSourceFamilyCounts(consolidated)
    });
    expect(needsPriors).toBe(false);
  });

  it("has no counts to offer when the brain has not been consolidated", () => {
    expect(consolidatedSourceFamilyCounts(undefined).size).toBe(0);
    // Which makes the guard read priors rather than assume a seed is unscorable.
    expect(relationPromotionNeedsPriors({
      batch: observations(3, ["family_a", "family_b", "family_c", "family_d"]),
      familyCountsOnFile: consolidatedSourceFamilyCounts(undefined)
    })).toBe(true);
  });

  it("is fitted the same whether observations arrive as candidates or as priors", () => {
    // The consolidation pass supplies everything as priors, because that is how they are persisted.
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
