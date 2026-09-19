// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createLanguageInductionEngine, type LanguageInductionDocument } from "../language-induction.js";
import { createHasher } from "../primitives.js";

// Separation of powers. induce() fitted a boundary estimator and learned segmentation populations from
// whatever documents it was handed, then built the lattices everything downstream reads from that fit. On the
// ingest path that ran once per shard, on a bounded slice, at a partial 96 iterations -- measured at 30% of
// train.compile, itself the largest stage in ingest. A model fit inside a firehose.
//
// With a population supplied, no fit happens: the supplied one assigns each document from its own measured
// statistics, because a population fitted elsewhere has never seen these documents and
// boundaryMixtureForDocument refuses an unseen one by design.
//
// The shard's boundary statistics are still computed and returned either way, because they are the sufficient
// statistics a later consolidation pass merges and fits from.

const hasher = createHasher();

function documents(count: number, seed: string): LanguageInductionDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${seed}-doc-${index}`,
    text: `The measured quantity in ${seed} document ${index} varies because the words do. `
      + `Boundaries are learned from recurrence and compression, not from a table of separators. `
      + `Paragraph ${index} repeats enough structure to give the estimator something to read.`,
    sourceVersionId: `${seed}_version_${index}` as LanguageInductionDocument["sourceVersionId"],
    sourceFamilyId: `family_${index % 3}`,
    evidenceIds: [`${seed}_evidence_${index}` as never],
    languageHint: "en",
    trust: 1
  }));
}

describe("fitting is separable from ingesting", () => {
  it("fits its own population when none is supplied, and reports it", () => {
    const engine = createLanguageInductionEngine({ hasher });
    const model = engine.induce({ documents: documents(6, "own") });
    expect(model.segmentationPopulations.populations.length).toBeGreaterThan(0);
    // The statistics a consolidation pass would merge are returned whether or not a fit happened here.
    expect(model.boundaryStatistics.rows.length).toBeGreaterThan(0);
    expect(model.boundaryEstimator.weights.length).toBeGreaterThan(0);
  });

  it("uses a supplied population instead of fitting a new one", () => {
    const engine = createLanguageInductionEngine({ hasher });
    // A population fitted from one corpus, then handed to a shard of a DIFFERENT one -- which is the real
    // case: consolidation fits from everything, and the next ingest run reuses it.
    const fitted = engine.induce({ documents: documents(8, "corpus") }).segmentationPopulations;

    const shard = engine.induce({ documents: documents(5, "shard"), fittedPopulation: fitted });

    // The supplied population is the one in force, not a newly learned one.
    expect(shard.segmentationPopulations.id).toBe(fitted.id);
    expect(shard.segmentationPopulations.rootPopulationId).toBe(fitted.rootPopulationId);
    // And the estimator reported is one the supplied population already carried, not a fresh descent.
    const suppliedEstimatorIds = new Set(fitted.populations.map(population => population.estimator.id));
    expect(suppliedEstimatorIds.has(shard.boundaryEstimator.id)).toBe(true);
  });

  it("still returns the shard's own statistics for a later pass to merge", () => {
    const engine = createLanguageInductionEngine({ hasher });
    const fitted = engine.induce({ documents: documents(8, "corpus") }).segmentationPopulations;
    const shard = engine.induce({ documents: documents(5, "shard"), fittedPopulation: fitted });

    // Sufficient statistics over this shard's own documents, which is what consolidation needs. They must not
    // be the supplied population's statistics, or the shard would contribute nothing to the next fit.
    expect(shard.boundaryStatistics.rows.length).toBeGreaterThan(0);
    const suppliedStatisticsIds = new Set(fitted.populations.map(population => population.statistics.id));
    expect(suppliedStatisticsIds.has(shard.boundaryStatistics.id)).toBe(false);
  });

  it("still produces a usable model, so what ingest consumes survives the change", () => {
    // The ingest path reads exactly one field off induce(): graphBoundConstructions, and bails when it is
    // empty. Whatever else changes, that has to keep coming out.
    const engine = createLanguageInductionEngine({ hasher });
    const fitted = engine.induce({ documents: documents(8, "corpus") }).segmentationPopulations;
    const shard = engine.induce({ documents: documents(5, "shard"), fittedPopulation: fitted });
    expect(Array.isArray(shard.graphBoundConstructions)).toBe(true);
    expect(shard.ngrams.length).toBeGreaterThan(0);
    expect(shard.symbolCount).toBeGreaterThan(0);
  });

  it("ignores an empty population rather than building on nothing", () => {
    // A brain with no consolidation yet has no populations. That must fall back to fitting, not throw or
    // silently produce lattices from an empty mixture.
    const engine = createLanguageInductionEngine({ hasher });
    const empty = {
      ...engine.induce({ documents: documents(4, "seed") }).segmentationPopulations,
      populations: []
    };
    const shard = engine.induce({ documents: documents(4, "shard"), fittedPopulation: empty });
    expect(shard.segmentationPopulations.populations.length).toBeGreaterThan(0);
    expect(shard.segmentationPopulations.id).not.toBe(empty.id);
  });
});
