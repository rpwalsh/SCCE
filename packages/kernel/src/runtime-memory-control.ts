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

  let activeBrainMarkerCache: { loadedAt: number; value: JsonValue } | undefined;

  let calibrationModelCache: { loadedAt: number; value: CalibrationModelSet } | undefined;

  let correctionRuleCache: { loadedAt: number; value: Awaited<ReturnType<typeof deps.storage.corrections.listRules>> } | undefined;


  async function activeBrainMarker(): Promise<JsonValue> {
    const now = clock.now();
    if (activeBrainMarkerCache && now - activeBrainMarkerCache.loadedAt < activeBrainMarkerCacheMs) return activeBrainMarkerCache.value;
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
    activeBrainMarkerCache = { loadedAt: now, value };
    return value;
  }


  async function correctionRulesCached() {
    const now = clock.now();
    if (correctionRuleCache && now - correctionRuleCache.loadedAt < 30_000) return correctionRuleCache.value;
    const value = await deps.storage.corrections.listRules({ limit: 96 });
    correctionRuleCache = { loadedAt: now, value };
    return value;
  }


  async function calibrationModelsCached(): Promise<CalibrationModelSet> {
    const now = clock.now();
    if (calibrationModelCache && now - calibrationModelCache.loadedAt < calibrationModelCacheMs) return calibrationModelCache.value;
    if (!deps.storage.dialogueMemory?.listCalibrationObservations) {
      const value = buildCalibrationModelSet({ observations: [], createdAt: now });
      calibrationModelCache = { loadedAt: now, value };
      return value;
    }
    const value = await loadCalibrationModelSet({
      store: deps.storage.dialogueMemory,
      limit: 5000,
      minPoints: 2,
      createdAt: now
    });
    calibrationModelCache = { loadedAt: now, value };
    return value;
  }

  return {
    activeBrainMarker,
    correctionRulesCached,
    calibrationModelsCached,
    invalidate() {
      activeBrainMarkerCache = undefined;
      calibrationModelCache = undefined;
    }
  };
}
