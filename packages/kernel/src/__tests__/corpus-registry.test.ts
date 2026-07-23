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
    expect(plan.find(item => item.sourceSystem === "gutenberg")?.querySourceSystems).toEqual(expect.arrayContaining(["gutenberg", canonicalCorpusSourceSystemId("gutenberg")]));
    expect(plan.find(item => item.sourceSystem === "wikipedia")?.querySourceSystems).toEqual(expect.arrayContaining(["wikipedia", "wikimedia", canonicalCorpusSourceSystemId("wikipedia")]));
    expect(plan.every(item => item.limits.ngramModels <= 10)).toBe(true);
  });

  it("hydrates the Mouth language path from non-Wikipedia source systems", async () => {
    const queried: string[] = [];
    const queriedProfileIds: string[][] = [];
    const storage = corpusQueryStorage(queried, queriedProfileIds);
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
    expect(queried).toContain("gutenberg");
    expect(queried).toContain("oss_docs");
    expect(queried).toContain("oss_code");
    expect(queried.filter(source => source === "wikipedia").length).toBeGreaterThan(0);
    expect(queriedProfileIds.length).toBeGreaterThan(0);
    expect(queriedProfileIds.every(profileIds => profileIds.includes("profile.corpus-registry"))).toBe(true);
  });
});

function corpusQueryStorage(queried: string[], queriedProfileIds: string[][]): ScceStorage {
  const events: ScceEvent[] = [];
  const profile: LanguageProfile = {
    id: "profile.corpus-registry",
    sourceVersionId: "source.corpus-registry" as never,
    scripts: [{ script: "script.opaque", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0,
    createdAt: 1
  };
  const remember = async (query?: { sourceSystem?: string; profileIds?: readonly string[] }) => {
    if (query?.sourceSystem) {
      queried.push(query.sourceSystem);
      queriedProfileIds.push([...(query.profileIds ?? [])]);
    }
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
