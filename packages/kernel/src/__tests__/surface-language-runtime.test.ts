// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { clearNgramModelCompilationMemo, createLanguageMemoryRuntime, ngramModelCompilationCount } from "../language-memory-runtime.js";
import { deriveClosedClassWords } from "../closed-class-words.js";
import { languageSurfaceTrigrams } from "../language.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher } from "../primitives.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import { CORPUS_SOURCE_SYSTEM_IDS } from "../corpus-registry.js";
import { creativeSelectorLanguagePattern } from "../request-language-hydration.js";
import type { LanguageContinuationPopulation, LanguagePatternRecord, LanguageUnitRecord, ScceKernelDeps, SemanticFrameRecord } from "../storage.js";
import type { SegmentationPopulationModelRecord } from "../segmentation-population-persistence.js";
import type { LanguageProfile } from "../types.js";
import { pooledProfileOwnerFixture } from "./fixtures/pooled-profile-owner.js";
import { sourceOwnedSemanticSurfacePatterns } from "./fixtures/source-owned-semantic-surface.js";

describe("surface language resident-only cache", () => {
  it("reads full compatibility bodies only for possible current owners while retaining calibrated and unspecified reliability", async () => {
    const fixture = runtimeFixture({ cacheMs: 100000 }), owner = pooledProfileOwnerFixture(["Aster powers pump."], "compatibility.scope");
    const evidence = owner.pages.flatMap(page => page.evidence), currentId = String(evidence[0]!.id);
    const base = { profileId: fixture.profile.id, patternKind: "semantic_role" as const, support: 1, entropy: 0, updatedAt: 1 };
    const compatibility: LanguagePatternRecord[] = [
      { ...base, id: "foreign.observed", evidenceIds: ["foreign" as never], patternJson: { schema: "scce.creative_event_compatibility_model.v1", reliability: "source_observed", sourceObservations: ["foreign body"] } },
      { ...base, id: "mixed.observed", evidenceIds: [currentId as never, "foreign" as never], patternJson: { schema: "scce.creative_event_compatibility_model.v1", reliability: "source_observed", sourceObservations: ["whole mixed body"] } },
      { ...base, id: "calibrated", evidenceIds: ["foreign" as never], patternJson: { schema: "scce.creative_event_compatibility_model.v1", reliability: "calibrated" } },
      { ...base, id: "unspecified", evidenceIds: [], patternJson: { schema: "scce.creative_event_compatibility_model.v1" } }
    ];
    const constructions = sourceOwnedSemanticSurfacePatterns({ evidence: evidence[0]!, profileId: fixture.profile.id, hasher: owner.hasher,
      facts: [{ subject: "Aster", predicate: "powers", object: "pump", relationId: "relation.powers", surface: evidence[0]!.text }] });
    const modelReads: string[][] = [];
    fixture.storage.languageMemory.listLanguagePatterns = async query => {
      if (query?.view === "creative_selector") return compatibility.map(creativeSelectorLanguagePattern);
      if (query?.patternIds) { modelReads.push([...query.patternIds]); return compatibility.filter(row => query.patternIds!.includes(row.id)); }
      return constructions;
    };
    fixture.storage.evidence.getEvidenceBatch = async ids => evidence.filter(span => ids.includes(span.id));
    const headers = await fixture.runtime.requestControlPatternsCached();
    expect(headers.every(row => !Object.hasOwn(row.patternJson as object, "sourceObservations"))).toBe(true);
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "owner-scoped", undefined, "Aster", { languageId: "language.fixture" });
    expect(modelReads).toEqual([["mixed.observed", "calibrated", "unspecified"]]);
  });
  it("does not promote an eligible model beyond the original combined admission window", async () => {
    const fixture = runtimeFixture({ cacheMs: 100000 }), owner = pooledProfileOwnerFixture(["Aster powers pump."], "compatibility.admission");
    const evidence = owner.pages.flatMap(page => page.evidence);
    const local = sourceOwnedSemanticSurfacePatterns({ evidence: evidence[0]!, profileId: fixture.profile.id, hasher: owner.hasher,
      facts: [{ subject: "Aster", predicate: "powers", object: "pump", relationId: "relation.powers", surface: evidence[0]!.text }] });
    const rows: LanguagePatternRecord[] = [...local, ...Array.from({ length: 255 - local.length }, (_, index) => ({ id: `local.${index}`,
      profileId: fixture.profile.id, patternKind: "syntax" as const, support: 1, entropy: 0, evidenceIds: [], updatedAt: 1, patternJson: {} }))];
    const selectors: LanguagePatternRecord[] = ["foreign", String(evidence[0]!.id)].map((id, index) => ({ id: `compatibility.${index}`,
      profileId: fixture.profile.id, patternKind: "semantic_role", support: 1, entropy: 0, evidenceIds: [id as never], updatedAt: 1,
      patternJson: { schema: "scce.creative_event_compatibility_model.v1", reliability: "source_observed" } }));
    const modelReads: string[][] = [];
    fixture.storage.languageMemory.listLanguagePatterns = async query => {
      if (query?.view === "creative_selector") return selectors;
      if (query?.patternIds) { modelReads.push([...query.patternIds]); return []; }
      return rows;
    };
    fixture.storage.evidence.getEvidenceBatch = async ids => evidence.filter(span => ids.includes(span.id));
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(1, undefined, "admission", undefined, "Aster", { languageId: "language.fixture" });
    expect(modelReads).toEqual([]);
  });
  it("cold-loads each pooled parent's constructions without admitting its sibling's source program", async () => {
    const owner = pooledProfileOwnerFixture(["Aster powers pump.", "Beryl powers valve."], "parent.closure");
    const fixture = runtimeFixture();
    const restored = JSON.parse(JSON.stringify(owner.owned)) as LanguageProfile;
    const evidence = owner.pages.flatMap(page => page.evidence);
    const patterns = evidence.flatMap((span, index) => sourceOwnedSemanticSurfacePatterns({ evidence: span, profileId: restored.id, hasher: owner.hasher,
      facts: [{ subject: index ? "Beryl" : "Aster", predicate: "powers", object: index ? "valve" : "pump", relationId: "relation.powers", surface: span.text }] }));
    fixture.storage.model.listLanguageProfiles = async query => typeof query !== "number" && query?.sourceVersionIds
      && !query.sourceVersionIds.some(id => owner.parentSourceVersionIds.includes(String(id))) ? [] : [restored];
    fixture.storage.languageMemory.listLanguagePatterns = async query => query?.profileIds?.includes(restored.id) ? JSON.parse(JSON.stringify(patterns)) : [];
    fixture.storage.evidence.getEvidenceBatch = async ids => evidence.filter(span => ids.includes(span.id));
    for (const span of evidence) {
      const bundles = await fixture.runtime.sourceOwnedConstructionsForEvidence([span]);
      expect(bundles).toHaveLength(1);
      expect(bundles[0]!.sourceProfileId).toBe(restored.id);
      expect(bundles[0]!.sourceVersionIds).toEqual([String(span.sourceVersionId)]);
    }
    await fixture.runtime.surfaceLanguageProfilesCached();
    for (const span of evidence) expect((await fixture.runtime.evidenceOwnedLanguageProfilesCached([span.sourceVersionId], { residentOnly: true })).profiles).toEqual([restored]);
    expect(await fixture.runtime.sourceOwnedConstructionsForEvidence([{ ...evidence[0]!, sourceVersionId: "source.foreign" as never }])).toEqual([]);
    expect(await fixture.runtime.sourceOwnedConstructionsForEvidence([{ ...evidence[0]!, status: "quarantined" }])).toEqual([]);
  });

  it("rejects a forged pooled parent binding before either cold or resident ownership admission", async () => {
    const owner = pooledProfileOwnerFixture(["Aster powers pump.", "Beryl powers valve."], "parent.forged");
    const fixture = runtimeFixture(), forged = JSON.parse(JSON.stringify(owner.owned)) as LanguageProfile;
    forged.pooledSourceBinding = { ...forged.pooledSourceBinding!, parents: ["source.foreign"] };
    fixture.storage.model.listLanguageProfiles = async () => [forged];
    await expect(fixture.runtime.sourceOwnedConstructionsForEvidence([{ ...owner.pages[0]!.evidence[0]!, sourceVersionId: "source.foreign" as never }]))
      .rejects.toThrow("invalid pooled profile ownership");
    await expect(fixture.runtime.surfaceLanguageProfilesCached()).rejects.toThrow("invalid pooled profile ownership");
  });

  it("invalidates pooled resident membership when a required sibling loses current access", async () => {
    const owner = pooledProfileOwnerFixture(["Aster powers pump.", "Beryl powers valve."], "parent.revision");
    const fixture = runtimeFixture({ cacheMs: 100000 }), restored = JSON.parse(JSON.stringify(owner.owned)) as LanguageProfile;
    let revision = "current", allParentsAdmitted = true;
    fixture.storage.languageMemory.readRevision = async () => revision;
    // The storage contract admits a pool only when every parent is current/promoted and principal-accessible.
    fixture.storage.model.listLanguageProfiles = async () => allParentsAdmitted ? [restored] : [];
    const evidence = owner.pages[0]!.evidence[0]!;
    const patterns = sourceOwnedSemanticSurfacePatterns({ evidence, profileId: restored.id, hasher: owner.hasher,
      facts: [{ subject: "Aster", predicate: "powers", object: "pump", relationId: "relation.powers", surface: evidence.text }] });
    fixture.storage.languageMemory.listLanguagePatterns = async query => query?.profileIds?.includes(restored.id) ? patterns : [];
    fixture.storage.evidence.getEvidenceBatch = async ids => ids.includes(evidence.id) ? [evidence] : [];
    await fixture.runtime.synchronizeWithStorage();
    await fixture.runtime.surfaceLanguageProfilesCached();
    const parent = owner.pages[0]!.evidence[0]!.sourceVersionId;
    expect((await fixture.runtime.evidenceOwnedLanguageProfilesCached([parent], { residentOnly: true })).profiles).toEqual([restored]);
    expect(await fixture.runtime.sourceOwnedConstructionsForEvidence([evidence])).toHaveLength(1);
    allParentsAdmitted = false; revision = "sibling-restricted";
    await fixture.runtime.synchronizeWithStorage();
    expect((await fixture.runtime.evidenceOwnedLanguageProfilesCached([parent], { residentOnly: true })).profiles).toEqual([]);
    expect((await fixture.runtime.evidenceOwnedLanguageProfilesCached([parent])).profiles).toEqual([]);
    expect(await fixture.runtime.sourceOwnedConstructionsForEvidence([evidence])).toEqual([]);
  });

  it("keeps exact source populations distinct within one learned language", async () => {
    const fixture = runtimeFixture({ cacheMs: 100000, languageResolver: () => ({ profile: () => "language.fixture", corpus: () => "language.fixture" }) });
    const secondProfile = { ...fixture.profile, id: "profile.second", sourceVersionId: "source.second" as never };
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) });
    const compile = (profile: LanguageProfile, text: string) => compiler.compile({ streamId: profile.sourceVersionId, sourceSystem: "wikipedia", profile,
      sourceVersionId: profile.sourceVersionId, text, evidence: [], createdAt: 1, retainObservations: false }).models;
    const firstModels = compile(fixture.profile, "alpha beta alpha gamma");
    const secondModels = compile(secondProfile, "delta epsilon delta zeta");
    const modelQueries: string[][] = [];
    fixture.storage.languageMemory.listNgramModels = async query => {
      modelQueries.push([...(query?.profileIds ?? [])]);
      return query?.profileIds?.includes(secondProfile.id) ? secondModels : firstModels;
    };
    const firstCluster = (await fixture.runtime.surfaceLanguageClusterCached("fixture language"))!;
    const secondCluster = { ...firstCluster, id: "cluster.second", profileIds: [secondProfile.id], members: [secondProfile] };
    const hydrate = (cluster: typeof firstCluster, residentOnly = false) => fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12, cluster, "exact-language-source", undefined, "", { languageId: "language.fixture", residentOnly });
    const first = await hydrate(firstCluster);
    const second = await hydrate(secondCluster);
    expect(first.state.models.length).toBeGreaterThan(0);
    expect(second.state.models.length).toBeGreaterThan(0);
    expect(first.models.map(model => model.id)).toEqual(firstModels.map(model => model.id));
    expect(second.models.map(model => model.id)).toEqual(secondModels.map(model => model.id));
    expect(modelQueries).toEqual([[fixture.profile.id], [secondProfile.id]]);
    expect(await hydrate(firstCluster, true)).toBe(first);
    expect(await hydrate(secondCluster, true)).toBe(second);
    expect(modelQueries).toHaveLength(2);
  });
  it("snapshots every bounded artifact owner and reuses that snapshot for warm rescoping", async () => {
    const snapshots: string[][] = [];
    const fixture = runtimeFixture({ cacheMs: 100000, languageResolver: async profileIds => {
      snapshots.push([...profileIds]);
      return { profile: id => id === "profile.foreign" ? "language.foreign"
        : id === "profile.unassigned" ? undefined : "language.fixture", corpus: () => undefined };
    } });
    const hasher = createHasher();
    const compiled = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) }).compile({
      streamId: "stream.snapshot", sourceSystem: "wikipedia", profile: fixture.profile, sourceVersionId: fixture.profile.sourceVersionId,
      text: "alpha beta alpha gamma", evidence: [], createdAt: 1, retainObservations: false });
    fixture.storage.languageMemory.listNgramModels = async () => compiled.models;
    const control: LanguagePatternRecord = { id: "request.control", profileId: "profile.request-control", patternKind: "syntax", support: 1, entropy: 0,
      patternJson: { schema: "scce.request_requirement_pattern.v1", sourceSystem: "dialogue" }, evidenceIds: [], updatedAt: 1 };
    fixture.storage.languageMemory.listLanguagePatterns = async query => query?.patternSchemas ? [control] : [];
    const units: LanguageUnitRecord[] = [fixture.profile.id, "profile.foreign", "profile.unassigned"].map(profileId => ({
      id: `unit:${profileId}`, profileId, sourceVersionId: fixture.profile.sourceVersionId, script: "script:Latn", unitKind: "phrase", text: profileId,
      features: [], competenceVector: [], alpha: 1, evidenceIds: [], metadata: {} }));
    fixture.storage.languageMemory.listLanguageUnits = async () => units;
    fixture.storage.languageMemory.listSemanticFrames = async () => [{ ...fixture.frame, frameJson: { profileId: "profile.frame", surface: "owned frame" } }];
    const hydrated = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "bounded-language-snapshot", undefined, "first", { languageId: "language.fixture" });
    expect(snapshots).toEqual([["profile.fixture", "profile.foreign", "profile.frame", "profile.request-control", "profile.unassigned"]]);
    expect(hydrated.state.importedUnits.map(unit => unit.profileId)).toEqual([fixture.profile.id, "profile.unassigned"]);
    expect(hydrated.state.importedObservations).toEqual([]);
    const warm = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "bounded-language-snapshot", undefined, "second", { languageId: "language.fixture" });
    expect(warm.state).toBe(hydrated.state);
    expect(snapshots).toHaveLength(1);
  });
  it("keeps a cluster request seed distinct from realization and omits source realization programs", async () => {
    const fixture = runtimeFixture({ cacheMs: 100000 });
    const hasher = createHasher();
    const compiled = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) }).compile({
      streamId: "stream.fixture", sourceSystem: "wikipedia", profile: fixture.profile, sourceVersionId: fixture.profile.sourceVersionId,
      text: "alpha beta alpha gamma", evidence: [], createdAt: 1, retainObservations: false });
    fixture.storage.languageMemory.listNgramModels = async () => compiled.models;
    const pattern = { id: "syntax.fixture", profileId: fixture.profile.id, patternKind: "syntax" as const, support: 1, entropy: 0,
      patternJson: { schema: "scce.induced_language_model.syntax_memory.v2", componentRecipe: "kernel.induced_language_memory_projection.v5",
        sourceSystem: "wikipedia", sourceVersionId: fixture.profile.sourceVersionId, templates: [], boundarySignals: [], counts: { alpha: 2 },
        surfaceRealizationProgram: { sourceSurfaceIds: ["source-surface.fixture"] } }, evidenceIds: [], updatedAt: 1 };
    const queries: NonNullable<Parameters<typeof fixture.storage.languageMemory.listLanguagePatterns>[0]>[] = [];
    fixture.storage.languageMemory.listLanguagePatterns = async query => {
      if (query?.patternSchemas) return [];
      queries.push(query ?? {});
      if (query?.view === "request_seed") {
        const { surfaceRealizationProgram: _program, ...patternJson } = pattern.patternJson;
        return [{ ...pattern, patternJson }];
      }
      return [pattern];
    };
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");
    const seed = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "seed", undefined, "", { purpose: "request_seed" });
    expect(seed.state.models.length).toBeGreaterThan(0);
    expect(seed.hydrationPurpose).toBe("request_seed");
    expect(seed.state.importedConstructionBundles).toEqual([]);
    expect(seed.patterns[0]?.patternJson).toEqual(expect.objectContaining({ counts: { alpha: 2 }, boundarySignals: [] }));
    expect(seed.patterns[0]?.patternJson).not.toHaveProperty("templates");
    expect(seed.patterns[0]?.patternJson).not.toHaveProperty("surfaceRealizationProgram");
    expect(queries.every(query => query.view === "request_seed" && query.profileIds?.includes(fixture.profile.id))).toBe(true);
    const realized = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "realization");
    expect(realized).not.toBe(seed);
    expect(realized.hydrationPurpose).toBe("realization");
    expect(realized.patterns[0]?.patternJson).toHaveProperty("surfaceRealizationProgram", pattern.patternJson.surfaceRealizationProgram);
    const seedAgain = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "seed", undefined, "", { purpose: "request_seed", residentOnly: true });
    expect(seedAgain).toBe(seed);
  });
  it("keeps prediction scoring projections out of resident realization lookup", async () => {
    const fixture = runtimeFixture({ cacheMs: 100000 });
    const hasher = createHasher();
    const compiled = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) }).compile({
      streamId: "stream.fixture", sourceSystem: "wikipedia", profile: fixture.profile, sourceVersionId: fixture.profile.sourceVersionId,
      text: "alpha beta alpha gamma", evidence: [], createdAt: 1, retainObservations: false });
    fixture.storage.languageMemory.listNgramModels = async () => compiled.models;
    const cluster = (await fixture.runtime.surfaceLanguageClusterCached("fixture language"))!;
    const scored = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "scoring", undefined, "", { purpose: "prediction_scoring" });
    expect(scored.hydrationPurpose).toBe("prediction_scoring");
    expect(scored.state.models.length).toBeGreaterThan(0);
    expect(fixture.runtime.residentSurfaceLanguageMemory(cluster)).toBeUndefined();
    const realized = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "realization");
    expect(realized.hydrationPurpose).toBe("realization");
    expect(fixture.runtime.residentSurfaceLanguageMemory(cluster)).toBe(realized);
  });

  it("loads exact request-control schemas, retries read failures, and TTL-caches a successful empty result", async () => {
    const fixture = runtimeFixture({ cacheMs: 100_000 });
    const queries: Array<{ sourceSystem?: string; patternSchemas?: readonly string[] }> = [];
    let fail = true;
    fixture.storage.languageMemory.listLanguagePatterns = async query => {
      queries.push(query ?? {});
      if (fail) throw new Error("temporary pattern-store failure");
      return [];
    };
    await expect(fixture.runtime.requestControlPatternsCached()).rejects.toThrow("temporary pattern-store failure");
    expect(queries).toHaveLength(4);
    fail = false;
    expect(await fixture.runtime.requestControlPatternsCached()).toEqual([]);
    expect(queries).toHaveLength(8);
    expect(await fixture.runtime.requestControlPatternsCached()).toEqual([]);
    expect(queries).toHaveLength(8);
    expect(queries.slice(4).map(query => query.sourceSystem).sort()).toEqual([
      CORPUS_SOURCE_SYSTEM_IDS.dialogue,
      CORPUS_SOURCE_SYSTEM_IDS.corrections,
      "dialogue",
      "corrections"
    ].sort());
    expect(queries.slice(4).every(query => query.patternSchemas?.includes("scce.request_requirement_pattern.v1"))).toBe(true);
    fixture.runtime.invalidate();
    await fixture.runtime.requestControlPatternsCached();
    expect(queries).toHaveLength(12);
  });

  it("loads request controls by the exact learned features observed in this request", async () => {
    const fixture = runtimeFixture({ cacheMs: 100_000 });
    const queries: NonNullable<Parameters<typeof fixture.storage.languageMemory.listLanguagePatterns>[0]>[] = [];
    const control: LanguagePatternRecord = {
      id: "request_requirement_pattern.what-does-the", profileId: "profile.dialogue", patternKind: "semantic_role",
      support: 0.83, entropy: 0.1, evidenceIds: [], updatedAt: 1,
      patternJson: {
        schema: "scce.request_requirement_pattern.v1", sourceSystem: "dialogue", surface: "what does the", anchor: "start",
        selectedAuthority: "factual", requestSpanRole: "control"
      }
    };
    fixture.storage.languageMemory.listLanguagePatterns = async query => {
      queries.push(query ?? {});
      return query?.requestRequirementFeatures?.some(feature => feature.anchor === "start" && feature.surface === "what does the")
        ? [control] : [];
    };

    expect(await fixture.runtime.requestControlPatternsForRequest("What does the admitted source say?")).toEqual([control]);
    expect(queries).toHaveLength(4);
    expect(queries.every(query => query.patternSchemas?.length === 1
      && query.patternSchemas[0] === "scce.request_requirement_pattern.v1"
      && query.requestRequirementFeatures?.some(feature => feature.anchor === "start" && feature.surface === "what does the"))).toBe(true);
    expect(await fixture.runtime.requestControlPatternsForRequest("What does the admitted source say?")).toEqual([control]);
    expect(queries).toHaveLength(4);
    expect(await fixture.runtime.requestControlPatternsForRequest("Where is the observatory?")).toEqual([]);
    expect(queries).toHaveLength(8);
  });

  it("reads stored source labels verbatim and keeps correction controls out of general language profiles", async () => {
    const fixture = runtimeFixture({ cacheMs: 100_000 });
    const spoken = { ...fixture.profile, id: "profile.dialogue" };
    fixture.storage.model.listLanguageProfiles = async () => [fixture.profile, spoken];
    const control = { id: "request_requirement_pattern_correction", profileId: fixture.profile.id, patternKind: "syntax" as const,
      support: 1, entropy: 0, evidenceIds: [], updatedAt: 1,
      patternJson: { schema: "scce.request_requirement_pattern.v1", sourceSystem: "corrections", surface: "fixture control" } };
    fixture.storage.languageMemory.listLanguagePatterns = async query => query?.sourceSystem === "corrections" ? [control] : [];
    expect(await fixture.runtime.requestControlPatternsCached()).toEqual([control]);
    expect((await fixture.runtime.surfaceLanguageProfilesCached()).profiles.map(profile => profile.id)).toEqual([spoken.id]);
  });

  it("loads opaque-key request roles alongside label-key speech models without normalizing the stored query", async () => {
    const fixture = runtimeFixture({ cacheMs: 100_000 });
    const role = { id: "request_requirement_pattern_opaque", profileId: fixture.profile.id, patternKind: "syntax" as const,
      support: 1, entropy: 0, evidenceIds: [], updatedAt: 1,
      patternJson: { schema: "scce.request_requirement_pattern.v1", sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue } };
    const speech = { ...role, id: "creative.observed.compatibility.label", patternKind: "semantic_role" as const,
      patternJson: { schema: "scce.creative_event_compatibility_model.v1", sourceSystem: "dialogue" } };
    fixture.storage.languageMemory.listLanguagePatterns = async query => query?.sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.dialogue ? [role]
      : query?.sourceSystem === "dialogue" ? [speech] : [];
    expect((await fixture.runtime.requestControlPatternsCached()).map(pattern => pattern.id).sort()).toEqual([role.id, speech.id].sort());
  });

  it("seeds request interpretation from canonical population statistics without reading or compiling full histories", async () => {
    const fixture = runtimeFixture({ cacheMs: 100000, languageResolver: () => ({ profile: () => "language.fixture", corpus: () => "language.fixture" }) });
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) });
    const compiled = compiler.compile({ streamId: "stream.fixture", sourceSystem: "wikipedia", profile: fixture.profile,
      sourceVersionId: fixture.profile.sourceVersionId, text: "the captain commands the vessel. the captain guides the vessel. "
        + Array.from({ length: 192 }, (_, index) => `the vessel carries cargo${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}.`).join(" "),
      evidence: [], createdAt: 1, retainObservations: false });
    const fullState = createLanguageMemoryRuntime().hydrate({ models: compiled.models });
    const continuationCounts = Object.fromEntries(fullState.models.flatMap(model => Object.entries(model.continuationCounts)));
    const population = { languageId: "language.fixture", modelCount: compiled.models.length, continuationCounts };
    let historyReads = 0;
    let populationReads = 0;
    const patternQueries: NonNullable<Parameters<typeof fixture.storage.languageMemory.listLanguagePatterns>[0]>[] = [];
    fixture.storage.languageMemory.continuationPopulation = async () => { populationReads++; return population; };
    fixture.storage.languageMemory.listNgramModels = async () => { historyReads++; return compiled.models; };
    fixture.storage.languageMemory.listLanguagePatterns = async query => {
      if (!query?.patternSchemas) patternQueries.push(query ?? {});
      return compiled.patterns;
    };
    clearNgramModelCompilationMemo();
    const seed = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "request-seed", undefined, "", { languageId: population.languageId, purpose: "request_seed" });
    expect(historyReads).toBe(0);
    expect(ngramModelCompilationCount()).toBe(0);
    expect(seed.state.continuationPopulation).toBe(population);
    expect(seed.state.importedPatterns.map(row => row.id)).toEqual(expect.arrayContaining(compiled.patterns.map(row => row.id)));
    expect(patternQueries).toHaveLength(1);
    expect(patternQueries[0]).toMatchObject({
      view: "request_seed",
      languageId: population.languageId,
      limit: 768,
      maxTotalJsonBytes: 32 * 1024 * 1024
    });
    expect(patternQueries[0]!.sourceSystem).toBeUndefined();
    expect(patternQueries[0]!.sourceSystems).toEqual(expect.arrayContaining(["dialogue", "wikipedia", "gutenberg", "oss_docs"]));
    expect(deriveClosedClassWords({ continuationPopulation: seed.state.continuationPopulation })).toEqual(deriveClosedClassWords({ models: fullState.models, continuationPopulation: population }));
    const resident = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "request-seed", undefined, "", { languageId: population.languageId, purpose: "request_seed", residentOnly: true });
    expect(resident).toBe(seed);
    expect(populationReads).toBe(1);
    await expect(fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "realization", undefined, "", { languageId: population.languageId, residentOnly: true })).rejects.toThrow(/was not warmed/u);
    const realization = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "realization", undefined, "", { languageId: population.languageId });
    expect(historyReads).toBeGreaterThan(0);
    expect(realization.state.models).toEqual(fullState.models);
    expect(realization.state).not.toBe(seed.state);
    fixture.runtime.invalidate();
    await expect(fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "request-seed", undefined, "", { languageId: population.languageId, purpose: "request_seed", residentOnly: true })).rejects.toThrow(/was not warmed/u);
  });

  const unavailablePopulations: (LanguageContinuationPopulation | undefined)[] = [undefined, { languageId: "language.foreign", modelCount: 1, continuationCounts: { foreign: 9 } }, { languageId: "language.fixture", modelCount: 0, continuationCounts: {} }, { languageId: "language.fixture", modelCount: 1, continuationCounts: { sparse: 9 } }];
  it.each(unavailablePopulations)("retains canonical model hydration when no valid learned request population is available: %j", async population => {
    const fixture = runtimeFixture({ languageResolver: () => ({ profile: () => "language.fixture", corpus: () => "language.fixture" }) });
    const hasher = createHasher();
    const compiled = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) }).compile({
      streamId: "stream.fixture", sourceSystem: "wikipedia", profile: fixture.profile, sourceVersionId: fixture.profile.sourceVersionId, text: "alpha beta alpha gamma", evidence: [], createdAt: 1, retainObservations: false });
    fixture.storage.languageMemory.continuationPopulation = async () => population;
    fixture.storage.languageMemory.listNgramModels = async () => compiled.models;
    const seed = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "request-seed", undefined, "", { languageId: "language.fixture", purpose: "request_seed" });
    expect(seed.state.models).toHaveLength(compiled.models.length);
    expect(seed.state.continuationPopulation).toBe(population?.languageId === "language.fixture" && population.modelCount > 0 ? population : undefined);
  });

  it("reuses expired warmed language, frame, and source-profile entries without durable calls", async () => {
    const fixture = runtimeFixture();

    const language = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      undefined,
      "source-surface-ambiguous-or-no-signal"
    );
    const frames = await fixture.runtime.requestSemanticFrames("alpha");
    const profiles = await fixture.runtime.sourceOwnedLanguageProfilesCached(["fixture"]);
    const durableCallsAfterWarmup = fixture.totalDurableCalls();

    const residentLanguage = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      undefined,
      "source-surface-ambiguous-or-no-signal",
      undefined,
      "",
      { residentOnly: true }
    );
    const residentFrames = await fixture.runtime.requestSemanticFrames(
      "alpha",
      { residentOnly: true }
    );
    const residentProfiles = await fixture.runtime.sourceOwnedLanguageProfilesCached(
      ["fixture"],
      { residentOnly: true }
    );

    expect(residentLanguage).toBe(language);
    expect(residentLanguage.state.scope).toMatchObject({ mode: "unscoped", degraded: true, purityProven: false });
    expect(residentLanguage.state.models).toEqual([]);
    expect(residentLanguage.state.continuationPopulation).toBeUndefined();
    expect(residentFrames.map(frame => frame.id)).toEqual(frames.map(frame => frame.id));
    expect(residentProfiles.profiles).toBe(profiles.profiles);
    expect(fixture.totalDurableCalls()).toBe(durableCallsAfterWarmup);
  });

  it("keeps absent data for a selected language retryable after caching an unscoped decision", async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "no-language-selected");
    const hydrate = () => fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12, undefined, "language-scoped", undefined, "", { languageId: "language.fixture" }
    );
    const first = await hydrate();
    expect(first.state.models).toEqual([]);
    const callsBeforeRetry = fixture.totalDurableCalls();
    await hydrate();
    expect(fixture.totalDurableCalls()).toBeGreaterThan(callsBeforeRetry);
    await expect(fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12, undefined, "language-scoped", undefined, "", { languageId: "language.fixture", residentOnly: true }
    )).rejects.toThrow(/was not warmed/u);
  });

  it("reuses a compiled language scope after the hydration entry is evicted", async () => {
    const fixture = runtimeFixture({
      surfaceLanguageMemoryCacheMaxEntries: 1,
      languageResolver: () => ({
        profile: () => "language.fixture",
        corpus: () => "language.fixture"
      })
    });
    const first = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12, undefined, "language-scoped", undefined, "first", { languageId: "language.fixture" }
    );
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "evicting-entry");
    const second = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12, undefined, "language-scoped", undefined, "second", { languageId: "language.fixture" }
    );

    expect(second.state).toBe(first.state);
    expect(second.state.scope).toMatchObject({ mode: "language", languageId: "language.fixture" });
  });

  it("bounds secondary scope references and refreshes changed artifacts with stable IDs", async () => {
    const fixture = runtimeFixture({ surfaceLanguageMemoryCacheMaxEntries: 1, languageResolver: () => ({ profile: () => "language.fixture", corpus: () => "language.fixture" }) });
    const hydrate = () => fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "language-scoped", undefined, "", { languageId: "language.fixture" });
    const first = await hydrate();
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "evicting-entry");
    fixture.frame.frameJson = { surface: "replacement", text: "replacement" };
    const second = await hydrate();
    expect(second.state).not.toBe(first.state);
    expect(second.state.importedSemanticFrames[0]?.frameJson).toMatchObject({ text: "replacement" });
    expect(fixture.runtime.cacheOccupancy().scopedStateReferences).toBeLessThanOrEqual(1);
  });

  it("refreshes a scope when persisted model contents change without changing their IDs", async () => {
    const fixture = runtimeFixture({ surfaceLanguageMemoryCacheMaxEntries: 1, languageResolver: () => ({ profile: () => "language.fixture", corpus: () => "language.fixture" }) });
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) });
    const compile = (text: string, createdAt: number) => compiler.compile({ streamId: "stream.fixture", sourceSystem: "oss_code", profile: fixture.profile,
      sourceVersionId: fixture.profile.sourceVersionId, text, evidence: [], createdAt, retainObservations: false }).models;
    let models = compile("alpha alpha", 1);
    const originalId = models[0]!.id;
    fixture.storage.languageMemory.listNgramModels = async () => models;
    fixture.storage.languageMemory.listNgramObservations = async () => { throw new Error("serving must not load raw counts"); };
    const hydrate = () => fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "language-scoped", undefined, "", { languageId: "language.fixture" });
    const first = await hydrate();
    expect(first.state.models[0]?.vocabulary).toContain("alpha");
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "evicting-entry");
    models = compile("beta beta", 2);
    expect(models[0]!.id).toBe(originalId);
    const second = await hydrate();
    expect(second.state).not.toBe(first.state);
    expect(second.state.models[0]?.vocabulary).toContain("beta");
    expect(second.state.models[0]?.vocabulary).not.toContain("alpha");
  });

  it("keeps observation-only serving untrained until a canonical compiled model exists", async () => {
    const fixture = runtimeFixture();
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) });
    const compiled = compiler.compile({ streamId: "stream.fixture", sourceSystem: "oss_code", profile: fixture.profile,
      sourceVersionId: fixture.profile.sourceVersionId, text: "alpha beta alpha beta", evidence: [], createdAt: 1 });
    let rawReads = 0;
    fixture.storage.languageMemory.listNgramObservations = async () => { rawReads += 1; return compiled.observations; };
    fixture.storage.languageMemory.listSemanticFrames = async () => [];
    expect(createLanguageMemoryRuntime().hydrate({ models: [], observations: compiled.observations }).models.length).toBeGreaterThan(0);
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");
    const first = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "canonical-only");
    expect(first.state.models).toEqual([]);
    expect(first.state.importedObservations).toEqual([]);
    expect(first.state.maxOrder).toBe(0);
    expect(createLanguageMemoryRuntime().generate({ state: first.state, contextSymbols: ["alpha"] }).text).toBe("");
    expect(await fixture.runtime.languageMemorySummary()).toMatchObject({ usableModels: 0, observedSymbolCount: 0 });
    expect(rawReads).toBe(0);
    fixture.storage.languageMemory.listNgramModels = async () => compiled.models;
    fixture.runtime.invalidate();
    const trained = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "canonical-only");
    expect(trained.state.models).toHaveLength(1);
    expect(trained.state.models[0]?.vocabulary).toContain("alpha");
    expect(trained.state.importedObservations).toEqual([]);
    expect(rawReads).toBe(0);
  });

  it("fails explicitly on an unwarmed resident-only request without durable calls", async () => {
    const fixture = runtimeFixture();
    const notWarm = /hydrated runtime unavailable: resident .* was not warmed/u;

    await expect(fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      undefined,
      "source-surface-ambiguous-or-no-signal",
      undefined,
      "",
      { residentOnly: true }
    )).rejects.toThrow(notWarm);
    await expect(fixture.runtime.requestSemanticFrames(
      "alpha",
      { residentOnly: true }
    )).rejects.toThrow(notWarm);
    await expect(fixture.runtime.sourceOwnedLanguageProfilesCached(
      ["fixture"],
      { residentOnly: true }
    )).rejects.toThrow(notWarm);

    expect(fixture.totalDurableCalls()).toBe(0);
  });

  it("resolves a never-queried alias from the warmed general profile generation without durable calls", async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.surfaceLanguageProfilesCached();
    const durableCallsAfterWarmup = fixture.totalDurableCalls();

    const residentProfiles = await fixture.runtime.sourceOwnedLanguageProfilesCached(
      ["fixture"],
      { residentOnly: true }
    );

    expect(residentProfiles.profiles.map(profile => profile.id)).toEqual(["profile.fixture"]);
    expect(residentProfiles.clusters).toHaveLength(1);
    expect(fixture.totalDurableCalls()).toBe(durableCallsAfterWarmup);
  });

  it("shares a cold global profile load across concurrent conversational surfaces", async () => {
    const fixture = runtimeFixture();

    const [first, second, third] = await Promise.all([
      fixture.runtime.surfaceLanguageProfilesCached(),
      fixture.runtime.surfaceLanguageProfilesCached(),
      fixture.runtime.surfaceLanguageProfilesCached()
    ]);

    expect(first.profiles).toBe(second.profiles);
    expect(first.profiles).toBe(third.profiles);
    expect(fixture.profileQueries).toHaveLength(1);
    expect(fixture.profileQueries[0]).toMatchObject({ referencedByLanguageMemory: true });
  });

  it("single-flights repeated lazy language warm requests scheduled after visibility", async () => {
    const fixture = runtimeFixture();
    const { clusters } = await fixture.runtime.surfaceLanguageProfilesCached();
    const cluster = clusters[0];
    expect(cluster).toBeDefined();
    const before = fixture.totalDurableCalls();

    fixture.runtime.warmSurfaceLanguageMemory(12, cluster, "visible-response-language");
    fixture.runtime.warmSurfaceLanguageMemory(12, cluster, "visible-response-language");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    await new Promise<void>(resolve => setImmediate(resolve));

    const after = fixture.totalDurableCalls();
    expect(after - before).toBeGreaterThan(0);
    // The scheduling guard is released after the shared load settles, so a
    // later explicit retry remains possible when the source had no models.
    fixture.runtime.warmSurfaceLanguageMemory(12, cluster, "visible-response-language");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.totalDurableCalls()).toBeGreaterThan(after);
  });

  it("shares one durable source-owned profile resolution among concurrent aliases", async () => {
    const fixture = runtimeFixture();

    const [first, second, reordered] = await Promise.all([
      fixture.runtime.sourceOwnedLanguageProfilesCached(["fixture", "alias"]),
      fixture.runtime.sourceOwnedLanguageProfilesCached(["alias", "fixture"]),
      fixture.runtime.sourceOwnedLanguageProfilesCached(["fixture", "alias"])
    ]);

    expect(first.profiles).toBe(second.profiles);
    expect(first.profiles).toBe(reordered.profiles);
    expect(fixture.profileQueries).toHaveLength(1);
    expect(fixture.profileQueries[0]).toMatchObject({
      referencedByLanguageMemory: true,
      sourceDerivedAliases: ["alias", "fixture"]
    });
  });

  it("retrieves surface candidates from durable memory-referenced profiles, not the recent-profile window", async () => {
    const fixture = runtimeFixture();

    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");

    // Global-first: the whole-memory durable set answers without a
    // per-surface trigram query (measured 2.7s/turn to return nothing);
    // the trigram query remains only as the global-miss fallback.
    expect(cluster?.profileIds).toEqual(["profile.fixture"]);
    expect(fixture.profileQueries.at(-1)).toMatchObject({
      referencedByLanguageMemory: true
    });
    expect(fixture.profileQueries.at(-1)?.surfaceNgrams).toBeUndefined();
  });

  it("evicts the oldest entry instead of growing without bound once the request-text-keyed caches exceed their configured size", async () => {
    // Real bug: surfaceLanguageMemoryCache and surfaceCandidateProfileCache
    // are keyed (in part) by a hash of arbitrary request/surface text, so a
    // long-lived process answering many distinct questions grew these Maps
    // by one entry per distinct question forever -- confirmed as the cause
    // of a real OOM crash on both a long-running server and a long test
    // run. maxEntries is set to 2 here so the test can prove eviction with
    // three calls instead of the real 500/2000-entry production default.
    const fixture = runtimeFixture({ cacheMs: 10_000_000, surfaceLanguageMemoryCacheMaxEntries: 2, surfaceCandidateProfileCacheMaxEntries: 2 });

    // The request surface no longer participates in the cache key at all --
    // hydration content depends only on (cluster, role, reason), and the
    // surface-dependent scoping is re-run against the cached payload -- so
    // distinct questions can no longer grow this Map by one entry each.
    // That closes the original growth vector outright; what remains to
    // prove is that the eviction machinery still bounds the entries that
    // legitimately differ, so distinct entries are created here through the
    // unscoped-reason key dimension instead of the request text.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "first-reason", undefined, "any request");
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "second-reason", undefined, "any request");
    const callsBeforeThird = fixture.totalDurableCalls();
    // Re-hydrating the second entry (still within the 2-entry cap) must not
    // trigger a new durable read -- proves the cache itself still works,
    // not just that it evicts everything. The request text differs on
    // purpose: it must NOT cause a miss.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "second-reason", undefined, "a different question entirely");
    expect(fixture.totalDurableCalls()).toBe(callsBeforeThird);

    // A third distinct entry exceeds the 2-entry cap and must evict the
    // first (the oldest), forcing a real durable re-read the next time it
    // is asked for -- if the Map were unbounded, this would still be served
    // from cache with zero new durable calls.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "third-reason", undefined, "any request");
    const callsBeforeReaskingFirst = fixture.totalDurableCalls();
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "first-reason", undefined, "any request");
    expect(fixture.totalDurableCalls()).toBeGreaterThan(callsBeforeReaskingFirst);
  });

  it("evicts on aggregate size even when the entry count is far under its cap", async () => {
    // Real bug, crashed a live 7GB-heap server twice. The entry-count
    // bound above treats every resident language cluster as the same
    // size, but ONE cluster hydration is hundreds of MB of live heap
    // (measured: 42MB of models+units JSON becomes 365MB of heap once
    // parsed and Kneser-Ney-indexed), so a 500-entry cap permits tens of
    // GB. Two earlier attempts at this bound still OOM'd: the first
    // JSON.stringify'd the whole models array, which throws RangeError
    // above V8's ~512MB string cap and was caught into a 0-byte
    // measurement -- so every entry weighed nothing and nothing was ever
    // evicted; the second measured JSON bytes but budgeted them as if
    // they were heap bytes, permitting ~9x too much. maxEntries is left
    // high here precisely so that ONLY the size bound can explain the
    // eviction.
    const fixture = runtimeFixture({
      cacheMs: 10_000_000,
      surfaceLanguageMemoryCacheMaxEntries: 100,
      surfaceLanguageMemoryCacheMaxEstimatedBytes: 1
    });

    // A cluster-scoped hydration, so the entry actually carries records:
    // the unscoped path returns empty arrays and would weigh nothing no
    // matter how the estimate is computed.
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected", undefined, "first request");
    // A second, distinct entry (the unscoped key) pushes the aggregate over
    // the 1-byte budget and must evict the cluster-scoped entry. Request
    // text cannot create the second entry any more -- it is no longer part
    // of the key -- so the key's reason dimension carries it.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "budget-pressure", undefined, "second request");

    // Only one entry may remain resident, so re-asking the older one
    // must force a real durable re-read even though the entry count
    // never came near its 100-entry cap.
    const callsBeforeReaskingFirst = fixture.totalDurableCalls();
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected", undefined, "first request");
    expect(fixture.totalDurableCalls()).toBeGreaterThan(callsBeforeReaskingFirst);
  });

  it("hydrates the learned segmentation population selected for the surface profile", async () => {
    const fixture = runtimeFixture();
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");
    const hydrated = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      cluster,
      "source-cluster-selected"
    );

    expect(hydrated.segmentationPopulationModels.map(record => record.id))
      .toEqual(["segmentation_population.fixture"]);
    expect(fixture.populationQueries).toEqual([{
      profileIds: ["profile.fixture"],
      limit: 12
    }]);
  });
});

