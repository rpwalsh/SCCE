import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  corpusRegistryEntriesFromConfig,
  trainGutenbergCorpus,
  trainLanguageCorpusText,
  trainOssCorpus,
  trainStoredCorpusConstructions,
  validateConfig,
  type ScceRuntimeConfig
} from "../index.js";
import { canonicalCorpusSourceSystemId, createClock, createHasher, createIdFactory } from "@scce/kernel";
import type {
  EvidenceSpan,
  InformationLabel,
  JsonValue,
  LanguagePatternRecord,
  LanguageProfile,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  ScceEvent,
  ScceStorage,
  SemanticFrameRecord,
  SourceVersion,
  SourceVersionId
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

  it("does not promote auto-induced constructions when no held-out linguistic evidence exists", async () => {
    const fixture = memoryStorage();
    const evidence = [corpusEvidenceSpan("source.no-heldout", constructionFixtureText(), 0)];

    const result = await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/no-heldout",
      text: evidence.map(span => span.text).join("\n"),
      evidence,
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.constructionCandidates).toBeGreaterThan(0);
    expect(result.languageConstructions).toBe(0);
    expect(result.rejectedLanguageConstructions).toBe(result.constructionCandidates);
    expect(fixture.state.patterns.some(pattern => isConstructionBundle(pattern))).toBe(false);
    expect(symbolPatternLearnedPayload(fixture.state)?.constructionPromotion).toBeDefined();
  });

  it("promotes auto-induced constructions only after a separate held-out slice is covered", async () => {
    const fixture = memoryStorage();
    const evidence = Array.from({ length: 20 }, (_, index) =>
      corpusEvidenceSpan(`source.heldout.${index}`, constructionFixtureText(), index * 10_000)
    );

    const result = await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/heldout",
      text: evidence.map(span => span.text).join("\n"),
      evidence,
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.constructionCandidates).toBeGreaterThan(0);
    expect(result.languageConstructions).toBeGreaterThan(0);
    expect(fixture.state.patterns.some(pattern => isConstructionBundle(pattern))).toBe(true);
    const promotion = symbolPatternLearnedPayload(fixture.state)?.constructionPromotion;
    expect(JSON.stringify(promotion)).toContain("heldOutCoverage");
    expect(JSON.stringify(promotion)).toContain("promotedInducedConstructionSets");
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
    expect(fixture.state.patterns.some(pattern => {
      const row = pattern.patternJson;
      return Boolean(row && typeof row === "object" && !Array.isArray(row)
        && (row as Record<string, JsonValue>).schema === "scce.creative_event_construction_pattern.v1");
    })).toBe(false);
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

  it("stops the Gutenberg run gracefully at the heap-safety checkpoint with a resumable report", async () => {
    const root = await tempDir("gutenberg-heap-fixture-");
    await writeFile(path.join(root, "book.txt"), [
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "This text should never be trained because the heap bound trips first.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    // The option floor is 256 MiB; any live Node process running this test
    // suite is far above that, so the checkpoint deterministically trips
    // before the first file -- proving the bound stops the run instead of
    // letting in-process training continue toward a real OOM.
    const result = await trainGutenbergCorpus({
      storage: fixture.storage,
      rootPath: root,
      maxFilesPerRun: 5,
      maxFileBytes: 100_000,
      heapCheckpointMb: 1
    });

    expect(result.stoppedByHeapSafetyBound).toBe(true);
    expect(result.filesTrained).toBe(0);
    expect(result.heapMiBAtExit).toBeGreaterThan(0);
    expect(fixture.state.sourceVersions.length).toBe(0);
  });

  it("trains stored-corpus constructions from evidence-backed blobs, prioritized and byte-bounded", async () => {
    const fixture = memoryStorage();
    const article = (title: string, body: string) =>
      `'${title}' is a subject with real prose. ${`${body} The predicate structure recurs across sentences. It recurs again in a second clause. `.repeat(8)}`;
    const blobs = new Map<string, Buffer>([
      ["sha256_high", Buffer.from(article("High Alpha", "The engine was designed by a careful team."))],
      ["sha256_low", Buffer.from(article("Low Alpha", "The bridge was painted by a different crew."))]
    ]);
    (fixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions = async () => [
      { sourceVersionId: "sv-high", contentHash: "sha256_high", canonicalUri: "https://example.org/high", byteLength: 160, maxAlpha: 0.9, promotedSpanCount: 3 },
      { sourceVersionId: "sv-low", contentHash: "sha256_low", canonicalUri: "https://example.org/low", byteLength: 160, maxAlpha: 0.2, promotedSpanCount: 1 }
    ];
    (fixture.storage as unknown as Record<string, unknown>).blobs = {
      get: async (hash: string) => {
        const found = blobs.get(hash);
        if (!found) throw new Error(`missing blob ${hash}`);
        return found;
      },
      put: async (content: Uint8Array) => `sha256_stored_${content.length}`,
      exists: async () => true
    };

    const report = await trainStoredCorpusConstructions({
      storage: fixture.storage,
      batchBytes: 100,
      maxTotalBytes: 4096
    });

    expect(report.schema).toBe("scce.storedCorpusConstructionTrainReport.v1");
    expect(report.batchesTrained).toBeGreaterThanOrEqual(1);
    expect(report.articlesTrained).toBe(2);
    expect(report.batchesFailed).toEqual([]);
    expect(report.stoppedByHeapSafetyBound).toBe(false);
    // Everything trains under the wikipedia corpus identity so hydration
    // clusters pick the constructions up like any other corpus lane.
    expect(allSourceSystems(fixture.state).size).toBeGreaterThan(0);
    expect(report.reports.every(item => item.streamUri.includes("construction-training"))).toBe(true);

    // A one-byte total budget still trains the top-priority batch only.
    const boundedFixture = memoryStorage();
    (boundedFixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions =
      (fixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions;
    (boundedFixture.storage as unknown as Record<string, unknown>).blobs = (fixture.storage as unknown as Record<string, unknown>).blobs;
    // Each repeated article is ~1KB; the 1024-byte floor on the total
    // budget admits the top-priority article, then stops before the next.
    const bounded = await trainStoredCorpusConstructions({
      storage: boundedFixture.storage,
      batchBytes: 100,
      maxTotalBytes: 1024
    });
    expect(bounded.articlesTrained).toBe(1);
  });

  it("records one file's training failure as an explicit skip and keeps training the rest", async () => {
    const root = await tempDir("oss-failure-fixture-");
    await writeFile(path.join(root, "README.md"), "Readable docs explain the pump API and the maintenance flow.", "utf8");
    await writeFile(path.join(root, "SECURITY.md"), "Report vulnerabilities through the responsible disclosure flow.", "utf8");
    const fixture = memoryStorage();
    // A storage whose language-memory writes fail exactly once poisons the
    // first file's training transaction; the second file must still train.
    let failures = 0;
    const poisoned = {
      ...fixture.storage,
      languageMemory: {
        ...fixture.storage.languageMemory,
        putNgramObservationsBatch: async (rows: unknown[]) => {
          if (failures === 0) {
            failures += 1;
            throw new Error("synthetic language-memory write failure");
          }
          return fixture.storage.languageMemory.putNgramObservationsBatch(rows as never);
        }
      }
    } as typeof fixture.storage;

    const result = await trainOssCorpus({
      storage: poisoned,
      rootPath: root,
      maxFiles: 10,
      maxFileBytes: 100_000,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.stoppedByHeapSafetyBound).toBe(false);
    expect(result.docsTrained).toBe(1);
    expect(result.filesSkipped.some(row => row.reason.startsWith("training_failed: synthetic language-memory write failure"))).toBe(true);
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
    security: {
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" },
      defaultSourceInformationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["test"], exportClass: "restricted", mergePolicy: "isolated" }
    },
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

const corpusTestClock = createClock({ fixedTime: 101_000, stepMs: 1 });
const corpusTestHasher = createHasher();
const corpusTestIds = createIdFactory({
  clock: corpusTestClock,
  hasher: corpusTestHasher,
  deterministicReplay: true,
  namespace: "corpus-training-test"
});
const publicCorpusInformationLabel: InformationLabel = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public",
  mergePolicy: "same_owner"
};

function constructionFixtureText(): string {
  return [
    "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
    "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
  ].join(" ");
}

function corpusEvidenceSpan(sourceVersionKey: string, text: string, charStart: number): EvidenceSpan {
  const bytes = Buffer.from(text, "utf8");
  const contentHash = corpusTestIds.contentHash(bytes);
  const sourceVersionId = corpusTestIds.sourceVersionId(`${sourceVersionKey}\u001f${text}`) as SourceVersionId;
  return {
    id: corpusTestIds.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash: contentHash }),
    sourceId: corpusTestIds.sourceId("fixture", `fixture://${sourceVersionKey}`),
    sourceVersionId,
    chunkId: corpusTestIds.chunkId({ sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: contentHash }),
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: bytes.byteLength,
    charStart,
    charEnd: charStart + [...text].length,
    text,
    textPreview: text.slice(0, 200),
    languageHints: {},
    scriptHints: {},
    trustVector: {},
    provenance: {},
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: corpusTestClock.now(),
    informationLabel: publicCorpusInformationLabel
  };
}

function isConstructionBundle(pattern: LanguagePatternRecord): boolean {
  const row = pattern.patternJson;
  return Boolean(row && typeof row === "object" && !Array.isArray(row)
    && (row as Record<string, JsonValue>).schema === "scce.language_construction_pattern.v1");
}

function symbolPatternLearnedPayload(state: MemoryState): Record<string, JsonValue> | undefined {
  const payload = state.events.find(row => row.typeId === "SymbolPatternLearned")?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, JsonValue>
    : undefined;
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
    transaction: async <T>(fn: () => Promise<T>) => fn(),
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