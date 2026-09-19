// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { consolidateSegmentationPopulations } from "../corpus-consolidation.js";
import { createLanguageInductionEngine, type LanguageInductionDocument } from "../language-induction.js";
import { createHasher } from "../primitives.js";
import { boundedInductionDocuments } from "../training-orchestrator.js";

// Separation of powers. Ingest ingests; this is the pass that fits afterwards. What has to be true of it:
//  - it fits over EVERY document handed to it, not a bounded slice of them, which is what a shard fit does;
//  - it can be asked for convergence and reports whether it got there;
//  - the model it produces is the one induce() will accept as a supplied population.

const hasher = createHasher();

function documents(count: number, seed: string): LanguageInductionDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${seed}-doc-${index}`,
    text: `The measured quantity in ${seed} document ${index} varies because the words do. `
      + `Boundaries are learned from recurrence and compression, not from a table of separators. `
      + `Paragraph ${index} repeats enough structure to give the estimator something to read.`,
    sourceVersionId: `${seed}_version_${index}` as LanguageInductionDocument["sourceVersionId"],
    sourceFamilyId: `family_${index % 4}`,
    evidenceIds: [`${seed}_evidence_${index}` as never],
    languageHint: "en",
    trust: 1
  }));
}

describe("corpus consolidation fits over the whole corpus", () => {
  it("counts every document, where the ingest path fits from a bounded slice", () => {
    // induce() does not bound its own input -- every CALLER does, with boundedInductionDocuments, because a
    // lattice's cost is superlinear in document length. So the fit an ingest shard performs is a fit over
    // whatever survived that bound, and documents past it contribute nothing to the model.
    const corpus = documents(80, "corpus");
    const slice = boundedInductionDocuments(corpus);
    expect(slice.length).toBeLessThan(corpus.length);

    const consolidated = consolidateSegmentationPopulations({ documents: corpus, hasher });
    expect(consolidated.documentCount).toBe(corpus.length);
    // Which means it had to window rather than hold the corpus alive at once.
    expect(consolidated.windowCount).toBeGreaterThan(1);

    const shardModel = createLanguageInductionEngine({ hasher }).induce({ documents: slice });
    const shardDocuments = new Set(shardModel.segmentationPopulations.assignments.map(row => row.documentId));
    const consolidatedDocuments = new Set(consolidated.model.assignments.map(row => row.documentId));
    expect(consolidatedDocuments.size).toBeGreaterThan(shardDocuments.size);
    // Every document the shard fit never saw is one consolidation did.
    for (const document of corpus.slice(slice.length)) {
      expect(shardDocuments.has(document.id)).toBe(false);
      expect(consolidatedDocuments.has(document.id)).toBe(true);
    }
  });

  it("merges statistics over every document, not over the window it last saw", () => {
    const corpus = documents(40, "merged");
    const consolidated = consolidateSegmentationPopulations({ documents: corpus, hasher });
    expect(consolidated.statistics.sourceDocumentIds.length).toBe(corpus.length);
    expect(consolidated.statistics.positiveMass + consolidated.statistics.negativeMass).toBeGreaterThan(0);
  });

  it("reports whether the descent converged rather than presenting a budget as an optimum", () => {
    const corpus = documents(24, "budget");
    // One iteration cannot converge. The result must say so instead of claiming a fit.
    const starved = consolidateSegmentationPopulations({ documents: corpus, hasher, fitIterations: 1 });
    expect(starved.populations.length).toBeGreaterThan(0);
    expect(starved.converged).toBe(false);
    for (const population of starved.populations) {
      expect(population.iterationCeiling).toBe(1);
      expect(population.iterationsRun).toBeLessThanOrEqual(1);
    }

    // Asked to converge, it escalates until the descent reaches the quantization floor -- which is the whole
    // point of moving the fit off the firehose. Measured at ~64,000 iterations for this corpus, against the
    // default budget of 96, so this is a cost only an offline pass can pay.
    const converged = consolidateSegmentationPopulations({
      documents: corpus,
      hasher,
      fitIterations: "converge"
    });
    expect(converged.converged).toBe(true);
    for (const population of converged.populations) {
      expect(population.largestStepAtStop).toBe(0);
      expect(population.iterationsRun).toBeLessThan(population.iterationCeiling);
    }
    // The escalation is reported, not hidden: every budget it tried, and the step the descent stopped at.
    expect(converged.escalation.length).toBeGreaterThan(1);
    expect(converged.escalation[0]!.converged).toBe(false);
    expect(converged.escalation[converged.escalation.length - 1]!.converged).toBe(true);
    // Each doubling made progress, or escalation would have stopped on the stall instead.
    for (let index = 1; index < converged.escalation.length; index += 1) {
      expect(converged.escalation[index]!.iterations).toBe(converged.escalation[index - 1]!.iterations * 2);
      expect(converged.escalation[index]!.worstStep).toBeLessThan(converged.escalation[index - 1]!.worstStep);
    }
  }, 300_000);

  it("produces a population induce() accepts in place of its own fit", () => {
    const consolidated = consolidateSegmentationPopulations({ documents: documents(30, "supply"), hasher });
    const engine = createLanguageInductionEngine({ hasher });
    const shard = engine.induce({
      documents: documents(5, "shard"),
      fittedPopulation: consolidated.model
    });
    expect(shard.segmentationPopulations.id).toBe(consolidated.model.id);
    expect(shard.ngrams.length).toBeGreaterThan(0);
  });

  it("holds one window alive at a time, so a bigger corpus is not a bigger peak", () => {
    // Windows are sized by a char budget, so doubling the corpus doubles the window COUNT and leaves the
    // documents per window where they were. That is what makes the pass survive a real corpus.
    const small = consolidateSegmentationPopulations({ documents: documents(40, "peak"), hasher });
    const large = consolidateSegmentationPopulations({ documents: documents(80, "peak"), hasher });
    expect(large.windowCount).toBeGreaterThan(small.windowCount);
    const smallPerWindow = small.documentCount / small.windowCount;
    const largePerWindow = large.documentCount / large.windowCount;
    expect(Math.abs(largePerWindow - smallPerWindow)).toBeLessThanOrEqual(1);
  });

  it("is deterministic, because replay depends on it", () => {
    const corpus = documents(20, "replay");
    const first = consolidateSegmentationPopulations({ documents: corpus, hasher });
    const second = consolidateSegmentationPopulations({ documents: corpus, hasher });
    expect(second.model.id).toBe(first.model.id);
    expect(second.statistics.id).toBe(first.statistics.id);
    expect(second.model.populations.map(row => row.id)).toEqual(first.model.populations.map(row => row.id));
  });
});
