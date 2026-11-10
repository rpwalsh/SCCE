// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  boundaryMixtureForDocument,
  boundaryMixtureForStatistics,
  collectBoundaryTrainingObservations,
  compileBoundaryFeatureContext,
  compileBoundaryStatistics,
  createHasher,
  learnSegmentationPopulations,
  scoreBoundaryState,
  type BoundaryFeatureVector
} from "../index.js";

const spaced: BoundaryFeatureVector = {
  whitespaceAdjacent: 1,
  punctuationAdjacent: 0,
  lineBreakAdjacent: 0,
  scriptTransition: 0,
  structuralBoundary: 0,
  localTransitionEntropy: 0.5,
  repeatedContextSupport: 0.5,
  crossDocumentRecurrence: 0.5,
  predictiveCompressionGain: 0.4,
  stableSubstitutionSupport: 0.2,
  exactPhraseRecurrence: 0.5,
  constructionReuse: 0.2
};

const joined: BoundaryFeatureVector = {
  whitespaceAdjacent: 0,
  punctuationAdjacent: 0,
  lineBreakAdjacent: 0,
  scriptTransition: 0,
  structuralBoundary: 0,
  localTransitionEntropy: 0.5,
  repeatedContextSupport: 0.5,
  crossDocumentRecurrence: 0,
  predictiveCompressionGain: 0,
  stableSubstitutionSupport: 0,
  exactPhraseRecurrence: 0,
  constructionReuse: 0
};

