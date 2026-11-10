// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as induction from "../language-induction.js";
import { prepareConstructionInduction, preparedLanguageInductionProducts, sourceLanguageInductionDocuments } from "../graph-surface-alignment.js";
import { sourceInductionBatches } from "../source-window-induction.js";
import { boundedInductionDocuments } from "../training-orchestrator.js";
import { compileUniversalCreativeEventConstructionPattern } from "../language-construction-memory.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createEvidenceExtractor } from "../evidence.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("complete bounded source induction", () => {
  const hasher = createHasher();

  it("covers every Unicode source range deterministically within the same memory bounds", () => {
    vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "48");
    vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "16");
    const documents = [{ id: "source.a", text: "猫が跳ぶ。\nÉlan visite 東京. 👩🏽‍🔬 explores. конец.".repeat(4) },
      { id: "source.b", text: "fıstık e\u0301tudie. 𐐀𐐨. tail." }];
    const first = [...sourceInductionBatches(documents, hasher)];
    expect(first).toEqual([...sourceInductionBatches(documents, hasher)]);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every(batch => batch.documents.reduce((total, document) => total + document.text.length, 0) <= 48)).toBe(true);
    for (const document of documents) {
      const entries = first.flatMap(batch => batch.documents).filter(window => window.sourceWindow?.ownerDocumentId === document.id);
      expect(entries.map(window => window.text).join("")).toBe(document.text);
      expect(entries.every(window => window.text.length <= 16 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(window.text))).toBe(true);
      expect(entries.map(window => window.sourceWindow!.startUtf16)).toEqual(entries.map((_, index) => entries.slice(0, index).reduce((sum, window) => sum + window.text.length, 0)));
    }
    const changed = [...sourceInductionBatches([{ ...documents[0]!, text: documents[0]!.text.replace("конец", "итог") }, documents[1]!], hasher)];
    expect(first.flatMap(batch => batch.windows).filter(window => window.ownerDocumentId === "source.b"))
      .toEqual(changed.flatMap(batch => batch.windows).filter(window => window.ownerDocumentId === "source.b"));
  });

  it("acquires the actual Alice source tail beyond the old prefix and shares each model with every compiler", () => {
    vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "2048");
    vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "512");
    const text = readFileSync(new URL("./fixtures/alice-acquisition-excerpt.txt", import.meta.url), "utf8");
    expect(text.indexOf("Rabbit’s little white kid gloves")).toBeGreaterThan(16_000);
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 20 }), namespace: "source-window-acquisition", deterministicReplay: true });
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 20 });
    const evidence = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
      sourceId: ids.sourceId("gutenberg", "fixture://alice-acquisition-excerpt"), sourceVersionId, namespace: "gutenberg",
      uri: "fixture://alice-acquisition-excerpt", mediaType: "text/plain", text, languageProfile: profile,
      sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
        independenceGroup: "alice", accessScope: "local", licenseStatus: "public_domain" },
      observedAt: 20, maxChunkBytes: 64_000, exactSourceText: true
    }).spans.map(span => ({ ...span, status: "promoted" as const }));
    const documents = sourceLanguageInductionDocuments(evidence);
    expect(boundedInductionDocuments(documents).every(document => !document.text.includes("Rabbit’s little white kid gloves"))).toBe(true);
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    const prepared = prepareConstructionInduction({ documents, hasher });
    const products = preparedLanguageInductionProducts({ documents, hasher, prepared });
    expect(products.coverage).toMatchObject({ complete: true, inputUtf16Length: text.length, coveredUtf16Length: text.length });
    expect(products.coverage.windows.some(window => window.startUtf16 > 16_000)).toBe(true);
    expect(products.fullModel).toBeUndefined();
    expect(products.models.every(model => !("kneserNey" in model) && !("ngrams" in model))).toBe(true);
    expect(products.models.every(model => !("joinProgram" in model))).toBe(true);
    const retained = products.models.flatMap(model => model.segmentationDocuments);
    expect(retained.reduce((total, document) => total + document.sourceWindow.endUtf16 - document.sourceWindow.startUtf16, 0)).toBe(text.length);
    expect(retained.every(document => document.graph.arcs.length > 0 && !("text" in document))).toBe(true);
    expect(products.models.some(model => model.semanticFrames.some(frame => frame.examples.some(example => example.includes("gloves"))))).toBe(true);
    const firstFrame = products.models.flatMap(model => model.semanticFrames)[0]!;
    expect(() => { firstFrame.predicate = "forged"; }).toThrow();
    const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const batch = { streamId: "fixture://alice-acquisition-excerpt", sourceSystem: "gutenberg", sourceVersionId, profile, text, evidence,
      canonicalSource: { sourceId: evidence[0]!.sourceId, contentHash: ids.contentHash(text) },
      createdAt: 20, preparedInduction: prepared, retainNgramObservations: false, maxCountersPerOrder: 64, vocabularyLimit: 512 };
    const compiled = compileLanguageTrainingBatch({ runtime, hasher, batch });
    const originalModels = structuredClone(compiled.models);
    expect(compiled.patterns.some(pattern => (pattern.patternJson as { schema?: string }).schema === "scce.source_induction_coverage.v1")).toBe(true);
    const semanticRows = compiled.patterns.filter(pattern => (pattern.patternJson as { schema?: string }).schema === "scce.induced_language_model.semantic_memory.v1");
    expect(semanticRows.some(pattern => JSON.stringify(pattern.patternJson).includes("Rabbit’s little white kid gloves"))).toBe(true);
    const hydrated = runtime.hydrate({ models: compiled.models, patterns: compiled.patterns, units: compiled.units,
      semanticFrames: compiled.semanticFrames, constructionEvidence: evidence });
    expect(hydrated.importedPatterns.some(pattern => JSON.stringify(pattern).includes("Rabbit’s little white kid gloves"))).toBe(true);
    compileUniversalCreativeEventConstructionPattern({ profileId: profile.id, evidence, hasher, updatedAt: 20, preparedInduction: prepared });
    expect(engine).toHaveBeenCalledTimes(products.models.length);
    const repair = compileLanguageTrainingBatch({ runtime, hasher, batch: { ...batch, artifactScope: "construction_only" } });
    expect(repair.models).toEqual([]);
    expect(repair.units).toEqual([]);
    expect(repair.semanticFrames).toEqual([]);
    expect(compiled.models).toEqual(originalModels);
    expect(repair.patterns.map(pattern => pattern.id)).toEqual(expect.arrayContaining(semanticRows.map(pattern => pattern.id)));
    expect(engine).toHaveBeenCalledTimes(products.models.length);
    expect(() => preparedLanguageInductionProducts({ documents: documents.map(document => ({ ...document, text: document.text + " changed" })), hasher, prepared })).toThrow("inputs changed");
    expect(() => preparedLanguageInductionProducts({ documents, hasher, prepared: { ...prepared } })).toThrow("inputs changed");
  });

  it("does not invoke the language engine or claim learned models for empty source material", () => {
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    const documents = [{ id: "empty", text: " \n\t " }];
    const prepared = prepareConstructionInduction({ documents, hasher });
    const products = preparedLanguageInductionProducts({ documents, hasher, prepared });
    expect(products.models).toEqual([]);
    expect(products.coverage.coveredUtf16Length).toBe(4);
    expect(engine).not.toHaveBeenCalled();
  });
});
