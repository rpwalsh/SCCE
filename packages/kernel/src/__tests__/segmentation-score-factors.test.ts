// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createClock, createHasher, toJsonValue } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { buildSegmentationForest, exportSegmentationAdjacencyFactors, type SegmentationForestUnit } from "../segmentation-forest.js";
import { createSegmentationAdjacencyQuery } from "../segmentation-adjacency-factors.js";
import { replaySegmentationScoreFactors, segmentationScoreFactorsCanonicalSafe, validateSegmentationScoreFactors, type SegmentationScoreFactors } from "../segmentation-score-factors.js";
import { compileJoinProgram, isJoinProgramLocalFactors } from "../join-program.js";
import { constructionSourceExampleStorageJson as exactJson } from "../construction-source-example-storage.js";
import type { BoundaryEstimatorModel } from "../boundary-estimator.js";
import { createLanguageInductionEngine } from "../language-induction.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "../language-induction-memory.js";
import type { LanguageProfile } from "../types.js";

const hasher = createHasher(), cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const estimator: BoundaryEstimatorModel = {
  schema: "scce.boundary_estimator.v2", id: "boundary.numerical.fixture", populationId: "population.fixture",
  featureOrder: ["whitespaceAdjacent", "punctuationAdjacent", "lineBreakAdjacent", "scriptTransition", "structuralBoundary", "localTransitionEntropy",
    "repeatedContextSupport", "crossDocumentRecurrence", "predictiveCompressionGain", "stableSubstitutionSupport", "exactPhraseRecurrence", "constructionReuse"],
  weights: [0.3, -0.2, 0.1, 0.4, -0.7, 0.2, 0.12, -0.1, 0.5, 0.6, -0.3, 0.8], intercept: -0.2,
  trainingStatisticsId: "statistics.numerical.fixture", iterations: 1, l2: 0,
  training: { examples: 0, positiveMass: 0, negativeMass: 0, logLoss: 0 },
  calibration: { method: "identity_no_holdout", slope: 1.1, intercept: 0.03,
    heldoutSourceDocumentIds: [], examples: 0, mass: 0, logLoss: null, brier: null,
    expectedCalibrationError: null, anchorPrecision: null, anchorRecall: null,
    predictiveCompressionGainNats: null, shardCount: 0, shardLogLossStdDev: null },
  audit: { scope: "explicit numerical fixture" }
};
function lattice(captureScoreFactors: boolean) {
  return buildSurfaceLattice({ documentId: "document.exact", text: "🧪e\u0301 f9 東京。\n甲 f9 🦉乙。\u0000 Ω 19.", boundaryEstimator: estimator, hasher, captureScoreFactors });
}
const topology = (graph: ReturnType<typeof exportSegmentationAdjacencyFactors>["factors"]) => graph.arcs.map(([start, end]) => [start, end] as const);
function resign(recipe: SegmentationScoreFactors) { const { digest: _digest, ...material } = recipe; recipe.digest = hasher.digestHex(exactJson(material)); }

