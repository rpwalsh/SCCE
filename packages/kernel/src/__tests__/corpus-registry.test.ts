// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { getFixtureLanguagePatternProjection, replaceFixtureLanguagePatternProjection } from "./language-pattern-projection-fixture.js";
import { describe, expect, it } from "vitest";
import {
  createCorpusRegistry,
  createScceKernel,
  CORPUS_ROLE_IDS,
  CORPUS_SOURCE_SYSTEM_IDS,
  CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
  REQUEST_REQUIREMENT_PATTERN_SCHEMA,
  canonicalCorpusSourceSystemId,
  languageMemoryEligibleCorpora,
  languageMemoryHydrationPlan,
  type ScceEvent,
  type ScceStorage,
  type LanguageProfile
} from "../index.js";
import type { EventRangeQuery } from "../storage.js";
import type { EpisodeId } from "../types.js";
import type { LanguageIdentityRecord } from "../language-identity.js";
import { filterEpisodeEvents, filterEventRange } from "./event-range-fixture.js";

type LanguageMemoryQuery = { sourceSystem?: string; profileIds?: readonly string[]; patternSchemas?: readonly string[]; limit?: number };

describe("corpus registry", () => {
  it("selects enabled language-memory corpora with bounded hydration limits", () => {
    const registry = createCorpusRegistry([
      { sourceSystem: "gutenberg", enabled: true, hydration: { priority: 120, limits: { ngramModels: 7 } } },
      { sourceSystem: "oss_docs", enabled: true },
      { sourceSystem: "oss_code", enabled: false }
    ]);

    const eligible = languageMemoryEligibleCorpora(registry).map(item => item.sourceSystem);
    expect(eligible).toContain("gutenberg");
    expect(eligible).toContain("oss_docs");
    expect(eligible).not.toContain("oss_code");

    const gutenberg = registry.find(item => item.sourceSystem === "gutenberg");
    expect(gutenberg?.sourceSystemId).toBe(canonicalCorpusSourceSystemId("gutenberg"));
    expect(gutenberg?.sourceSystemId).not.toBe(gutenberg?.sourceSystem);

    const plan = languageMemoryHydrationPlan(registry, { ngramModels: 10 });
    expect(plan.find(item => item.sourceSystem === "gutenberg")?.limits.ngramModels).toBe(7);
    expect(plan.find(item => item.sourceSystem === "gutenberg")?.querySourceSystems).toEqual(["gutenberg"]);
    expect(plan.find(item => item.sourceSystem === "wikipedia")?.querySourceSystems).toEqual(["wikipedia"]);
    expect(plan.every(item => item.limits.ngramModels <= 10)).toBe(true);
  });

  it("does not guess a dominant Mouth language profile during surface-free warmup", async () => {
    const queried: LanguageMemoryQuery[] = [];
    const storage = corpusQueryStorage(queried);
    const kernel = createScceKernel({
      storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async () => ({ build: commandResult(), test: commandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      corpusRegistry: createCorpusRegistry([
        { sourceSystem: "gutenberg", enabled: true },
        { sourceSystem: "oss_docs", enabled: true },
        { sourceSystem: "oss_code", enabled: true }
      ])
    });

    const result = await kernel.warmup({ language: true, graph: false, brain: false, profile: false, corrections: false });

    expect(result.language?.loaded).toBe(true);
    const exactProfileQueries = queried.filter(query => (query.profileIds?.length ?? 0) > 0);
    expect(exactProfileQueries).toEqual([]);
    const controlQueries = queried.filter(query => query.sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.corrections
      || query.sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.dialogue);
    expect(controlQueries.map(query => query.sourceSystem).sort()).toEqual([
      CORPUS_SOURCE_SYSTEM_IDS.corrections,
      CORPUS_SOURCE_SYSTEM_IDS.dialogue
    ].sort());
    expect(controlQueries.every(query => query.patternSchemas?.length === 2
      && query.patternSchemas.includes(REQUEST_REQUIREMENT_PATTERN_SCHEMA)
      && query.patternSchemas.includes(CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA)
      && query.limit === 2048)).toBe(true);
  });

  it("skips the language capability entirely when startup asks for a lightweight warmup", async () => {
    const queried: LanguageMemoryQuery[] = [];
    const kernel = createScceKernel({
      storage: corpusQueryStorage(queried),
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async () => ({ build: commandResult(), test: commandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      corpusRegistry: createCorpusRegistry([{ sourceSystem: "gutenberg", enabled: true }])
    });

    const result = await kernel.warmup({ language: false, graph: false, brain: false, profile: false, corrections: false });

    expect(result.language).toBeUndefined();
    expect(queried).toEqual([]);
  });

  it("warms one canonical request seed by typed natural-language role and reuses it", async () => {
    const queried: LanguageMemoryQuery[] = [];
    const storage = corpusQueryStorage(queried);
    const natural = languageIdentity("language.natural", [
      { corpusRoleId: CORPUS_ROLE_IDS.dialogue, count: 8 },
      { corpusRoleId: CORPUS_ROLE_IDS.publicDomainProse, count: 12 }
    ]);
    const symbolic = languageIdentity("language.symbolic", [
      { corpusRoleId: CORPUS_ROLE_IDS.softwareSymbolic, count: 500 }
    ]);
    storage.languageIdentities = identityStore([natural, symbolic]);
    const kernel = createScceKernel({
      storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async () => ({ build: commandResult(), test: commandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      corpusRegistry: createCorpusRegistry([
        { sourceSystem: "gutenberg", enabled: true },
        { sourceSystem: "oss_docs", enabled: true },
        { sourceSystem: "oss_code", enabled: true }
      ])
    });

    const result = await kernel.warmup({ language: false, requestLanguage: true, graph: false, brain: false, profile: false, corrections: false });

    expect(result.language).toBeUndefined();
    expect(result.requestLanguage).toMatchObject({ loaded: true, languageId: natural.id });
    expect(queried.some(query => query.sourceSystem === "oss_code")).toBe(false);
    expect(queried.length).toBeGreaterThan(0);
    const queriesAfterWarmup = queried.length;

    await kernel.warmup({ language: false, requestLanguage: true, graph: false, brain: false, profile: false, corrections: false });

    expect(queried).toHaveLength(queriesAfterWarmup);
  });

  it("warms general request language instead of a larger software-document identity", async () => {
    const queried: LanguageMemoryQuery[] = [];
    const storage = corpusQueryStorage(queried);
    const general = languageIdentity("language.general", [
      { corpusRoleId: CORPUS_ROLE_IDS.dialogue, count: 18 },
      { corpusRoleId: CORPUS_ROLE_IDS.encyclopedic, count: 12 }
    ]);
    const documentation = languageIdentity("language.documentation", [
      { corpusRoleId: CORPUS_ROLE_IDS.softwareDocumentation, count: 900 }
    ]);
    storage.languageIdentities = identityStore([documentation, general]);
    const kernel = createScceKernel({
      storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async () => ({ build: commandResult(), test: commandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) }
    });

    const result = await kernel.warmup({ language: false, requestLanguage: true, graph: false, brain: false, profile: false, corrections: false });

    expect(result.requestLanguage).toMatchObject({ loaded: true, languageId: general.id });
  });

  it("leaves request-language warmup unresolved when natural role evidence is tied", async () => {
    const queried: LanguageMemoryQuery[] = [];
    const storage = corpusQueryStorage(queried);
    storage.languageIdentities = identityStore([
      languageIdentity("language.one", [{ corpusRoleId: CORPUS_ROLE_IDS.publicDomainProse, count: 3 }]),
      languageIdentity("language.two", [{ corpusRoleId: CORPUS_ROLE_IDS.dialogue, count: 3 }]),
      languageIdentity("language.symbolic", [{ corpusRoleId: CORPUS_ROLE_IDS.softwareSymbolic, count: 50 }])
    ]);
    const kernel = createScceKernel({
      storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async () => ({ build: commandResult(), test: commandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) }
    });

    const result = await kernel.warmup({ language: false, requestLanguage: true, graph: false, brain: false, profile: false, corrections: false });

    expect(result.requestLanguage).toMatchObject({ loaded: false });
    expect(queried).toEqual([]);
  });

  it("defers source-owned language hydration until a source is selected", async () => {
    const queried: LanguageMemoryQuery[] = [];
    const kernel = createScceKernel({
      storage: corpusQueryStorage(queried, true),
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async () => ({ build: commandResult(), test: commandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      corpusRegistry: createCorpusRegistry([{ sourceSystem: "gutenberg", enabled: true }])
    });

    await kernel.warmup({ language: true, graph: false, brain: false, profile: false, corrections: false });

    const exactProfileQueries = queried.filter(query => (query.profileIds?.length ?? 0) > 0);
    expect(exactProfileQueries).toEqual([]);
  });
});

function corpusQueryStorage(
  queried: LanguageMemoryQuery[],
  sourceOwned = false
): ScceStorage {
  const events: ScceEvent[] = [];
  const profile: LanguageProfile = {
    id: "profile.corpus-registry",
    sourceVersionId: "source.corpus-registry" as never,
    ...(sourceOwned ? {
      discoveredNames: [{
        surface: "language.fixture",
        evidenceRefs: [],
        sourceVersionRefs: ["source.corpus-registry" as never],
        confidence: 1
      }]
    } : {}),
    scripts: [{ script: "script.opaque", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0,
    createdAt: 1
  };
  const remember = async (query?: LanguageMemoryQuery) => {
    queried.push({
      sourceSystem: query?.sourceSystem,
      profileIds: [...(query?.profileIds ?? [])],
      patternSchemas: query?.patternSchemas ? [...query.patternSchemas] : undefined,
      limit: query?.limit
    });
    return [];
  };
  return {
    events: {
      append: async (event: ScceEvent) => { events.push(event); },
      appendBatch: async (rows: ScceEvent[]) => { events.push(...rows); },
      readEpisode: async (episodeId: EpisodeId) => filterEpisodeEvents(events, episodeId),
      readRange: async (query: EventRangeQuery) => filterEventRange(events, query),
      latestLedgerHash: async () => events.at(-1)?.hash ?? ""
    },
    languageMemory: {
      putNgramObservation: async () => undefined,
      putNgramObservationsBatch: async () => undefined,
      putNgramModel: async () => undefined,
      putLanguageUnit: async () => undefined,
      getLanguagePatternProjection: getFixtureLanguagePatternProjection,
      replaceLanguagePatternProjection: replaceFixtureLanguagePatternProjection,
      putLanguagePattern: async () => undefined,
      putSemanticFrame: async () => undefined,
      putTranslationAlignment: async () => undefined,
      continuationPopulation: async ({ languageId }: { languageId: string }) => ({ languageId, modelCount: 1, continuationCounts: { a: 1 } }),
      listNgramModels: remember,
      listNgramObservations: remember,
      listLanguageUnits: remember,
      listLanguagePatterns: remember,
      listSemanticFrames: async (query: { sourceSystem?: string; profileIds?: readonly string[] }) => {
        await remember(query);
        return [{ id: "frame.request-seed", frameJson: { surface: "fixture" }, embedding: [], evidenceIds: [], alpha: 1, createdAt: 1 }];
      },
      listTranslationAlignments: async () => []
    },
    brainImports: {
      putLedger: async () => undefined,
      listLedger: async () => [],
      summarize: async () => ({ activeImportRunIds: [], importedLanguagePriorCount: 0, importedGraphPriorCount: 0, importedDirectEvidenceCount: 0, profileExcerptEvidenceCount: 0, importedLearnedPriorCount: 0, importedProgramPriorCount: 0, unknownPriorCount: 0, runs: [] }),
      active: async () => ({ activeImportRunIds: [] })
    },
    model: {
      listLanguageProfiles: async () => [profile]
    },
    init: async () => undefined,
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined,
    conversation: unusedStore(),
    ingestion: unusedStore(),
    graph: unusedStore(),
    evidence: unusedStore(),
    blobs: unusedStore(),
    quarantine: unusedStore(),
    proofs: unusedStore(),
    constructs: unusedStore(),
    capabilities: unusedStore(),
    forecasts: unusedStore(),
    benchmarks: unusedStore(),
    corrections: unusedStore(),
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore(),
    dialogueMemory: unusedStore()
  } as unknown as ScceStorage;
}

function languageIdentity(id: string, corpusRoles: LanguageIdentityRecord["corpusRoles"]): LanguageIdentityRecord {
  return {
    schema: "scce.language_identity.v2",
    id,
    script: "script.fixture",
    directions: [{ direction: "unknown", count: 1 }],
    closedClass: [],
    families: [],
    corpusRoles,
    profileCount: corpusRoles.reduce((sum, role) => sum + role.count, 0),
    membershipCut: 0,
    createdAt: 1
  };
}

function identityStore(identities: readonly LanguageIdentityRecord[]) {
  return {
    putIdentities: async () => undefined,
    listIdentities: async () => [...identities],
    assignProfileLanguages: async () => undefined,
    listProfileLanguages: async () => [],
    listProfileSignatures: async () => []
  };
}

function unusedStore(): Record<string, (...args: never[]) => Promise<unknown>> {
  return new Proxy({}, { get: () => async () => null }) as Record<string, (...args: never[]) => Promise<unknown>>;
}

function commandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
