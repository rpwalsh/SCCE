// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher } from "../primitives.js";
import { compileSourceInductionWindows } from "../source-window-induction.js";
import { joinProgramMixtureFromStorage, joinProgramMixtureStorageForm } from "../join-program-storage.js";
import { joinProgramChoices } from "../join-program.js";
import { canonicalGraphemeSegmenter } from "../normalization-contract.js";
import { createSegmentationAdjacencyQuery } from "../segmentation-adjacency-factors.js";
import { normalizeSurfaceLatticeSurface } from "../surface-lattice.js";
import { SEGMENTATION_SCORE_FACTORS_SCHEMA, validateSegmentationScoreFactors } from "../segmentation-score-factors.js";
import type { EvidenceId } from "../types.js";

describe("real source join-storage equivalence", () => {
  it("preserves the complete pinned human Dolly window and reuses its frozen packed join program", () => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-window-160-193.json", import.meta.url), "utf8")) as { text: string };
    const hasher = createHasher();
    expect(Buffer.byteLength(source.text)).toBe(9_224);
    const products = compileSourceInductionWindows({ documents: [{ id: "real-dolly-owned-window.160-193", text: source.text,
      evidenceIds: ["evidence.real-dolly.160-193" as EvidenceId] }], hasher });
    expect(products.coverage).toMatchObject({ complete: true, inputUtf16Length: 9_214, coveredUtf16Length: 9_214 });
    // This versioned receipt includes the v4 JOIN representation. Source and probability
    // assertions below remain independent of its sparse global storage layout.
    const originalModel = <T extends { semanticInductionFactors?: unknown }>(model: T) => {
      const { semanticInductionFactors: _sufficientFacts, ...original } = model; return original;
    };
    const originalProducts = { ...products, models: products.models.map(originalModel),
      ...(products.fullModel ? { fullModel: originalModel(products.fullModel) } : {}) };
    const withoutScorerMetadata = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutScorerMetadata);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).filter(([key, child]) => !(key === "scoreRecipe"
        && child && typeof child === "object" && (child as { schema?: string }).schema === SEGMENTATION_SCORE_FACTORS_SCHEMA))
        .map(([key, child]) => [key, withoutScorerMetadata(child)]));
    };
    // Keep the original whole-product oracle. Only the new, independently
    // checked reconstruction metadata is excluded; graph energies remain pinned.
    expect(hasher.digestHex(canonicalStringify(withoutScorerMetadata(originalProducts)))).toBe("d6eb8489098a7047c089dbc289ac9b64d6c67632069b1459f5dcd544df46c722");
    let retainedSourceUtf16 = 0;
    for (const model of products.models) {
      const packed = joinProgramMixtureStorageForm(model.joinProgram);
      expect(packed).toBe(model.joinProgram);
      const cold = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(packed)))!;
      expect(cold).toBeDefined();
      expect(joinProgramMixtureStorageForm(cold)).toEqual(packed);
      for (const { program } of packed.mixture.components) {
        if (program.header.trainingDocumentIds.length) expect(program.header.observations).toBeGreaterThan(0);
        expect(program.header.localFactors).toBeDefined();
        expect(program.header.globalFactors).toBeDefined();
        for (const document of program.header.localFactors!.documents) {
          if (document.scoreRecipe) validateSegmentationScoreFactors(document.scoreRecipe, document.graph, hasher);
          retainedSourceUtf16 += document.text.length;
          const window = products.coverage.windows.find(window => window.documentId === document.documentId)!;
          expect(window).toBeDefined();
          expect(document.text).toBe(source.text.slice(window.startUtf16, window.endUtf16));
          expect(hasher.digestHex(document.text)).toBe(window.contentDigest);
          expect(Object.keys(document.graph).sort()).toEqual(["arcs", "nodeCount", "schema"]);
          expect(document.contexts.every(context => context.length === 1)).toBe(true);
        }
        expect(program.indexes.exactIndex).toEqual([]);
        expect(program.indexes.classIndex).toEqual([]);
        expect(program.indexes.conditionedIndex).toEqual([]);
        expect(program.indexes.structuralIndex).toEqual([]);
        for (const [, refs] of program.indexes.localShapeIndex) {
          expect(refs.every(ref => program.choiceDictionary[ref]![4].length === 0)).toBe(true);
        }
        expect(program.choiceDictionary.every(([, count, probability]) => count > 0 || probability > 0)).toBe(true);
      }
      for (const { program } of cold.components) {
        const factors = program.localFactors!;
        const documents = factors.documents.map(document => {
          const offsets = [0, ...[...canonicalGraphemeSegmenter().segment(document.text)].map(segment => segment.index + segment.segment.length)];
          const bounds = document.units.map((unit, index) => unit === null ? null : unit.length === 5
            ? [unit[3], unit[4]] as const : [offsets[document.graph.arcs[index]![0]]!, offsets[document.graph.arcs[index]![1]]!] as const);
          const labels = bounds.map(bounds => bounds === null ? null : normalizeSurfaceLatticeSurface(document.text.slice(...bounds), factors.normalizationContract));
          const query = createSegmentationAdjacencyQuery(document.graph, new Set(bounds.flatMap((bounds, index) => bounds === null ? [] : [index])));
          return { document, bounds, labels, query };
        });
        const first = documents.flatMap(document => {
          for (const pair of document.query.pairs()) return [{ document, pair }];
          return [];
        })[0];
        if (!first) continue;
        const leftLabel = first.document.labels[first.pair.leftArcIndex]!, rightLabel = first.document.labels[first.pair.rightArcIndex]!;
        const expected = new Map<string, { mass: number; coordinates: Set<string> }>();
        for (const { document, bounds, labels, query } of documents) {
          const left = new Set(labels.flatMap((label, index) => label === leftLabel ? [index] : []));
          const right = new Set(labels.flatMap((label, index) => label === rightLabel ? [index] : []));
          for (const pair of query.pairs({ leftArcIndices: left, rightArcIndices: right })) {
            const start = bounds[pair.leftArcIndex]![1], end = bounds[pair.rightArcIndex]![0], gap = document.text.slice(start, end);
            const row = expected.get(gap) ?? { mass: 0, coordinates: new Set<string>() }; row.mass += pair.posterior;
            for (const index of new Set([...document.units[pair.leftArcIndex]![2], ...document.units[pair.rightArcIndex]![2]])) {
              row.coordinates.add(JSON.stringify({ evidenceId: document.evidenceIds[index]!, ...(document.sourceVersionId ? { sourceVersionId: document.sourceVersionId } : {}),
                documentId: document.documentId, byteStart: Buffer.byteLength(document.text.slice(0, start)), byteEnd: Buffer.byteLength(document.text.slice(0, end)),
                utf16Start: start, utf16End: end, exactSurfaceHash: hasher.digestHex(gap) }));
            }
            expected.set(gap, row);
          }
        }
        const actual = joinProgramChoices(program, "exact", JSON.stringify([leftLabel, rightLabel]));
        expect(actual).toHaveLength(expected.size);
        const total = [...expected.values()].reduce((sum, row) => sum + row.mass, 0);
        for (const choice of actual) {
          const row = expected.get(choice.surface)!;
          expect(choice.count).toBeCloseTo(row.mass, 10);
          expect(choice.probability).toBeCloseTo(row.mass / total, 12);
          expect(new Set(choice.evidenceCoordinates.map(coordinate => JSON.stringify(coordinate)))).toEqual(row.coordinates);
        }
      }
    }
    expect(retainedSourceUtf16).toBe(source.text.length);
  });
});