describe("frozen segmentation score factors", () => {
  it("reconstructs every ordered arc Float64 and full-DAG adjacency from scorer inputs without changing the public forest", () => {
    const original = lattice(false), captured = lattice(true), measured = exportSegmentationAdjacencyFactors(captured.segmentationForest);
    expect(measured.scoreRecipe).toBeDefined();
    expect(captured).toEqual(original);
    expect(measured.factors).toEqual(exportSegmentationAdjacencyFactors(original.segmentationForest).factors);
    const graph = replaySegmentationScoreFactors(cold(measured.scoreRecipe), topology(measured.factors), hasher);
    expect(graph).toEqual(measured.factors);
    for (let i = 0; i < graph.arcs.length; i++) expect(Object.is(graph.arcs[i]![2], measured.factors.arcs[i]![2])).toBe(true);
    const bearing = new Set(graph.arcs.map((_, i) => i));
    expect([...createSegmentationAdjacencyQuery(graph, bearing).pairs()]).toEqual([...createSegmentationAdjacencyQuery(measured.factors, bearing).pairs()]);
  });

  it("defaults to no capture and preserves complete JOIN and model identities when redundant metadata is enabled", () => {
    const plain = lattice(false), captured = lattice(true);
    expect(exportSegmentationAdjacencyFactors(plain.segmentationForest)).not.toHaveProperty("scoreRecipe");
    const compile = (value: typeof plain) => compileJoinProgram({ populationId: "population.fixture", hasher,
      documents: [{ documentId: value.documentId, sourceFamilyId: "source.family", text: "🧪e\u0301 f9 東京。\n甲 f9 🦉乙。\u0000 Ω 19.", lattice: value }] });
    const first = compile(plain), second = compile(captured);
    expect(second.id).toBe(first.id);
    const clean = structuredClone(second);
    for (const document of clean.localFactors!.documents) delete document.scoreRecipe;
    expect(clean).toEqual(first);
    const { id: _id, audit: _audit, ...canonical } = clean;
    expect(second.id).toBe(`join_program.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`);
    expect(isJoinProgramLocalFactors(second.localFactors)).toBe(true);
  });

  it("publishes only normalization-stable metadata through direct corpus memory without changing model or graph identities", () => {
    const idFactory = createIdFactory({ hasher, clock: createClock({ fixedTime: 172_000 }), deterministicReplay: true, namespace: "score-proof-publication" });
    for (const text of ["alpha beta gamma. alpha beta delta. alpha beta gamma.", "alpha beta\u0000 gamma. alpha beta delta. alpha beta gamma."]) {
      const sourceVersionId = idFactory.sourceVersionId(text);
      const documents = [{ id: "document.direct", sourceVersionId, text }];
      const engine = createLanguageInductionEngine({ hasher });
      const plain = engine.induce({ documents });
      const captured = engine.induce({ documents, captureScoreFactors: true });
      expect(captured.id).toBe(plain.id);
      expect(captured.joinProgram.id).toBe(plain.joinProgram.id);
      const profile: LanguageProfile = { id: "profile.direct", sourceVersionId, scripts: [], symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 0, createdAt: 172_000 };
      const project = (model: typeof plain) => languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory, updatedAt: 172_000 });
      const baseline = project(plain), published = project(captured);
      expect(published.patterns.map(pattern => pattern.id)).toEqual(baseline.patterns.map(pattern => pattern.id));
      const clean = structuredClone(captured.joinProgram);
      let recipes = 0;
      for (const component of clean.components) for (const document of component.program.localFactors!.documents) {
        const original = plain.joinProgram.components.find(value => value.program.id === component.program.id)!.program.localFactors!.documents.find(value => value.documentId === document.documentId)!;
        expect(document.graph).toEqual(original.graph);
        if (document.scoreRecipe) { recipes++; expect(segmentationScoreFactorsCanonicalSafe(document.scoreRecipe)).toBe(true); }
        delete document.scoreRecipe;
      }
      expect(clean).toEqual(plain.joinProgram);
      if (text.includes("\u0000")) expect(recipes).toBe(0); else expect(recipes).toBeGreaterThan(0);
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const row = value as Record<string, unknown>;
        if (row.scoreRecipe) { expect(row.scoreRecipe).toEqual(toJsonValue(row.scoreRecipe)); validateSegmentationScoreFactors(row.scoreRecipe, row.graph as Parameters<typeof validateSegmentationScoreFactors>[1], hasher); }
        for (const child of Object.values(row)) visit(child);
      };
      visit(cold(published.patterns));
    }
    const measured = exportSegmentationAdjacencyFactors(lattice(true).segmentationForest);
    expect(measured.scoreRecipe).toBeDefined();
    expect(segmentationScoreFactorsCanonicalSafe(measured.scoreRecipe!)).toBe(false);
  });

  it("keeps effective custom boundary probabilities and all measured extra energy terms, including a signed-zero arc", () => {
    const unit = (id: string, start: number, end: number, before: number, after: number): SegmentationForestUnit => ({
      id, kind: "fixture", overlapClass: "base_partition", graphemeStart: start, graphemeEnd: end, recurrenceCount: 1, predictability: 0,
      boundaryBefore: { boundaryProbability: before }, boundaryAfter: { boundaryProbability: after }
    });
    const input = { latticeId: "lattice.custom", estimatorId: estimator.id, hasher, boundaryScoreState: estimator,
      units: [unit("a", 0, 1, Infinity, NaN), unit("b", 1, 2, -0, 2), unit("c", 2, 3, 2, -Infinity)],
      anchorEnergyByUnitId: { c: -1e-14 }, descriptionEnergyByUnitId: { a: 0.25 }, populationEnergyByUnitId: { b: -0.1 }, semanticContextEnergyByUnitId: { a: 0.3 } };
    const plain = buildSegmentationForest(input), captured = buildSegmentationForest({ ...input, captureScoreFactors: true });
    expect(captured).toEqual(plain);
    const measured = exportSegmentationAdjacencyFactors(captured), recipe = measured.scoreRecipe!;
    expect(recipe).toBeDefined(); expect(recipe.extras).toHaveLength(3);
    const replayed = replaySegmentationScoreFactors(cold(recipe), topology(measured.factors), hasher);
    for (let i = 0; i < replayed.arcs.length; i++) expect(Object.is(replayed.arcs[i]![2], measured.factors.arcs[i]![2])).toBe(true);
    expect(replayed.arcs.some(arc => Object.is(arc[2], -0))).toBe(true);
  });

  it("uses actual measured literals for non-JSON scorer extensions instead of changing forest acceptance", () => {
    const custom = { ...estimator, audit: { opaque: 12n } } as unknown as BoundaryEstimatorModel;
    const captured = buildSurfaceLattice({ documentId: "document.custom", text: "甲 f9 乙。", boundaryEstimator: custom, hasher, captureScoreFactors: true });
    const measured = exportSegmentationAdjacencyFactors(captured.segmentationForest);
    expect(measured.scoreRecipe).toBeDefined();
    expect(measured.scoreRecipe!.estimator).toBeNull();
    expect(measured.scoreRecipe!.states.every(state => state[0] === 1)).toBe(true);
    expect(replaySegmentationScoreFactors(cold(measured.scoreRecipe), topology(measured.factors), hasher)).toEqual(measured.factors);
  });

  it("rejects changed recipe inputs, scorer drift, unknown fields, bad refs, and any different actual graph even with valid self-digests", () => {
    const measured = exportSegmentationAdjacencyFactors(lattice(true).segmentationForest), recipe = measured.scoreRecipe!;
    for (const mutate of [
      (p: SegmentationScoreFactors) => { p.arcRefs[0] = 99999; resign(p); },
      (p: SegmentationScoreFactors) => { p.estimator!.schema = "unknown" as typeof estimator.schema; resign(p); },
      (p: SegmentationScoreFactors) => { p.repeated[0] = 0.987; resign(p); },
      (p: SegmentationScoreFactors) => { p.expectedGraphDigest = "changed"; resign(p); },
      (p: SegmentationScoreFactors) => { (p as unknown as Record<string, unknown>).extra = true; }
    ]) {
      const changed = cold(recipe); mutate(changed);
      expect(() => validateSegmentationScoreFactors(changed, measured.factors, hasher)).toThrow();
    }
    const graph = { ...measured.factors, arcs: measured.factors.arcs.map(arc => [...arc] as [number, number, number]) };
    graph.arcs[0]![2] += 1e-12;
    expect(() => validateSegmentationScoreFactors(recipe, graph, hasher)).toThrow(/segmentation score/u);
    const originalRecipe = cold(recipe), before = cold(originalRecipe);
    replaySegmentationScoreFactors(originalRecipe, topology(measured.factors), hasher);
    expect(originalRecipe).toEqual(before);
  });
});
