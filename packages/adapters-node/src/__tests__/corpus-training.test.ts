import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  corpusRegistryEntriesFromConfig,
  trainGutenbergCorpus,
  trainLanguageCorpusText,
  trainOssCorpus,
  validateConfig,
  type ScceRuntimeConfig
} from "../index.js";
import { canonicalCorpusSourceSystemId } from "@scce/kernel";
import type {
  EvidenceSpan,
  JsonValue,
  LanguagePatternRecord,
  LanguageProfile,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  ScceEvent,
  ScceStorage,
  SemanticFrameRecord,
  SourceVersion
} from "@scce/kernel";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("multi-corpus training", () => {
  it("keeps old Wikipedia-only config valid and parses multi-corpus config into registry entries", () => {
    const oldConfig = configFixture({
      wikipedia: {
        enabled: true,
        dumpPath: "data/wiki/enwiki.xml.bz2",
        indexPath: "data/wiki/enwiki-index.txt.bz2",
        allowedNamespaces: [0],
        memorySafetyBoundMb: 1024,
        ngramMaxOrder: 4
      }
    });
    validateConfig(oldConfig, "old");
    expect(corpusRegistryEntriesFromConfig(oldConfig).find(item => item.sourceSystem === "wikipedia")?.localPath).toBe("data/wiki/enwiki.xml.bz2");

    const nextConfig = configFixture({
      gutenberg: { enabled: true, rootPath: "corpus/gutenberg", maxFilesPerRun: 2, ngramMaxOrder: 5 },
      oss: { enabled: true, rootPath: "corpus/oss", repos: ["vite"], includeDocs: true, includeSource: true, ngramMaxCountersPerOrder: 256 }
    });
    validateConfig(nextConfig, "next");
    const registry = corpusRegistryEntriesFromConfig(nextConfig);
    expect(registry.find(item => item.sourceSystem === "gutenberg")?.enabled).toBe(true);
    expect(registry.find(item => item.sourceSystem === "gutenberg")?.ngram.maxOrder).toBe(5);
    expect(registry.find(item => item.sourceSystem === "oss_docs")?.enabled).toBe(true);
    expect(registry.find(item => item.sourceSystem === "oss_code")?.ngram.maxCountersPerOrder).toBe(256);
  });

  it("stamps shared trainer artifacts with the requested source system", async () => {
    const fixture = memoryStorage();
    const result = await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/1",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(result.sourceSystem).toBe("wikipedia");
    expect(result.sourceSystemId).toBe(canonicalCorpusSourceSystemId("wikipedia"));
    expect(result.sourceSystemId).not.toBe(result.sourceSystem);
    expect(fixture.state.observations.length).toBeGreaterThan(0);
    expect(fixture.state.models.length).toBeGreaterThan(0);
    expect(fixture.state.units.length).toBeGreaterThan(0);
    expect(fixture.state.patterns.length).toBeGreaterThan(0);
    expect(fixture.state.events.some(event => event.typeId === "SymbolPatternLearned" && sourceSystemOf(event.payload) === "wikipedia")).toBe(true);
    expect(fixture.state.observations.every(row => sourceSystemIdOf(row.metadata) === result.sourceSystemId)).toBe(true);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["wikipedia"]));
  });

  it("trains a Project Gutenberg fixture into source-stamped language memory", async () => {
    const root = await tempDir("gutenberg-fixture-");
    await writeFile(path.join(root, "book.txt"), [
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "Chapter 1",
      "",
      "The workshop had a patient rhythm. The sentences were public-domain training material.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    const result = await trainGutenbergCorpus({ storage: fixture.storage, rootPath: root, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    expect(result.filesTrained).toBe(1);
    expect(result.totals.ngramObservations).toBeGreaterThan(0);
    expect(fixture.state.sourceVersions.length).toBe(1);
    expect(fixture.state.evidence.length).toBeGreaterThan(0);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["gutenberg"]));
  });

  it("trains OSS docs and code as separate source systems through the engineering corpus scanner", async () => {
    const root = await tempDir("oss-fixture-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "Readable docs explain the pump API and the maintenance flow.", "utf8");
    await writeFile(path.join(root, "src", "pump.ts"), [
      "// Stabilize pump pressure before returning a status object.",
      "export function stabilizePumpPressure(input: number) {",
      "  return { pressureReading: input, stable: input > 0 };",
      "}"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    const result = await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 10, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    expect(result.docsTrained).toBe(1);
    expect(result.codeTrained).toBe(1);
    expect(result.totals.oss_docs.ngramObservations).toBeGreaterThan(0);
    expect(result.totals.oss_code.ngramObservations).toBeGreaterThan(0);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["oss_docs", "oss_code"]));
    expect(JSON.stringify(result).toLowerCase()).not.toContain("provider");
  });
});

