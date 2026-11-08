// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { buildSourceAlignmentSurfaceLattice, buildSurfaceLattice, collectBoundaryTrainingObservations,
  compileBoundaryFeatureContext, createSurfaceLatticePreparationContext } from "../surface-lattice.js";
import { compileBoundaryStatistics, fitBoundaryEstimator } from "../boundary-estimator.js";
import { canonicalNormalizationContract } from "../normalization-contract.js";
import { createHasher } from "../primitives.js";

const text = "\u00c9lan and e\u0301 visit \u6771\u4eac. \u041a\u043e\u0442 \u0438\u0434\u0451\u0442. \u0642\u0637 \u064a\u0645\u0634\u064a. \u0915\u093f\u0924\u093e\u092c \u0e41\u0e21\u0e27 \ud83d\udc69\u200d\ud83d\udcbb.\nalpha = 7 | beta = 3";
const hasher = createHasher();
const options = { documentId: "preparation.options", sourceVersionId: "source.options", evidenceIds: ["evidence.b", "evidence.a"], text, hasher };
const contextFor = (texts: string[]) => createSurfaceLatticePreparationContext({ maximumDocuments: texts.length,
  maximumSourceBytes: texts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0) });

describe("scoped estimator-independent lattice preparation", () => {
  it("preserves every output across boundary estimators, source metadata, budgets and lexical projection", () => {
    const neutral = buildSurfaceLattice(options);
    const estimator = fitBoundaryEstimator({ statistics: compileBoundaryStatistics({ populationId: "population.options",
      observations: collectBoundaryTrainingObservations({ lattices: [neutral] }), hasher }), hasher });
    const featureContext = compileBoundaryFeatureContext({ lattices: [neutral], hasher });
    const context = contextFor([text]);
    const variants = [options, { ...options, boundaryEstimator: estimator, boundaryFeatureContext: featureContext },
      { ...options, documentId: "other.document", sourceVersionId: "other.source", evidenceIds: ["other.evidence"], maxUnits: 64, maxEdges: 64, segmentationPathLimit: 2 }];
    for (const variant of variants) {
      expect(buildSurfaceLattice({ ...variant, preparationContext: context })).toEqual(buildSurfaceLattice(variant));
      expect(buildSourceAlignmentSurfaceLattice({ ...variant, preparationContext: context })).toEqual(buildSourceAlignmentSurfaceLattice(variant));
    }
    expect(context.stats()).toEqual({ preparations: 1, hits: 5, retainedDocuments: 1, retainedSourceBytes: Buffer.byteLength(text, "utf8") });
    context.clear();
    expect(context.stats()).toMatchObject({ retainedDocuments: 0, retainedSourceBytes: 0 });
  });

  it("does not expose prepared candidates or canonical identity fields through mutable output", () => {
    const context = contextFor([text]);
    const first = buildSurfaceLattice({ ...options, preparationContext: context });
    first.units[0]!.proposalSources.push("quote");
    (first.units[0]!.canonicalIdentities.normalizedForm.fields as Record<string, unknown>).normalizedSurface = "changed";
    (first.units[0]!.canonicalIdentities.surfaceFormClass.fields as Record<string, unknown>).unicodeScriptId = "changed";
    first.units[0]!.boundaryBefore.features.whitespaceAdjacent = 99;
    first.units[0]!.leftContextSketch.push("changed");
    first.units[0]!.evidenceIds.push("changed");
    expect(buildSurfaceLattice({ ...options, preparationContext: context })).toEqual(buildSurfaceLattice(options));
  });

  it("keys complete normalization dependencies and owns their values even if the caller mutates the same ID", () => {
    const context = contextFor([text]);
    const originalContract = canonicalNormalizationContract(hasher);
    const contract = { ...originalContract };
    const expected = buildSurfaceLattice({ ...options, normalizationContract: originalContract });
    expect(buildSurfaceLattice({ ...options, normalizationContract: contract, preparationContext: context })).toEqual(expected);
    contract.normalizationForm = "NFKC";
    expect(buildSurfaceLattice({ ...options, normalizationContract: { ...originalContract }, preparationContext: context })).toEqual(expected);
    expect(() => buildSurfaceLattice({ ...options, normalizationContract: contract, preparationContext: context })).toThrow("unsupported normalization contract");
    expect(() => buildSurfaceLattice({ ...options, normalizationContract: contract })).toThrow("unsupported normalization contract");
  });

  it("uses the same producer without retaining preparations beyond the actual batch allowance", () => {
    const context = contextFor([]);
    const expected = buildSurfaceLattice(options);
    expect(buildSurfaceLattice({ ...options, preparationContext: context })).toEqual(expected);
    expect(buildSurfaceLattice({ ...options, preparationContext: context })).toEqual(expected);
    expect(context.stats()).toEqual({ preparations: 2, hits: 0, retainedDocuments: 0, retainedSourceBytes: 0 });
  });

  it("keeps custom hasher ownership separate and retains no caller-controlled context", () => {
    const context = contextFor([text, text]);
    const customHasher = { digestHex: (value: string | Uint8Array) => hasher.digestHex(value) };
    expect(buildSurfaceLattice({ ...options, preparationContext: context })).toEqual(buildSurfaceLattice(options));
    expect(buildSurfaceLattice({ ...options, hasher: customHasher, preparationContext: context })).toEqual(buildSurfaceLattice({ ...options, hasher: customHasher }));
    expect(context.stats()).toMatchObject({ preparations: 2, hits: 0, retainedDocuments: 2 });
    expect(() => buildSurfaceLattice({ ...options, preparationContext: { clear() {}, stats: context.stats } })).toThrow("not owned by this compiler");
  });
});
