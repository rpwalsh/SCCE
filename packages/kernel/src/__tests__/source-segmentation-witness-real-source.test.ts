// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher } from "../primitives.js";
import { compileSourceInductionWindows } from "../source-window-induction.js";
import { createSegmentationAdjacencyQuery } from "../segmentation-adjacency-factors.js";
import {
  sourceSegmentationArcObservation,
  sourceSegmentationSurfaceBearingArcIndices,
  validateLanguageSegmentationWitness
} from "../source-segmentation-witness.js";
import type { EvidenceId } from "../types.js";

describe("real source segmentation witness", () => {
  it("preserves the complete pinned human Dolly window, full DAG, derived coordinates, and provenance", () => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-window-160-193.json", import.meta.url), "utf8")) as { text: string };
    const hasher = createHasher(), evidenceId = "evidence.real-dolly.160-193" as EvidenceId;
    expect(Buffer.byteLength(source.text)).toBe(9_224);
    const input = { documents: [{ id: "real-dolly-owned-window.160-193", text: source.text, evidenceIds: [evidenceId] }], hasher };
    const products = compileSourceInductionWindows(input);
    const replay = compileSourceInductionWindows(input);
    expect(replay).toEqual(products);
    expect(products.coverage).toMatchObject({ complete: true, inputUtf16Length: 9_214, coveredUtf16Length: 9_214 });

    const witnessed = products.models.flatMap(model => {
      validateLanguageSegmentationWitness(model.segmentationWitness);
      const cold = JSON.parse(JSON.stringify(model.segmentationWitness));
      validateLanguageSegmentationWitness(cold);
      expect(cold).toEqual(model.segmentationWitness);
      expect(canonicalStringify(model.segmentationWitness)).not.toContain("joinProgram");
      return model.segmentationWitness.populations.flatMap(population => population.documents);
    });
    const decodedWitnessBytes = witnessed.reduce((total, document) =>
      total + Buffer.byteLength(JSON.stringify(document)), 0);
    expect(decodedWitnessBytes).toBeLessThan(550_000);
    expect(decodedWitnessBytes / Buffer.byteLength(source.text)).toBeLessThan(60);
    const byId = new Map(witnessed.map(document => [document.documentId, document]));
    let adjacencyCount = 0, fractionalAdjacencyCount = 0, retainedPathCount = 0;
    for (const window of products.coverage.windows) {
      const document = byId.get(window.documentId)!;
      expect(document).toBeDefined();
      expect(document.ownerDocumentId).toBe(window.ownerDocumentId);
      expect(document.sourceUtf16Start).toBe(window.startUtf16);
      expect(document.sourceUtf16End).toBe(window.endUtf16);
      expect(document.text).toBe(source.text.slice(window.startUtf16, window.endUtf16));
      expect(hasher.digestHex(document.text)).toBe(window.contentDigest);
      expect(document.evidenceIds).toEqual([evidenceId]);
      expect(Object.keys(document.fullDag.factors).sort()).toEqual(["arcs", "nodeCount", "schema"]);
      expect(document.fullDag).not.toHaveProperty("scoreRecipe");

      retainedPathCount += document.lattice.segmentationForest.retainedPathCount;
      expect(document.lattice.segmentationForest.retainedPathDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(document.lattice.segmentationForest.boundaryMarginalCount).toBe(document.fullDag.factors.nodeCount);
      expect(document.lattice.segmentationForest.boundaryMarginalDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(document.lattice).not.toHaveProperty("graphemeUtf16Offsets");
      expect(document.lattice).not.toHaveProperty("surfaceBearingArcIndices");
      expect(document.lattice.segmentationForest).not.toHaveProperty("paths");
      expect(document.lattice.segmentationForest).not.toHaveProperty("boundaryMarginals");

      const bearing = new Set(sourceSegmentationSurfaceBearingArcIndices(document));
      for (const pair of createSegmentationAdjacencyQuery(document.fullDag.factors, bearing).pairs()) {
        adjacencyCount++;
        if (pair.posterior < 1) fractionalAdjacencyCount++;
        const left = sourceSegmentationArcObservation(document, pair.leftArcIndex);
        const right = sourceSegmentationArcObservation(document, pair.rightArcIndex);
        expect(left.utf16End).toBeLessThanOrEqual(right.utf16Start);
        expect(document.text.slice(left.utf16Start, left.utf16End)).toBe(left.surface);
        expect(document.text.slice(right.utf16Start, right.utf16End)).toBe(right.surface);
        expect([...new Set([...left.evidenceIds, ...right.evidenceIds])]).toContain(evidenceId);
        // The literal between children remains owned by the source witness;
        // no independent boundary predictor is needed to recover it.
        expect(document.text.slice(left.utf16End, right.utf16Start)).toBe(
          source.text.slice(window.startUtf16 + left.utf16End, window.startUtf16 + right.utf16Start));
      }
    }
    expect(products.coverage.windows.map(window => byId.get(window.documentId)!.text).join("")).toBe(source.text);
    expect(adjacencyCount).toBeGreaterThan(0);
    expect(fractionalAdjacencyCount).toBeGreaterThan(0);
    expect(retainedPathCount).toBeGreaterThan(0);
  });
});
