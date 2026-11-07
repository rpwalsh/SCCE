// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createClock, createHasher, canonicalStringify } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createEvidenceExtractor } from "../evidence.js";
import { prepareConstructionInduction, preparedLanguageInductionModel, sourceLanguageInductionDocuments } from "../graph-surface-alignment.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "../language-induction-memory.js";
import { preparePooledLanguageProfileBinding } from "../pooled-language-profile-binding.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { learnedEntitySurfacesFromLanguageMemory, observedEntitySurfacesFromInducedLanguageModel } from "../kernel-answer-primitives.js";
import { proseRelations } from "../prose-relation-channel.js";

describe("owned parent evidence binds one pooled language profile", () => {
  it("reuses the prepared real-page model, persists learned entities, and rejects foreign or fake bindings", () => {
    const hasher = createHasher();
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
    const language = createLanguageAcquisitionEngine({ idFactory: ids });
    const extractor = createEvidenceExtractor({ idFactory: ids, hasher });
    const pages = ["ada visited london. ada visited paris. eve visited london. eve visited paris.",
      "ada visited berlin. ada visited madrid. eve visited berlin. eve visited madrid."];
    const evidence = pages.flatMap((text, index) => {
      const sourceId = ids.sourceId("fixture", `fixture://page/${index}`);
      const sourceVersionId = ids.sourceVersionId(canonicalStringify({ sourceId, contentHash: ids.contentHash(text), role: "original" }));
      return extractor.extract({ sourceId, sourceVersionId, namespace: "fixture", uri: `fixture://page/${index}`, mediaType: "text/plain", text,
        languageProfile: language.acquire({ sourceVersionId, text, createdAt: 1 }), sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1,
          freshness: 1, independenceGroup: `page-${index}`, accessScope: "fixture", licenseStatus: "fixture" }, observedAt: 1, metadata: {}, exactSourceText: true }).spans
        .map(span => ({ ...span, status: "promoted" as const, provenance: { ...span.provenance as object, sourceFamilyId: `page-${index}` } }));
    });
    const text = pages.join("\n\n");
    const sourceVersionId = ids.sourceVersionId(`fixture://shard\u001f${text}`);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 1 });
    const ranges = pages.map((page, index) => ({ start: index ? pages[0]!.length + 2 : 0, end: (index ? pages[0]!.length + 2 : 0) + page.length,
      sourceVersionId: evidence[index]!.sourceVersionId, sourceFamilyId: `page-${index}` }));
    const input = { profile, text, sourceVersionId, parentSourceVersionIds: evidence.map(span => String(span.sourceVersionId)), evidence, sourceFamilyRanges: ranges, hasher };
    const binding = preparePooledLanguageProfileBinding(input);
    const documents = sourceLanguageInductionDocuments(evidence);
    const prepared = prepareConstructionInduction({ documents, hasher });
    const model = preparedLanguageInductionModel({ documents, hasher, prepared })!;
    expect(observedEntitySurfacesFromInducedLanguageModel(model, evidence.map(span => String(span.id)))).toContain("ada");
    const relationOptions = { entityConstructions: model.graphBoundConstructions };
    expect(proseRelations("ada visited london.", relationOptions).map(row => [row.subject.surface, row.predicateSurface, row.object.surface])).toContainEqual(["ada", "visited", "london"]);
    expect(proseRelations("Ada visited London.", relationOptions).map(row => [row.subject.surface, row.predicateSurface, row.object.surface])).toContainEqual(["Ada", "visited", "London"]);
    expect(proseRelations("london visited ada. ada invented london. ada visited toronto.", relationOptions)).toEqual([]);
    expect(languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory: ids, updatedAt: 1 }).patterns).toEqual([]);
    const runtime = createLanguageMemoryRuntime({ hasher, idFactory: ids });
    const compiled = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: "fixture://shard", sourceSystem: "wikipedia", sourceVersionId, profile, text,
      evidence, createdAt: 1, preparedInduction: prepared, profileBinding: binding, retainNgramObservations: false } });
    expect(compiled.preparedInduction).toBe(prepared);
    expect(preparedLanguageInductionModel({ documents, hasher, prepared: compiled.preparedInduction })).toBe(model);
    const state = scopeLanguageMemoryStateToLanguage(runtime.hydrate({ models: compiled.models, patterns: compiled.patterns, units: compiled.units, constructionEvidence: evidence }),
      "language.fixture", { profile: () => "language.fixture", corpus: () => "language.fixture" });
    expect(learnedEntitySurfacesFromLanguageMemory(state)).toContain("ada");
    const semantic = compiled.patterns.find(row => (row.patternJson as { schema?: string }).schema === "scce.induced_language_model.semantic_memory.v1")!;
    expect([...(semantic.patternJson as { parentSourceVersionIds: string[] }).parentSourceVersionIds].sort()).toEqual([...input.parentSourceVersionIds].sort());
    expect(semantic.evidenceIds).toEqual(expect.arrayContaining(evidence.map(span => span.id)));
    expect(learnedEntitySurfacesFromLanguageMemory({ ...state, scope: { ...state.scope, sourceVersionIds: ["foreign.source"] } })).toEqual([]);
    expect(languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [{ ...profile, id: "profile.foreign" }], idFactory: ids, updatedAt: 1, profileBinding: binding }).patterns).toEqual([]);
    expect(() => languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory: ids, updatedAt: 1, profileBinding: { ...binding } })).toThrow("unrecognized pooled");
    expect(() => preparePooledLanguageProfileBinding({ ...input, sourceFamilyRanges: ranges.map(row => ({ ...row, sourceFamilyId: "foreign" })) })).toThrow("not source-owned");
    expect(() => preparePooledLanguageProfileBinding({ ...input, text: text.replace("ada", "eve") })).toThrow("not source-owned");
  });
});
