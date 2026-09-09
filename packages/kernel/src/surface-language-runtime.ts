// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { traceEvent } from "./debug/trace.js";
import { createCorpusRegistry, languageMemoryHydrationPlan, type CorpusRoleId } from "./corpus-registry.js";
import { isCreativeEventCompatibilityPattern } from "./creative-event-compatibility.js";
import { jsonRecord, kernelString, normalizePriorKey, splitPriorUnits } from "./kernel-answer-primitives.js";
import { featureSetMemoStats } from "./primitives.js";
import { tidySurfaceTextMemoStats } from "./surface-linguistics.js";
import { isLanguageConstructionPattern } from "./language-construction-memory.js";
import { createLanguageMemoryRuntime, markLanguageMemoryStateUnscoped, scopeLanguageMemoryStateToCluster, scopeLanguageMemoryStateToLanguage } from "./language-memory-runtime.js";
import type { LanguageResolver } from "./language-identity-runtime.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import {
  buildLanguageProfileClusters,
  clustersSpeakSurface,
  languageSurfaceTrigrams,
  languageProfileClusterCacheKey,
  normalizeSourceLanguageAlias,
  selectDominantLanguageProfileCluster,
  selectLearnedLanguageProfileCluster,
  selectLanguageProfileForSurface,
  selectLanguageProfileClusterForSurface,
  type LanguageProfileCluster
} from "./language.js";
import { createClock, createHasher, sourceTextSurface, toJsonValue } from "./primitives.js";
import {
  isRequestRequirementPattern
} from "./request-requirement-learning.js";
import type { LanguagePatternRecord, ScceKernelDeps, SemanticFrameRecord } from "./storage.js";
import type { SegmentationPopulationModelRecord } from "./segmentation-population-persistence.js";
import type {
  EvidenceSpan,
  JsonValue,
  LanguageProfile,
  SourceVersionId
} from "./types.js";

/**
 * Real bug this guards against: surfaceLanguageMemoryCache and
 * surfaceCandidateProfileCache are both keyed (in part or entirely) by a
 * hash of the raw request/surface text, so a long-lived server answering
 * many distinct questions grows these Maps by one entry per distinct
 * question forever -- no TTL branch here ever deletes an entry, TTL only
 * decides whether an existing entry gets reused or overwritten at the
 * SAME key. Over a real session this is unbounded heap growth, not a
 * bounded cache; confirmed as the cause of an OOM crash on both a
 * long-running server process and a long vitest run exercising many
 * distinct request texts. FIFO-capped rather than a full LRU: simpler,
 * and eviction order doesn't need to be precise for a warm-recent-work
 * cache like this one.
 */
/** Cache-key field separator; cannot occur in an id. */
const UNIT_SEPARATOR = String.fromCharCode(31);

function boundedCacheSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Real bug this guards against: surfaceLanguageMemoryCache's entry-count
 * bound (above) treats every resident language cluster as the same size,
 * but one cluster hydration is hundreds of MB of live heap -- 500
 * entries is tens of GB, not a bounded cache. Confirmed live: an
 * ordinary question about a never-warmed topic ("tell me about
 * mmorpgs") took the resident-only durable fallback, hydrated one more
 * cluster on top of the startup-warmed set, and OOM'd a 7GB heap. Each
 * entry's size is tracked so eviction is oldest-first until the
 * AGGREGATE fits, not just the entry count.
 *
 * The budget is denominated in this file's OWN estimator units, not in
 * heap bytes and not in exact JSON bytes, and it is calibrated by
 * measurement rather than derivation: against real hydrated production
 * state, one full cluster hydration measures ~933MB by
 * approximateHydrationEstimatedBytes and costs ~365MB of actual V8 heap. The
 * estimator deliberately runs on a bounded sample (see below), so it
 * over-counts arrays whose leading records are larger than their tail --
 * that is acceptable in the conservative direction, but it means any
 * "bytes-to-heap multiplier" would be fiction. Two earlier attempts got
 * this wrong in exactly that way: the first budgeted 1.5GB of JSON bytes
 * (permitting ~13GB of real heap), the second multiplied the estimate by
 * a 9x figure measured on a narrower set of arrays (over-evicting by
 * ~23x). Budgeting ~3 full clusters keeps real resident heap near 1.1GB,
 * low enough that warmup's own oldest entries get evicted -- they
 * re-hydrate on demand, which is strictly better than an OOM that takes
 * every in-flight request with it.
 */
// Sized for a 7GB Node heap (node --max-old-space-size=7168 on a 16GB machine): the resident language cache may hold
// about five sixths of it, and each hydration below is bounded so several fit.
const SURFACE_LANGUAGE_MEMORY_CACHE_MAX_ESTIMATED_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Measured PER RECORD, never over the whole array, and failing toward
 * "huge" rather than "free". A single hydration's models array is
 * hundreds of MB; JSON.stringify over the whole thing throws RangeError
 * ("Invalid string length") above V8's ~512MB string cap -- the first
 * version of this function caught that and returned 0, so every entry
 * measured as weightless, the aggregate budget never tripped, nothing
 * was ever evicted, and the server OOM'd exactly as before (verified
 * live, twice). Any record that cannot be measured is therefore counted
 * as UNMEASURED_RECORD_BYTES, which pushes toward eviction instead of
 * silently disabling the bound. Only a bounded prefix is measured and
 * then extrapolated, so measuring never itself allocates much.
 */
const UNMEASURED_RECORD_BYTES = 16 * 1024 * 1024;
const MEASURED_RECORD_SAMPLE = 4;

function approximateRecordBytes(records: readonly unknown[]): number {
  if (!records.length) return 0;
  const sampleSize = Math.min(MEASURED_RECORD_SAMPLE, records.length);
  let sampledBytes = 0;
  for (let index = 0; index < sampleSize; index++) {
    try {
      sampledBytes += JSON.stringify(records[index])?.length ?? UNMEASURED_RECORD_BYTES;
    } catch {
      sampledBytes += UNMEASURED_RECORD_BYTES;
    }
  }
  return Math.round((sampledBytes / sampleSize) * records.length);
}

/**
 * Every large array a hydration holds, not just the two that carry an
 * explicit byte budget: an entry whose weight sits in observations or
 * construction evidence would otherwise measure as weightless and be
 * exempt from the bound entirely -- the same zero-measurement failure
 * that made the first version of this budget useless.
 */
function approximateHydrationEstimatedBytes(value: {
  models?: readonly unknown[];
  units?: readonly unknown[];
  observations?: readonly unknown[];
  patterns?: readonly unknown[];
  semanticFrames?: readonly unknown[];
  constructionEvidence?: readonly unknown[];
}): number {
  const jsonBytes = approximateRecordBytes(value.models ?? [])
    + approximateRecordBytes(value.units ?? [])
    + approximateRecordBytes(value.observations ?? [])
    + approximateRecordBytes(value.patterns ?? [])
    + approximateRecordBytes(value.semanticFrames ?? [])
    + approximateRecordBytes(value.constructionEvidence ?? []);
  return jsonBytes;
}

function boundedSurfaceLanguageMemoryCacheSet<K, V extends { approxEstimatedBytes: number }>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  maxBytes: number
): void {
  map.delete(key);
  map.set(key, value);
  let totalBytes = 0;
  for (const entry of map.values()) totalBytes += entry.approxEstimatedBytes;
  while ((map.size > maxEntries || totalBytes > maxBytes) && map.size > 1) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = map.get(oldestKey);
    map.delete(oldestKey);
    if (oldest) totalBytes -= oldest.approxEstimatedBytes;
  }
}

