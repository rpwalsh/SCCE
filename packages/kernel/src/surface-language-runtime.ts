// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { estimateRetainedProgramBytes } from "./retained-program-size.js";
import { traceEvent } from "./debug/trace.js";
import { canonicalDigestHex, canonicalJsonByteLength } from "./canonical-json-digest.js";
import { deriveClosedClassWords } from "./closed-class-words.js";
import { conversationalConstructionBinding, requestConstructionCandidate, requestSeedLanguagePattern, requestSeedSemanticFrame, sourceConstructionCandidate } from "./request-language-hydration.js";
import { conversationalActBindingId } from "./conversational-act-binding.js";
import { DIALOGUE_ACT_IDS, type DialogueActId } from "./dialogue-pragmatics.js";
import { CORPUS_SOURCE_SYSTEM_IDS, corpusSourceAlias, createCorpusRegistry, languageMemoryHydrationPlan, requestLanguageHydrationPlan, type CorpusRoleId } from "./corpus-registry.js";
import { CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, isCreativeEventCompatibilityPattern, creativeRequestSourcePrerequisites,
  compileCreativeRequestFrameFromCompatibilityModels } from "./creative-event-compatibility.js";
import { jsonRecord, kernelString, normalizePriorKey, splitPriorUnits } from "./kernel-answer-primitives.js";
import { featureSetMemoStats } from "./primitives.js";
import { tidySurfaceTextMemoStats } from "./surface-linguistics.js";
import { hydrateLanguageConstructionPatterns, isLanguageConstructionPattern, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type DurableLanguageConstructionBundle } from "./language-construction-memory.js";
import { cloneLanguageMemoryRuntimeState, createLanguageMemoryRuntime, markLanguageMemoryStateUnscoped, onLanguageMemoryConstructionHydrated, peekLanguageMemoryConstructionState, scopeLanguageMemoryStateToCluster, scopeLanguageMemoryStateToLanguage } from "./language-memory-runtime.js";
import { languageIdentityProfileIdsForArtifacts, type LanguageResolver } from "./language-identity-runtime.js";
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
import { primeNumericTokenCounts } from "./numeric-token-statistics.js";
import { createClock, createHasher, sourceTextSurface, toJsonValue } from "./primitives.js";
import { isRequestRequirementPattern, REQUEST_REQUIREMENT_PATTERN_SCHEMA } from "./request-requirement-learning.js";
import type { LanguageContinuationPopulation, LanguagePatternRecord, NgramObservation, ScceKernelDeps, SemanticFrameRecord, TargetProfilePatternRecord } from "./storage.js";
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
// Portable fallback ceiling. Host adapters must also supply their runtime-specific resource allowance;
// a deployment with a smaller heap must never inherit a cache budget sized for a larger process.
const SURFACE_LANGUAGE_MEMORY_CACHE_MAX_ESTIMATED_BYTES = 5 * 1024 * 1024 * 1024;

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
  state?: Partial<LanguageMemoryRuntimeState>;
  retainedProgramState?: LanguageMemoryRuntimeState;
}, allowance: number): number {
  let jsonBytes = 0;
  for (const records of [value.models ?? [], value.units ?? [], value.observations ?? [], value.patterns ?? [],
    value.semanticFrames ?? [], value.constructionEvidence ?? [],
    value.state?.continuationPopulation ? [value.state.continuationPopulation.continuationCounts] : []]) {
    for (const record of records) {
      try { jsonBytes += canonicalJsonByteLength(record, allowance - jsonBytes); }
      catch { return allowance + 1; }
      if (jsonBytes > allowance) return jsonBytes;
    }
  }
  // rescopeForSurface captures the unscoped state as well as returning a scoped state. Both remain live.
  // Visit their program roots together so aliases between scopes and between compiled programs cost once.
  const programRoots = [value.state, value.retainedProgramState].flatMap(state => state ? [
    ...peekLanguageMemoryConstructionState(state).roots, state.importedReversibleConstructions,
    state.importedPairedAntiUnifiedConstructions, state.optionalNullRealizationModels,
    state.joinPrograms, state.structuralDeltas,
    state.requestRequirementHydration
  ] : []);
  return jsonBytes + estimateRetainedProgramBytes(programRoots, allowance - jsonBytes);
}

