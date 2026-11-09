// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { compileJoinProgram, compileJoinProgramMixture, renderJoinedSurface } from "../join-program.js";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { createHasher } from "../primitives.js";
import type { SurfaceSegmentationPath } from "../segmentation-forest.js";

const indexes = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;

function fixture() {
  const documentId = "document.posterior", text = "\u03b1 \u03b2 \u03b1 \u03b3.", hasher = createHasher();
  const lattice = buildSurfaceLattice({ documentId, text, evidenceIds: ["evidence.posterior"], segmentationPathLimit: 64, hasher });
  expect(lattice.segmentationForest.paths.length).toBeGreaterThan(1);
  const compile = (paths: SurfaceSegmentationPath[]) => compileJoinProgram({ populationId: "population.posterior", hasher,
    documents: [{ documentId, text, lattice: { ...lattice, segmentationForest: { ...lattice.segmentationForest, paths } } }] });
  return { lattice, compile };
}

it("does not turn zero-posterior derivations into join vocabulary, shapes or evidence statistics", () => {
  const { lattice, compile } = fixture();
  const program = compile(lattice.segmentationForest.paths.map(path => ({ ...path, posterior: 0 })));
  expect(program).toEqual(compile([]));
  expect(program.observations).toBe(0);
  expect(program.sourceDocumentIds).toEqual(["document.posterior"]);
  expect(program.trainingDocumentIds).toEqual(["document.posterior"]);
  for (const index of indexes) expect(program[index]).toEqual({});
  const mixture = compileJoinProgramMixture({ populationModelId: "model.posterior", components: [{ populationId: program.populationId, weight: 1, program }] });
  const rendered = renderJoinedSurface(["\u03b1", "\u03b2"], mixture);
  expect(rendered.status).toBe("unresolved");
  expect(rendered.trace[0]!.alternatives).toEqual([]);
  expect(rendered.trace[0]!.evidenceIds).toEqual([]);
});

it.each([0.25, 1e-12])("preserves every genuine positive contribution of %s without reallocating omitted mass", posterior => {
  const { lattice, compile } = fixture();
  const positive = { ...lattice.segmentationForest.paths[0]!, posterior };
  const expected = compile([positive]);
  const actual = compile([positive, ...lattice.segmentationForest.paths.map(path => ({ ...path, posterior: 0 }))]);
  expect(actual).toEqual(expected);
  expect(actual.observations).toBeGreaterThan(0);
  const rows = indexes.flatMap(index => Object.values(actual[index]).flat());
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.count >= posterior && row.probability > 0)).toBe(true);
  expect(rows.flatMap(row => row.evidenceIds)).toContain("evidence.posterior");
  expect(rows.flatMap(row => row.evidenceCoordinates).length).toBeGreaterThan(0);
});