function runtimeFixture(cacheOverrides: { cacheMs?: number; surfaceLanguageMemoryCacheMaxEntries?: number; surfaceCandidateProfileCacheMaxEntries?: number; surfaceLanguageMemoryCacheMaxEstimatedBytes?: number; languageResolver?: Parameters<typeof createSurfaceLanguageRuntime>[0]["languageResolver"] } = {}) {
  const calls = {
    active: 0,
    evidence: 0,
    frames: 0,
    models: 0,
    observations: 0,
    patterns: 0,
    populations: 0,
    profiles: 0,
    units: 0
  };
  const profileQueries: Array<{ surfaceNgrams?: readonly string[]; limit?: number; referencedByLanguageMemory?: boolean }> = [];
  const populationQueries: Array<{ profileIds?: readonly string[]; limit?: number }> = [];
  const profile: LanguageProfile = {
    id: "profile.fixture",
    sourceVersionId: "source.fixture" as never,
    discoveredNames: [{
      surface: "fixture",
      evidenceRefs: [],
      sourceVersionRefs: ["source.fixture" as never],
      confidence: 1
    }],
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: languageSurfaceTrigrams("fixture language fixture language")
      .map(ngram => ({ ngram, count: 2 })),
    direction: "ltr",
    entropy: 1,
    createdAt: 1
  };
  const frame: SemanticFrameRecord = {
    id: "frame.alpha",
    frameJson: { surface: "alpha", text: "alpha" },
    embedding: [],
    evidenceIds: [],
    alpha: 1,
    createdAt: 1
  };
  const populationRecord: SegmentationPopulationModelRecord = {
    id: "segmentation_population.fixture",
    model: {
      schema: "scce.segmentation_population_model.v3",
      id: "segmentation_population.fixture",
      rootPopulationId: "population.fixture",
      populations: [],
      assignments: [],
      assignmentIndex: {},
      selection: {
        fitDocumentIds: [],
        modelSelectionDocumentIds: [],
        mergeGuardDocumentIds: [],
        finalEvaluationDocumentIds: [],
        sourceFamilyDisjoint: true,
        holdoutDocumentIds: [],
        candidates: [],
        selectedPopulationCount: 0,
        baselineDescriptionNats: 0,
        selectedDescriptionNats: 0,
        mdlGainNats: 0,
        finalEvaluationNats: 0
      },
      collapseGuard: [],
      audit: {}
    },
    trainingPlanId: "training.fixture",
    profileIds: ["profile.fixture"],
    sourceVersionIds: ["source.fixture" as never],
    createdAt: 1,
    informationLabel: {
      tenantId: "tenant.fixture",
      principals: [],
      compartments: [],
      exportClass: "internal",
      mergePolicy: "same_owner"
    }
  };
  const storage = {
    brainImports: {
      active: async () => {
        calls.active += 1;
        return { activeImportRunIds: [] };
      }
    },
    evidence: {
      getEvidenceBatch: async () => {
        calls.evidence += 1;
        return [];
      }
    },
    languageMemory: {
      listNgramModels: async () => {
        calls.models += 1;
        return [];
      },
      listNgramObservations: async () => {
        calls.observations += 1;
        return [];
      },
      listLanguageUnits: async () => {
        calls.units += 1;
        return [];
      },
      listLanguagePatterns: async () => {
        calls.patterns += 1;
        return [];
      },
      listSemanticFrames: async () => {
        calls.frames += 1;
        return [frame];
      }
    },
    segmentationPopulations: {
      listRecent: async (query: { profileIds?: readonly string[]; limit?: number }) => {
        calls.populations += 1;
        populationQueries.push(query);
        return [populationRecord];
      }
    },
    model: {
      listLanguageProfiles: async (query: { surfaceNgrams?: readonly string[]; limit?: number; referencedByLanguageMemory?: boolean }) => {
        calls.profiles += 1;
        profileQueries.push(query);
        return [profile];
      }
    }
  } as unknown as ScceKernelDeps["storage"];
  const clock = createClock({ fixedTime: 0, stepMs: 100 });
  const hasher = createHasher();
  const runtime = createSurfaceLanguageRuntime({
    deps: { storage, corpusRegistry: [] },
    languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }),
    clock,
    hasher,
    cacheMs: 10,
    profileLimit: 32,
    languageResolver: cacheOverrides.languageResolver,
    ...cacheOverrides
  });

  return {
    runtime,
    storage,
    profile,
    frame,
    profileQueries,
    populationQueries,
    totalDurableCalls: () => Object.values(calls).reduce((sum, count) => sum + count, 0)
  };
}
