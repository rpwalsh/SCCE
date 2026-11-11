// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { CORPUS_ROLE_IDS } from "../corpus-registry.js";
import { persistedKneserNey, trainKneserNey } from "../kneser-ney.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createClock, createHasher, symbolizeData, toJsonValue } from "../primitives.js";
import { PREDICTION_SCORING_MAX_DECODED_BYTES } from "../request-language-hydration.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, ScceKernelDeps, SemanticFrameRecord } from "../storage.js";
import type { EvidenceId, LanguageProfile, SourceVersionId } from "../types.js";

const hasher = createHasher();
const clock = createClock({ fixedTime: 1 });
const sourceVersionId = "version.prediction-view" as SourceVersionId;
const profile: LanguageProfile = {
  id: "profile.prediction-view", sourceVersionId,
  scripts: [{ script: "script.Latn", mass: 1 }], symbolShapes: [], charNgrams: [],
  direction: "ltr", entropy: 0, createdAt: 1
};
const cluster = {
  id: "cluster.prediction-view", members: [profile], profileIds: [profile.id], sourceVersionIds: [sourceVersionId],
  discoveredNames: [], scripts: profile.scripts, symbolShapes: [], charNgrams: [], direction: "ltr" as const, artifactSupport: 1
};

function compileModels(): NgramModelRecord[] {
  const text = Array.from({ length: 20 }, (_, index) => `lumen arc turns toward harbor ${index % 3}.`).join(" ");
  return [4, 5, 6, 6].map((maxOrder, index) => {
    const streamId = `stream.prediction-view.${maxOrder}.${index}`;
    const model = trainKneserNey(symbolizeData(`${text} branch ${index}.`), { order: maxOrder, vocabularyLimit: 4000 });
    return {
      id: `model.prediction-view.${maxOrder}.${index}`, streamId, languageHint: "fixture",
      maxOrder, discount: model.discount,
      modelJson: toJsonValue({ profileId: profile.id, sourceVersionId, sourceSystem: "wikipedia", model: persistedKneserNey(model) }),
      updatedAt: index + 1
    };
  });
}

const unit: LanguageUnitRecord = {
  id: "unit.lumen-arc", profileId: profile.id, sourceVersionId, script: "script.Latn", unitKind: "phrase",
  text: "lumen arc", features: ["large-unused-feature"], competenceVector: [0.1, 0.2], alpha: 0.9,
  evidenceIds: [], metadata: { connectors: ["therefore"], sourceBody: "not part of prediction input" }
};
const ordinaryPattern: LanguagePatternRecord = {
  id: "pattern.lumen-arc", profileId: profile.id, patternKind: "discourse", support: 0.8, entropy: 0,
  patternJson: {
    schema: "scce.long_form_discourse_pattern.v1", profileId: profile.id, sourceVersionId,
    counts: { "lumen arc": 4 }, sentenceCount: 3, paragraphCount: 1,
    sentenceSymbolLengths: [5, 6, 7], paragraphSymbolLengths: [18], dialogueTurnMarkers: {},
    sourceBody: "not part of prediction input"
  }, evidenceIds: [], updatedAt: 1
};
const heavyPattern: LanguagePatternRecord = {
  id: "surface.construction.bundle.heavy", profileId: profile.id, patternKind: "semantic_role", support: 1, entropy: 0,
  patternJson: { schema: "scce.language_construction_pattern.v1", surface: "lumen arc", bundle: {
    sourceExamples: [{ surface: "secret construction body", roles: [], nullRoles: [] }],
    constructions: [{ program: "x".repeat(4096) }]
  } }, evidenceIds: ["evidence.heavy" as EvidenceId], updatedAt: 1
};
const frame: SemanticFrameRecord = {
  id: "frame.lumen-arc", frameJson: {
    schema: "scce.semantic_frame.v1", profileId: profile.id, sourceVersionId,
    surface: "lumen arc", semanticRoleId: "role.topic", requirementCoefficients: { noveltyDemand: 2 },
    content: { sourceBody: "not part of prediction input" }
  }, embedding: [1, 2, 3], evidenceIds: [], alpha: 0.7, createdAt: 1
};

function behaviorScore(score: ReturnType<ReturnType<typeof createLanguageMemoryRuntime>["score"]>) {
  return { activation: score.activation, information: score.information, fit: score.fit, orderScores: score.orderScores };
}