function configFixture(corpora: ScceRuntimeConfig["runtime"]["corpora"]): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873" },
    database: { url: "postgresql://user:pass@localhost:5432/scce", schema: "scce_test" },
    runtime: {
      workspaceRoot: ".",
      tempRoot: ".tmp",
      maxFileBytes: 1_000_000,
      maxChunkBytes: 64_000,
      allowedRoots: ["."],
      excludedPaths: ["node_modules", "dist"],
      tools: {},
      corpora
    },
    connectors: {},
    policy: {
      allowMutation: false,
      requireTwoPhaseCommit: true,
      dryRunByDefault: true,
      maxNetworkRequests: 0,
      maxToolCalls: 0,
      maxSpendCents: 0,
      alphaRiskCeiling: 0.5,
      encryptSecretsAtRest: true
    }
  };
}

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

interface MemoryState {
  events: ScceEvent[];
  sourceVersions: SourceVersion[];
  evidence: EvidenceSpan[];
  profiles: LanguageProfile[];
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  frames: SemanticFrameRecord[];
}

function memoryStorage(): { storage: ScceStorage; state: MemoryState } {
  const state: MemoryState = {
    events: [],
    sourceVersions: [],
    evidence: [],
    profiles: [],
    observations: [],
    models: [],
    units: [],
    patterns: [],
    frames: []
  };
  const storage = {
    events: {
      append: async (event: ScceEvent) => { state.events.push(event); },
      appendBatch: async (events: ScceEvent[]) => { state.events.push(...events); },
      readEpisode: async () => state.events,
      readRange: async () => state.events,
      latestLedgerHash: async () => state.events.at(-1)?.hash ?? ""
    },
    evidence: {
      putSourceVersion: async (source: SourceVersion) => { state.sourceVersions.push(source); },
      putEvidenceSpan: async (span: EvidenceSpan) => { state.evidence.push(span); },
      putEvidenceSpans: async (spans: readonly EvidenceSpan[]) => { state.evidence.push(...spans); },
      promoteEvidence: async (ids: EvidenceSpan["id"][]) => ids.length,
      getEvidence: async () => null,
      getEvidenceBatch: async () => [],
      searchEvidence: async () => [],
      sourceVersionsForEvidence: async () => []
    },
    model: {
      readModel: async () => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async (profile: LanguageProfile) => { state.profiles.push(profile); },
      listLanguageProfiles: async () => state.profiles
    },
    languageMemory: {
      putNgramObservation: async (row: NgramObservation) => { state.observations.push(row); },
      putNgramObservationsBatch: async (rows: readonly NgramObservation[]) => { state.observations.push(...rows); },
      putNgramModel: async (row: NgramModelRecord) => { state.models.push(row); },
      putNgramModels: async (rows: readonly NgramModelRecord[]) => { state.models.push(...rows); },
      putLanguageUnit: async (row: LanguageUnitRecord) => { state.units.push(row); },
      putLanguageUnits: async (rows: readonly LanguageUnitRecord[]) => { state.units.push(...rows); },
      putLanguagePattern: async (row: LanguagePatternRecord) => { state.patterns.push(row); },
      putLanguagePatterns: async (rows: readonly LanguagePatternRecord[]) => { state.patterns.push(...rows); },
      putSemanticFrame: async (row: SemanticFrameRecord) => { state.frames.push(row); },
      putSemanticFrames: async (rows: readonly SemanticFrameRecord[]) => { state.frames.push(...rows); },
      putTranslationAlignment: async () => undefined,
      listNgramModels: async () => state.models,
      listNgramObservations: async () => state.observations,
      listLanguageUnits: async () => state.units,
      listLanguagePatterns: async () => state.patterns,
      listSemanticFrames: async () => state.frames,
      listTranslationAlignments: async () => []
    },
    init: async () => undefined,
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined,
    conversation: unusedStore(),
    ingestion: unusedStore(),
    graph: unusedStore(),
    blobs: unusedStore(),
    quarantine: unusedStore(),
    proofs: unusedStore(),
    constructs: unusedStore(),
    capabilities: unusedStore(),
    forecasts: unusedStore(),
    benchmarks: unusedStore(),
    brainImports: unusedStore(),
    corrections: unusedStore(),
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore(),
    dialogueMemory: unusedStore()
  } as unknown as ScceStorage;
  return { storage, state };
}

function allSourceSystems(state: MemoryState): Set<string> {
  const values = [
    ...state.observations.map(row => sourceSystemOf(row.metadata)),
    ...state.models.map(row => sourceSystemOf(row.modelJson)),
    ...state.units.map(row => sourceSystemOf(row.metadata)),
    ...state.patterns.map(row => sourceSystemOf(row.patternJson)),
    ...state.frames.map(row => sourceSystemOf(row.frameJson))
  ].filter((value): value is string => Boolean(value));
  return new Set(values);
}

function sourceSystemOf(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sourceSystem = (value as Record<string, JsonValue>).sourceSystem;
  return typeof sourceSystem === "string" ? sourceSystem : undefined;
}

function sourceSystemIdOf(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sourceSystemId = (value as Record<string, JsonValue>).sourceSystemId;
  return typeof sourceSystemId === "string" ? sourceSystemId : undefined;
}

function unusedStore(): Record<string, (...args: never[]) => Promise<unknown>> {
  return new Proxy({}, { get: () => async () => null }) as Record<string, (...args: never[]) => Promise<unknown>>;
}