function boundedSurfaceLanguageMemoryCacheSet<K, V extends { approxEstimatedBytes: number }>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  maxBytes: number
): void {
  map.delete(key);
  if (value.approxEstimatedBytes > maxBytes) return;
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

// Opt-in like SCCE_TRACE_GC below: sizing the payload restringifies every hydrated row, seconds of event loop for a trace number.
const approxJsonMb = (rows: readonly unknown[]): number => {
  if (process.env.SCCE_TRACE_HYDRATION_BYTES !== "1") return -1;
  if (!(globalThis as { __sccTrace?: unknown }).__sccTrace) return 0;
  let bytes = 0;
  for (const row of rows) { try { bytes += JSON.stringify(row).length; } catch { bytes += 512 * 1024 * 1024; } }
  return Math.round(bytes / 1048576);
};
const hydrateHeapTrace = (stage: string, counts: Record<string, number>) =>
  traceEvent((globalThis as { __sccTrace?: Parameters<typeof traceEvent>[0] }).__sccTrace, { stage, label: "kernel.language.hydrate", counts: { ...counts, heapMb: (process.env.SCCE_TRACE_GC === "1" && typeof (globalThis as { gc?: () => void }).gc === "function" ? ((globalThis as { gc?: () => void }).gc!(), 0) : 0) + Math.round(process.memoryUsage().heapUsed / 1048576) } });

export function createSurfaceLanguageRuntime(options: {
  deps: Pick<ScceKernelDeps, "storage" | "corpusRegistry" | "surfaceLanguageMemoryCacheMaxEstimatedBytes">;
  languageMemoryRuntime: ReturnType<typeof createLanguageMemoryRuntime>;
  clock: ReturnType<typeof createClock>;
  hasher: ReturnType<typeof createHasher>;
  cacheMs: number;
  profileLimit: number;
  /** Resolves artifact languages once identities are loaded; absent until then, when cluster scoping applies. */
  languageResolver?: (profileIds: readonly string[]) => LanguageResolver | undefined | Promise<LanguageResolver | undefined>;
  onDurableRevision?: () => Promise<unknown>;
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
  const requestedCacheBytes = options.surfaceLanguageMemoryCacheMaxEstimatedBytes ?? SURFACE_LANGUAGE_MEMORY_CACHE_MAX_ESTIMATED_BYTES;
  const hostCacheBytes = deps.surfaceLanguageMemoryCacheMaxEstimatedBytes ?? SURFACE_LANGUAGE_MEMORY_CACHE_MAX_ESTIMATED_BYTES;
  if (![requestedCacheBytes, hostCacheBytes].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("surface language cache allowance must be a finite nonnegative byte count");
  }
  const surfaceLanguageMemoryCacheMaxEstimatedBytes = Math.min(requestedCacheBytes, hostCacheBytes);

  const corpusRegistry = createCorpusRegistry(deps.corpusRegistry ?? []);

  const surfaceLanguageMemoryCache = new Map<string, { limit: number; loadedAt: number; value: Awaited<ReturnType<typeof hydrateSurfaceLanguageMemory>>; approxEstimatedBytes: number }>();
  /**
   * One durable hydration per key at a time.
   *
   * A hydration of an unwarmed language takes 60-80s and a turn arrives every 20-30s, so each turn found an empty
   * cache and started its own copy of the same work: measured, 38 lookups and 0 hits across six coding turns, none
   * of which ever received a model. The turn's stage budget then abandons its copy at five seconds and proceeds
   * with nothing, so a cold turn is not merely slower than a warm one, it is less able -- with no models it cannot
   * derive a closed class, so it cannot tell a relation from scaffolding. Sharing the work makes the first turn
   * pay once and every later turn hit.
   */
  const surfaceLanguageMemoryInFlight = new Map<string, Promise<Awaited<ReturnType<typeof hydrateSurfaceLanguageMemory>>>>();
  // Calls that arrive after a visible response may schedule the same lazy
  // enrichment before its timer gets a chance to install the in-flight load.
  // Keep that scheduling edge single-flight too; the durable map below still
  // owns the actual hydration identity and cache population.
  const deferredLanguageWarmups = new Set<string>();
  // Language scoping is independent of the request surface. Keep the compiled
  // result by the durable language/model identity so a cache hit from another
  // hydration object does not rebuild every model and construction program.
  const languageScopeCache = new Map<string, WeakRef<LanguageMemoryRuntimeState>>();
  let hydrationTail = Promise.resolve();
  let activeHydrations = 0;
  let waitingHydrations = 0;
  function admitHydration<T>(run: () => Promise<T>): Promise<T> {
    const previous = hydrationTail;
    let release!: () => void;
    hydrationTail = new Promise<void>(resolve => { release = resolve; });
    waitingHydrations++;
    return (async () => {
      await previous;
      waitingHydrations--;
      activeHydrations++;
      try { return await run(); } finally { activeHydrations--; release(); }
    })();
  }
  const continuationPopulationCache = new Map<string, { loadedAt: number; value: WeakRef<LanguageContinuationPopulation> }>();
  const sourceOwnedConstructionCache = new Map<string, { loadedAt: number; bundles: WeakRef<DurableLanguageConstructionBundle[]> }>();
  const creativeSourceCache = new Map<string, { loadedAt: number; state: WeakRef<LanguageMemoryRuntimeState>; profile: LanguageProfile; patterns: WeakRef<LanguagePatternRecord[]> }>();
  const creativeSourceInFlight = new Map<string, Promise<{ state: LanguageMemoryRuntimeState; profile: LanguageProfile; patterns: LanguagePatternRecord[] } | undefined>>();
  const continuationPopulationInFlight = new Map<string, Promise<LanguageContinuationPopulation | undefined>>();
  let languageMemoryGeneration = 0;
  let requestControlPatternCache: { loadedAt: number; value: LanguagePatternRecord[] } | undefined;
  let requestControlPatternInFlight: Promise<LanguagePatternRecord[]> | undefined;
  let durableLanguageRevision: string | undefined;
  let revisionReadInFlight: Promise<void> | undefined;

  async function synchronizeWithStorage(): Promise<void> {
    if (!deps.storage.languageMemory.readRevision) return;
    if (revisionReadInFlight) return revisionReadInFlight;
    const pending = (async () => {
      const revision = await deps.storage.languageMemory.readRevision!();
      if (typeof revision !== "string" || !revision) throw new Error("language-memory revision must be a nonempty opaque string");
      const previous = durableLanguageRevision;
      if (previous !== revision) await options.onDurableRevision?.();
      if (previous !== undefined && previous !== revision) invalidateLanguageMemory();
      durableLanguageRevision = revision;
      if (previous !== revision) traceEvent((globalThis as { __sccTrace?: Parameters<typeof traceEvent>[0] }).__sccTrace, {
        stage: "language.cache.revision", label: "kernel.language.hydrate", support: { previous: previous ?? null, revision, invalidated: previous !== undefined }
      });
    })();
    revisionReadInFlight = pending;
    try { await pending; }
    finally { if (revisionReadInFlight === pending) revisionReadInFlight = undefined; }
  }

  async function requestControlPatternsCached(): Promise<LanguagePatternRecord[]> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const now = clock.now();
    if (requestControlPatternCache && now - requestControlPatternCache.loadedAt < surfaceLanguageMemoryCacheMs) return requestControlPatternCache.value;
    if (requestControlPatternInFlight) return requestControlPatternInFlight;
    const generation = languageMemoryGeneration;
    // Historical request controls use opaque corpus keys; canonical speech models use registry labels.
    const sourceSystems = [...new Set([CORPUS_SOURCE_SYSTEM_IDS.corrections, CORPUS_SOURCE_SYSTEM_IDS.dialogue]
      .flatMap(sourceSystem => [sourceSystem, corpusSourceAlias(sourceSystem)]))];
    const pending = Promise.all(sourceSystems.map(sourceSystem =>
      deps.storage.languageMemory.listLanguagePatterns({
        sourceSystem,
        patternSchemas: [REQUEST_REQUIREMENT_PATTERN_SCHEMA, CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA],
        limit: 2048
      }))).then(groups => {
      const records = groups.flat();
      const value = uniqueRecordsById(records, records.length);
      if (generation === languageMemoryGeneration) requestControlPatternCache = { loadedAt: clock.now(), value };
      return value;
    });
    requestControlPatternInFlight = pending;
    try { return await pending; }
    finally { if (requestControlPatternInFlight === pending) requestControlPatternInFlight = undefined; }
  }

  async function continuationPopulationCached(languageId: string): Promise<LanguageContinuationPopulation | undefined> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    if (!deps.storage.languageMemory.continuationPopulation) return undefined;
    const cached = continuationPopulationCache.get(languageId);
    const value = cached?.value.deref();
    if (value && clock.now() - cached!.loadedAt < surfaceLanguageMemoryCacheMs) return value;
    const existing = continuationPopulationInFlight.get(languageId);
    if (existing) return existing;
    const generation = languageMemoryGeneration;
    const started = Date.now();
    let result = "unmeasured";
    const pending = (async () => {
      try {
        const population = await deps.storage.languageMemory.continuationPopulation!({ languageId });
        if (generation !== languageMemoryGeneration) return undefined;
        if (population && population.languageId === languageId && population.modelCount > 0) {
          // Hydrated states own the memory; this shared prior cache must not keep evicted populations alive.
          boundedCacheSet(continuationPopulationCache, languageId, { loadedAt: clock.now(), value: new WeakRef(population) }, surfaceLanguageMemoryCacheMaxEntries);
          result = "measured";
          return population;
        }
        return undefined;
      } catch {
        result = "failed";
        return undefined;
      } finally {
        traceEvent((globalThis as { __sccTrace?: Parameters<typeof traceEvent>[0] }).__sccTrace, {
          stage: "language.hydrate.continuation_population", label: "kernel.language.hydrate",
          durationMs: Date.now() - started, support: { languageId, result }
        });
      }
    })();
    continuationPopulationInFlight.set(languageId, pending);
    try { return await pending; } finally {
      if (continuationPopulationInFlight.get(languageId) === pending) continuationPopulationInFlight.delete(languageId);
    }
  }

  let surfaceProfileCache: { loadedAt: number; value: LanguageProfile[]; clusters: LanguageProfileCluster[] } | undefined;
  // Creative and conversational surface selection can ask for the global
  // profile set from multiple stages before the first read is cached. Share
  // that durable read so a cold turn does not duplicate both queries.
  let surfaceProfileInFlight: Promise<{ profiles: LanguageProfile[]; clusters: LanguageProfileCluster[] }> | undefined;

  const sourceOwnedAliasProfileCache = new Map<string, {
    loadedAt: number;
    profiles: LanguageProfile[];
    clusters: LanguageProfileCluster[];
  }>();
  // Alias resolution is requested by several runtime stages during the same
  // turn. Keep the durable read single-flight so a cold alias cannot fan out
  // one identical profile query per stage.
  const sourceOwnedAliasProfileInFlight = new Map<string, Promise<{ profiles: LanguageProfile[]; clusters: LanguageProfileCluster[] }>>();
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

  const sourceAnchorSemanticFrameCache = new Map<string, {
    loadedAt: number;
    value: Array<{ frame: SemanticFrameRecord; surface: string; surfaceUnits: string[] }>;
  }>();
  const targetProfilePatternCache = new Map<string, { loadedAt: number; value: TargetProfilePatternRecord[] }>();
  const targetProfilePatternInFlight = new Map<string, Promise<TargetProfilePatternRecord[]>>();

  type ResidentOnlyOptions = {
    residentOnly?: boolean;
    /** Return a resident fallback immediately and warm durable state in the background. */
    deferDurable?: boolean;
    /** Scope the hydration to a learned language identity instead of to the cluster's document membership. */
    languageId?: string;
    /** Request interpretation consumes the canonical population statistics, not generative history indexes. */
    purpose?: "request_seed";
  };


  async function languageMemorySummary(limit = 36): Promise<JsonValue> {
    const models = await deps.storage.languageMemory.listNgramModels({ limit });
    const units = await deps.storage.languageMemory.listLanguageUnits({ limit: 2048 });
    const patterns = await deps.storage.languageMemory.listLanguagePatterns({ limit: 512 });
    const state = languageMemoryRuntime.hydrate({ models, observations: [], units, patterns });
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
    languageId?: string,
    generation = languageMemoryGeneration,
    purpose?: "request_seed"
  ) {
    const boundedLimit = Math.max(1, Math.min(256, Math.floor(limit)));
    // Request-seed uses typed natural-language roles below; the unsupervised surface cluster may be symbolic.
    const selectionCluster = purpose === "request_seed" && languageId ? undefined : cluster;
    const hydrateHeapStart = process.memoryUsage().heapUsed;
    const hydrateStartedAt = Date.now();
    const profileIds = preferredCorpusRoleId ? undefined : selectionCluster?.profileIds;
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
    // A role-scoped hydration may reach a population the unscoped fan-out must never sweep in.
    const corpusPlan = purpose === "request_seed"
      ? requestLanguageHydrationPlan(corpusRegistry, hydrationLimits, preferredCorpusRoleId ? "role-scoped" : "unscoped")
      : languageMemoryHydrationPlan(corpusRegistry, hydrationLimits, preferredCorpusRoleId ? "role-scoped" : "unscoped");
    const [active, requestControlPatterns, continuationPopulation] = await Promise.all([
      deps.storage.brainImports.active(),
      requestControlPatternsCached(),
      languageId ? continuationPopulationCached(languageId) : undefined
    ]);
    const learnedRequestControlPatterns = latestRequestRequirementPatterns(requestControlPatterns);
    const populationSeed = purpose === "request_seed" && continuationPopulation !== undefined
      && deriveClosedClassWords({ continuationPopulation }).size > 0;
    const requestControlCompatibilityPatterns = requestControlPatterns
      .filter(isCreativeEventCompatibilityPattern);
    if (!selectionCluster && !preferredCorpusRoleId && !languageId) {
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
        measuredHeapBytes: Math.max(0, process.memoryUsage().heapUsed - hydrateHeapStart),
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
    const [
      modelsBySource,
      unitsBySource,
      patternsBySource,
      semanticFramesBySource,
      persistedProfiles,
      segmentationPopulationModels
    ] = await Promise.all([
      (populationSeed ? Promise.resolve([]) : Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listNgramModels({ sourceSystem: item.sourceSystem, profileIds: item.profileIds, limit: Math.min(limit, item.limits.ngramModels), maxTotalJsonBytes: hydrationShare(hydrationByteBudgets.ngramModelJsonBytes, hydrationQueries.length) })))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listNgramModels", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listLanguageUnits({ profileIds: item.profileIds, sourceSystem: item.sourceSystem, limit: item.limits.languageUnits, maxTotalJsonBytes: hydrationShare(hydrationByteBudgets.languageUnitJsonBytes, hydrationQueries.length) }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listLanguageUnits", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listLanguagePatterns({ ...(purpose ? { view: purpose } : {}), profileIds: item.profileIds, sourceSystem: item.sourceSystem, languageId: item.profileIds ? undefined : languageId, limit: item.limits.languagePatterns, maxTotalJsonBytes: hydrationShare(hydrationByteBudgets.languagePatternJsonBytes, hydrationQueries.length) }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listLanguagePatterns", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listSemanticFrames({ ...(purpose ? { view: purpose } : {}), profileIds: item.profileIds, sourceSystem: item.sourceSystem, limit: item.limits.semanticFrames }))).then(rows => { hydrateHeapTrace("language.hydrate.part", { elapsedMs: Date.now() - hydrateStartedAt, part: "listSemanticFrames", rows: rows.flat().length } as unknown as Record<string, number>); return rows; }),
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
    const observations: NgramObservation[] = [];
    const units = uniqueRecordsById(unitsBySource.flat(), Math.max(512, boundedLimit * 128));
    const patterns = uniqueRecordsById(patternsBySource.flat(), Math.max(256, boundedLimit * 64))
      .map(pattern => purpose === "request_seed" ? requestSeedLanguagePattern(pattern) : pattern);
    const queriedSemanticFrames = uniqueRecordsById(semanticFramesBySource.flat(), Math.max(512, boundedLimit * 96));
    const semanticFrames = purpose === "request_seed" ? queriedSemanticFrames.flatMap(frame => requestSeedSemanticFrame(frame) ?? []) : queriedSemanticFrames;
    const constructionEvidenceIds = purpose === "request_seed" ? [] : [...new Set(patterns
      .filter(isLanguageConstructionPattern)
      .flatMap(pattern => pattern.evidenceIds.map(String)))]
      .sort()
      .slice(0, 4096)
      .map(id => id as EvidenceSpan["id"]);
    const constructionEvidence = constructionEvidenceIds.length
      ? await deps.storage.evidence.getEvidenceBatch(constructionEvidenceIds)
      : [];
    hydrateHeapTrace("language.hydrate.loaded", { elapsedMs: Date.now() - hydrateStartedAt, modelsJsonMb: approxJsonMb(models), observationsJsonMb: approxJsonMb(observations), unitsJsonMb: approxJsonMb(units), patternsJsonMb: approxJsonMb(patterns), framesJsonMb: approxJsonMb(semanticFrames), constructionEvidenceJsonMb: approxJsonMb(constructionEvidence), models: models.length, observations: observations.length, units: units.length, patterns: patterns.length, semanticFrames: semanticFrames.length, constructionEvidence: constructionEvidence.length, queries: hydrationQueries.length });
    const hydrationInput = {
      importRunId: active.activeImportRunIds[0],
      models,
      observations,
      units,
      patterns: uniqueRecordsById([
        ...patterns.filter(pattern => purpose !== "request_seed" || !isLanguageConstructionPattern(pattern)),
        ...(purpose === "request_seed" ? [] : requestControlCompatibilityPatterns)
      ], Math.max(256, boundedLimit * 64)),
      semanticFrames,
      constructionEvidence
    };
    const hydratedBase = languageMemoryRuntime.hydrateFromImportedBrain(hydrationInput);
    const hydrated = continuationPopulation ? cloneLanguageMemoryRuntimeState(hydratedBase, { continuationPopulation }) : hydratedBase;
    if (purpose !== "request_seed") void hydrated.importedConstructionBundles;
    const constructionPeek = peekLanguageMemoryConstructionState(hydrated);
    hydrateHeapTrace("language.hydrate.built", { elapsedMs: Date.now() - hydrateStartedAt, importedUnits: hydrated.importedUnits?.length ?? 0, importedPatterns: hydrated.importedPatterns?.length ?? 0, constructionBundles: constructionPeek.bundles?.length ?? -1, rejectedBundles: constructionPeek.rejected?.length ?? -1 });
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
    const assignmentProfileIds = languageIdentityProfileIdsForArtifacts({ ...hydrationInput, profiles: roleProfiles,
      patterns: [...patterns, ...hydrationInput.patterns, ...learnedRequestControlPatterns] });
    const resolver = languageId ? await options.languageResolver?.(assignmentProfileIds) : undefined;
    // The ONLY thing the request surface influences in this whole function:
    // which role cluster scopes the already-hydrated payload. Everything
    // above -- the 64MB model read, unit/pattern/frame loads, trie build --
    // is surface-independent, so this tail is factored out and returned so
    // a cached hydration can be re-scoped for a new request in milliseconds
    // instead of re-hydrated in minutes.
    // A language scope does not depend on the surface, and scoping recompiles every retained model (13s per turn on a
    // cache hit, measured); it is computed once per hydration and only the surface profile is chosen per request.
    let languageScopedState: LanguageMemoryRuntimeState | undefined;
    const languageScopeKey = languageId
      ? `${languageId}${UNIT_SEPARATOR}${preferredCorpusRoleId ?? "corpus-role:any"}${UNIT_SEPARATOR}${purpose ?? "realization"}${UNIT_SEPARATOR}${canonicalDigestHex({
        generation,
        active,
        hydrationInput,
        continuationPopulation: continuationPopulation ?? null
      }, hasher)}`
      : undefined;
    const scopeForSurface = (surface: string) => {
      // A language identity scopes by what each artifact is, not by which document it came from.
      if (languageId && resolver) {
        languageScopedState ??= (languageScopeKey ? languageScopeCache.get(languageScopeKey)?.deref() : undefined)
          ?? scopeLanguageMemoryStateToLanguage(hydrated, languageId, resolver);
        if (languageScopeKey && generation === languageMemoryGeneration) boundedCacheSet(
          languageScopeCache, languageScopeKey, new WeakRef(languageScopedState), surfaceLanguageMemoryCacheMaxEntries);
        // cluster is the document/evidence-similarity cluster this hydration was originally asked to scope to --
        // unrelated to languageId, and its members can belong to any identity at all (verified live: a factual
        // turn's cluster member ended up a profile trained almost entirely from this repo's own source files and
        // license headers, under a completely different learned identity than the one languageScopedState was
        // just built from, while the identity's own real prose profiles -- one alone carrying 2,815 semantic-role
        // patterns -- went unused). The surface profile has to come from the same identity-scoped population the
        // state itself was filtered to, or every downstream profile-identity comparison is comparing across
        // unrelated corpora by accident. Falls back to the old cluster-based pick only if scoping produced no
        // candidate profiles at all, rather than leaving surfaceProfile undefined.
        const languageScopedProfileIds = purpose === "request_seed" ? undefined : new Set(languageScopedState.scope.profileIds);
        const languageScopedProfiles = roleProfiles.filter(profile => {
          if (languageScopedProfileIds) return languageScopedProfileIds.has(profile.id);
          const owner = resolver.profile(profile.id);
          return owner === undefined || owner === languageId;
        });
        return {
          state: languageScopedState,
          surfaceProfile: (languageScopedProfiles.length
            ? selectLanguageProfileForSurface(languageScopedProfiles, surface) ?? languageScopedProfiles[0]
            : selectionCluster ? selectLanguageProfileForSurface(selectionCluster.members, surface) ?? selectionCluster.members[0] : undefined) as LanguageProfile | undefined
        };
      }
      const roleCluster = preferredCorpusRoleId
        ? corpusRoleLanguageCluster({
          roleId: preferredCorpusRoleId,
          target: selectionCluster,
          profiles: roleProfiles,
          surface
        })
        : undefined;
      const effectiveCluster = roleCluster ?? selectionCluster;
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
      retainedProgramState: hydrated,
      surfaceProfile: scoped.surfaceProfile,
      clusterMembers: (selectionCluster?.members ?? []) as LanguageProfile[],
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
    const latestByOwner = new Map<string, LanguagePatternRecord>();
    for (const pattern of requestPatterns) {
      const record = jsonRecord(pattern.patternJson);
      const owner = `${String(record.sourceSystem ?? "")}:${pattern.profileId}`;
      if (!latestByOwner.has(owner)) latestByOwner.set(owner, pattern);
    }
    const current = requestPatterns.filter(pattern => {
      const record = jsonRecord(pattern.patternJson);
      const owner = `${String(record.sourceSystem ?? "")}:${pattern.profileId}`;
      const latest = latestByOwner.get(owner)!;
      const latestSourceVersionId = kernelString(jsonRecord(latest.patternJson).sourceVersionId);
      return latestSourceVersionId
        ? kernelString(record.sourceVersionId) === latestSourceVersionId
        : pattern.updatedAt === latest.updatedAt;
    });
    return uniqueRecordsById(current, 2048);
  }


  /**
   * Whether a hydration is worth keeping.
   *
   * A cache entry that carries no models is not a cheaper way to reach the same answer -- it is a different,
   * worse answer, served to every later request that hits the same key. Measured 2026-09-12: one sealed cloze
   * question answered correctly as the first request of a process and returned a two-word fragment as the fifth,
   * because an early resident-only attempt stored an empty hydration and later turns were served it as a hit
   * (`runtime.seed.language {models: 0, patterns: 0}` behind `language.cache.lookup hit-language`). Storing only
   * hydrations that actually carry language keeps the cache answer-transparent: a hit and a miss differ in time,
   * never in what the turn can say.
   */
  function hydrationWorthCaching(value: { state?: { models?: readonly unknown[]; continuationPopulation?: { modelCount: number } } } | undefined): boolean {
    return (value?.state?.models?.length ?? 0) > 0 || (value?.state?.continuationPopulation?.modelCount ?? 0) > 0;
  }

  async function hydrateSurfaceLanguageMemoryScoped(
    limit = 36,
    cluster?: LanguageProfileCluster,
    unscopedReason = "no-language-cluster-selected",
    preferredCorpusRoleId?: CorpusRoleId,
    preferredSurface = "",
    hydrationOptions: ResidentOnlyOptions = {}
  ) {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const now = clock.now();
    const generation = languageMemoryGeneration;
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
      const languageKey = `${languageId}\u001flanguage\u001f${preferredCorpusRoleId ?? "corpus-role:any"}${hydrationOptions.purpose ? `\u001f${hydrationOptions.purpose}` : ""}`;
      const resident = surfaceLanguageMemoryCache.get(languageKey);
      if (resident && resident.limit >= limit && (hydrationOptions.residentOnly || now - resident.loadedAt < surfaceLanguageMemoryCacheMs)) {
        lookup("hit-language");
        return preferredSurface.trim() && resident.value.rescopeForSurface
          ? { ...resident.value, ...resident.value.rescopeForSurface(preferredSurface) }
          : resident.value;
      }
      lookup(hydrationOptions.residentOnly ? "miss-resident" : "miss-durable");
      if (hydrationOptions.residentOnly) return residentRuntimeNotWarm(`language-memory:${unscopedReason}`);
      let pending = surfaceLanguageMemoryInFlight.get(languageKey);
      if (!pending) {
        pending = admitHydration(() => hydrateSurfaceLanguageMemory(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface, languageId, generation, hydrationOptions.purpose))
          .then(hydrated => {
            if (generation === languageMemoryGeneration && hydrationWorthCaching(hydrated)) boundedSurfaceLanguageMemoryCacheSet(
              surfaceLanguageMemoryCache,
              languageKey,
              { limit, loadedAt: clock.now(), value: hydrated, approxEstimatedBytes: approximateHydrationEstimatedBytes(hydrated, surfaceLanguageMemoryCacheMaxEstimatedBytes) },
              surfaceLanguageMemoryCacheMaxEntries,
              surfaceLanguageMemoryCacheMaxEstimatedBytes
            );
            const reweigh = () => {
              const entry = surfaceLanguageMemoryCache.get(languageKey);
              if (generation !== languageMemoryGeneration || entry?.value !== hydrated) return;
              boundedSurfaceLanguageMemoryCacheSet(surfaceLanguageMemoryCache, languageKey,
                { ...entry, approxEstimatedBytes: approximateHydrationEstimatedBytes(hydrated, surfaceLanguageMemoryCacheMaxEstimatedBytes) },
                surfaceLanguageMemoryCacheMaxEntries, surfaceLanguageMemoryCacheMaxEstimatedBytes);
            };
            onLanguageMemoryConstructionHydrated(hydrated.state, reweigh);
            if (hydrated.retainedProgramState) onLanguageMemoryConstructionHydrated(hydrated.retainedProgramState, reweigh);
            return hydrated;
          });
        // Cleared only after the store above has run, so a turn arriving late still joins rather than restarting.
        void pending.catch(() => undefined).finally(() => {
          if (surfaceLanguageMemoryInFlight.get(languageKey) === pending) surfaceLanguageMemoryInFlight.delete(languageKey);
        });
        surfaceLanguageMemoryInFlight.set(languageKey, pending);
      }
      return await pending;
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
    const cacheKey = `${languageProfileClusterCacheKey(cluster)}\u001f${cluster ? "scoped" : unscopedReason}\u001f${preferredCorpusRoleId ?? "corpus-role:any"}${hydrationOptions.purpose ? `\u001f${hydrationOptions.purpose}` : ""}`;
    const cached = surfaceLanguageMemoryCache.get(cacheKey);
    if (cached
      && cached.limit >= limit
      && (hydrationOptions.residentOnly || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) {
      lookup("hit-exact");
      return preferredCorpusRoleId && preferredSurface.trim() && cached.value.rescopeForSurface
        ? { ...cached.value, ...cached.value.rescopeForSurface(preferredSurface) }
        : cached.value;
    }
    const superset = cluster && !preferredCorpusRoleId && !hydrationOptions.purpose ? residentSupersetLanguageMemory(cluster, preferredSurface) : undefined;
    if (superset) { lookup("hit-superset"); return superset; }
    lookup(hydrationOptions.residentOnly ? "miss-resident" : "miss-durable", {
      roleEntries: preferredCorpusRoleId ? [...surfaceLanguageMemoryCache.keys()].filter(key => key.endsWith(`\u001f${preferredCorpusRoleId}`)).length : 0,
      surfaceProfiles: surfaceProfileCache?.value.length ?? -1
    });
    if (hydrationOptions.residentOnly) {
      return residentRuntimeNotWarm(`language-memory:${unscopedReason}`);
    }
    if (hydrationOptions.deferDurable && (cluster || preferredCorpusRoleId || languageId)) {
      // The caller explicitly placed durable enrichment off the response path.
      // Schedule it through the same single-flight cache, then serve only a
      // resident compatible state if one exists. A miss remains a fast,
      // inspectable not-warmed result for the caller to handle.
      warmSurfaceLanguageMemory(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface, hydrationOptions);
      const languageResident = languageId
        ? surfaceLanguageMemoryCache.get(`${languageId}\u001flanguage\u001f${preferredCorpusRoleId ?? "corpus-role:any"}`)?.value
        : undefined;
      const resident = languageResident ?? residentSurfaceLanguageMemory(cluster, preferredCorpusRoleId);
      if (resident) {
        return preferredCorpusRoleId && preferredSurface.trim() && resident.rescopeForSurface
          ? { ...resident, ...resident.rescopeForSurface(preferredSurface) }
          : resident;
      }
      return residentRuntimeNotWarm(`language-memory:${unscopedReason}`);
    }
    // Cluster/role hydrations use the same single-flight map as language-id
    // hydrations. Without this, two turns selecting the same cluster while the
    // first durable read is in progress each fan out their own database work.
    // Hydration content is surface-independent; rescope each waiter after the
    // shared base finishes so concurrent surfaces do not borrow one another's
    // selected profile.
    let pending = surfaceLanguageMemoryInFlight.get(cacheKey);
    if (!pending) {
      pending = admitHydration(() => hydrateSurfaceLanguageMemory(limit, cluster, unscopedReason, preferredCorpusRoleId, "", undefined, generation, hydrationOptions.purpose));
      void pending.then(value => {
        // An explicit unscoped decision is reusable; missing data for a
        // selected language must remain retryable.
        const resolvedUnscoped = !cluster && !preferredCorpusRoleId && value.state.scope.mode === "unscoped";
        if (generation === languageMemoryGeneration && (resolvedUnscoped || hydrationWorthCaching(value))) boundedSurfaceLanguageMemoryCacheSet(
          surfaceLanguageMemoryCache,
          cacheKey,
          { limit, loadedAt: clock.now(), value, approxEstimatedBytes: approximateHydrationEstimatedBytes(value, surfaceLanguageMemoryCacheMaxEstimatedBytes) },
          surfaceLanguageMemoryCacheMaxEntries,
          surfaceLanguageMemoryCacheMaxEstimatedBytes
        );
      }, () => undefined).finally(() => {
        if (surfaceLanguageMemoryInFlight.get(cacheKey) === pending) surfaceLanguageMemoryInFlight.delete(cacheKey);
      });
      surfaceLanguageMemoryInFlight.set(cacheKey, pending);
    }
    const value = await pending;
    return preferredCorpusRoleId && preferredSurface.trim() && value.rescopeForSurface
      ? { ...value, ...value.rescopeForSurface(preferredSurface) }
      : value;
  }

  // Numeric token counts of the models that survived scoping, derived here rather than by the first turn to read them.
  const hydrateSurfaceLanguageMemoryCached = async (
    limit = 36,
    cluster?: LanguageProfileCluster,
    unscopedReason = "no-language-cluster-selected",
    preferredCorpusRoleId?: CorpusRoleId,
    preferredSurface = "",
    hydrationOptions: ResidentOnlyOptions = {}
  ) => {
    const value = await hydrateSurfaceLanguageMemoryScoped(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface, hydrationOptions);
    primeNumericTokenCounts(value.state.models);
    return value;
  };

  /**
   * Read durable dialogue-learned target-profile patterns through the same
   * runtime seam used by surface selection. These records are written by the
   * dialogue learner but were previously only observable through storage,
   * making the learned preference write-only for later turns.
   */
  async function targetProfilePatternsCached(
    targetProfileId?: string,
    patternFamilyId?: string,
    residentOnly = false
  ): Promise<TargetProfilePatternRecord[]> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    if (!deps.storage.dialogueMemory?.listTargetProfilePatterns) return [];
    const cacheKey = `${targetProfileId ?? "*"}\u001f${patternFamilyId ?? "*"}`;
    const now = clock.now();
    const cached = targetProfilePatternCache.get(cacheKey);
    if (cached && (residentOnly || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) return cached.value;
    if (residentOnly) return [];
    let pending = targetProfilePatternInFlight.get(cacheKey);
    if (!pending) {
      pending = deps.storage.dialogueMemory.listTargetProfilePatterns({ targetProfileId, patternFamilyId, limit: 512 })
        .then(value => {
          targetProfilePatternCache.set(cacheKey, { loadedAt: clock.now(), value });
          return value;
        })
        .finally(() => {
          if (targetProfilePatternInFlight.get(cacheKey) === pending) targetProfilePatternInFlight.delete(cacheKey);
        });
      targetProfilePatternInFlight.set(cacheKey, pending);
    }
    return pending;
  }

  /** Start a single-flight durable profile-pattern read after a visible response has begun. */
  function warmTargetProfilePatterns(targetProfileId?: string, patternFamilyId?: string): void {
    const timer = setTimeout(() => {
      void targetProfilePatternsCached(targetProfileId, patternFamilyId, false).catch(() => undefined);
    }, 0);
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * Start durable language hydration after the caller has returned its
   * resident/fast-path result. The returned promise is intentionally not
   * exposed: callers must not make a user response wait for durable loading.
   * The shared in-flight map makes repeated warm requests one database load.
   */
  function warmSurfaceLanguageMemory(
    limit = 36,
    cluster?: LanguageProfileCluster,
    unscopedReason = "deferred-language-warm",
    preferredCorpusRoleId?: CorpusRoleId,
    preferredSurface = "",
    hydrationOptions: ResidentOnlyOptions = {}
  ): void {
    const warmKey = hydrationOptions.languageId
      ? `language:${hydrationOptions.languageId}\u001f${preferredCorpusRoleId ?? "corpus-role:any"}${hydrationOptions.purpose ? `\u001f${hydrationOptions.purpose}` : ""}`
      : `cluster:${languageProfileClusterCacheKey(cluster)}\u001f${preferredCorpusRoleId ?? "corpus-role:any"}\u001f${cluster ? "" : unscopedReason}${hydrationOptions.purpose ? `\u001f${hydrationOptions.purpose}` : ""}`;
    if (deferredLanguageWarmups.has(warmKey)) return;
    deferredLanguageWarmups.add(warmKey);
    const durableOptions = { ...hydrationOptions, residentOnly: false, deferDurable: false };
    const timer = setTimeout(() => {
      void hydrateSurfaceLanguageMemoryCached(
        limit,
        cluster,
        unscopedReason,
        preferredCorpusRoleId,
        preferredSurface,
        durableOptions
      ).catch(() => undefined).finally(() => {
        deferredLanguageWarmups.delete(warmKey);
      });
    }, 0);
    if (typeof timer.unref === "function") timer.unref();
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
      .filter(([key]) => key.startsWith(prefix) && !key.endsWith("\u001frequest_seed") && (!roleMarker || key.endsWith(roleMarker)))
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
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const now = clock.now();
    const generation = languageMemoryGeneration;
    if (surfaceProfileCache && (residentOnly || now - surfaceProfileCache.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return { profiles: surfaceProfileCache.value, clusters: surfaceProfileCache.clusters };
    }
    if (residentOnly) return { profiles: [], clusters: [] };
    const existing = surfaceProfileInFlight;
    if (existing) return existing;
    const pending = (async () => {
      const [persistedProfiles, requestControlPatterns] = await Promise.all([
        deps.storage.model.listLanguageProfiles({
          limit: surfaceLanguageProfileLimit,
          referencedByLanguageMemory: true
        }),
        requestControlPatternsCached()
      ]);
      const requestControlProfileIds = new Set(
        latestRequestRequirementPatterns(requestControlPatterns)
          .filter(pattern => corpusSourceAlias(kernelString(jsonRecord(pattern.patternJson).sourceSystem) ?? "") === corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.corrections))
          .map(pattern => pattern.profileId)
      );
      const profiles = persistedProfiles
        .filter(profile => !requestControlProfileIds.has(profile.id))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const clusters = buildLanguageProfileClusters(profiles);
      if (generation === languageMemoryGeneration) surfaceProfileCache = { loadedAt: clock.now(), value: profiles, clusters };
      return { profiles, clusters };
    })();
    surfaceProfileInFlight = pending;
    try { return await pending; }
    finally {
      if (surfaceProfileInFlight === pending) surfaceProfileInFlight = undefined;
    }
  }


  async function sourceOwnedLanguageProfilesCached(
    aliases: readonly string[],
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<{ profiles: LanguageProfile[]; clusters: LanguageProfileCluster[] }> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const aliasKeys = [...new Set(aliases.map(normalizeSourceLanguageAlias).filter(Boolean))].sort();
    if (!aliasKeys.length) return { profiles: [], clusters: [] };
    const cacheKey = aliasKeys.join("\u001f");
    const now = clock.now();
    const generation = languageMemoryGeneration;
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
    const existing = sourceOwnedAliasProfileInFlight.get(cacheKey);
    if (existing) return existing;
    const pending = (async () => {
      const profiles = (await deps.storage.model.listLanguageProfiles({
        limit: surfaceLanguageProfileLimit,
        referencedByLanguageMemory: true,
        sourceDerivedAliases: aliasKeys
      })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const clusters = buildLanguageProfileClusters(profiles);
      if (generation === languageMemoryGeneration) sourceOwnedAliasProfileCache.set(cacheKey, { loadedAt: clock.now(), profiles, clusters });
      return { profiles, clusters };
    })();
    sourceOwnedAliasProfileInFlight.set(cacheKey, pending);
    try { return await pending; }
    finally {
      if (sourceOwnedAliasProfileInFlight.get(cacheKey) === pending) sourceOwnedAliasProfileInFlight.delete(cacheKey);
    }
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
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const byKey = new Map<string, SourceVersionId>();
    for (const sourceVersionId of sourceVersionIds) {
      const key = String(sourceVersionId);
      if (key) byKey.set(key, sourceVersionId);
    }
    const versionKeys = [...byKey.keys()].sort();
    if (!versionKeys.length) return { profiles: [], clusters: [] };
    const cacheKey = versionKeys.join(UNIT_SEPARATOR);
    const now = clock.now();
    const generation = languageMemoryGeneration;
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
    if (generation === languageMemoryGeneration) boundedCacheSet(evidenceOwnedProfileCache, cacheKey, { loadedAt: now, profiles, clusters }, surfaceCandidateProfileCacheMaxEntries);
    return { profiles, clusters };
  }

  /** Source programs retain the same cluster or language ownership as the request state. */
  async function constructionBundlesForScope(bundles: readonly DurableLanguageConstructionBundle[], scope: LanguageMemoryRuntimeState["scope"]): Promise<DurableLanguageConstructionBundle[]> {
    if (!bundles.length || scope.mode === "unscoped") return [];
    const resolver = scope.mode === "language" && scope.languageId
      ? await options.languageResolver?.([...new Set(bundles.flatMap(bundle => [bundle.sourceProfileId, bundle.targetProfileId]))]) : undefined;
    const profiles = new Set(scope.profileIds);
    const versions = new Set(scope.sourceVersionIds.map(String));
    return bundles.filter(bundle => scope.mode === "language"
      ? Boolean(resolver) && [bundle.sourceProfileId, bundle.targetProfileId].some(profileId => {
        const identity = resolver!.profile(profileId);
        return identity === undefined || identity === scope.languageId;
      })
      : profiles.has(bundle.sourceProfileId) && profiles.has(bundle.targetProfileId) && bundle.sourceVersionIds.length > 0
        && bundle.sourceVersionIds.every(version => versions.has(String(version)))
        && bundle.sourceExamples.every(example => versions.has(example.sourceVersionId) && bundle.evidenceIds.includes(example.evidenceId)));
  }

  /** Acquired request ports and their source interpreters load only after evidence admission. */
  async function conversationalConstructionBundles(patternHeaders: readonly LanguagePatternRecord[], scope: LanguageMemoryRuntimeState["scope"], actId: DialogueActId): Promise<DurableLanguageConstructionBundle[]> {
    if (scope.mode === "unscoped" || actId === DIALOGUE_ACT_IDS.neutral) return [];
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const candidates = patternHeaders.filter(pattern => conversationalConstructionBinding(pattern) === conversationalActBindingId(hasher, pattern.profileId, actId));
    const resolver = scope.mode === "language" && scope.languageId ? await options.languageResolver?.(candidates.map(pattern => pattern.profileId)) : undefined;
    const headers = candidates.filter(pattern => scope.mode === "language" ? Boolean(resolver) && (() => {
      const identity = resolver!.profile(pattern.profileId) ?? resolver!.corpus(kernelString(jsonRecord(pattern.patternJson).sourceSystem));
      return identity === undefined || identity === scope.languageId;
    })() : scope.profileIds.includes(pattern.profileId));
    const patternIds = [...new Set(headers.map(pattern => pattern.id))].sort();
    if (!patternIds.length) return [];
    const key = `conversation${UNIT_SEPARATOR}${canonicalDigestHex({ actId, mode: scope.mode, languageId: scope.languageId ?? null,
      profileIds: [...scope.profileIds].sort(), sourceVersionIds: [...scope.sourceVersionIds].sort(), patternIds }, hasher)}`;
    const cached = sourceOwnedConstructionCache.get(key), resident = cached?.bundles.deref();
    if (resident && clock.now() - cached!.loadedAt < surfaceLanguageMemoryCacheMs) return resident;
    const generation = languageMemoryGeneration;
    const patterns = (await deps.storage.languageMemory.listLanguagePatterns({ patternIds, limit: patternIds.length, maxTotalJsonBytes: 8 * 1024 * 1024 }))
      .filter(pattern => headers.some(header => header.id === pattern.id && header.profileId === pattern.profileId)
        && conversationalConstructionBinding(pattern) === conversationalActBindingId(hasher, pattern.profileId, actId));
    const evidenceIds = [...new Set(patterns.filter(isLanguageConstructionPattern).flatMap(pattern => pattern.evidenceIds))];
    const evidence = evidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(evidenceIds) : [];
    const memory = hydrateLanguageConstructionPatterns({ patterns, evidence, hasher });
    const bundles = await constructionBundlesForScope(memory.bundles.filter(bundle => bundle.bindingId === conversationalActBindingId(hasher, bundle.targetProfileId, actId)
      && bundle.sourceExamples.length > 0 && bundle.sourceExamples.every(example => example.antecedent)), scope);
    if (generation === languageMemoryGeneration) boundedCacheSet(sourceOwnedConstructionCache, key,
      { loadedAt: clock.now(), bundles: new WeakRef(bundles) }, surfaceCandidateProfileCacheMaxEntries);
    return bundles;
  }

  /** Acquired request ports and their source interpreters load only after evidence admission. */
  async function requestConstructionBundles(patternHeaders: readonly LanguagePatternRecord[], scope: LanguageMemoryRuntimeState["scope"]): Promise<DurableLanguageConstructionBundle[]> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    if (scope.mode === "unscoped") return [];
    const candidateHeaders = patternHeaders.filter(pattern => requestConstructionCandidate(pattern) || sourceConstructionCandidate(pattern));
    const resolver = scope.mode === "language" && scope.languageId
      ? await options.languageResolver?.(candidateHeaders.map(pattern => pattern.profileId)) : undefined;
    const headers = candidateHeaders.filter(pattern => {
      if (scope.mode !== "language") return scope.profileIds.includes(pattern.profileId);
      if (!resolver || !scope.languageId) return false;
      const identity = resolver.profile(pattern.profileId) ?? resolver.corpus(kernelString(jsonRecord(pattern.patternJson).sourceSystem));
      return identity === undefined || identity === scope.languageId;
    });
    if (!headers.some(requestConstructionCandidate)) return [];
    const patternIds = [...new Set(headers.map(pattern => pattern.id))].sort();
    if (!patternIds.length) return [];
    const key = `request${UNIT_SEPARATOR}${canonicalDigestHex({ mode: scope.mode, languageId: scope.languageId ?? null,
      profileIds: [...scope.profileIds].sort(), sourceVersionIds: [...scope.sourceVersionIds].sort(), patternIds }, hasher)}`;
    const cached = sourceOwnedConstructionCache.get(key);
    const resident = cached?.bundles.deref();
    if (resident && clock.now() - cached!.loadedAt < surfaceLanguageMemoryCacheMs) return resident;
    const generation = languageMemoryGeneration;
    const patterns = (await deps.storage.languageMemory.listLanguagePatterns({ patternIds, limit: patternIds.length, maxTotalJsonBytes: 8 * 1024 * 1024 }))
      .filter(pattern => patternIds.includes(pattern.id));
    const evidenceIds = [...new Set(patterns.filter(isLanguageConstructionPattern).flatMap(pattern => pattern.evidenceIds))];
    const evidence = evidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(evidenceIds) : [];
    const memory = hydrateLanguageConstructionPatterns({ patterns, evidence, hasher });
    const bundles = await constructionBundlesForScope(memory.bundles, scope);
    if (generation === languageMemoryGeneration) boundedCacheSet(sourceOwnedConstructionCache, key,
      { loadedAt: clock.now(), bundles: new WeakRef(bundles) }, surfaceCandidateProfileCacheMaxEntries);
    return bundles;
  }

  /** Source semantics follow the admitted source versions, independently of the corpus chosen to word the answer. */
  async function sourceOwnedConstructionsForEvidence(evidence: readonly EvidenceSpan[]): Promise<DurableLanguageConstructionBundle[]> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const versionIds = [...new Set(evidence.filter(span => span.status === "promoted").map(span => String(span.sourceVersionId)).filter(Boolean))].sort();
    if (!versionIds.length) return [];
    const key = versionIds.join(UNIT_SEPARATOR);
    const cached = sourceOwnedConstructionCache.get(key);
    const resident = cached?.bundles.deref();
    if (resident && clock.now() - cached!.loadedAt < surfaceLanguageMemoryCacheMs) return resident;
    const generation = languageMemoryGeneration;
    const owned = await evidenceOwnedLanguageProfilesCached(versionIds as SourceVersionId[]);
    const profileIds = owned.profiles.filter(profile => versionIds.includes(String(profile.sourceVersionId)))
      .map(profile => profile.id).sort().slice(0, 32);
    if (!profileIds.length) return [];
    // Read only source-owned construction artifacts. Generic models and output-role priors do not compete for this budget.
    const patterns = await deps.storage.languageMemory.listLanguagePatterns({
      profileIds, patternSchemas: [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA], limit: 512, maxTotalJsonBytes: 8 * 1024 * 1024
    });
    const constructionEvidenceIds = [...new Set(patterns.filter(isLanguageConstructionPattern)
      .flatMap(pattern => pattern.evidenceIds.map(String)))].sort().slice(0, 4096);
    const constructionEvidence = constructionEvidenceIds.length
      ? await deps.storage.evidence.getEvidenceBatch(constructionEvidenceIds as EvidenceSpan["id"][]) : [];
    const admittedVersions = new Set(versionIds);
    const memory = hydrateLanguageConstructionPatterns({ patterns, evidence: constructionEvidence, hasher });
    const bundles = memory.bundles.filter(bundle => bundle.sourceVersionIds.length > 0
      && bundle.sourceVersionIds.every(id => admittedVersions.has(String(id))));
    hydrateHeapTrace("language.source_constructions", { profiles: profileIds.length, patterns: patterns.length,
      evidence: constructionEvidence.length, bundles: bundles.length, rejected: memory.rejected.length });
    if (generation === languageMemoryGeneration) boundedCacheSet(sourceOwnedConstructionCache, key, { loadedAt: clock.now(), bundles: new WeakRef(bundles) }, surfaceCandidateProfileCacheMaxEntries);
    return bundles;
  }

  async function creativeSourceMemoryForRequest(requestText: string, languageId?: string): Promise<{ state: LanguageMemoryRuntimeState; profile: LanguageProfile; patterns: LanguagePatternRecord[] } | undefined> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const candidates = creativeRequestSourcePrerequisites({ requestText, patterns: await requestControlPatternsCached(), hasher });
    const patternIds = [...new Set(candidates.flatMap(candidate => candidate.patternIds))].sort();
    if (!patternIds.length) return undefined;
    const key = canonicalDigestHex({ patternIds, models: candidates.map(candidate => candidate.modelPattern.id).sort(), languageId: languageId ?? null }, hasher);
    const cached = creativeSourceCache.get(key);
    const resident = cached?.state.deref();
    const residentPatterns = cached?.patterns.deref();
    if (resident && residentPatterns && clock.now() - cached!.loadedAt < surfaceLanguageMemoryCacheMs) return { state: resident, profile: cached!.profile, patterns: residentPatterns };
    const inFlight = creativeSourceInFlight.get(key);
    if (inFlight) return inFlight;
    const generation = languageMemoryGeneration;
    const pending = (async () => {
      const sourcePatterns = await deps.storage.languageMemory.listLanguagePatterns({ patternIds, limit: patternIds.length,
        maxTotalJsonBytes: (Number(process.env.SCCE_LANGUAGE_HYDRATE_PATTERNS_MB) || 32) * 1024 * 1024 });
      const evidenceIds = [...new Set(sourcePatterns.flatMap(pattern => pattern.evidenceIds))];
      const evidence = evidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(evidenceIds) : [];
      const patterns = uniqueRecordsById([...sourcePatterns, ...candidates.map(candidate => candidate.modelPattern)], sourcePatterns.length + candidates.length);
      const hydrated = languageMemoryRuntime.hydrate({ models: [], patterns, constructionEvidence: evidence });
      const owned = await evidenceOwnedLanguageProfilesCached([...new Set(evidence.map(span => span.sourceVersionId))]);
      const resolver = languageId ? await options.languageResolver?.(languageIdentityProfileIdsForArtifacts({ patterns, profiles: owned.profiles })) : undefined;
      let state: LanguageMemoryRuntimeState;
      if (languageId && resolver) state = scopeLanguageMemoryStateToLanguage(hydrated, languageId, resolver);
      else {
        const cluster = selectLanguageProfileClusterForSurface(owned.clusters, requestText)?.cluster ?? selectDominantLanguageProfileCluster(owned.clusters);
        if (!cluster) return undefined;
        state = scopeLanguageMemoryStateToCluster(hydrated, cluster);
      }
      const sourceProfiles = owned.profiles.filter(profile => state.scope.profileIds.includes(profile.id));
      const profile = selectLanguageProfileForSurface(sourceProfiles, requestText) ?? sourceProfiles[0];
      const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText, models: state.creativeEventCompatibilityModels, hasher });
      const learned = frame && state.creativeEventCompatibilityModels.some(model => model.reliability === "source_observed"
        && candidates.some(candidate => candidate.modelPattern.id === model.id)
        && model.sourceObservations.some(row => frame.sourceActivationIds.includes(row.requestFrameId)));
      traceEvent((globalThis as { __sccTrace?: Parameters<typeof traceEvent>[0] }).__sccTrace, {
        stage: "language.creative_source_request", label: "kernel.language.hydrate", counts: { requestedPatterns: patternIds.length, patterns: sourcePatterns.length, evidence: evidence.length },
        support: { admitted: Boolean(profile && frame && learned), sourceProfileIds: candidates.map(candidate => candidate.profileId), frameId: frame?.id ?? null }
      });
      if (!profile || !frame || !learned) return undefined;
      if (generation === languageMemoryGeneration) boundedCacheSet(creativeSourceCache, key, { loadedAt: clock.now(), state: new WeakRef(state), profile, patterns: new WeakRef(patterns) }, surfaceCandidateProfileCacheMaxEntries);
      return { state, profile, patterns };
    })();
    creativeSourceInFlight.set(key, pending);
    try { return await pending; }
    finally { if (creativeSourceInFlight.get(key) === pending) creativeSourceInFlight.delete(key); }
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
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    if (!surface.trim()) return undefined;
    const surfaceKey = hasher.digestHex(surface.normalize("NFC"));
    const cached = surfaceCandidateProfileCache.get(surfaceKey);
    const now = clock.now();
    const generation = languageMemoryGeneration;
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
    if (generation === languageMemoryGeneration) boundedCacheSet(surfaceCandidateProfileCache, surfaceKey, { loadedAt: now, profiles, clusters }, surfaceCandidateProfileCacheMaxEntries);
    return selectLanguageProfileClusterForSurface(clusters, surface)?.cluster
      ?? languageForSurface(global.clusters, surface);
  }


  async function requestSemanticFrames(
    surface: string,
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<SemanticFrameRecord[]> {
    const normalizedSurface = normalizePriorKey(surface);
    if (!normalizedSurface) return [];
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const key = `request${UNIT_SEPARATOR}${normalizedSurface}`;
    const cached = sourceAnchorSemanticFrameCache.get(key);
    if (cached && (cacheOptions.residentOnly || clock.now() - cached.loadedAt < surfaceLanguageMemoryCacheMs)) return cached.value.map(row => row.frame);
    if (cacheOptions.residentOnly) return residentRuntimeNotWarm("semantic-frames");
    const generation = languageMemoryGeneration;
    const frames = await deps.storage.languageMemory.listSemanticFrames({ requestSurface: normalizedSurface, limit: 128 });
    const matched = uniqueRecordsById(frames.filter(frame => {
      const frameSurface = kernelString(jsonRecord(frame.frameJson).surface);
      return frameSurface ? normalizePriorKey(frameSurface) === normalizedSurface : false;
    }), 128);
    if (generation === languageMemoryGeneration) boundedCacheSet(sourceAnchorSemanticFrameCache, key,
      { loadedAt: clock.now(), value: matched.map(frame => ({ frame, surface: normalizedSurface, surfaceUnits: [] })) }, surfaceCandidateProfileCacheMaxEntries);
    return matched;
  }


  async function sourceAnchorSemanticFramesCached(
    cacheOptions: ResidentOnlyOptions = {}
  ): Promise<Array<{ frame: SemanticFrameRecord; surface: string; surfaceUnits: string[] }>> {
    if (durableLanguageRevision === undefined && deps.storage.languageMemory.readRevision) await synchronizeWithStorage();
    const now = clock.now();
    const generation = languageMemoryGeneration;
    const cached = sourceAnchorSemanticFrameCache.get("");
    if (cached
      && (cacheOptions.residentOnly
        || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return cached.value;
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
    if (generation === languageMemoryGeneration) boundedCacheSet(sourceAnchorSemanticFrameCache, "", { loadedAt: now, value }, surfaceCandidateProfileCacheMaxEntries);
    return value;
  }

  function invalidateLanguageMemory() {
    surfaceLanguageMemoryCache.clear();
    requestControlPatternCache = undefined;
    requestControlPatternInFlight = undefined;
    languageScopeCache.clear();
    languageMemoryGeneration += 1;
    surfaceLanguageMemoryInFlight.clear();
    continuationPopulationCache.clear();
    continuationPopulationInFlight.clear();
    sourceOwnedAliasProfileCache.clear();
    sourceOwnedAliasProfileInFlight.clear();
    surfaceCandidateProfileCache.clear();
    evidenceOwnedProfileCache.clear();
    sourceOwnedConstructionCache.clear();
    creativeSourceCache.clear();
    creativeSourceInFlight.clear();
    surfaceProfileCache = undefined;
    surfaceProfileInFlight = undefined;
    sourceAnchorSemanticFrameCache.clear();
    targetProfilePatternCache.clear();
    targetProfilePatternInFlight.clear();
    deferredLanguageWarmups.clear();
  }

  return {
    corpusRegistry,
    revisionGeneration: () => languageMemoryGeneration,
    synchronizeWithStorage,
    requestControlPatternsCached,
    languageMemorySummary,
    targetProfilePatternsCached,
    warmTargetProfilePatterns,
    hydrateSurfaceLanguageMemoryCached,
    warmSurfaceLanguageMemory,
    residentSurfaceLanguageMemory,
    surfaceLanguageProfilesCached,
    sourceOwnedLanguageProfilesCached,
    sourceOwnedLanguageClusterForAlias,
    sourceOwnedLanguageClustersForWarmup,
    evidenceOwnedLanguageProfilesCached,
    sourceOwnedConstructionsForEvidence,
    requestConstructionBundles,
    conversationalConstructionBundles,
    constructionBundlesForScope,
    creativeSourceMemoryForRequest,
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
        languageMemoryMaxEstimatedBytes: surfaceLanguageMemoryCacheMaxEstimatedBytes,
        scopedStateReferences: languageScopeCache.size,
        activeHydrations,
        waitingHydrations,
        candidateProfileEntries: surfaceCandidateProfileCache.size,
        aliasProfileEntries: sourceOwnedAliasProfileCache.size,
        evidenceProfileEntries: evidenceOwnedProfileCache.size,
        surfaceProfiles: surfaceProfileCache?.value.length ?? 0,
        sourceAnchorFrames: sourceAnchorSemanticFrameCache.get("")?.value.length ?? 0,
        // Hit rates for the two memos that sit on the hottest paths in the kernel. Both accessors existed to be
        // read and nothing read them, so a memo that had stopped hitting looked exactly like one that never ran.
        featureSetMemo: featureSetMemoStats(),
        tidySurfaceTextMemo: tidySurfaceTextMemoStats()
      };
    },
    invalidate: invalidateLanguageMemory
  };
}