describe("segmentation population induction", () => {
  it("selects a non-collapsed corpus-derived mixture only when held-out MDL improves", () => {
    const hasher = createHasher();
    const documents = Array.from({ length: 20 }, (_, index) => {
      const family = index < 10 ? "a" : "b";
      const prefersSpaced = family === "a";
      const documentId = `doc.${family}.${String(index).padStart(2, "0")}`;
      return {
        documentId,
        statistics: compileBoundaryStatistics({
          populationId: "population.test",
          sourceDocumentIds: [documentId],
          observations: [
            {
              sourceDocumentId: documentId,
              features: spaced,
              positiveMass: prefersSpaced ? 120 : 1,
              negativeMass: prefersSpaced ? 1 : 120,
              supervision: "independent_anchor",
              signalKind: "external_anchor",
              signalId: `${documentId}.spaced`
            },
            {
              sourceDocumentId: documentId,
              features: joined,
              positiveMass: prefersSpaced ? 1 : 120,
              negativeMass: prefersSpaced ? 120 : 1,
              supervision: "independent_anchor",
              signalKind: "external_anchor",
              signalId: `${documentId}.joined`
            }
          ],
          hasher
        })
      };
    });

    const model = learnSegmentationPopulations({
      rootPopulationId: "population.test",
      documents,
      maxPopulations: 4,
      hasher
    });

    expect(model.selection.holdoutDocumentIds.length).toBeGreaterThan(0);
    expect(model.selection.selectedPopulationCount).toBe(2);
    expect(model.selection.candidates.find(candidate =>
      candidate.populations === 1)?.mergeBlocked).toBe(true);
    expect(model.populations.every(population => population.documentIds.length >= 2)).toBe(true);
    expect(model.assignmentIndex["doc.a.01"]).toBeTypeOf("number");
    const familyA = boundaryMixtureForDocument(model, "doc.a.01", hasher);
    const familyB = boundaryMixtureForDocument(model, "doc.b.11", hasher);
    expect(scoreBoundaryState(familyA, spaced)).toBeGreaterThan(scoreBoundaryState(familyA, joined));
    expect(scoreBoundaryState(familyB, spaced)).toBeLessThan(scoreBoundaryState(familyB, joined));
    const assignment = model.assignments.find(row => row.documentId === "doc.a.01")!;
    const logWeights = assignment.posterior.map(row => {
      const prior = model.populations.find(population => population.id === row.populationId)!.prior;
      return Math.log(prior) - row.negativeLogLikelihood;
    });
    const maximum = Math.max(...logWeights);
    const denominator = logWeights.reduce((sum, value) =>
      sum + Math.exp(value - maximum), 0);
    assignment.posterior.forEach((row, index) => {
      expect(row.probability).toBeCloseTo(
        Math.exp(logWeights[index]! - maximum) / denominator,
        10
      );
    });
    expect(() => boundaryMixtureForDocument(model, "doc.unseen", hasher))
      .toThrow(/boundaryMixtureForStatistics/u);
    const unseen = boundaryMixtureForStatistics(
      model,
      "doc.unseen",
      documents[0]!.statistics,
      hasher
    );
    expect(scoreBoundaryState(unseen, spaced)).toBeGreaterThan(
      scoreBoundaryState(unseen, joined)
    );
  });

  it("assigns a supplied one-grapheme document its learned prior without changing population fitting", () => {
    const hasher = createHasher();
    const rootPopulationId = "population.zero-boundaries";
    const documents = Array.from({ length: 20 }, (_, index) => {
      const documentId = `doc.measured.${index}`;
      return { documentId, statistics: compileBoundaryStatistics({ populationId: rootPopulationId, sourceDocumentIds: [documentId], hasher,
        observations: [spaced, joined].map((features, featureIndex) => ({ sourceDocumentId: documentId, features,
          positiveMass: (index < 10) === (featureIndex === 0) ? 120 : 1,
          negativeMass: (index < 10) === (featureIndex === 0) ? 1 : 120,
          supervision: "independent_anchor" as const, signalKind: "external_anchor" as const, signalId: `${documentId}.${featureIndex}` })) }) };
    });
    const lattice = buildSurfaceLattice({ documentId: "doc.one-grapheme", text: "木", hasher });
    const zero = { documentId: lattice.documentId, statistics: compileBoundaryStatistics({ populationId: rootPopulationId,
      sourceDocumentIds: [lattice.documentId], observations: collectBoundaryTrainingObservations({ lattices: [lattice] }), hasher }) };
    expect(zero.statistics.positiveMass + zero.statistics.negativeMass).toBe(0);
    expect(() => learnSegmentationPopulations({ rootPopulationId, documents: [zero], hasher }))
      .toThrow("cannot fit segmentation populations without positive boundary observation mass");
    expect(() => learnSegmentationPopulations({ rootPopulationId, documents: [], hasher }))
      .toThrow("cannot fit segmentation populations without positive boundary observation mass");
    const baseline = learnSegmentationPopulations({ rootPopulationId, documents, maxPopulations: 4, hasher });
    const model = learnSegmentationPopulations({ rootPopulationId, documents: [zero, ...documents], maxPopulations: 4, hasher });
    expect(model.populations).toHaveLength(2);
    expect(model.populations).toEqual(baseline.populations);
    expect(model.selection).toEqual(baseline.selection);
    expect(model.collapseGuard).toEqual(baseline.collapseGuard);
    expect(model.assignments.filter(row => row.documentId !== zero.documentId)).toEqual(baseline.assignments);
    const mixture = boundaryMixtureForDocument(model, zero.documentId, hasher);
    const assignment = model.assignments[model.assignmentIndex[zero.documentId]!]!;
    expect(assignment.documentId).toBe(zero.documentId);
    for (const row of assignment.posterior) {
      expect(row.documentMass).toBe(0);
      expect(row.negativeLogLikelihood).toBe(0);
      expect(row.probability).toBeCloseTo(model.populations.find(population => population.id === row.populationId)!.prior, 12);
    }
    expect(mixture.components.map(row => row.weight)).toEqual(model.populations.map(row => row.prior));
    expect(() => boundaryMixtureForDocument(model, "doc.never-supplied", hasher)).toThrow(/unseen document/u);
    expect(learnSegmentationPopulations({ rootPopulationId, documents: [...documents, zero].reverse(), maxPopulations: 4, hasher })).toEqual(model);
  });

  it("is invariant to input document order", () => {
    const hasher = createHasher();
    const documents = ["a", "b", "c", "d"].map((id, index) => ({
      documentId: `doc.${id}`,
      statistics: compileBoundaryStatistics({
        populationId: "population.stable",
        sourceDocumentIds: [`doc.${id}`],
        observations: [{
          sourceDocumentId: `doc.${id}`,
          features: index % 2 ? spaced : joined,
          positiveMass: 4,
          negativeMass: 1,
          supervision: "independent_anchor",
          signalKind: "external_anchor",
          signalId: `doc.${id}.anchor`
        }],
        hasher
      })
    }));
    const left = learnSegmentationPopulations({
      rootPopulationId: "population.stable",
      documents,
      hasher
    });
    const right = learnSegmentationPopulations({
      rootPopulationId: "population.stable",
      documents: [...documents].reverse(),
      hasher
    });
    expect(left).toEqual(right);
  });

  it("does not merge a rare coherent population into a much larger population", () => {
    const hasher = createHasher();
    const documents = Array.from({ length: 50 }, (_, index) => {
      const rare = index >= 40;
      const documentId = `doc.opaque.${String(index).padStart(2, "0")}`;
      return {
        documentId,
        statistics: compileBoundaryStatistics({
          populationId: "population.rare-guard",
          sourceDocumentIds: [documentId],
          observations: [{
            sourceDocumentId: documentId,
            features: rare ? joined : spaced,
            positiveMass: rare ? 1 : 80,
            negativeMass: rare ? 80 : 1,
            supervision: "independent_anchor",
            signalKind: "external_anchor",
            signalId: `${documentId}.anchor`
          }],
          hasher
        })
      };
    });
    const model = learnSegmentationPopulations({
      rootPopulationId: "population.rare-guard",
      documents,
      maxPopulations: 2,
      hasher
    });

    expect(model.selection.selectedPopulationCount).toBe(2);
    expect(model.selection.candidates.find(candidate =>
      candidate.populations === 1)?.mergeBlocked).toBe(true);
    expect(model.populations.map(population => population.documentIds.length).sort((a, b) => a - b))
      .toEqual([8, 35]);
    expect(model.selection.finalEvaluationDocumentIds).toHaveLength(7);
    expect(model.populations.flatMap(population => population.documentIds)
      .some(id => model.selection.finalEvaluationDocumentIds.includes(id))).toBe(false);
    expect(model.populations.reduce((sum, population) =>
      sum + population.documentIds.length, 0)
      + model.selection.finalEvaluationDocumentIds.length).toBe(50);
  });

  it("learns through one script-neutral path without language-name inputs", () => {
    const hasher = createHasher();
    const surfaces = [
      "the river bends",
      "النهر ينحني",
      "강이 굽는다",
      "河流弯曲",
      "let value = 함수(값)",
      "◈◆◇ ◈◆◇"
    ];
    const lattices = surfaces.map((text, index) =>
      buildSurfaceLattice({
        documentId: `doc.surface.${index}`,
        text,
        hasher
      }));
    const observations = collectBoundaryTrainingObservations({ lattices });
    const documents = lattices.map(lattice => ({
      documentId: lattice.documentId,
      statistics: compileBoundaryStatistics({
        populationId: "population.script-neutral",
        observations: observations.filter(row =>
          row.sourceDocumentId === lattice.documentId),
        sourceDocumentIds: [lattice.documentId],
        hasher
      })
    }));
    const model = learnSegmentationPopulations({
      rootPopulationId: "population.script-neutral",
      documents,
      maxPopulations: 2,
      hasher
    });
    const audit = JSON.stringify(model.audit);

    expect(model.assignments).toHaveLength(surfaces.length);
    expect(audit).toContain("\"languageLabelsOrLanguageSpecificRoutingUsed\":false");
    expect(audit).toContain("\"unicodeStructuralPropertiesMayBeUniversalFeatures\":true");
    expect(audit).not.toMatch(/English|Arabic|Korean|Chinese/);
  });

  it("keeps dependent source families in one partition", () => {
    const hasher = createHasher();
    const documents = Array.from({ length: 24 }, (_, index) => {
      const family = `family.${Math.floor(index / 2)}`;
      const documentId = `doc.copy.${index}`;
      return {
        documentId,
        sourceFamilyId: family,
        statistics: compileBoundaryStatistics({
          populationId: "population.families",
          sourceDocumentIds: [documentId],
          observations: [{
            sourceDocumentId: documentId,
            features: index % 4 < 2 ? spaced : joined,
            positiveMass: 12,
            negativeMass: 1,
            supervision: "independent_anchor",
            signalKind: "external_anchor",
            signalId: `${documentId}.anchor`
          }],
          hasher
        })
      };
    });
    const model = learnSegmentationPopulations({
      rootPopulationId: "population.families",
      documents,
      maxPopulations: 2,
      hasher
    });
    const partitionByDocument = new Map<string, string>();
    for (const [partition, ids] of Object.entries({
      fit: model.selection.fitDocumentIds,
      selection: model.selection.modelSelectionDocumentIds,
      guard: model.selection.mergeGuardDocumentIds,
      evaluation: model.selection.finalEvaluationDocumentIds
    })) {
      ids.forEach(id => partitionByDocument.set(id, partition));
    }
    for (let index = 0; index < documents.length; index += 2) {
      expect(partitionByDocument.get(documents[index]!.documentId))
        .toBe(partitionByDocument.get(documents[index + 1]!.documentId));
    }
  });

  it("reconstructs corpus-derived boundary features on the serving path", () => {
    const hasher = createHasher();
    const training = [
      buildSurfaceLattice({ documentId: "doc.feature.a", text: "alpha beta", hasher }),
      buildSurfaceLattice({ documentId: "doc.feature.b", text: "alpha beta", hasher })
    ];
    const context = compileBoundaryFeatureContext({ lattices: training, hasher });
    const served = buildSurfaceLattice({
      documentId: "doc.feature.unseen",
      text: "alpha beta",
      boundaryFeatureContext: context,
      hasher
    });
    const derived = served.units.flatMap(unit => [
      unit.boundaryBefore.features,
      unit.boundaryAfter.features
    ]);
    expect(Math.max(...derived.map(features => features.crossDocumentRecurrence)))
      .toBeGreaterThan(0);
    expect(Math.max(...derived.map(features => features.exactPhraseRecurrence)))
      .toBeGreaterThan(0);
  });
});
