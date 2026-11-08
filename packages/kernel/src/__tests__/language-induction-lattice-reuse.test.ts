// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageInductionEngine, type LanguageInductionDocument } from "../language-induction.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import type { EvidenceId, SourceVersionId } from "../types.js";
import * as surfaceLattice from "../surface-lattice.js";

describe("induction bootstrap lexical reuse", () => {
  it("does not repeat source coordinate and candidate traversals for estimator-fitted lattices", () => {
    const documents: LanguageInductionDocument[] = [
      { id: "preparation.mixed.a", text: "\u00c9lan visits \u6771\u4eac. \u00c9lan visits Paris. \u041a\u043e\u0442 \u0438\u0434\u0451\u0442. e\u0301 \ud83d\udc69\u200d\ud83d\udcbb.", sourceVersionId: "source.preparation.a" as SourceVersionId, evidenceIds: ["evidence.a" as EvidenceId] },
      { id: "preparation.mixed.b", text: "\u0642\u0637 \u064a\u0645\u0634\u064a. \u732b\u304c\u98db\u3076\u3002 \u0915\u093f\u0924\u093e\u092c \u0e41\u0e21\u0e27. 7 + 3 = 10.", sourceVersionId: "source.preparation.b" as SourceVersionId, evidenceIds: ["evidence.b" as EvidenceId] }
    ];
    const sourceTexts = new Set(documents.map(document => document.text));
    const traversals = new Map<string, number>();
    const segment = Intl.Segmenter.prototype.segment;
    const scan = vi.spyOn(Intl.Segmenter.prototype, "segment").mockImplementation(function (this: Intl.Segmenter, text: string) {
      if (this.resolvedOptions().granularity === "grapheme" && sourceTexts.has(text)) traversals.set(text, (traversals.get(text) ?? 0) + 1);
      return segment.call(this, text);
    });
    try {
      const hasher = createHasher();
      const model = createLanguageInductionEngine({ hasher }).induce({ documents });
      expect(hasher.digestHex(canonicalStringify(model))).toBe("d353644e8af7b1805fa13d31b8f970de12dc8acfa98bd8f96edda8e32d2070c7");
      for (const text of sourceTexts) expect(traversals.get(text)).toBeLessThanOrEqual(3);
    } finally { scan.mockRestore(); }
  });
  it.each([false, true])("clears scoped preparation after fitted compilation, including failure=%s", failure => {
    const create = surfaceLattice.createSurfaceLatticePreparationContext;
    const build = surfaceLattice.buildSurfaceLattice;
    let context: surfaceLattice.SurfaceLatticePreparationContext | undefined;
    const creating = vi.spyOn(surfaceLattice, "createSurfaceLatticePreparationContext").mockImplementation(input => context = create(input));
    const building = vi.spyOn(surfaceLattice, "buildSurfaceLattice").mockImplementation(input => {
      if (failure && input.boundaryEstimator) throw Error("fitted lattice interruption");
      return build(input);
    });
    try {
      const run = () => createLanguageInductionEngine().induce({ documents: [{ id: "release.source", text: "a cat runs. a dog runs. a cat sleeps." }] });
      if (failure) expect(run).toThrow("fitted lattice interruption"); else run();
      expect(context!.stats()).toMatchObject({ preparations: 1, retainedDocuments: 0, retainedSourceBytes: 0, hits: failure ? 0 : 1 });
    } finally { creating.mockRestore(); building.mockRestore(); }
  });
  it("partitions boundary observations without rescanning the complete list for each document", () => {
    const collect = surfaceLattice.collectBoundaryTrainingObservations;
    const scans: Array<{ mockRestore(): void }> = [];
    const collecting = vi.spyOn(surfaceLattice, "collectBoundaryTrainingObservations").mockImplementation(input => {
      const observations = collect(input);
      scans.push(vi.spyOn(observations, "filter"));
      return observations;
    });
    try {
      const model = createLanguageInductionEngine().induce({ documents: [
        { id: "partition.a", text: "猫が飛ぶ。犬が走る。猫が眠る。" },
        { id: "partition.b", text: "Élan visite 東京. Élan visite Paris." }
      ] });
      expect(model.boundaryStatistics.sourceDocumentIds).toEqual(["partition.a", "partition.b"]);
      expect(scans).toHaveLength(1);
      for (const scan of scans) expect(scan).not.toHaveBeenCalled();
    } finally { collecting.mockRestore(); for (const scan of scans) scan.mockRestore(); }
  });
  it("preserves the complete learned artifact and deterministic replay while building each lattice only once", () => {
    const documents = [
      { id: "fixture.alpha", text: "the cat sat. the dog sat. the cat ran. the dog ran. the cat sat. the dog ran." },
      { id: "fixture.beta", text: "a fox slept. a wolf slept. a fox walked. a wolf walked. a fox slept. a wolf walked." }
    ];
    const hasher = createHasher();
    const build = vi.spyOn(surfaceLattice, "buildSurfaceLattice");
    try {
      const engine = createLanguageInductionEngine({ hasher });
      const first = engine.induce({ documents });
      expect(build).toHaveBeenCalledTimes(2 * documents.length);
      // Fingerprint of the complete artifact produced before bootstrap lexical reuse.
      expect(hasher.digestHex(canonicalStringify(first))).toBe("fb5a5f0e12ea871a1e67b622eb2cafda632533f94538052327071b5c624440d0");
      const replay = engine.induce({ documents });
      expect(replay).toEqual(first);
      expect(build).toHaveBeenCalledTimes(4 * documents.length);
    } finally {
      build.mockRestore();
    }
  });
});