const DEFAULT_SURFACE_LANGUAGE_MEMORY_CACHE_MAX_ENTRIES = 500;
const DEFAULT_SURFACE_CANDIDATE_PROFILE_CACHE_MAX_ENTRIES = 2_000;

const approxJsonMb = (rows: readonly unknown[]): number => {
  if (!(globalThis as { __sccTrace?: unknown }).__sccTrace) return 0;
  let bytes = 0;
  for (const row of rows) { try { bytes += JSON.stringify(row).length; } catch { bytes += 512 * 1024 * 1024; } }
  return Math.round(bytes / 1048576);
};
const hydrateHeapTrace = (stage: string, counts: Record<string, number>) =>
  traceEvent((globalThis as { __sccTrace?: Parameters<typeof traceEvent>[0] }).__sccTrace, { stage, label: "kernel.language.hydrate", counts: { ...counts, heapMb: (process.env.SCCE_TRACE_GC === "1" && typeof (globalThis as { gc?: () => void }).gc === "function" ? ((globalThis as { gc?: () => void }).gc!(), 0) : 0) + Math.round(process.memoryUsage().heapUsed / 1048576) } });

export function createSurfaceLanguageRuntime(options: {
  deps: Pick<ScceKernelDeps, "storage" | "corpusRegistry">;
  languageMemoryRuntime: ReturnType<typeof createLanguageMemoryRuntime>;
  clock: ReturnType<typeof createClock>;
  hasher: ReturnType<typeof createHasher>;
  cacheMs: number;
  profileLimit: number;
  /** Resolves artifact languages once identities are loaded; absent until then, when cluster scoping applies. */
  languageResolver?: () => LanguageResolver | undefined;
  /** Test/tuning hook; production callers should rely on the defaults. */
  surfaceLanguageMemoryCacheMaxEntries?: number;
  surfaceCandidateProfileCacheMaxEntries?: number;
  surfaceLanguageMemoryCacheMaxEstimatedBytes?: number;
}) {
  const { deps, languageMemoryRuntime, clock, hasher } = options;
  const surfaceLanguageMemoryCacheMs = options.cacheMs;
  const surfaceLanguageProfileLimit = options.profileLimit;
  const surfaceLanguageMemoryCacheMaxEntries = options.surfaceLanguageMemoryCacheMaxEntries ?? DEFAULT_SURFACE_LANGUAGE_MEMORY_CACHE_MAX_ENTRIES;
  const surfaceCandidateProfileCacheMaxEntries = options.surfaceCandidateProfileCacheMaxEntries ?? DEFAULT_SURFACE_CANDIDATE_PROFILE_CACHE_MAX_ENTRIES;
  const surfaceLanguageMemoryCacheMaxEstimatedBytes = options.surfaceLanguageMemoryCacheMaxEstimatedBytes ?? SURFACE_LANGUAGE_MEMORY_CACHE_MAX_ESTIMATED_BYTES;

  const corpusRegistry = createCorpusRegistry(deps.corpusRegistry ?? []);

  const surfaceLanguageMemoryCache = new Map<string, { limit: number; loadedAt: number; value: Awaited<ReturnType<typeof hydrateSurfaceLanguageMemory>>; approxEstimatedBytes: number }>();

  let surfaceProfileCache: { loadedAt: number; value: LanguageProfile[]; clusters: LanguageProfileCluster[] } | undefined;

  const sourceOwnedAliasProfileCache = new Map<string, {
    loadedAt: number;
    profiles: LanguageProfile[];
    clusters: LanguageProfileCluster[];
  }>();
  const surfaceCandidateProfileCache = new Map<string, {
    loadedAt: number;
    profiles: LanguageProfile[];
    clusters: LanguageProfileCluster[];
  }>();
  const evidenceOwnedProfileCache = new Map<string, {
    loadedAt: number;
    profiles: LanguageProfile[];
    clusters: LanguageProfileCluster[];
  }>();

  let sourceAnchorSemanticFrameCache: {
    loadedAt: number;
    value: Array<{ frame: SemanticFrameRecord; surface: string; surfaceUnits: string[] }>;
  } | undefined;

  type ResidentOnlyOptions = {
    residentOnly?: boolean;
    /** Scope the hydration to a learned language identity instead of to the cluster's document membership. */
    languageId?: string;
  };


  async function languageMemorySummary(limit = 36): Promise<JsonValue> {
    const models = await deps.storage.languageMemory.listNgramModels({ limit });
    const observations = await deps.storage.languageMemory.listNgramObservations({ limit: 10000 });
    const units = await deps.storage.languageMemory.listLanguageUnits({ limit: 2048 });
    const patterns = await deps.storage.languageMemory.listLanguagePatterns({ limit: 512 });
    const state = languageMemoryRuntime.hydrate({ models, observations, units, patterns });
    return toJsonValue({
      modelRecords: models.length,
      usableModels: state.models.length,
      maxOrder: state.maxOrder,
      observedSymbolCount: state.observedSymbolCount,
      vocabularySize: state.vocabularySize,
      importedLanguagePriorCount: state.importedLanguagePriorCount,
      streamIds: state.streamIds.slice(0, 24),
      languageHints: state.languageHints.slice(0, 24),
      profile: languageMemoryRuntime.profile({ state }),
      audit: state.audit
    });
  }


  async function hydrateSurfaceLanguageMemory(
    limit = 36,
    cluster?: LanguageProfileCluster,
    unscopedReason = "no-language-cluster-selected",
    preferredCorpusRoleId?: CorpusRoleId,
    preferredSurface = "",
    languageId?: string
  ) {
    const boundedLimit = Math.max(1, Math.min(256, Math.floor(limit)));
    const hydrateHeapStart = process.memoryUsage().heapUsed;
    const hydrateStartedAt = Date.now();
    const profileIds = preferredCorpusRoleId ? undefined : cluster?.profileIds;
    const hydrationLimits = {
      ngramModels: Math.max(12, boundedLimit * Math.max(1, corpusRegistry.length)),
      ngramObservations: Math.max(1200, boundedLimit * 320),
      languageUnits: Math.max(512, boundedLimit * 128),
      languagePatterns: Math.max(256, boundedLimit * 64),
      semanticFrames: Math.max(512, boundedLimit * 96)
    };
    // Byte budgets, not just record counts: whole-novel training grew a
    // single n-gram model to tens of MB and language units to ~660KB
    // average, so count limits alone OOMed a 4GB server heap at warmup
    // (verified live). Enforced adapter-side in relevance order -- the
    // best records still load, the oversized tail is skipped
    // deterministically. Sized so several concurrently-cached clusters
    // fit a default 4GB heap with parsed-object overhead.
    // TOTAL durable-hydration JSON budgets across the whole query fan-out. Per-query
    // budgets multiplied by corpus count: a wiki-brain turn hydrated 3.9GB of heap
    // (6 models / 768 patterns / 393 frames, 141s) before producing nothing. Shares
    // are divided across hydrationQueries at the load sites below.
    const hydrationByteBudgets = {
      // Memory bounds, not relevance knobs: JSON of this size hydrates to roughly 25x in Map-heavy heap (measured 120MB
      // -> 3.3GB), so 96MB of JSON per hydration is about 2.4GB, and a 5GB cache holds two of them.
      ngramModelJsonBytes: (Number(process.env.SCCE_LANGUAGE_HYDRATE_NGRAM_MB) || 48) * 1024 * 1024,
      languageUnitJsonBytes: (Number(process.env.SCCE_LANGUAGE_HYDRATE_UNITS_MB) || 16) * 1024 * 1024,
      languagePatternJsonBytes: (Number(process.env.SCCE_LANGUAGE_HYDRATE_PATTERNS_MB) || 32) * 1024 * 1024
    };
    const hydrationShare = (total: number, fanOut: number) => Math.max(256 * 1024, Math.floor(total / Math.max(1, fanOut)));
    const exactProfileOwnerCount = Math.max(1, profileIds?.length ?? 0);
    // Per-profile scaling is capped at the general bounded limits: 214 profiles asked for
    // 54,784 observations (then trimmed to 3,840 after loading) -- 1.8GB of heap for nothing.
    const exactProfileHydrationLimits = {
      ngramModels: Math.min(Math.max(12, exactProfileOwnerCount * 4), hydrationLimits.ngramModels),
      ngramObservations: Math.min(Math.max(256, exactProfileOwnerCount * 256), hydrationLimits.ngramObservations),
      languageUnits: Math.min(Math.max(256, exactProfileOwnerCount * 256), hydrationLimits.languageUnits),
      languagePatterns: Math.min(Math.max(96, exactProfileOwnerCount * 96), hydrationLimits.languagePatterns),
      semanticFrames: Math.min(Math.max(128, exactProfileOwnerCount * 128), hydrationLimits.semanticFrames)
    };
    const corpusPlan = languageMemoryHydrationPlan(corpusRegistry, hydrationLimits);
    const [active, requestControlPatterns] = await Promise.all([
      deps.storage.brainImports.active(),
      deps.storage.languageMemory.listLanguagePatterns({ sourceSystem: "corrections", limit: 2048 })
    ]);
    const learnedRequestControlPatterns = latestRequestRequirementPatterns(requestControlPatterns);
    const requestControlCompatibilityPatterns = requestControlPatterns
      .filter(isCreativeEventCompatibilityPattern);
    if (!cluster && !preferredCorpusRoleId) {
      const hydrated = languageMemoryRuntime.hydrateFromImportedBrain({
        importRunId: active.activeImportRunIds[0],
        models: [],
        observations: [],
        units: [],
        patterns: [],
        semanticFrames: [],
        constructionEvidence: []
      });
      return {
        models: [],
        observations: [],
        units: [],
        patterns: [],
        semanticFrames: [],
        segmentationPopulationModels: [] as SegmentationPopulationModelRecord[],
        requestControlPatterns: learnedRequestControlPatterns,
        state: markLanguageMemoryStateUnscoped(hydrated, unscopedReason),
        surfaceProfile: undefined as LanguageProfile | undefined,
        clusterMembers: [] as LanguageProfile[],
        active,
        corpusPlan,
        // Nothing here depends on the surface; rescoping returns the same
        // unscoped empty state so the cached-hit path stays uniform.
        rescopeForSurface: () => ({
          state: markLanguageMemoryStateUnscoped(hydrated, unscopedReason),
          surfaceProfile: undefined as LanguageProfile | undefined
        })
      };
    }
    const roleScopedCorpusPlan = preferredCorpusRoleId
      ? corpusPlan.filter(item => corpusRegistry.some(entry =>
        entry.sourceSystemId === item.sourceSystemId
        && entry.corpusRoleId === preferredCorpusRoleId
      ))
      : corpusPlan;
    const orderedCorpusPlan = [...roleScopedCorpusPlan].sort((left, right) =>
      right.priority - left.priority
      || left.sourceSystem.localeCompare(right.sourceSystem)
    );
    const corpusQueries = orderedCorpusPlan.flatMap(item => item.querySourceSystems.map(sourceSystem => ({ ...item, sourceSystem })));
    const hydrationQueries: Array<{
      sourceSystem?: string;
      profileIds?: readonly string[];
      limits: typeof hydrationLimits;
    }> = profileIds?.length
      ? [{ profileIds, limits: exactProfileHydrationLimits }]
      : corpusQueries;
    hydrateHeapTrace("language.hydrate.start", { queries: hydrationQueries.length, boundedLimit, limit, obsLimit: hydrationQueries[0]?.limits.ngramObservations ?? -1, unitLimit: hydrationQueries[0]?.limits.languageUnits ?? -1, patternLimit: hydrationQueries[0]?.limits.languagePatterns ?? -1, profiles: hydrationQueries[0]?.profileIds?.length ?? -1, corpora: corpusRegistry.length });
    const modelsBySource = await Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listNgramModels({ sourceSystem: item.sourceSystem, profileIds: item.profileIds, limit: Math.min(limit, item.limits.ngramModels), maxTotalJsonBytes: hydrationShare(hydrationByteBudgets.ngramModelJsonBytes, hydrationQueries.length) }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listNgramModels", rows: rows.flat().length } as unknown as Record<string, number>); return rows; });
    // Observations are the uncompiled form of the same models. They are read only for a scope that has no persisted
    // model at all: measured, 20,480 observation rows across a 1,960-profile scope took 260s and added nothing the
    // parsed block models did not already carry.
    const persistedModelsPresent = modelsBySource.flat().some(record => languageMemoryRuntime.hydrateFromImportedBrain({ importRunId: undefined, models: [record], observations: [], units: [], patterns: [], semanticFrames: [], constructionEvidence: [] }).models.length > 0);
    const [
      observationsBySource,
      unitsBySource,
      patternsBySource,
      semanticFramesBySource,
      persistedProfiles,
      segmentationPopulationModels
    ] = await Promise.all([
      persistedModelsPresent
        ? Promise.resolve(hydrationQueries.map(() => [] as Awaited<ReturnType<typeof deps.storage.languageMemory.listNgramObservations>>))
        : Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listNgramObservations({ sourceSystem: item.sourceSystem, profileIds: item.profileIds, limit: item.limits.ngramObservations }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listNgramObservations", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listLanguageUnits({ profileIds: item.profileIds, sourceSystem: item.sourceSystem, limit: item.limits.languageUnits, maxTotalJsonBytes: hydrationShare(hydrationByteBudgets.languageUnitJsonBytes, hydrationQueries.length) }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listLanguageUnits", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listLanguagePatterns({ profileIds: item.profileIds, sourceSystem: item.sourceSystem, languageId: item.profileIds ? undefined : languageId, limit: item.limits.languagePatterns, maxTotalJsonBytes: hydrationShare(hydrationByteBudgets.languagePatternJsonBytes, hydrationQueries.length) }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listLanguagePatterns", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listSemanticFrames({ profileIds: item.profileIds, sourceSystem: item.sourceSystem, limit: item.limits.semanticFrames }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listSemanticFrames", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
      preferredCorpusRoleId
        ? surfaceProfileCache
          ? Promise.resolve(surfaceProfileCache.value)
          : deps.storage.model.listLanguageProfiles({ limit: surfaceLanguageProfileLimit, referencedByLanguageMemory: true })
        : Promise.resolve([] as LanguageProfile[]),
      deps.storage.segmentationPopulations
        ? deps.storage.segmentationPopulations.listRecent({
          profileIds,
          limit: Math.max(4, Math.min(32, boundedLimit))
        })
        : Promise.resolve([] as SegmentationPopulationModelRecord[])
    ]);
    const models = uniqueRecordsById(modelsBySource.flat(), Math.max(boundedLimit, corpusPlan.reduce((sum, item) => sum + item.limits.ngramModels, 0)));
    const observations = uniqueRecordsById(observationsBySource.flat(), Math.max(1200, boundedLimit * 320));
    const units = uniqueRecordsById(unitsBySource.flat(), Math.max(512, boundedLimit * 128));
    const patterns = uniqueRecordsById(patternsBySource.flat(), Math.max(256, boundedLimit * 64));
    const queriedSemanticFrames = uniqueRecordsById(semanticFramesBySource.flat(), Math.max(512, boundedLimit * 96));
    const semanticFrames = queriedSemanticFrames;
    const constructionEvidenceIds = [...new Set(patterns
      .filter(isLanguageConstructionPattern)
      .flatMap(pattern => pattern.evidenceIds.map(String)))]
      .sort()
      .slice(0, 4096)
      .map(id => id as EvidenceSpan["id"]);
    const constructionEvidence = constructionEvidenceIds.length
      ? await deps.storage.evidence.getEvidenceBatch(constructionEvidenceIds)
      : [];
    hydrateHeapTrace("language.hydrate.loaded", { elapsedMs: Date.now() - hydrateStartedAt, modelsJsonMb: approxJsonMb(models), observationsJsonMb: approxJsonMb(observations), unitsJsonMb: approxJsonMb(units), patternsJsonMb: approxJsonMb(patterns), framesJsonMb: approxJsonMb(semanticFrames), constructionEvidenceJsonMb: approxJsonMb(constructionEvidence), models: models.length, observations: observations.length, units: units.length, patterns: patterns.length, semanticFrames: semanticFrames.length, constructionEvidence: constructionEvidence.length, queries: hydrationQueries.length });
    const hydrated = languageMemoryRuntime.hydrateFromImportedBrain({
      importRunId: active.activeImportRunIds[0],
      models,
      observations,
      units,
      patterns: uniqueRecordsById([
        ...patterns,
        ...requestControlCompatibilityPatterns
      ], Math.max(256, boundedLimit * 64)),
      semanticFrames,
      constructionEvidence
    });
    hydrateHeapTrace("language.hydrate.built", { elapsedMs: Date.now() - hydrateStartedAt, importedUnits: hydrated.importedUnits?.length ?? 0, importedPatterns: hydrated.importedPatterns?.length ?? 0, constructionBundles: hydrated.importedConstructionBundles?.length ?? 0, rejectedBundles: hydrated.rejectedConstructionPatterns?.length ?? 0 });
    const roleProfileIds = new Set<string>([
      ...units.map(unit => unit.profileId),
      ...patterns.map(pattern => pattern.profileId),
      ...models.map(model => {
        const record = jsonRecord(model.modelJson);
        return typeof record.profileId === "string" ? record.profileId : "";
      }).filter(Boolean),
      ...semanticFrames.map(frame => {
        const record = jsonRecord(frame.frameJson);
        return typeof record.profileId === "string" ? record.profileId : "";
      }).filter(Boolean)
    ]);
    const roleProfiles = persistedProfiles.filter(profile => roleProfileIds.has(profile.id));
    // The ONLY thing the request surface influences in this whole function:
    // which role cluster scopes the already-hydrated payload. Everything
    // above -- the 64MB model read, unit/pattern/frame loads, trie build --
    // is surface-independent, so this tail is factored out and returned so
    // a cached hydration can be re-scoped for a new request in milliseconds
    // instead of re-hydrated in minutes.
    // A language scope does not depend on the surface, and scoping recompiles every retained model (13s per turn on a
    // cache hit, measured); it is computed once per hydration and only the surface profile is chosen per request.
    let languageScopedState: LanguageMemoryRuntimeState | undefined;
    const scopeForSurface = (surface: string) => {
      // A language identity scopes by what each artifact is, not by which document it came from.
      const resolver = languageId ? options.languageResolver?.() : undefined;
      if (languageId && resolver) {
        languageScopedState ??= scopeLanguageMemoryStateToLanguage(hydrated, languageId, resolver);
        // cluster is the document/evidence-similarity cluster this hydration was originally asked to scope to --
        // unrelated to languageId, and its members can belong to any identity at all (verified live: a factual
        // turn's cluster member ended up a profile trained almost entirely from this repo's own source files and
        // license headers, under a completely different learned identity than the one languageScopedState was
        // just built from, while the identity's own real prose profiles -- one alone carrying 2,815 semantic-role
        // patterns -- went unused). The surface profile has to come from the same identity-scoped population the
        // state itself was filtered to, or every downstream profile-identity comparison is comparing across
        // unrelated corpora by accident. Falls back to the old cluster-based pick only if scoping produced no
        // candidate profiles at all, rather than leaving surfaceProfile undefined.
        const languageScopedProfileIds = new Set(languageScopedState.scope.profileIds);
        const languageScopedProfiles = roleProfiles.filter(profile => languageScopedProfileIds.has(profile.id));
        return {
          state: languageScopedState,
          surfaceProfile: (languageScopedProfiles.length
            ? selectLanguageProfileForSurface(languageScopedProfiles, surface) ?? languageScopedProfiles[0]
            : cluster ? selectLanguageProfileForSurface(cluster.members, surface) ?? cluster.members[0] : undefined) as LanguageProfile | undefined
        };
      }
      const roleCluster = preferredCorpusRoleId
        ? corpusRoleLanguageCluster({
          roleId: preferredCorpusRoleId,
          target: cluster,
          profiles: roleProfiles,
          surface
        })
        : undefined;
      const effectiveCluster = roleCluster ?? cluster;
      return {
        state: effectiveCluster
          ? scopeLanguageMemoryStateToCluster(hydrated, effectiveCluster, { admitUnprofiled: Boolean(preferredCorpusRoleId) })
          : markLanguageMemoryStateUnscoped(hydrated, unscopedReason),
        // The member whose own distribution matches this surface, not whichever member sorted first.
        surfaceProfile: (effectiveCluster
          ? selectLanguageProfileForSurface(effectiveCluster.members, surface) ?? effectiveCluster.members[0]
          : undefined) as LanguageProfile | undefined
      };
    };
    const scoped = scopeForSurface(preferredSurface);
    return {
      models,
      observations,
      units,
      patterns,
      semanticFrames,
      segmentationPopulationModels,
      constructionEvidence,
      requestControlPatterns: learnedRequestControlPatterns,
      state: scoped.state,
      surfaceProfile: scoped.surfaceProfile,
      clusterMembers: (cluster?.members ?? []) as LanguageProfile[],
      active,
      corpusPlan,
      rescopeForSurface: scopeForSurface,
      // Measured, not estimated: Map-heavy n-gram state is invisible to JSON-size estimates
      // (120MB of JSON hydrated to 3.3GB of heap while the estimator never triggered eviction).
      measuredHeapBytes: Math.max(0, process.memoryUsage().heapUsed - hydrateHeapStart)
    };
  }


  function corpusRoleLanguageCluster(input: {
    roleId: CorpusRoleId;
    target?: LanguageProfileCluster;
    profiles: readonly LanguageProfile[];
    surface?: string;
  }): LanguageProfileCluster | undefined {
    const target = input.target;
    const targetScripts = new Set((target?.scripts ?? [])
      .filter(row => row.mass >= 0.12)
      .map(row => row.script));
    const targetLanguageOwners = new Set((target?.discoveredNames ?? [])
      .filter(row => row.confidence > 0)
      .map(row => normalizePriorKey(row.surface))
      .filter(Boolean));
    const ownerCompatible = target
      ? input.profiles.filter(profile => (
        directionCompatible(profile.direction, target.direction)
        && profile.scripts.some(script => script.mass >= 0.12 && targetScripts.has(script.script))
        && targetLanguageOwners.size > 0
        && (profile.discoveredNames ?? []).some(name =>
          name.confidence > 0
          && targetLanguageOwners.has(normalizePriorKey(name.surface))
        )
      ))
      : [];
    const surfaceSelected = input.surface?.trim()
      ? selectLanguageProfileClusterForSurface(buildLanguageProfileClusters(input.profiles), input.surface)?.cluster
      : undefined;
    const surfaceSelectedOwners = new Set((surfaceSelected?.discoveredNames ?? [])
      .filter(row => row.confidence > 0)
      .map(row => normalizePriorKey(row.surface))
      .filter(Boolean));
    const surfaceCompatible = surfaceSelectedOwners.size
      ? input.profiles.filter(profile => (profile.discoveredNames ?? []).some(name =>
        name.confidence > 0 && surfaceSelectedOwners.has(normalizePriorKey(name.surface))
      ))
      : surfaceSelected?.members ?? [];
    const roleCompatible = ownerCompatible.length
      ? ownerCompatible
      : surfaceCompatible.length
        ? surfaceCompatible
        : target
          ? []
          : input.profiles;
    const compatible = roleCompatible
      .filter(profile => !target || (
        directionCompatible(profile.direction, target.direction)
        && profile.scripts.some(script => script.mass >= 0.12 && targetScripts.has(script.script))
      ))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!compatible.length) return undefined;
    const base = buildLanguageProfileClusters(compatible)[0];
    if (!base) return undefined;
    const profileIds = compatible.map(profile => profile.id);
    const sourceVersionIds = compatible.map(profile => profile.sourceVersionId);
    return {
      ...base,
      id: `language-cluster:corpus-role:${hasher.digestHex(`${input.roleId}\u001f${profileIds.join("\u001f")}`).slice(0, 32)}`,
      members: compatible,
      profileIds,
      sourceVersionIds,
      discoveredNames: base.discoveredNames,
      scripts: target?.scripts ?? base.scripts,
      symbolShapes: target?.symbolShapes ?? base.symbolShapes,
      charNgrams: target?.charNgrams ?? base.charNgrams,
      direction: target?.direction ?? base.direction,
      artifactSupport: compatible.reduce((sum, profile) => sum + Math.max(1, profile.charNgrams.reduce((mass, row) => mass + row.count, 0)), 0)
    };
  }


  // A corpus batch carrying a few foreign names reads "mixed"; that is not a different language from "ltr".
  function directionCompatible(left: string, right: string): boolean {
    return left === right || left === "mixed" || right === "mixed" || left === "unknown" || right === "unknown";
  }

  function uniqueRecordsById<T extends { id: string }>(records: readonly T[], limit: number): T[] {
    const byId = new Map<string, T>();
    for (const record of records) if (!byId.has(record.id)) byId.set(record.id, record);
    return [...byId.values()].slice(0, limit);
  }


  function latestRequestRequirementPatterns(records: readonly LanguagePatternRecord[]): LanguagePatternRecord[] {
    const requestPatterns = records
      .filter(isRequestRequirementPattern)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const latest = requestPatterns[0];
    if (!latest) return [];
    const latestSourceVersionId = kernelString(jsonRecord(latest.patternJson).sourceVersionId);
    const current = latestSourceVersionId
      ? requestPatterns.filter(pattern => kernelString(jsonRecord(pattern.patternJson).sourceVersionId) === latestSourceVersionId)
      : requestPatterns.filter(pattern => pattern.updatedAt === latest.updatedAt);
    return uniqueRecordsById(current, 2048);
  }


  async function hydrateSurfaceLanguageMemoryCached(
    limit = 36,
    cluster?: LanguageProfileCluster,
    unscopedReason = "no-language-cluster-selected",
    preferredCorpusRoleId?: CorpusRoleId,
    preferredSurface = "",
    hydrationOptions: ResidentOnlyOptions = {}
  ) {
    const now = clock.now();
    const languageId = hydrationOptions.languageId;
    const lookup = (result: string, extra: Record<string, number> = {}) => traceEvent(
      (globalThis as { __sccTrace?: Parameters<typeof traceEvent>[0] }).__sccTrace,
      {
        stage: "language.cache.lookup",
        label: "kernel.language.hydrate",
        counts: { entries: surfaceLanguageMemoryCache.size, ...extra },
        support: { result, cluster: cluster?.id ?? null, language: languageId ?? null, profiles: cluster?.profileIds.length ?? 0, role: preferredCorpusRoleId ?? null, residentOnly: hydrationOptions.residentOnly === true, reason: unscopedReason }
      }
    );
    // Keyed by language and role: the same language is the same hydration whatever the request cluster was.
    if (languageId) {
      const languageKey = `${languageId}\u001flanguage\u001f${preferredCorpusRoleId ?? "corpus-role:any"}`;
      const resident = surfaceLanguageMemoryCache.get(languageKey);
      if (resident && resident.limit >= limit && (hydrationOptions.residentOnly || now - resident.loadedAt < surfaceLanguageMemoryCacheMs)) {
        lookup("hit-language");
        return preferredSurface.trim() && resident.value.rescopeForSurface
          ? { ...resident.value, ...resident.value.rescopeForSurface(preferredSurface) }
          : resident.value;
      }
      lookup(hydrationOptions.residentOnly ? "miss-resident" : "miss-durable");
      if (hydrationOptions.residentOnly) return residentRuntimeNotWarm(`language-memory:${unscopedReason}`);
      const value = await hydrateSurfaceLanguageMemory(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface, languageId);
      boundedSurfaceLanguageMemoryCacheSet(
        surfaceLanguageMemoryCache,
        languageKey,
        { limit, loadedAt: now, value, approxEstimatedBytes: Math.max(approximateHydrationEstimatedBytes(value), value.measuredHeapBytes ?? 0) },
        surfaceLanguageMemoryCacheMaxEntries,
        surfaceLanguageMemoryCacheMaxEstimatedBytes
      );
      return value;
    }
    if (preferredCorpusRoleId && preferredSurface.trim() && surfaceProfileCache) {
      // The role id ends the cache key, so it is matched as a suffix; the old "\u001f<role>\u001f" marker never matched.
      const roleKey = `\u001f${preferredCorpusRoleId}`;
      const residentRoleMatch = [...surfaceLanguageMemoryCache.entries()]
        .filter(([key, entry]) => (
          key.endsWith(roleKey)
          && (entry.value.state.models.length > 0 || entry.value.state.importedConstructionBundles.length > 0)
          && entry.value.state.scope.mode === "cluster"
          && entry.value.state.scope.purityProven
        ))
        .map(([, entry]) => {
          const profileIds = new Set(entry.value.state.scope.profileIds);
          // The entry's own members, not this request's profile window: the window is rebuilt per request by
          // trigram overlap, and a resident hydration of the whole learned language rarely intersects it enough.
          const profiles = entry.value.clusterMembers?.length
            ? entry.value.clusterMembers
            : surfaceProfileCache!.value.filter(profile => profileIds.has(profile.id));
          const clusterCompatible = cluster
            && entry.value.surfaceProfile
            && languageProfileMatchesCluster(entry.value.surfaceProfile, cluster);
          if (clusterCompatible) return { entry, score: 1, margin: 1 };
          const match = clustersSpeakSurface(buildLanguageProfileClusters(profiles), preferredSurface);
          return match ? { entry, score: match.score, margin: 0 } : undefined;
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .sort((left, right) => right.score - left.score || right.margin - left.margin)[0];
      if (residentRoleMatch) { lookup("hit-role"); return residentRoleMatch.entry.value; }
    }
    // The request surface is deliberately NOT part of this key. Hydration
    // content depends only on (cluster, role); the surface influences just
    // the scoping tail, which rescopeForSurface re-runs against the cached
    // payload below. Keying on the surface hash meant every distinct
    // request text was a guaranteed miss -- the same defect as the
    // readiness cache keyed on a rebuilt context object -- and a cold
    // process re-paid the full durable hydration (measured: 535s of a 581s
    // creative turn) for every new question. The residentRoleMatch branch
    // above already established that cross-surface reuse of a role-scoped
    // hydration is sound; this makes the fallback key agree with it.
    const cacheKey = `${languageProfileClusterCacheKey(cluster)}\u001f${cluster ? "scoped" : unscopedReason}\u001f${preferredCorpusRoleId ?? "corpus-role:any"}`;
    const cached = surfaceLanguageMemoryCache.get(cacheKey);
    if (cached
      && cached.limit >= limit
      && (hydrationOptions.residentOnly || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) {
      lookup("hit-exact");
      return preferredCorpusRoleId && preferredSurface.trim() && cached.value.rescopeForSurface
        ? { ...cached.value, ...cached.value.rescopeForSurface(preferredSurface) }
        : cached.value;
    }
    const superset = cluster && !preferredCorpusRoleId ? residentSupersetLanguageMemory(cluster, preferredSurface) : undefined;
    if (superset) { lookup("hit-superset"); return superset; }
    lookup(hydrationOptions.residentOnly ? "miss-resident" : "miss-durable", {
      roleEntries: preferredCorpusRoleId ? [...surfaceLanguageMemoryCache.keys()].filter(key => key.endsWith(`\u001f${preferredCorpusRoleId}`)).length : 0,
      surfaceProfiles: surfaceProfileCache?.value.length ?? -1
    });
    if (hydrationOptions.residentOnly) {
      return residentRuntimeNotWarm(`language-memory:${unscopedReason}`);
    }
    const value = await hydrateSurfaceLanguageMemory(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface);
    boundedSurfaceLanguageMemoryCacheSet(
      surfaceLanguageMemoryCache,
      cacheKey,
      { limit, loadedAt: now, value, approxEstimatedBytes: Math.max(approximateHydrationEstimatedBytes(value), value.measuredHeapBytes ?? 0) },
      surfaceLanguageMemoryCacheMaxEntries,
      surfaceLanguageMemoryCacheMaxEstimatedBytes
    );
    return value;
  }

  // Selection aggregates tied same-language clusters per request, so the cluster a turn names is rarely the one
  // warmup named; a warmed hydration whose profiles contain the requested ones, scoped down, is that hydration.
  function residentSupersetLanguageMemory(cluster: LanguageProfileCluster, surface: string) {
    const wanted = cluster.profileIds;
    const match = [...surfaceLanguageMemoryCache.entries()]
      .filter(([key]) => key.endsWith("\u001fcorpus-role:any"))
      .map(([, entry]) => entry)
      .filter(entry => entry.value.state.scope.mode === "cluster" && entry.value.state.scope.profileIds.length >= wanted.length)
      .map(entry => ({ entry, have: new Set(entry.value.state.scope.profileIds) }))
      .filter(row => wanted.every(id => row.have.has(id)))
      .sort((left, right) => left.have.size - right.have.size)[0];
    if (match) {
      const value = match.entry.value;
      return {
        ...value,
        state: scopeLanguageMemoryStateToCluster(value.state, cluster),
        surfaceProfile: (surface.trim() ? selectLanguageProfileForSurface(cluster.members, surface) : undefined) ?? cluster.members[0]
      };
    }
    // No containing hydration: a resident hydration of the whole learned language is still this request's
    // language when its own members select for the surface, and it is served as it stands.
    if (!surface.trim()) return undefined;
    const spoken = [...surfaceLanguageMemoryCache.entries()]
      .filter(([key, entry]) => key.endsWith("\u001fcorpus-role:any") && entry.value.state.scope.mode === "cluster" && entry.value.clusterMembers.length > 0)
      .map(([, entry]) => {
        const selected = clustersSpeakSurface(buildLanguageProfileClusters(entry.value.clusterMembers), surface);
        return selected ? { entry, score: selected.score, members: selected.cluster.members } : undefined;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort((left, right) => right.score - left.score || right.entry.loadedAt - left.entry.loadedAt)[0];
    if (!spoken) return undefined;
    return {
      ...spoken.entry.value,
      surfaceProfile: selectLanguageProfileForSurface(spoken.members, surface) ?? spoken.members[0]
    };
  }

  function residentRuntimeNotWarm(resource: string): never {
    throw new Error(`hydrated runtime unavailable: resident ${resource} was not warmed`);
  }

  function residentSurfaceLanguageMemory(
    cluster: LanguageProfileCluster | undefined,
    preferredCorpusRoleId?: CorpusRoleId
  ) {
    if (!cluster) return undefined;
    const prefix = `${languageProfileClusterCacheKey(cluster)}\u001fscoped\u001f`;
    const roleMarker = preferredCorpusRoleId ? `\u001f${preferredCorpusRoleId}` : undefined;
    return [...surfaceLanguageMemoryCache.entries()]
      .filter(([key]) => key.startsWith(prefix) && (!roleMarker || key.endsWith(roleMarker)))
      .map(([, entry]) => entry)
      .sort((left, right) => right.loadedAt - left.loadedAt)[0]?.value;
  }


  function languageProfileMatchesCluster(
    profile: LanguageProfile,
    cluster: LanguageProfileCluster
  ): boolean {
    if (profile.direction !== cluster.direction) return false;
    const targetScripts = new Set(cluster.scripts
      .filter(row => row.mass >= 0.12)
      .map(row => row.script));
    if (!profile.scripts.some(row => row.mass >= 0.12 && targetScripts.has(row.script))) return false;
    const profileOwners = new Set((profile.discoveredNames ?? [])
      .filter(row => row.confidence > 0)
      .map(row => normalizePriorKey(row.surface))
      .filter(Boolean));
    const targetOwners = new Set((cluster.discoveredNames ?? [])
      .filter(row => row.confidence > 0)
      .map(row => normalizePriorKey(row.surface))
      .filter(Boolean));
    if (!profileOwners.size || !targetOwners.size) return false;
    return [...profileOwners].some(owner => targetOwners.has(owner));
  }


  async function surfaceLanguageProfilesCached(
    residentOnly = false
  ): Promise<{ profiles: LanguageProfile[]; clusters: LanguageProfileCluster[] }> {
    const now = clock.now();
    if (surfaceProfileCache && (residentOnly || now - surfaceProfileCache.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return { profiles: surfaceProfileCache.value, clusters: surfaceProfileCache.clusters };
    }
    if (residentOnly) return { profiles: [], clusters: [] };
    const [persistedProfiles, requestControlPatterns] = await Promise.all([
      deps.storage.model.listLanguageProfiles({
        limit: surfaceLanguageProfileLimit,
        referencedByLanguageMemory: true
      }),
      deps.storage.languageMemory.listLanguagePatterns({ sourceSystem: "corrections", limit: 2048 })
    ]);
    const requestControlProfileIds = new Set(
      latestRequestRequirementPatterns(requestControlPatterns).map(pattern => pattern.profileId)
    );
    const profiles = persistedProfiles
      .filter(profile => !requestControlProfileIds.has(profile.id))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const clusters = buildLanguageProfileClusters(profiles);
    surfaceProfileCache = { loadedAt: now, value: profiles, clusters };
    return { profiles, clusters };
  }


  async function sourceOwnedLanguageProfilesCached(
    aliases: readonly string[],
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<{ profiles: LanguageProfile[]; clusters: LanguageProfileCluster[] }> {
    const aliasKeys = [...new Set(aliases.map(normalizeSourceLanguageAlias).filter(Boolean))].sort();
    if (!aliasKeys.length) return { profiles: [], clusters: [] };
    const cacheKey = aliasKeys.join("\u001f");
    const now = clock.now();
    const cached = sourceOwnedAliasProfileCache.get(cacheKey);
    if (cached && (cacheOptions.residentOnly || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return { profiles: cached.profiles, clusters: cached.clusters };
    }
    if (cacheOptions.residentOnly) {
      if (!surfaceProfileCache) return residentRuntimeNotWarm("surface-language-profiles");
      const requestedAliases = new Set(aliasKeys);
      const profiles = surfaceProfileCache.value
        .filter(profile => (profile.discoveredNames ?? []).some(name => (
          requestedAliases.has(normalizeSourceLanguageAlias(name.surface))
          && (
            name.evidenceRefs.length > 0
            || (name.sourceVersionRefs ?? []).some(sourceVersionId =>
              String(sourceVersionId) === String(profile.sourceVersionId)
            )
          )
        )))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const clusters = buildLanguageProfileClusters(profiles);
      sourceOwnedAliasProfileCache.set(cacheKey, {
        loadedAt: surfaceProfileCache.loadedAt,
        profiles,
        clusters
      });
      return { profiles, clusters };
    }
    const profiles = (await deps.storage.model.listLanguageProfiles({
      limit: surfaceLanguageProfileLimit,
      referencedByLanguageMemory: true,
      sourceDerivedAliases: aliasKeys
    })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const clusters = buildLanguageProfileClusters(profiles);
    sourceOwnedAliasProfileCache.set(cacheKey, { loadedAt: now, profiles, clusters });
    return { profiles, clusters };
  }


  async function sourceOwnedLanguageClusterForAlias(
    alias: string,
    surface: string,
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<LanguageProfileCluster | undefined> {
    const { clusters } = await sourceOwnedLanguageProfilesCached([alias], cacheOptions);
    if (clusters.length === 1) return clusters[0];
    // A named source alias with no surface to judge by still resolves: the alias's own best-supported cluster.
    if (!surface.trim()) return selectDominantLanguageProfileCluster(clusters);
    return selectLanguageProfileClusterForSurface(clusters, surface)?.cluster
      ?? selectDominantLanguageProfileCluster(clusters);
  }


  async function sourceOwnedLanguageClustersForWarmup(): Promise<LanguageProfileCluster[]> {
    const { profiles } = await surfaceLanguageProfilesCached();
    const sourceOwnedProfiles = profiles.filter(profile =>
      (profile.discoveredNames ?? []).some(name =>
        (name.sourceVersionRefs ?? []).some(sourceVersionId =>
          String(sourceVersionId) === String(profile.sourceVersionId)
        )
      )
    );
    return buildLanguageProfileClusters(sourceOwnedProfiles);
  }


  /**
   * The language profiles the admitted evidence itself owns.
   *
   * Every other profile path here starts from the bounded global window -- listLanguageProfiles({ limit }) -- and asks
   * whether the thing it wants happens to be inside it. For evidence that is the wrong question: the answer is being
   * realized FROM these documents, so their profiles are named, not hoped for. Measured on the live corpus: 22,502
   * profiles behind a window that admits a fraction, so most turns matched no cluster, and no cluster is the condition
   * under which hydrateSurfaceLanguageMemory returns an explicitly empty state -- 226,992 learned units in storage and
   * models=0 patterns=0 units=0 at the mouth.
   */
  async function evidenceOwnedLanguageProfilesCached(
    sourceVersionIds: readonly SourceVersionId[],
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<{ profiles: LanguageProfile[]; clusters: LanguageProfileCluster[] }> {
    const byKey = new Map<string, SourceVersionId>();
    for (const sourceVersionId of sourceVersionIds) {
      const key = String(sourceVersionId);
      if (key) byKey.set(key, sourceVersionId);
    }
    const versionKeys = [...byKey.keys()].sort();
    if (!versionKeys.length) return { profiles: [], clusters: [] };
    const cacheKey = versionKeys.join(UNIT_SEPARATOR);
    const now = clock.now();
    const cached = evidenceOwnedProfileCache.get(cacheKey);
    if (cached && (cacheOptions.residentOnly || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return { profiles: cached.profiles, clusters: cached.clusters };
    }
    if (cacheOptions.residentOnly) {
      // Resident answers only from what the global window already holds, which is exactly the population that fails
      // to cover the evidence. It is still worth asking -- a warm cache costs nothing -- but a miss is not an error
      // here the way it is for a warmed cluster: the durable path below is the one that resolves these.
      if (!surfaceProfileCache) return { profiles: [], clusters: [] };
      const requested = new Set(versionKeys);
      const profiles = surfaceProfileCache.value
        .filter(profile => requested.has(String(profile.sourceVersionId)))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return { profiles, clusters: buildLanguageProfileClusters(profiles) };
    }
    const profiles = (await deps.storage.model.listLanguageProfiles({
      limit: surfaceLanguageProfileLimit,
      referencedByLanguageMemory: true,
      sourceVersionIds: versionKeys.map(key => byKey.get(key)!)
    })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const clusters = buildLanguageProfileClusters(profiles);
    boundedCacheSet(evidenceOwnedProfileCache, cacheKey, { loadedAt: now, profiles, clusters }, surfaceCandidateProfileCacheMaxEntries);
    return { profiles, clusters };
  }


  /**
   * The cluster the admitted evidence speaks in, resolved from its own profiles rather than from the global window.
   *
   * selectLanguageProfileClusterForSourceVersions abstains on a tie because over the global population a tie means the
   * source versions are spread across unrelated clusters. Here every profile in every cluster is already owned by this
   * turn's evidence, so a tie is not ambiguity about whose language this is -- it is one corpus that clustered into
   * more than one profile group, and the surface picks among them.
   */
  async function evidenceOwnedLanguageClusterCached(
    sourceVersionIds: readonly SourceVersionId[],
    surface: string,
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<LanguageProfileCluster | undefined> {
    const { clusters } = await evidenceOwnedLanguageProfilesCached(sourceVersionIds, cacheOptions);
    if (clusters.length <= 1) return clusters[0];
    if (!surface.trim()) return selectDominantLanguageProfileCluster(clusters);
    return selectLanguageProfileClusterForSurface(clusters, surface)?.cluster
      ?? selectDominantLanguageProfileCluster(clusters);
  }


  /**
   * Which learned cluster this surface speaks in.
   *
   * Every exit used to be `selectLanguageProfileClusterForSurface(...)?.cluster` with nothing after it, so a surface
   * that resembled no cluster resolved to no cluster -- and no cluster is the condition under which
   * hydrateSurfaceLanguageMemory returns an explicitly empty state. "We could not tell which learned language to use"
   * therefore behaved exactly like "there is no learned language": measured on the live brain, ordinary turns realized
   * with models=0 patterns=0 units=0 against 226,992 stored units. sourceOwnedLanguageClusterForAlias never had this
   * hole -- it has always ended `...ForSurface(...) ?? selectDominantLanguageProfileCluster(...)`, so a named source
   * fell back to its own language while an ordinary question fell back to nothing. Same ending here: surface matching
   * decides WHICH learned cluster speaks, not WHETHER any of it does.
   */
  /**
   * Which learned language this turn speaks. Total whenever any learned language exists.
   *
   * Two different questions were being answered by one function. "Does this surface distinctively belong to cluster
   * X?" is a discrimination and may legitimately abstain -- selectLanguageProfileClusterForSurface returns undefined
   * when the top two clusters score within MIN_SURFACE_SELECTION_MARGIN of each other, which is the honest answer to
   * that question. "Which learned language should this turn speak?" cannot abstain: no cluster is the condition under
   * which hydrateSurfaceLanguageMemory returns an explicitly empty state, so an undecidable "which" became "none" and
   * the mouth realized with models=0 patterns=0 units=0 against 226,992 stored units. The discrimination is an input
   * here, not the answer; when it abstains the answer is the argmax it already ranked, which is only undefined when
   * there is genuinely no learned language at all.
   */
  function languageForSurface(
    clusters: readonly LanguageProfileCluster[],
    surface: string
  ): LanguageProfileCluster | undefined {
    return selectLanguageProfileClusterForSurface(clusters, surface)?.cluster
      ?? selectLearnedLanguageProfileCluster(clusters);
  }


  async function surfaceLanguageClusterCached(surface: string, residentOnly = false): Promise<LanguageProfileCluster | undefined> {
    if (!surface.trim()) return undefined;
    const surfaceKey = hasher.digestHex(surface.normalize("NFC"));
    const cached = surfaceCandidateProfileCache.get(surfaceKey);
    const now = clock.now();
    // Whole-memory cluster set answers most surfaces without a per-request query, and is also what makes the answer
    // stable: the argmax of a per-surface trigram subset is a DIFFERENT cluster for every distinct question, so each
    // would pay its own cold hydration and warmup could not have hydrated it in advance.
    const global = await surfaceLanguageProfilesCached(residentOnly);
    if (cached && (residentOnly || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return selectLanguageProfileClusterForSurface(cached.clusters, surface)?.cluster
        ?? languageForSurface(global.clusters, surface);
    }
    const globalSelected = selectLanguageProfileClusterForSurface(global.clusters, surface)?.cluster;
    if (globalSelected) return globalSelected;
    if (residentOnly) return languageForSurface(global.clusters, surface);
    // Global under its cap holds every memory-referenced profile; a
    // trigram-filtered subset of an already-scanned set cannot match more.
    // Measured: this per-surface query cost 2.7s/turn to return nothing.
    if (global.profiles.length && global.profiles.length < surfaceLanguageProfileLimit) {
      return languageForSurface(global.clusters, surface);
    }
    // Widening past the global cap is the one thing an abstaining discrimination legitimately triggers: a surface
    // whose language lives outside the bounded window is exactly what it cannot decide about.
    const profiles = await deps.storage.model.listLanguageProfiles({
      limit: surfaceLanguageProfileLimit,
      referencedByLanguageMemory: true,
      surfaceNgrams: languageSurfaceTrigrams(surface)
    });
    const clusters = buildLanguageProfileClusters(profiles);
    boundedCacheSet(surfaceCandidateProfileCache, surfaceKey, { loadedAt: now, profiles, clusters }, surfaceCandidateProfileCacheMaxEntries);
    return selectLanguageProfileClusterForSurface(clusters, surface)?.cluster
      ?? languageForSurface(global.clusters, surface);
  }


  async function requestSemanticFrames(
    surface: string,
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<SemanticFrameRecord[]> {
    const normalizedSurface = normalizePriorKey(surface);
    if (!normalizedSurface) return [];
    const cachedFrames = sourceAnchorSemanticFramesCached(cacheOptions);
    const frames = (cacheOptions.residentOnly
      ? await cachedFrames
      : await cachedFrames.catch(() => []))
      .map(row => row.frame);
    return uniqueRecordsById(frames.filter(frame => {
      const frameSurface = kernelString(jsonRecord(frame.frameJson).surface);
      return frameSurface ? normalizePriorKey(frameSurface) === normalizedSurface : false;
    }), 128);
  }


  async function sourceAnchorSemanticFramesCached(
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<Array<{ frame: SemanticFrameRecord; surface: string; surfaceUnits: string[] }>> {
    const now = clock.now();
    if (sourceAnchorSemanticFrameCache
      && (cacheOptions.residentOnly
        || now - sourceAnchorSemanticFrameCache.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return sourceAnchorSemanticFrameCache.value;
    }
    if (cacheOptions.residentOnly) return residentRuntimeNotWarm("semantic-frames");
    const frames = await deps.storage.languageMemory.listSemanticFrames({ limit: 2048 });
    // Splitting every frame's surface into units cost seconds on a corpus of thousands of frames, and a request
    // only ever looks at the handful its anchors could match. The surface is kept; the units are derived on the
    // first read and remembered, so the same value is served either way.
    const value = frames.map(frame => {
      const record = jsonRecord(frame.frameJson);
      const surface = sourceTextSurface(kernelString(record.preview) ?? kernelString(record.text) ?? "", 6000);
      let units: string[] | undefined;
      return {
        frame,
        surface,
        get surfaceUnits(): string[] {
          units ??= surface ? splitPriorUnits(normalizePriorKey(surface)).filter(Boolean) : [];
          return units;
        }
      };
    });
    sourceAnchorSemanticFrameCache = { loadedAt: now, value };
    return value;
  }

  return {
    languageMemorySummary,
    hydrateSurfaceLanguageMemoryCached,
    residentSurfaceLanguageMemory,
    surfaceLanguageProfilesCached,
    sourceOwnedLanguageProfilesCached,
    sourceOwnedLanguageClusterForAlias,
    sourceOwnedLanguageClustersForWarmup,
    evidenceOwnedLanguageProfilesCached,
    evidenceOwnedLanguageClusterCached,
    surfaceLanguageClusterCached,
    requestSemanticFrames,
    sourceAnchorSemanticFramesCached,
    uniqueRecordsById,
    /**
     * Resident occupancy of the caches this module owns. Exists because
     * three separate attempts at bounding surfaceLanguageMemoryCache all
     * "looked right" while the server kept OOMing post-warmup -- without
     * a way to read the bound's actual effect, each fix was a guess. Any
     * future memory regression should be checked here first: if these
     * numbers are small while heapUsed is large, the memory is NOT in
     * this module and the search belongs elsewhere.
     */
    cacheOccupancy() {
      let languageMemoryEstimatedBytes = 0;
      for (const entry of surfaceLanguageMemoryCache.values()) languageMemoryEstimatedBytes += entry.approxEstimatedBytes;
      return {
        languageMemoryEntries: surfaceLanguageMemoryCache.size,
        languageMemoryEstimatedBytes,
        candidateProfileEntries: surfaceCandidateProfileCache.size,
        aliasProfileEntries: sourceOwnedAliasProfileCache.size,
        evidenceProfileEntries: evidenceOwnedProfileCache.size,
        surfaceProfiles: surfaceProfileCache?.value.length ?? 0,
        sourceAnchorFrames: sourceAnchorSemanticFrameCache?.value.length ?? 0,
        // Hit rates for the two memos that sit on the hottest paths in the kernel. Both accessors existed to be
        // read and nothing read them, so a memo that had stopped hitting looked exactly like one that never ran.
        featureSetMemo: featureSetMemoStats(),
        tidySurfaceTextMemo: tidySurfaceTextMemoStats()
      };
    },
    invalidate() {
      surfaceLanguageMemoryCache.clear();
      sourceOwnedAliasProfileCache.clear();
      surfaceCandidateProfileCache.clear();
      evidenceOwnedProfileCache.clear();
      surfaceProfileCache = undefined;
      sourceAnchorSemanticFrameCache = undefined;
    }
  };
}