it("hydrates a bounded prediction/scoring view with causal 4/5/6-gram behavior and explicit non-global coverage", async () => {
  const models = compileModels();
  const calls = { evidence: 0, continuations: 0, models: [] as unknown[], units: [] as unknown[], patterns: [] as unknown[], frames: [] as unknown[] };
  const storage = {
    brainImports: { active: async () => ({ activeImportRunIds: [] }) },
    model: { listLanguageProfiles: async () => [profile] },
    evidence: { getEvidenceBatch: async () => { calls.evidence++; return []; } },
    languageMemory: {
      continuationPopulation: async () => {
        calls.continuations++;
        return { languageId: "language.prediction-view", modelCount: 1, continuationCounts: { oversized: 1 } };
      },
      listNgramModels: async (query: unknown) => { calls.models.push(query); return models; },
      listLanguageUnits: async (query: unknown) => { calls.units.push(query); return [unit]; },
      listLanguagePatterns: async (query: unknown) => { calls.patterns.push(query); return [ordinaryPattern, heavyPattern]; },
      listSemanticFrames: async (query: unknown) => { calls.frames.push(query); return [frame]; }
    }
  } as unknown as ScceKernelDeps["storage"];
  const languageMemory = createLanguageMemoryRuntime({ hasher });
  const surface = createSurfaceLanguageRuntime({
    deps: { storage, corpusRegistry: [] }, languageMemoryRuntime: languageMemory, clock, hasher,
    cacheMs: 100_000, profileLimit: 32,
    languageResolver: () => ({ profile: () => "language.prediction-view", corpus: () => "language.prediction-view" })
  });
  // Warm the ordinary role-scoped cache first. The operation-specific call below must not reuse this broader
  // state merely because its profile/surface matches; it needs the projected rows and its own truthful receipt.
  await surface.surfaceLanguageProfilesCached();
  const fullWarm = await surface.hydrateSurfaceLanguageMemoryCached(
    12, cluster, "full-warm", CORPUS_ROLE_IDS.encyclopedic, "lumen arc"
  );
  expect(fullWarm.operationView).toBeUndefined();
  const evidenceCallsAfterFullWarm = calls.evidence;
  vi.useFakeTimers();
  try {
    await expect(surface.hydrateSurfaceLanguageMemoryCached(
      12, cluster, "prediction-scoring-deferred", CORPUS_ROLE_IDS.encyclopedic, "lumen arc",
      { purpose: "prediction_scoring", deferDurable: true }
    )).rejects.toThrow(/resident language-memory:prediction-scoring-deferred was not warmed/u);
    // The broader role hydration above is not returned as an operation-specific result.
    expect(calls.models).toHaveLength(1);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  const projected = await surface.hydrateSurfaceLanguageMemoryCached(
    12, cluster, "prediction-scoring", CORPUS_ROLE_IDS.encyclopedic, "lumen arc", { purpose: "prediction_scoring" }
  );

  expect(calls.models).toHaveLength(2);
  expect(calls.models.at(-1)).toMatchObject({ view: "prediction_scoring", maxTotalJsonBytes: expect.any(Number) });
  expect(calls.units.at(-1)).toMatchObject({ view: "prediction_scoring", maxTotalJsonBytes: expect.any(Number) });
  expect(calls.patterns.at(-1)).toMatchObject({ view: "prediction_scoring", maxTotalJsonBytes: expect.any(Number) });
  expect(calls.frames.at(-1)).toMatchObject({ view: "prediction_scoring", maxTotalJsonBytes: expect.any(Number) });
  expect(calls.evidence).toBe(evidenceCallsAfterFullWarm);
  expect(projected.constructionEvidence).toEqual([]);
  expect(projected.state.importedConstructionBundles).toEqual([]);
  expect(projected.state.importedPatterns.map(row => row.id)).toEqual([ordinaryPattern.id]);
  expect(JSON.stringify(projected.units)).not.toContain("large-unused-feature");
  expect(JSON.stringify(projected.units)).not.toContain("not part of prediction input");
  expect(JSON.stringify(projected.patterns)).not.toContain("secret construction body");
  expect(JSON.stringify(projected.patterns)).not.toContain("\"bundle\"");
  expect(JSON.stringify(projected.semanticFrames)).not.toContain("not part of prediction input");

  expect(projected.operationView).toMatchObject({
    schema: "scce.language_operation_view_receipt.v1", operation: "prediction_scoring",
    coverage: { scope: "authorized_bounded_operation_input", completeness: "bounded",
      excludedCapabilities: ["source_realization", "structured_creative_generation", "proof_contradiction", "global_learning"] },
    hydratedRows: { ngramModels: 4, languageUnits: 1, languagePatterns: 1, semanticFrames: 1, constructionEvidence: 0 },
    qualifiedCapabilities: { ngramOrders: [4, 5, 6], maxNgramOrder: 6, recognizedSemanticFrameCount: 1 }
  });
  expect(projected.operationView!.decodedBytes).toBeLessThanOrEqual(PREDICTION_SCORING_MAX_DECODED_BYTES);
  expect(projected.operationView!.maxDecodedBytes).toBe(PREDICTION_SCORING_MAX_DECODED_BYTES);
  expect(projected.operationView!.measuredHeapBytes).toBe(projected.measuredHeapBytes);
  // Four hydrated rows are not misreported as four distinct n-gram capabilities.
  expect(projected.operationView!.hydratedRows.ngramModels).toBeGreaterThan(projected.operationView!.qualifiedCapabilities.ngramOrders.length);

  const languageScoped = await surface.hydrateSurfaceLanguageMemoryCached(
    12, cluster, "prediction-scoring-language", CORPUS_ROLE_IDS.encyclopedic, "lumen arc",
    { purpose: "prediction_scoring", languageId: "language.prediction-view" }
  );
  expect(calls.continuations).toBe(0);
  expect(languageScoped.state.continuationPopulation).toBeUndefined();
  expect(languageScoped.operationView?.decodedBytes).toBeLessThanOrEqual(PREDICTION_SCORING_MAX_DECODED_BYTES);

  const full = languageMemory.hydrate({ models, units: [unit], patterns: [ordinaryPattern], semanticFrames: [frame] });
  const fullScore = languageMemory.score({ state: full, text: "lumen arc turns toward harbor", contextText: "lumen arc" });
  const projectedScore = languageMemory.score({ state: projected.state, text: "lumen arc turns toward harbor", contextText: "lumen arc" });
  expect(behaviorScore(projectedScore)).toEqual(behaviorScore(fullScore));
  expect(projectedScore.orderScores.map(row => row.order)).toEqual([6, 6, 5, 4]);
  expect(languageMemory.suggest({ state: projected.state, context: "lumen arc", limit: 8 }))
    .toEqual(languageMemory.suggest({ state: full, context: "lumen arc", limit: 8 }));
  const candidates = [{ text: "lumen arc turns toward harbor", evidenceIds: ["evidence.candidate"] }, { text: "harbor" }];
  const fullRealization = languageMemory.realize({ state: full, requestText: "lumen arc", candidates });
  const projectedRealization = languageMemory.realize({ state: projected.state, requestText: "lumen arc", candidates });
  expect({ text: projectedRealization.text, evidenceIds: projectedRealization.evidenceIds, score: behaviorScore(projectedRealization.score) })
    .toEqual({ text: fullRealization.text, evidenceIds: fullRealization.evidenceIds, score: behaviorScore(fullRealization.score) });
  const generationInput = { contextSymbols: ["lumen", "arc"], requiredTerms: [{ id: "term.lumen", text: "lumen", weight: 1 }], generationExtent: 24 };
  const fullGeneration = languageMemory.generate({ state: full, ...generationInput });
  const projectedGeneration = languageMemory.generate({ state: projected.state, ...generationInput });
  expect({ text: projectedGeneration.text, symbols: projectedGeneration.symbols, phrasesUsed: projectedGeneration.phrasesUsed })
    .toEqual({ text: fullGeneration.text, symbols: fullGeneration.symbols, phrasesUsed: fullGeneration.phrasesUsed });
  // Behavioral equality above is scoped; the receipt remains an explicit bounded-coverage audit, not a global-equivalence assertion.
  expect(projected.operationView!.coverage.completeness).toBe("bounded");

  const withoutUnit = languageMemory.hydrate({ models, units: [], patterns: [ordinaryPattern], semanticFrames: [frame] });
  expect(behaviorScore(languageMemory.score({ state: withoutUnit, text: "lumen arc", contextText: "lumen arc" })))
    .not.toEqual(behaviorScore(languageMemory.score({ state: full, text: "lumen arc", contextText: "lumen arc" })));
  const withoutSixGram = languageMemory.hydrate({ models: models.filter(model => model.maxOrder !== 6), units: [unit], patterns: [ordinaryPattern], semanticFrames: [frame] });
  expect(languageMemory.score({ state: withoutSixGram, text: "lumen arc", contextText: "lumen arc" }).orderScores.map(row => row.order))
    .toEqual([5, 4]);
  expect(languageMemory.suggest({ state: withoutSixGram, context: "lumen arc", limit: 8 }))
    .not.toEqual(languageMemory.suggest({ state: full, context: "lumen arc", limit: 8 }));

  const recognized = deriveTurnRequirementField({ requestText: "lumen arc", languageMemoryState: projected.state });
  const changedFrameState = languageMemory.hydrate({ models, units: [unit], patterns: [ordinaryPattern], semanticFrames: [{
    ...frame, frameJson: { ...(frame.frameJson as Record<string, unknown>), surface: "different surface", requirementCoefficients: { noveltyDemand: 0 } }
  }] });
  const changed = deriveTurnRequirementField({ requestText: "lumen arc", languageMemoryState: changedFrameState });
  expect(recognized.activatedFrameIds).toEqual([frame.id]);
  expect(recognized.noveltyDemand).toBeGreaterThan(changed.noveltyDemand);
});
