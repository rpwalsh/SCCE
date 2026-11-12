// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { buildSurfaceLattice } from "../surface-lattice.js";
import {
  compileLanguageSegmentationWitness,
  exportSourceSegmentationReplayRecipe,
  validateLanguageSegmentationWitness,
  type LanguageSegmentationWitnessDocument
} from "../source-segmentation-witness.js";

const hasher = createHasher();
const documentId = "source_window.real-kernel-code";
const sourceFamilyId = "source.family.real-kernel-code";
// A pinned-size window from an actual SCCE TypeScript source, rather than a
// token-shaped fixture. The assertion is representation-invariant, so edits
// to the source do not turn its content address into a brittle golden value.
const realCodeSource = readFileSync(
  new URL("../source-segmentation-witness.ts", import.meta.url),
  "utf8"
).slice(0, 1_536);

function sourceDocument(
  text = realCodeSource,
  captureSegmentationReplay = true
): LanguageSegmentationWitnessDocument {
  return {
    documentId,
    sourceFamilyId,
    text,
    lattice: buildSurfaceLattice({
      documentId,
      sourceFamilyId,
      text,
      captureSegmentationReplay,
      hasher
    })
  };
}

describe("content-addressed population membership coalescing", () => {
  it("stores one lossless membership when fitted populations converge to the same id", () => {
    const document = sourceDocument();
    const compile = (reverse: boolean) => compileLanguageSegmentationWitness({
      populationModelId: "segmentation_population.real-code",
      populations: (reverse ? [0.6, 0.4] : [0.4, 0.6]).map(prior => ({
        populationId: "population.converged",
        prior,
        documents: [document]
      })),
      hasher
    });

    const witness = compile(false);
    const reordered = compile(true);
    validateLanguageSegmentationWitness(witness, hasher);
    expect(reordered).toEqual(witness);
    expect(witness.populations).toHaveLength(1);
    expect(witness.populations[0]).toMatchObject({
      populationId: "population.converged",
      prior: 1
    });
    expect(witness.populations[0]!.documents).toHaveLength(1);
    expect(witness.populations[0]!.documents[0]!.text).toBe(realCodeSource);
    expect(exportSourceSegmentationReplayRecipe(witness.populations[0]!.documents[0]!)).toEqual(
      exportSourceSegmentationReplayRecipe(reordered.populations[0]!.documents[0]!)
    );
    expect(witness.audit).toMatchObject({
      populationCount: 1,
      inputPopulationCount: 2,
      coalescedPopulationCount: 1,
      inputDocumentMembershipCount: 2,
      coalescedDocumentMembershipCount: 1,
      documentCount: 1
    });
  });

  it("fails closed when a repeated membership changes durable or replay state", () => {
    const captured = sourceDocument();
    const changedText = sourceDocument(realCodeSource.replace("SCCE", "XCCE"));
    const withoutReplay = sourceDocument(realCodeSource, false);
    const compile = (right: LanguageSegmentationWitnessDocument) => () =>
      compileLanguageSegmentationWitness({
        populationModelId: "segmentation_population.real-code",
        populations: [captured, right].map(document => ({
          populationId: "population.converged",
          prior: 0.5,
          documents: [document]
        })),
        hasher
      });

    expect(compile(changedText)).toThrow(`segmentation witness repeats changed document ${documentId}`);
    // Replay is producer-only, so these compile to the same durable witness;
    // coalescing must still reject the missing replay recipe.
    expect(compileLanguageSegmentationWitness({
      populationModelId: "segmentation_population.captured-only",
      populations: [{ populationId: "population.one", prior: 1, documents: [captured] }],
      hasher
    }).populations[0]!.documents[0]!.id).toBe(compileLanguageSegmentationWitness({
      populationModelId: "segmentation_population.public-only",
      populations: [{ populationId: "population.one", prior: 1, documents: [withoutReplay] }],
      hasher
    }).populations[0]!.documents[0]!.id);
    expect(compile(withoutReplay)).toThrow(`segmentation witness repeats changed document ${documentId}`);
  });

  it("continues to reject one document routed to two distinct populations", () => {
    const document = sourceDocument();
    expect(() => compileLanguageSegmentationWitness({
      populationModelId: "segmentation_population.real-code",
      populations: ["population.alpha", "population.beta"].map(populationId => ({
        populationId,
        prior: 0.5,
        documents: [document]
      })),
      hasher
    })).toThrow(`segmentation witness repeats document ${documentId}`);
  });
});
