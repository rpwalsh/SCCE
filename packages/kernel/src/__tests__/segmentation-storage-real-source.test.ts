// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher } from "../primitives.js";
import { compileSourceInductionWindows } from "../source-window-induction.js";
import { encodeSegmentationAdjacencyFactors, decodeSegmentationAdjacencyFactors } from "../segmentation-adjacency-storage.js";
import type { EvidenceId } from "../types.js";

describe("real source complete graph storage", () => {
  it("preserves every pinned human Dolly window and its complete source-owned geometry", () => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-window-160-193.json", import.meta.url), "utf8")) as { text: string };
    const hasher = createHasher();
    expect(Buffer.byteLength(source.text)).toBe(9_224);
    const products = compileSourceInductionWindows({ documents: [{ id: "real-dolly-owned-window.160-193", text: source.text,
      evidenceIds: ["evidence.real-dolly.160-193" as EvidenceId] }], hasher });
    expect(products.coverage).toMatchObject({ complete: true, inputUtf16Length: 9_214, coveredUtf16Length: 9_214 });
    let retainedSourceUtf16 = 0;
    for (const model of products.models) {
      expect(model).not.toHaveProperty("joinProgram");
      for (const document of model.segmentationDocuments) {
        retainedSourceUtf16 += document.sourceWindow.endUtf16 - document.sourceWindow.startUtf16;
        expect(document).not.toHaveProperty("text");
        expect(document.evidenceIds).toEqual(["evidence.real-dolly.160-193"]);
        expect(document.graph.arcs.length).toBeGreaterThan(0);
        expect(decodeSegmentationAdjacencyFactors(encodeSegmentationAdjacencyFactors(document.graph, 1024 * 1024),
          { maxBytes: 1024 * 1024, maxNodes: 100000, maxArcs: 100000 })).toEqual(document.graph);
      }
    }
    expect(retainedSourceUtf16).toBe(source.text.length);
  });
});
