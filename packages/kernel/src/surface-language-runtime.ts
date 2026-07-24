import { createCorpusRegistry, languageMemoryHydrationPlan, type CorpusRoleId } from "./corpus-registry.js";
import { jsonRecord, kernelString, normalizePriorKey, splitPriorUnits } from "./kernel-answer-primitives.js";
import { isLanguageConstructionPattern } from "./language-construction-memory.js";
import { createLanguageMemoryRuntime, markLanguageMemoryStateUnscoped, scopeLanguageMemoryStateToCluster } from "./language-memory-runtime.js";
import {
  buildLanguageProfileClusters,
  languageProfileClusterCacheKey,
  normalizeSourceLanguageAlias,
  selectLanguageProfileClusterForSurface,
  type LanguageProfileCluster
} from "./language.js";
import { createClock, createHasher, sourceTextSurface, toJsonValue } from "./primitives.js";
import {
  isRequestRequirementPattern
} from "./request-requirement-learning.js";
import type { LanguagePatternRecord, ScceKernelDeps, SemanticFrameRecord } from "./storage.js";
import type {
  EvidenceSpan,
  JsonValue,
  LanguageProfile
} from "./types.js";

export function createSurfaceLanguageRuntime(options: {
  deps: Pick<ScceKernelDeps, "storage" | "corpusRegistry">;
  languageMemoryRuntime: ReturnType<typeof createLanguageMemoryRuntime>;
  clock: ReturnType<typeof createClock>;
  hasher: ReturnType<typeof createHasher>;
  cacheMs: number;
  profileLimit: number;
}) {
  const { deps, languageMemoryRuntime, clock, hasher } = options;
  const surfaceLanguageMemoryCacheMs = options.cacheMs;
  const surfaceLanguageProfileLimit = options.profileLimit;

  const corpusRegistry = createCorpusRegistry(deps.corpusRegistry ?? []);

  const surfaceLanguageMemoryCache = new Map<string, { limit: number; loadedAt: number; value: Awaited<ReturnType<typeof hydrateSurfaceLanguageMemory>> }>();

  let surfaceProfileCache: { loadedAt: number; value: LanguageProfile[]; clusters: LanguageProfileCluster[] } | undefined;

  const sourceOwnedAliasProfileCache = new Map<string, {
    loadedAt: number;
    profiles: LanguageProfile[];
    clusters: LanguageProfileCluster[];
  }>();

  let sourceAnchorSemanticFrameCache: {
    loadedAt: number;
    value: Array<{ frame: SemanticFrameRecord; surfaceUnits: string[] }>;
  } | undefined;

  type ResidentOnlyOptions = {
    residentOnly?: boolean;
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
    preferredSurface = ""
  ) {
    const boundedLimit = Math.max(1, Math.min(64, Math.floor(limit)));
    const profileIds = preferredCorpusRoleId ? undefined : cluster?.profileIds;
    const hydrationLimits = {
      ngramModels: Math.max(12, boundedLimit * Math.max(1, corpusRegistry.length)),
      ngramObservations: Math.max(1200, boundedLimit * 320),
      languageUnits: Math.max(512, boundedLimit * 128),
      languagePatterns: Math.max(256, boundedLimit * 64),
      semanticFrames: Math.max(512, boundedLimit * 96)
    };
    const exactProfileOwnerCount = Math.max(1, profileIds?.length ?? 0);
    const exactProfileHydrationLimits = {
      ngramModels: Math.max(12, exactProfileOwnerCount * 4),
      ngramObservations: Math.max(256, exactProfileOwnerCount * 256),
      languageUnits: Math.max(256, exactProfileOwnerCount * 256),
      languagePatterns: Math.max(96, exactProfileOwnerCount * 96),
      semanticFrames: Math.max(128, exactProfileOwnerCount * 128)
    };
    const corpusPlan = languageMemoryHydrationPlan(corpusRegistry, hydrationLimits);
    const [active, requestControlPatterns] = await Promise.all([
      deps.storage.brainImports.active(),
      deps.storage.languageMemory.listLanguagePatterns({ sourceSystem: "corrections", limit: 2048 })
    ]);
    const learnedRequestControlPatterns = latestRequestRequirementPatterns(requestControlPatterns);
    if (!cluster) {
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
        requestControlPatterns: learnedRequestControlPatterns,
        state: markLanguageMemoryStateUnscoped(hydrated, unscopedReason),
        surfaceProfile: undefined as LanguageProfile | undefined,
        active,
        corpusPlan
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
    const [
      modelsBySource,
      observationsBySource,
      unitsBySource,
      patternsBySource,
      semanticFramesBySource,
      persistedProfiles
    ] = await Promise.all([
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listNgramModels({ sourceSystem: item.sourceSystem, profileIds: item.profileIds, limit: Math.min(limit, item.limits.ngramModels) }))),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listNgramObservations({ sourceSystem: item.sourceSystem, profileIds: item.profileIds, limit: item.limits.ngramObservations }))),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listLanguageUnits({ profileIds: item.profileIds, sourceSystem: item.sourceSystem, limit: item.limits.languageUnits }))),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listLanguagePatterns({ profileIds: item.profileIds, sourceSystem: item.sourceSystem, limit: item.limits.languagePatterns }))),
      Promise.all(hydrationQueries.map(item => deps.storage.languageMemory.listSemanticFrames({ profileIds: item.profileIds, sourceSystem: item.sourceSystem, limit: item.limits.semanticFrames }))),
      preferredCorpusRoleId
        ? surfaceProfileCache
          ? Promise.resolve(surfaceProfileCache.value)
          : deps.storage.model.listLanguageProfiles({ limit: surfaceLanguageProfileLimit, referencedByLanguageMemory: true })
        : Promise.resolve([] as LanguageProfile[])
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
    const hydrated = languageMemoryRuntime.hydrateFromImportedBrain({
      importRunId: active.activeImportRunIds[0],
      models,
      observations,
      units,
      patterns,
      semanticFrames,
      constructionEvidence
    });
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
    const roleCluster = preferredCorpusRoleId
      ? corpusRoleLanguageCluster({
        roleId: preferredCorpusRoleId,
        target: cluster,
        profiles: persistedProfiles.filter(profile => roleProfileIds.has(profile.id)),
        surface: preferredSurface
      })
      : undefined;
    const effectiveCluster = roleCluster ?? cluster;
    const state = scopeLanguageMemoryStateToCluster(hydrated, effectiveCluster);
    return {
      models,
      observations,
      units,
      patterns,
      semanticFrames,
      constructionEvidence,
      requestControlPatterns: learnedRequestControlPatterns,
      state,
      surfaceProfile: effectiveCluster.members[0] as LanguageProfile | undefined,
      active,
      corpusPlan
    };
  }


  function corpusRoleLanguageCluster(input: {
    roleId: CorpusRoleId;
    target?: LanguageProfileCluster;
    profiles: readonly LanguageProfile[];
    surface?: string;
  }): LanguageProfileCluster | undefined {
    const targetScripts = new Set((input.target?.scripts ?? [])
      .filter(row => row.mass >= 0.12)
      .map(row => row.script));
    const targetLanguageOwners = new Set((input.target?.discoveredNames ?? [])
      .filter(row => row.confidence > 0)
      .map(row => normalizePriorKey(row.surface))
      .filter(Boolean));
    const ownerCompatible = input.profiles
      .filter(profile => !input.target || (
        profile.direction === input.target.direction
        && profile.scripts.some(script => script.mass >= 0.12 && targetScripts.has(script.script))
        && targetLanguageOwners.size > 0
        && (profile.discoveredNames ?? []).some(name =>
          name.confidence > 0
          && targetLanguageOwners.has(normalizePriorKey(name.surface))
        )
      ));
    const surfaceSelected = !ownerCompatible.length && input.surface?.trim()
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
    const compatible = (ownerCompatible.length ? ownerCompatible : surfaceCompatible)
      .filter(profile => !input.target || (
        profile.direction === input.target.direction
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
      scripts: input.target?.scripts ?? base.scripts,
      symbolShapes: input.target?.symbolShapes ?? base.symbolShapes,
      charNgrams: input.target?.charNgrams ?? base.charNgrams,
      direction: input.target?.direction ?? base.direction,
      artifactSupport: compatible.reduce((sum, profile) => sum + Math.max(1, profile.charNgrams.reduce((mass, row) => mass + row.count, 0)), 0)
    };
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
    if (preferredCorpusRoleId && preferredSurface.trim() && surfaceProfileCache) {
      const roleKey = `\u001f${preferredCorpusRoleId}\u001f`;
      const residentRoleMatch = [...surfaceLanguageMemoryCache.entries()]
        .filter(([key, entry]) => (
          key.includes(roleKey)
          && entry.value.state.importedConstructionBundles.length > 0
          && entry.value.state.scope.mode === "cluster"
          && entry.value.state.scope.purityProven
        ))
        .map(([, entry]) => {
          const profileIds = new Set(entry.value.state.scope.profileIds);
          const profiles = surfaceProfileCache!.value.filter(profile => profileIds.has(profile.id));
          const clusterCompatible = cluster
            && entry.value.surfaceProfile
            && languageProfileMatchesCluster(entry.value.surfaceProfile, cluster);
          if (clusterCompatible) return { entry, score: 1, margin: 1 };
          const match = selectLanguageProfileClusterForSurface(buildLanguageProfileClusters(profiles), preferredSurface);
          return match ? { entry, score: match.score, margin: match.margin } : undefined;
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .sort((left, right) => right.score - left.score || right.margin - left.margin)[0];
      if (residentRoleMatch) return residentRoleMatch.entry.value;
    }
    const preferredSurfaceKey = preferredSurface.trim()
      ? hasher.digestHex(preferredSurface.normalize("NFC"))
      : "surface:none";
    const cacheKey = `${languageProfileClusterCacheKey(cluster)}\u001f${cluster ? "scoped" : unscopedReason}\u001f${preferredCorpusRoleId ?? "corpus-role:any"}\u001f${preferredSurfaceKey}`;
    const cached = surfaceLanguageMemoryCache.get(cacheKey);
    if (cached
      && cached.limit >= limit
      && (hydrationOptions.residentOnly || now - cached.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return cached.value;
    }
    if (hydrationOptions.residentOnly) {
      return residentRuntimeNotWarm(`language-memory:${unscopedReason}`);
    }
    const value = await hydrateSurfaceLanguageMemory(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface);
    surfaceLanguageMemoryCache.set(cacheKey, { limit, loadedAt: now, value });
    return value;
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
    const roleMarker = preferredCorpusRoleId ? `\u001f${preferredCorpusRoleId}\u001f` : undefined;
    return [...surfaceLanguageMemoryCache.entries()]
      .filter(([key]) => key.startsWith(prefix) && (!roleMarker || key.includes(roleMarker)))
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
    return surface.trim()
      ? selectLanguageProfileClusterForSurface(clusters, surface)?.cluster
      : undefined;
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


  async function surfaceLanguageClusterCached(surface: string, residentOnly = false): Promise<LanguageProfileCluster | undefined> {
    const { clusters } = await surfaceLanguageProfilesCached(residentOnly);
    if (!surface.trim()) return undefined;
    return selectLanguageProfileClusterForSurface(clusters, surface)?.cluster;
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
  ): Promise<Array<{ frame: SemanticFrameRecord; surfaceUnits: string[] }>> {
    const now = clock.now();
    if (sourceAnchorSemanticFrameCache
      && (cacheOptions.residentOnly
        || now - sourceAnchorSemanticFrameCache.loadedAt < surfaceLanguageMemoryCacheMs)) {
      return sourceAnchorSemanticFrameCache.value;
    }
    if (cacheOptions.residentOnly) return residentRuntimeNotWarm("semantic-frames");
    const frames = await deps.storage.languageMemory.listSemanticFrames({ limit: 2048 });
    const value = frames.map(frame => {
      const record = jsonRecord(frame.frameJson);
      const surface = sourceTextSurface(kernelString(record.preview) ?? kernelString(record.text) ?? "", 6000);
      return {
        frame,
        surfaceUnits: surface ? splitPriorUnits(normalizePriorKey(surface)).filter(Boolean) : []
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
    surfaceLanguageClusterCached,
    requestSemanticFrames,
    sourceAnchorSemanticFramesCached,
    uniqueRecordsById,
    invalidate() {
      surfaceLanguageMemoryCache.clear();
      sourceOwnedAliasProfileCache.clear();
      surfaceProfileCache = undefined;
      sourceAnchorSemanticFrameCache = undefined;
    }
  };
}
