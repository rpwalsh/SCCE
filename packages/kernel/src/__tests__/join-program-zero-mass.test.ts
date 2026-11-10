// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { compileJoinProgram, compileJoinProgramMixture, renderJoinedSurface } from "../join-program.js";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { createHasher } from "../primitives.js";
import { buildSegmentationForest, type SurfaceSegmentationPath } from "../segmentation-forest.js";

const indexes = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;

function fixture(posterior = 0.5) {
  const documentId = "document.posterior", text = "\u03b1\u03b2", hasher = createHasher();
  const lattice = buildSurfaceLattice({ documentId, text, evidenceIds: ["evidence.posterior"], segmentationPathLimit: 64, hasher });
  const parts = lattice.units.filter(unit => unit.overlapClass === "base_partition").sort((a, b) => a.graphemeStart - b.graphemeStart)
    .map(unit => ({ ...unit, boundaryBefore: { ...unit.boundaryBefore, boundaryProbability: unit.graphemeStart === 0 ? 1 : 0.5 },
      boundaryAfter: { ...unit.boundaryAfter, boundaryProbability: unit.graphemeEnd === 2 ? 1 : 0.5 } }));
  const [left, right] = parts;
  lattice.units = [...parts, { ...left!, id: "whole", surface: text, normalized: text, kind: "lexical", overlapClass: "segmentation_alternative",
    boundaryAfter: right!.boundaryAfter, graphemeEnd: 2, utf16End: 2, byteEnd: right!.byteEnd, codePointEnd: 2 }];
  lattice.segmentationForest = buildSegmentationForest({ latticeId: lattice.id, estimatorId: "posterior.proof", units: lattice.units,
    semanticContextEnergyByUnitId: { [left!.id]: Math.log((1 - posterior) / posterior) }, pathLimit: 2 });
  expect(lattice.segmentationForest.paths.length).toBeGreaterThan(1);
  const compile = (paths: SurfaceSegmentationPath[]) => {
    lattice.segmentationForest.paths = paths;
    return compileJoinProgram({ populationId: "population.posterior", hasher, documents: [{ documentId, text, lattice }] });
  };
  return { lattice, compile };
}

it("does not turn zero-posterior derivations into global shape statistics while retaining genuine local evidence", () => {
  const { lattice, compile } = fixture();
  const program = compile(lattice.segmentationForest.paths.map(path => ({ ...path, posterior: 0 })));
  expect(program).toEqual(compile([]));
  expect(program.observations).toBeGreaterThan(0);
  expect(program.sourceDocumentIds).toEqual(["document.posterior"]);
  expect(program.trainingDocumentIds).toEqual(["document.posterior"]);
  for (const index of ["conditionedIndex", "structuralIndex"] as const) expect(program[index]).toEqual({});
  const mixture = compileJoinProgramMixture({ populationModelId: "model.posterior", components: [{ populationId: program.populationId, weight: 1, program }] });
  const rendered = renderJoinedSurface(["\u03b1", "\u03b2"], mixture);
  expect(rendered.status).toBe("resolved");
  expect(rendered.trace[0]!.source).toBe("exact");
  expect(rendered.trace[0]!.evidenceIds).toEqual(["evidence.posterior"]);
});

it.each([0.25, 1e-12])("preserves every genuine positive contribution of %s without reallocating omitted mass", posterior => {
  const { lattice, compile } = fixture(posterior);
  const paths = lattice.segmentationForest.paths;
  const positive = paths.find(path => path.unitIds.length === 2)!;
  expect(positive.posterior).toBe(posterior);
  const expected = compile([positive]);
  const actual = compile([positive, ...paths.map(path => ({ ...path, posterior: 0 }))]);
  expect(actual).toEqual(expected);
  expect(actual.observations).toBeGreaterThan(0);
  const rows = indexes.flatMap(index => Object.values(actual[index]).flat());
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.count >= posterior && row.probability > 0)).toBe(true);
  expect(rows.flatMap(row => row.evidenceIds)).toContain("evidence.posterior");
  expect(rows.flatMap(row => row.evidenceCoordinates).length).toBeGreaterThan(0);
});
