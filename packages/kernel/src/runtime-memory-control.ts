// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { buildCalibrationModelSet, loadCalibrationModelSet, type CalibrationModelSet } from "./calibration-spine.js";
import { createClock, toJsonValue } from "./primitives.js";
import {
  positiveRuntimeInt
} from "./runtime-graph-cache.js";
import type { ScceKernelDeps } from "./storage.js";
import type {
  JsonValue
} from "./types.js";

export function createRuntimeMemoryControl(options: {
  deps: Pick<ScceKernelDeps, "storage">;
  clock: ReturnType<typeof createClock>;
}) {
  const { deps, clock } = options;

  const activeBrainMarkerCacheMs = positiveRuntimeInt("SCCE_ACTIVE_BRAIN_MARKER_CACHE_MS", 300_000);

  const calibrationModelCacheMs = positiveRuntimeInt("SCCE_CALIBRATION_MODEL_CACHE_MS", 120_000);

  let generation = 0;
  let activeBrainMarkerCache: { loadedAt: number; generation: number; value: JsonValue } | undefined;
  let activeBrainMarkerInFlight: { generation: number; promise: Promise<JsonValue> } | undefined;

  let calibrationModelCache: { loadedAt: number; generation: number; value: CalibrationModelSet } | undefined;
  let calibrationModelInFlight: { generation: number; promise: Promise<CalibrationModelSet> } | undefined;

  let correctionRuleCache: { loadedAt: number; generation: number; value: Awaited<ReturnType<typeof deps.storage.corrections.listRules>> } | undefined;
  let correctionRuleInFlight: { generation: number; promise: Promise<Awaited<ReturnType<typeof deps.storage.corrections.listRules>>> } | undefined;


  async function activeBrainMarker(): Promise<JsonValue> {
    const now = clock.now();
    const currentGeneration = generation;
    if (activeBrainMarkerCache
      && activeBrainMarkerCache.generation === currentGeneration
      && now - activeBrainMarkerCache.loadedAt < activeBrainMarkerCacheMs) return activeBrainMarkerCache.value;
    if (activeBrainMarkerInFlight?.generation === currentGeneration) return activeBrainMarkerInFlight.promise;
    const promise = (async () => {
      const summary = await deps.storage.brainImports.summarize({ limit: 2000 });
      const value = toJsonValue({
        activeBrainVersion: summary.activeBrainVersion ?? null,
        activeImportRunIds: summary.activeImportRunIds,
        importedLanguagePriorCount: summary.importedLanguagePriorCount,
        importedGraphPriorCount: summary.importedGraphPriorCount,
        importedDirectEvidenceCount: summary.importedDirectEvidenceCount,
        profileExcerptEvidenceCount: summary.profileExcerptEvidenceCount,
        importedLearnedPriorCount: summary.importedLearnedPriorCount,
        importedProgramPriorCount: summary.importedProgramPriorCount,
        unknownPriorCount: summary.unknownPriorCount,
        runs: summary.runs.slice(0, 24).map(run => ({
          importRunId: run.importRunId,
          brainVersion: run.brainVersion,
          rows: run.rows,
          forceClasses: run.forceClasses,
          rowCounts: run.rowCounts,
          warnings: run.warnings.slice(0, 24)
        })),
        forceClassExplanation: {
          direct_evidence: "exact source URI, version identity, and span preserved; may certify factual proof when promoted",
          profile_excerpt_evidence: "SCCE2 profile-contained excerpt only; may prove the profile contained text, not the original external factual claim",
          learned_language_prior: "language prior for scoring, suggestion, and Mouth realization; not factual proof",
          learned_concept_prior: "graph prior for alpha and PPF activation; not factual proof",
          learned_program_prior: "program-language prior; not factual proof",
          unknown_prior: "imported material with unsupported or uncertain semantics; not factual proof"
        }
      });
      if (generation === currentGeneration) activeBrainMarkerCache = { loadedAt: clock.now(), generation: currentGeneration, value };
      return value;
    })();
    activeBrainMarkerInFlight = { generation: currentGeneration, promise };
    void promise.finally(() => {
      if (activeBrainMarkerInFlight?.promise === promise) activeBrainMarkerInFlight = undefined;
    }).catch(() => undefined);
    return promise;
  }


  async function correctionRulesCached() {
    const now = clock.now();
    const currentGeneration = generation;
    if (correctionRuleCache
      && correctionRuleCache.generation === currentGeneration
      && now - correctionRuleCache.loadedAt < 30_000) return correctionRuleCache.value;
    if (correctionRuleInFlight?.generation === currentGeneration) return correctionRuleInFlight.promise;
    const promise = deps.storage.corrections.listRules({ limit: 96 }).then(value => {
      if (generation === currentGeneration) correctionRuleCache = { loadedAt: clock.now(), generation: currentGeneration, value };
      return value;
    });
    correctionRuleInFlight = { generation: currentGeneration, promise };
    void promise.finally(() => {
      if (correctionRuleInFlight?.promise === promise) correctionRuleInFlight = undefined;
    }).catch(() => undefined);
    return promise;
  }


  async function calibrationModelsCached(): Promise<CalibrationModelSet> {
    const now = clock.now();
    const currentGeneration = generation;
    if (calibrationModelCache
      && calibrationModelCache.generation === currentGeneration
      && now - calibrationModelCache.loadedAt < calibrationModelCacheMs) return calibrationModelCache.value;
    if (calibrationModelInFlight?.generation === currentGeneration) return calibrationModelInFlight.promise;
    if (!deps.storage.dialogueMemory?.listCalibrationObservations) {
      const value = buildCalibrationModelSet({ observations: [], createdAt: now });
      calibrationModelCache = { loadedAt: now, generation: currentGeneration, value };
      return value;
    }
    const promise = loadCalibrationModelSet({
      store: deps.storage.dialogueMemory,
      limit: 5000,
      minPoints: 2,
      createdAt: now
    }).then(value => {
      if (generation === currentGeneration) calibrationModelCache = { loadedAt: clock.now(), generation: currentGeneration, value };
      return value;
    });
    calibrationModelInFlight = { generation: currentGeneration, promise };
    void promise.finally(() => {
      if (calibrationModelInFlight?.promise === promise) calibrationModelInFlight = undefined;
    }).catch(() => undefined);
    return promise;
  }

  return {
    activeBrainMarker,
    correctionRulesCached,
    calibrationModelsCached,
    invalidate() {
      generation++;
      activeBrainMarkerCache = undefined;
      calibrationModelCache = undefined;
      correctionRuleCache = undefined;
    }
  };
}
