import { describe, expect, it } from "vitest";
import {
  createCorpusRegistry,
  createScceKernel,
  canonicalCorpusSourceSystemId,
  languageMemoryEligibleCorpora,
  languageMemoryHydrationPlan,
  type ScceEvent,
  type ScceStorage,
  type LanguageProfile
} from "../index.js";

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
    const queried: Array<{ sourceSystem?: string; profileIds: string[] }> = [];
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
    const exactProfileQueries = queried.filter(query => query.profileIds.length > 0);
    expect(exactProfileQueries).toEqual([]);
    expect(queried.some(query => query.sourceSystem === "corrections")).toBe(true);
  });

  it("warms an explicitly source-owned language cluster once by exact profile", async () => {
    const queried: Array<{ sourceSystem?: string; profileIds: string[] }> = [];
    const kernel = createScceKernel({
      storage: corpusQueryStorage(queried, true),
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async () => ({ build: commandResult(), test: commandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      corpusRegistry: createCorpusRegistry([{ sourceSystem: "gutenberg", enabled: true }])
    });

    await kernel.warmup({ language: true, graph: false, brain: false, profile: false, corrections: false });

    const exactProfileQueries = queried.filter(query => query.profileIds.length > 0);
    expect(exactProfileQueries).toHaveLength(5);
    expect(exactProfileQueries.every(query => query.sourceSystem === undefined)).toBe(true);
    expect(exactProfileQueries.every(query => query.profileIds.includes("profile.corpus-registry"))).toBe(true);
  });
});

function corpusQueryStorage(
  queried: Array<{ sourceSystem?: string; profileIds: string[] }>,
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
  const remember = async (query?: { sourceSystem?: string; profileIds?: readonly string[] }) => {
    queried.push({
      sourceSystem: query?.sourceSystem,
      profileIds: [...(query?.profileIds ?? [])]
    });
    return [];
  };
  return {
    events: {
      append: async (event: ScceEvent) => { events.push(event); },
      appendBatch: async (rows: ScceEvent[]) => { events.push(...rows); },
      readEpisode: async () => events,
      readRange: async () => events,
      latestLedgerHash: async () => events.at(-1)?.hash ?? ""
    },
    languageMemory: {
      putNgramObservation: async () => undefined,
      putNgramObservationsBatch: async () => undefined,
      putNgramModel: async () => undefined,
      putLanguageUnit: async () => undefined,
      putLanguagePattern: async () => undefined,
      putSemanticFrame: async () => undefined,
      putTranslationAlignment: async () => undefined,
      listNgramModels: remember,
      listNgramObservations: remember,
      listLanguageUnits: remember,
      listLanguagePatterns: remember,
      listSemanticFrames: remember,
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

function unusedStore(): Record<string, (...args: never[]) => Promise<unknown>> {
  return new Proxy({}, { get: () => async () => null }) as Record<string, (...args: never[]) => Promise<unknown>>;
}

function commandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
