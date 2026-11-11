// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { buildSurfaceLattice, exportSegmentationAdjacencyFactors, type SegmentationScoreFactors } from "@scce/kernel";
import { encodeSegmentationScoreGraph, decodeSegmentationScoreGraph, SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA } from "../segmentation-score-storage.js";
import { encodeDurableArtifact, decodeDurableArtifact } from "../durable-artifact-storage.js";
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture() {
  const text = "雪が降る。 ёж идёт. ગુજરાતી લખાણ. 🧭 e\u0301. ".repeat(8), documentId = "source.multilingual";
  const lattice = buildSurfaceLattice({ documentId, text, captureScoreFactors: true, evidenceIds: ["evidence.owned"] });
  const measured = exportSegmentationAdjacencyFactors(lattice.segmentationForest);
  expect(measured.scoreRecipe).toBeDefined();
  return { text, documentId, lattice, graph: measured.factors, recipe: measured.scoreRecipe! };
}
it("restores original topology, arc order and every measured Float64 without fitting", () => {
  const f = fixture(), stored = encodeSegmentationScoreGraph(f.graph, f.recipe), restored = decodeSegmentationScoreGraph(cold(stored));
  expect(restored.recipe).toEqual(f.recipe); expect(restored.graph).toEqual(f.graph);
  restored.graph.arcs.forEach((arc, i) => expect(Object.is(arc[2], f.graph.arcs[i]![2])).toBe(true));
});
it("composes with a source full-DAG witness while retaining exact public metadata", () => {
  const f = fixture();
  const original = { fullDag: { factors: f.graph, scoreRecipe: f.recipe }, retained: "\u0000雪" };
  const stored = encodeDurableArtifact(original);
  expect(JSON.stringify(stored)).toContain(SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA);
  expect(decodeDurableArtifact(cold(stored))).toEqual(original);
  expect(encodeDurableArtifact(stored)).toBe(stored);
});
it.each(["topology", "recipe", "graph_digest", "unknown", "oversized"])("rejects %s corruption before exposing a reconstructed graph", mutation => {
  const f = fixture(), stored = cold(encodeSegmentationScoreGraph(f.graph, f.recipe)) as Record<string, unknown>;
  if (mutation === "topology") stored.topology = "AAAA";
  if (mutation === "recipe") stored.recipe = "{}";
  if (mutation === "graph_digest") { const recipe = JSON.parse(String(stored.recipe)) as SegmentationScoreFactors; recipe.expectedGraphDigest = "foreign"; stored.recipe = JSON.stringify(recipe); }
  if (mutation === "unknown") stored.extra = true;
  if (mutation === "oversized") stored.recipe = " ".repeat(64 * 1024 * 1024 + 1);
  expect(() => decodeSegmentationScoreGraph(stored)).toThrow();
});
