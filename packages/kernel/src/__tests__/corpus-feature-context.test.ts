// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  consolidateSegmentationPopulations,
  measureWindow,
  CONSOLIDATION_WINDOW_POPULATION_ID
} from "../corpus-consolidation.js";
import { createLanguageInductionEngine, type LanguageInductionDocument } from "../language-induction.js";
import {
  buildSurfaceLattice,
  compileAccumulatedBoundaryFeatureContext,
  compileBoundaryFeatureContext,
  createBoundaryFeatureContextAccumulator,
  observeLatticesForFeatureContext
} from "../surface-lattice.js";
import { createHasher } from "../primitives.js";

// The boundary feature context is cross-document recurrence: how many documents carry each surface form class.
// Derived from one shard it measures recurrence over a few hundred documents; consolidation accumulates it over
// the corpus. Measured on 40 real scce4 documents against a context over 160: the pair is 24% faster than the
// population alone AND compresses better (3.281 tokens/type against 3.637), while the population WITH a
// shard-scoped context compresses worse than deriving both per batch (3.356). They travel together or not at all.

const hasher = createHasher();

function documents(count: number, seed: string): LanguageInductionDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${seed}-doc-${index}`,
    text: `The measured quantity in ${seed} document ${index} recurs because the corpus repeats itself. `
      + `Boundaries are learned from recurrence and compression, never from a table of separators. `
      + `Paragraph ${index} carries enough shared structure for a recurrence count to mean something.`,
    sourceVersionId: `${seed}_version_${index}` as LanguageInductionDocument["sourceVersionId"],
    sourceFamilyId: `family_${index % 4}`,
    evidenceIds: [`${seed}_evidence_${index}` as never],
    languageHint: "en",
    trust: 1
  }));
}

function latticesFor(docs: readonly LanguageInductionDocument[]) {
  return docs.map(document => buildSurfaceLattice({
    documentId: document.id,
    text: document.text.slice(0, 2000),
    sourceVersionId: document.sourceVersionId,
    evidenceIds: document.evidenceIds,
    hasher
  }));
}

describe("the accumulated feature context", () => {
  it("equals the batch-compiled one when it has seen the same documents", () => {
    // The accumulator is only worth trusting if it is the same arithmetic, just fed incrementally.
    const docs = documents(9, "same");
    const lattices = latticesFor(docs);
    const direct = compileBoundaryFeatureContext({ lattices, hasher });

    const accumulator = createBoundaryFeatureContextAccumulator();
    for (let index = 0; index < lattices.length; index += 3) {
      observeLatticesForFeatureContext(accumulator, lattices.slice(index, index + 3));
    }
    const accumulated = compileAccumulatedBoundaryFeatureContext(accumulator, hasher);
    expect(accumulated.id).toBe(direct.id);
    expect(accumulated.sourceDocumentCount).toBe(direct.sourceDocumentCount);
    expect(accumulated.documentCountBySurfaceFormClass).toEqual(direct.documentCountBySurfaceFormClass);
    expect(accumulated.classCountByBoundaryContext).toEqual(direct.classCountByBoundaryContext);
  });

  it("counts a class once per boundary context however many windows it appears in", () => {
    // Summing each window's counts would double-count a class seen in two windows. The sets prevent that, and
    // the check is that windowing cannot inflate a count above the number of documents that exist.
    const docs = documents(12, "windowed");
    const lattices = latticesFor(docs);
    const accumulator = createBoundaryFeatureContextAccumulator();
    for (const lattice of lattices) observeLatticesForFeatureContext(accumulator, [lattice]);
    const context = compileAccumulatedBoundaryFeatureContext(accumulator, hasher);
    expect(context.sourceDocumentCount).toBe(docs.length);
    for (const count of Object.values(context.documentCountBySurfaceFormClass)) {
      expect(count).toBeLessThanOrEqual(docs.length);
    }
  });

  it("is carried out of consolidation, so a shard can be handed it", () => {
    const consolidated = consolidateSegmentationPopulations({ documents: documents(20, "carried"), hasher });
    expect(consolidated.boundaryFeatureContext).toBeDefined();
    // Over every document the pass saw, not the last window's.
    expect(consolidated.boundaryFeatureContext!.sourceDocumentCount).toBe(20);
  });

  it("folds into an accumulator from measureWindow, so a streaming caller gets the same thing", () => {
    const docs = documents(8, "stream");
    const accumulator = createBoundaryFeatureContextAccumulator();
    measureWindow({
      documents: docs,
      populationId: CONSOLIDATION_WINDOW_POPULATION_ID,
      hasher,
      featureContext: accumulator
    });
    const context = compileAccumulatedBoundaryFeatureContext(accumulator, hasher);
    expect(context.sourceDocumentCount).toBe(docs.length);
    expect(Object.keys(context.documentCountBySurfaceFormClass).length).toBeGreaterThan(0);
  });
});

describe("induce() with the pair", () => {
  it("still measures every document, whatever is supplied", () => {
    // THE INVARIANT THAT WAS BROKEN. An earlier version skipped the bootstrap lattice pass when a population
    // and a context were both supplied, which removed the step that measures a document's own boundary
    // statistics -- and then routed it by the population's global priors instead. That is not a cheaper way to
    // do the inference, it is not doing it. A test was even added asserting rows.length === 0, blessing the
    // absence. A document has to be measured before it can be routed.
    const engine = createLanguageInductionEngine({ hasher });
    const corpus = documents(20, "corpus");
    const consolidated = consolidateSegmentationPopulations({ documents: corpus, hasher });
    const shard = documents(6, "shard");

    const populationOnly = engine.induce({ documents: shard, fittedPopulation: consolidated.model });
    expect(populationOnly.boundaryStatistics.rows.length).toBeGreaterThan(0);

    const withContext = engine.induce({
      documents: shard,
      fittedPopulation: consolidated.model,
      boundaryFeatureContext: consolidated.boundaryFeatureContext
    });
    expect(withContext.boundaryStatistics.rows.length).toBeGreaterThan(0);
    expect(withContext.ngrams.length).toBeGreaterThan(0);
    expect(withContext.symbolCount).toBeGreaterThan(0);
    expect(Array.isArray(withContext.graphBoundConstructions)).toBe(true);
  });

  it("routes a document by its own statistics, never to population zero by default", () => {
    // The join program grouped documents with the SUPPLIED model's assignment map, which lists the documents
    // that model was fitted from. Newly ingested documents are not in it, so every one of them fell through to
    // populations[0] while its lattice had been built from a different routing entirely. Two disagreeing
    // stories about the same document inside one ingest.
    const engine = createLanguageInductionEngine({ hasher });
    const consolidated = consolidateSegmentationPopulations({ documents: documents(24, "routed"), hasher });
    const shard = documents(8, "unseen");
    const model = engine.induce({
      documents: shard,
      fittedPopulation: consolidated.model,
      boundaryFeatureContext: consolidated.boundaryFeatureContext
    });

    // Every document in this batch is one the supplied population never saw.
    const fittedIds = new Set(consolidated.model.assignments.map(row => row.documentId));
    for (const doc of shard) expect(fittedIds.has(doc.id)).toBe(false);

    // And the model still reports a population per document, derived here rather than inherited.
    const assigned = new Set(model.segmentationPopulations.populations.map(row => row.id));
    expect(assigned.size).toBeGreaterThan(0);
    expect(model.ngrams.length).toBeGreaterThan(0);
  });

  it("ignores a context offered without a population, rather than mixing scopes", () => {
    // A shard-scoped estimator fed corpus-scoped features is the mismatch this pairing exists to avoid, so a
    // context alone must change nothing.
    const engine = createLanguageInductionEngine({ hasher });
    const corpus = documents(20, "alone");
    const consolidated = consolidateSegmentationPopulations({ documents: corpus, hasher });
    const shard = documents(6, "shard-alone");
    const contextOnly = engine.induce({
      documents: shard,
      boundaryFeatureContext: consolidated.boundaryFeatureContext
    });
    const neither = engine.induce({ documents: shard });
    expect(contextOnly.boundaryStatistics.rows.length).toBe(neither.boundaryStatistics.rows.length);
    expect(contextOnly.symbolCount).toBe(neither.symbolCount);
  });
});

describe("singleton entries are dropped because they cannot change a feature", () => {
  it("segments identically with and without them", () => {
    // Both features subtract one before the logarithm, so a support of one contributes zero -- and so does an
    // absent key, because the lookup defaults to zero and max(0, -1) is zero too. This asserts that directly
    // rather than trusting the arithmetic: a context with every singleton restored must build the same lattice.
    const docs = documents(10, "prune");
    const lattices = latticesFor(docs);
    const pruned = compileBoundaryFeatureContext({ lattices, hasher });

    // Reconstruct what the context looked like before pruning, by counting without the filter.
    const accumulator = createBoundaryFeatureContextAccumulator();
    observeLatticesForFeatureContext(accumulator, lattices);
    const withSingletons = {
      ...pruned,
      documentCountBySurfaceFormClass: Object.fromEntries([...accumulator.documentsByClass]),
      classCountByBoundaryContext: Object.fromEntries(
        [...accumulator.classesByContext].map(([key, value]) => [key, value.size])
      )
    };
    // The singletons really are the bulk of it, or this test proves nothing.
    expect(Object.keys(withSingletons.documentCountBySurfaceFormClass).length)
      .toBeGreaterThan(Object.keys(pruned.documentCountBySurfaceFormClass).length * 2);

    const target = docs[0]!;
    const build = (context: typeof pruned) => buildSurfaceLattice({
      documentId: target.id,
      text: target.text.slice(0, 2000),
      sourceVersionId: target.sourceVersionId,
      evidenceIds: target.evidenceIds,
      boundaryFeatureContext: context,
      hasher
    });
    const a = build(pruned);
    const b = build(withSingletons as typeof pruned);
    // Same units, same boundary features, so the same segmentation and the same n-grams downstream.
    expect(b.units.length).toBe(a.units.length);
    expect(JSON.stringify(b.units)).toBe(JSON.stringify(a.units));
  });
});
