// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  corpusRegistryEntriesFromConfig,
  trainDialogueCorpus,
  trainGutenbergCorpus,
  trainLanguageCorpusText,
  trainOssCorpus,
  trainStoredCorpusConstructions,
  validateConfig,
  type ScceRuntimeConfig
} from "../index.js";
import { canonicalCorpusSourceSystemId, createClock, createHasher, createIdFactory, resolveEvidenceSourceIdentity, CORPUS_ROLE_IDS } from "@scce/kernel";
import { prepareLanguageCorpusTraining, commitLanguageCorpusTraining } from "../language-corpus-trainer.js";
import { blobContentHash } from "../postgres.js";
import type {
  EvidenceSpan,
  InformationLabel,
  IngestionCheckpoint,
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

describe("learned rows carry the shard's provenance once", () => {
  it("stamps units, patterns, frames and models without the page list and keeps it on the learned event", async () => {
    const { storage, state } = memoryStorage();
    const input = {
      storage, sourceSystem: "gutenberg", streamUri: "fixture://provenance-once",
      text: "A reader opens a book. Another reader closes the same book. ".repeat(3), createdAt: 1700000000000,
      languageOnly: true, ngramMaxOrder: 2, ngramVocabularyLimit: 32,
      corpusMetadata: { shardUri: "fixture://shard/1", pages: 2, sourceVersionIds: ["version.a", "version.b"] }
    };
    const report = await commitLanguageCorpusTraining(input, await prepareLanguageCorpusTraining(input));
    expect(report.ngramModels).toBeGreaterThan(0);
    for (const model of state.models) expect(model.modelJson).not.toHaveProperty("sourceVersionIds");
    for (const unit of state.units) expect(unit.metadata).not.toHaveProperty("sourceVersionIds");
    for (const pattern of state.patterns) expect(pattern.patternJson).not.toHaveProperty("sourceVersionIds");
    for (const frame of state.frames) expect(frame.frameJson).not.toHaveProperty("sourceVersionIds");
    expect(state.models.every(model => (model.modelJson as Record<string, JsonValue>).shardUri === "fixture://shard/1")).toBe(true);
    const learned = state.events.find(event => event.typeId === "SymbolPatternLearned");
    const payload = learned!.payload as Record<string, any>;
    expect(payload.corpusMetadata.sourceVersionIds).toEqual(["version.a", "version.b"]);
    expect(typeof payload.graphSurfaceAlignments).toBe("number");
    expect(Array.isArray(payload.graphSurfaceAlignment)).toBe(true);
  });
});

describe("prepared corpus training", () => {
  const options = (storage: ScceStorage) => ({ storage, sourceSystem: "gutenberg", streamUri: "fixture://prepared-book",
    text: "A reader opens a book. Another reader closes the same book. ".repeat(3), createdAt: 1700000000000,
    languageOnly: true, ngramMaxOrder: 2, ngramVocabularyLimit: 32 });

  it("prepares without writes and atomically commits one opaque, input-bound result", async () => {
    const { storage, state } = memoryStorage();
    const input = options(storage);
    const prepared = await prepareLanguageCorpusTraining(input);
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect("models" in prepared).toBe(false);
    await expect(commitLanguageCorpusTraining(input, { ...prepared })).rejects.toThrow("unrecognized");
    const report = await commitLanguageCorpusTraining(input, prepared);
    expect(report.ngramModels).toBeGreaterThan(0);
    expect(state.sourceVersions).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    await expect(commitLanguageCorpusTraining(input, prepared)).rejects.toThrow("already committed");
    expect(state.events).toHaveLength(1);
  });

  it("rejects changed input or graph dependencies before persisting prepared learning", async () => {
    const { storage, state } = memoryStorage();
    const input = options(storage);
    const prepared = await prepareLanguageCorpusTraining(input);
    await expect(commitLanguageCorpusTraining({ ...input, text: "changed source" }, prepared)).rejects.toThrow("input changed");
    storage.graph.getSlice = async query => ({ bounded: true, query, nodes: [], edges: [], hyperedges: [
      { id: "changed-hyperedge", modality: { extractionChannel: "fixture" } } as any
    ] });
    await expect(commitLanguageCorpusTraining(input, prepared)).rejects.toThrow("graph dependencies changed");
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
  });

  it("detaches a creative compiler's small result while keeping the prepared commit input-bound", async () => {
    const { storage, state } = memoryStorage();
    const compilerPattern = {
      id: "creative.fixture.pattern",
      profileId: "creative.fixture.profile",
      patternKind: "semantic_role" as const,
      support: 1,
      entropy: 0,
      patternJson: { schema: "creative.fixture", original: true },
      evidenceIds: [],
      updatedAt: 1
    };
    const input = {
      ...options(storage),
      creativeEventCompiler: {
        id: "creative.fixture.compiler",
        compile: () => ({ status: "compiled" as const, pattern: compilerPattern, bundle: {} as any })
      }
    };
    const prepared = await prepareLanguageCorpusTraining(input);
    compilerPattern.patternJson.original = false;
    await commitLanguageCorpusTraining(input, prepared);
    const persisted = state.patterns.find(pattern => pattern.id === compilerPattern.id);
    expect(persisted?.patternJson).toMatchObject({ original: true });
    expect(persisted?.patternJson).not.toMatchObject({ original: false });
  });

  it("propagates graph lookup failures and rolls back a later model write failure", async () => {
    const { storage, state } = memoryStorage();
    const input = options(storage);
    const lookup = storage.graph.getSlice;
    storage.graph.getSlice = async () => { throw new Error("graph unavailable"); };
    await expect(prepareLanguageCorpusTraining(input)).rejects.toThrow("graph unavailable");
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
    storage.graph.getSlice = lookup;
    const prepared = await prepareLanguageCorpusTraining(input);
    storage.languageMemory.putNgramModels = async () => { throw new Error("injected model failure"); };
    await expect(commitLanguageCorpusTraining(input, prepared)).rejects.toThrow("injected model failure");
    expect(Object.values(state).every(rows => rows.length === 0)).toBe(true);
  });
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

  it("writes the compiled models without the raw observations when asked", async () => {
    // A corpus ingest wrote its n-gram mass twice: as compiled models, and as the raw observations they were
    // compiled from. Nothing reads the raw form -- its only consumers are a diagnostic summary and a hydration
    // fallback whose own comment records it returning 0 rows in 48 of 48 measured executions -- and nothing
    // learns from it, because training reads evidence spans.
    //
    // The rows never collapse, because their ids are per shard. Measured on a clean scce5 after 4,762
    // articles: 19,382,688 rows and 27GB, roughly 460,000 new rows per shard inserted into a primary key that
    // grew with every shard before it. Throughput fell from 1,217 sources an hour to 348 across five hours.
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/observations-skipped",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      skipNgramObservationPersistence: true,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(fixture.state.observations.length).toBe(0);
    // The mass still lands, in the form the runtime actually hydrates.
    expect(fixture.state.models.length).toBeGreaterThan(0);
    // And everything else the lane produces is untouched.
    expect(fixture.state.units.length).toBeGreaterThan(0);
    expect(fixture.state.patterns.length).toBeGreaterThan(0);
  });

  it("keeps writing observations for callers that did not ask to skip them", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/observations-kept",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(fixture.state.observations.length).toBeGreaterThan(0);
    expect(fixture.state.models.length).toBeGreaterThan(0);
  });

  it("replays a completed corpus checkpoint without repeating learned writes or accepting a changed recipe", async () => {
    const fixture = memoryStorage();
    const checkpoints = new Map<string, any>();
    fixture.storage.ingestion = {
      put: async (checkpoint: IngestionCheckpoint) => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
      get: async (id: string) => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()]
    } as any;
    const input = {
      storage: fixture.storage,
      sourceSystem: "gutenberg",
      streamUri: "fixture://prepared-book",
      text: "A reader opens a book. Another reader closes the same book. ".repeat(3),
      createdAt: 1700000000000,
      languageOnly: true,
      ngramMaxOrder: 2,
      ngramVocabularyLimit: 32,
      corpusCheckpoint: { rootUri: "fixture://gutenberg", itemUri: "book.txt", contentHash: "sha256_fixture", byteLength: 128 }
    };

    const first = await trainLanguageCorpusText(input);
    const counts = Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]));
    const second = await trainLanguageCorpusText(input);

    expect(second).toEqual(first);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(counts);
    expect([...checkpoints.values()]).toHaveLength(1);
    expect([...checkpoints.values()][0].status).toBe("complete");
    await expect(trainLanguageCorpusText({ ...input, text: "changed source" })).rejects.toThrow(/checkpoint binding mismatch/iu);
  });

  it("survives a commit acknowledgement loss by replaying the terminal checkpoint", async () => {
    const fixture = memoryStorage();
    const checkpoints = new Map<string, any>();
    fixture.storage.ingestion = {
      put: async (checkpoint: IngestionCheckpoint) => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
      get: async (id: string) => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()]
    } as any;
    const input = {
      storage: fixture.storage,
      sourceSystem: "gutenberg",
      streamUri: "fixture://prepared-book",
      text: "A reader opens a book. Another reader closes the same book. ".repeat(3),
      createdAt: 1700000000000,
      languageOnly: true,
      ngramMaxOrder: 2,
      ngramVocabularyLimit: 32,
      corpusCheckpoint: { rootUri: "fixture://gutenberg", itemUri: "lost-ack.txt", contentHash: "sha256_lost_ack", byteLength: 64 }
    };
    const transaction = fixture.storage.transaction;
    let depth = 0;
    let loseAcknowledgement = true;
    fixture.storage.transaction = async <T>(callback: () => Promise<T>) => {
      depth += 1;
      try {
        const result = await transaction(callback);
        if (depth === 1 && loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("injected commit acknowledgement loss");
        }
        return result;
      } finally {
        depth -= 1;
      }
    };

    await expect(trainLanguageCorpusText(input)).rejects.toThrow("injected commit acknowledgement loss");
    expect([...checkpoints.values()][0].status).toBe("complete");
    const counts = Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]));
    await trainLanguageCorpusText(input);
    expect(Object.fromEntries(Object.entries(fixture.state).map(([key, rows]) => [key, rows.length]))).toEqual(counts);
  });

  it("still drops models too when the whole-lane switch is set, which is a different question", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "wikipedia",
      streamUri: "wiki://fixture/shard/lane-skipped",
      text: "Structured source text gives the mouth usable cadence. Evidence remains separate from the generated surface.",
      persistSource: false,
      skipNgramPersistence: true,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64,
      ngramVocabularyLimit: 512
    });

    expect(fixture.state.observations.length).toBe(0);
    expect(fixture.state.models.length).toBe(0);
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
    expect(fixture.state.sourceVersions.length).toBe(2);
    const original = fixture.state.sourceVersions.find(source => source.role === "original");
    const derivative = fixture.state.sourceVersions.find(source => source.role === "evidence-derivative");
    expect(original).toBeDefined();
    expect(derivative?.derivation).toMatchObject({
      kind: "extracted-text",
      transformId: "scce.gutenberg.boilerplate-strip.v1",
      derivedFromSourceVersionId: original?.sourceVersionId,
      originalCoordinateSpace: "source-bytes",
      redactionMap: []
    });
    expect(fixture.state.evidence.every(span => span.sourceVersionId === derivative?.sourceVersionId)).toBe(true);
    const rawBytes = Buffer.from([
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "Chapter 1",
      "",
      "The workshop had a patient rhythm. The sentences were public-domain training material.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const derivativeBytes = Buffer.from("Chapter 1\n\nThe workshop had a patient rhythm. The sentences were public-domain training material.", "utf8");
    expect(fixture.state.blobs.some(bytes => Buffer.from(bytes).equals(rawBytes))).toBe(true);
    expect(fixture.state.blobs.some(bytes => Buffer.from(bytes).equals(derivativeBytes))).toBe(true);
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

    // A source file trains twice, into different corpora: its token stream is code, and its comments and
    // identifier words are documentation. One projection cannot be both, and the code lane is unusable for
    // generation if it holds prose.
    expect(result.codeTrained).toBe(1);
    expect(result.docsTrained).toBe(2);
    expect(result.totals.oss_docs.ngramObservations).toBeGreaterThan(0);
    expect(result.totals.oss_code.ngramObservations).toBeGreaterThan(0);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["oss_docs", "oss_code"]));
    expect(JSON.stringify(result).toLowerCase()).not.toContain("provider");

    const codeReport = result.reports.find(report => report.sourceSystem === "oss_code")!;
    const proseReport = result.reports.find(report => report.streamUri.endsWith("src/pump.ts") && report.sourceSystem === "oss_docs")!;
    expect(codeReport.streamUri.endsWith("src/pump.ts")).toBe(true);
    expect(proseReport).toBeDefined();
  });

  it("keeps the OSS cursor on a file with an incompletely trained projection", async () => {
    const root = await tempDir("oss-retry-cursor-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "pump.ts"), "export function pumpPressure(input: number) { return input + 1; }\n", "utf8");
    const fixture = memoryStorage();
    const checkpoints = new Map<string, any>();
    fixture.storage.ingestion = {
      put: async (checkpoint: IngestionCheckpoint) => { checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
      get: async (id: string) => checkpoints.get(id) ?? null,
      list: async () => [...checkpoints.values()]
    } as any;
    const putModels = fixture.storage.languageMemory.putNgramModels;
    let failOnce = true;
    fixture.storage.languageMemory.putNgramModels = async rows => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected projection failure");
      }
      if (!putModels) throw new Error("fixture language model store is unavailable");
      return putModels(rows);
    };

    const first = await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 10, maxFilesPerRun: 1, includeDocs: true, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    expect(first.filesConsidered).toBe(1);
    expect(first.nextFileIndex).toBe(first.startFileIndex);
    expect(first.filesSkipped.some(item => item.reason.includes("training_failed"))).toBe(true);

    const second = await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 10, maxFilesPerRun: 1, includeDocs: true, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64 });
    expect(second.filesConsidered).toBe(1);
    expect(second.nextFileIndex).toBe(1);
    expect(second.codeTrained).toBe(1);
    expect(second.docsTrained).toBe(1);
  });

  it("counts an empty projection once so resume advances to the next file", async () => {
    const root = await tempDir("oss-empty-projection-resume-");
    await writeFile(path.join(root, "a-empty.ts"), "", "utf8");
    await writeFile(path.join(root, "b-valid.ts"), "export function validSurface(input: number) { return input + 1; }\n", "utf8");
    const fixture = memoryStorage();

    const result = await trainOssCorpus({
      storage: fixture.storage,
      rootPath: root,
      maxFiles: 10,
      maxFilesPerRun: 2,
      includeDocs: false,
      includeSource: true,
      ngramMaxOrder: 2,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.filesConsidered).toBe(2);
    expect(result.nextFileIndex).toBe(2);
    expect(result.codeTrained).toBe(1);
    expect(result.filesSkipped).toContainEqual(expect.objectContaining({
      path: "a-empty.ts",
      reason: "empty_language_training_projection"
    }));
  });

  it("names every OSS and Gutenberg source version by title and identity at ingest, not by backfill", async () => {
    const ossRoot = await tempDir("oss-identity-fixture-");
    await mkdir(path.join(ossRoot, "src"), { recursive: true });
    await writeFile(path.join(ossRoot, "README.md"), "Readable docs explain the pump API and the maintenance flow.", "utf8");
    await writeFile(path.join(ossRoot, "src", "pump-pressure.ts"), [
      "// Stabilize pump pressure before returning a status object.",
      "export function stabilizePumpPressure(input: number) {",
      "  return { pressureReading: input, stable: input > 0 };",
      "}"
    ].join("\n"), "utf8");
    const oss = memoryStorage();
    await trainOssCorpus({ storage: oss.storage, rootPath: ossRoot, maxFiles: 10, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    expect(oss.state.sourceVersions.length).toBeGreaterThan(0);
    for (const source of oss.state.sourceVersions) {
      expect(nonEmptyString(recordOf(source.metadata).title)).toBe(true);
      expect(nonEmptyString(recordOf(source.metadata).identity)).toBe(true);
    }
    const codeSource = oss.state.sourceVersions.find(source => String(recordOf(source.metadata).relativePath) === "src/pump-pressure.ts")!;
    expect(String(recordOf(codeSource.metadata).title)).toBe("pump pressure");
    // A source file is about what it declares, so the declared name has to survive into the identity.
    expect(String(recordOf(codeSource.metadata).identity)).toContain("stabilizePumpPressure");
    for (const span of oss.state.evidence) {
      expect(nonEmptyString(resolveEvidenceSourceIdentity(span.provenance).title)).toBe(true);
      expect(nonEmptyString(resolveEvidenceSourceIdentity(span.provenance).identity)).toBe(true);
    }

    const gutenbergRoot = await tempDir("gutenberg-identity-fixture-");
    await writeFile(path.join(gutenbergRoot, "moby-dick_or-the-whale.txt"), [
      "The Project Gutenberg eBook of Moby Dick; Or, The Whale",
      "",
      "*** START OF THE PROJECT GUTENBERG EBOOK FIXTURE ***",
      "",
      "Call me Ishmael. The workshop had a patient rhythm and the sentences were public-domain material.",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK FIXTURE ***"
    ].join("\n"), "utf8");
    const gutenberg = memoryStorage();
    await trainGutenbergCorpus({ storage: gutenberg.storage, rootPath: gutenbergRoot, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    const book = gutenberg.state.sourceVersions[0]!;
    // One title contract, the producer document.ts already uses: separators in a file name are word boundaries.
    expect(String(recordOf(book.metadata).title)).toBe("moby dick or the whale");
    expect(String(recordOf(book.metadata).identity)).toContain("whale");
    for (const span of gutenberg.state.evidence) {
      expect(nonEmptyString(resolveEvidenceSourceIdentity(span.provenance).identity)).toBe(true);
    }
  });

  it("keeps the code corpus free of prose and the prose corpus free of syntax", async () => {
    const root = await tempDir("oss-projection-fixture-");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "pump.ts"), [
      "// Stabilize pump pressure before returning a status object.",
      "export function stabilizePumpPressure(input: number) {",
      "  return { pressureReading: input, stable: input > 0 };",
      "}"
    ].join("\n"), "utf8");

    // Trained separately so each projection can be read on its own.
    const codeOnly = memoryStorage();
    await trainOssCorpus({ storage: codeOnly.storage, rootPath: root, maxFiles: 10, includeDocs: false, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });
    const docsOnly = memoryStorage();
    await trainOssCorpus({ storage: docsOnly.storage, rootPath: root, maxFiles: 10, includeSource: false, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    expect(allSourceSystems(codeOnly.state)).toEqual(new Set(["oss_code"]));
    // includeSource:false skips the file entirely, so no projection of it is trained at all.
    expect(allSourceSystems(docsOnly.state).size).toBe(0);
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
      put: async (content: Uint8Array) => blobContentHash(content),
      exists: async () => true
    };

    const report = await trainStoredCorpusConstructions({
      storage: fixture.storage,
      batchBytes: 100,
      maxTotalBytes: 4096
    });

    expect(report.schema).toBe("scce.storedCorpusConstructionTrainReport.v1");
    expect(report.batchesFailed).toEqual([]);
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

  it("asks the graph for the batch's own slice, so the construction lane has surfaces to align to", async () => {
    const article = (title: string, body: string) =>
      `'${title}' is a subject with real prose. ${`${body} The predicate structure recurs across sentences. It recurs again in a second clause. `.repeat(8)}`;
    const blob = Buffer.from(article("Graph Bound", "The engine was designed by a careful team."));
    const fixture = memoryStorage();
    (fixture.storage.evidence as unknown as Record<string, unknown>).listEvidenceBackedSourceVersions = async () => [
      { sourceVersionId: "sv-graph", contentHash: "sha256_graph", canonicalUri: "https://example.org/graph", byteLength: blob.length, maxAlpha: 0.9, promotedSpanCount: 3 }
    ];
    (fixture.storage as unknown as Record<string, unknown>).blobs = {
      get: async () => blob,
      put: async (content: Uint8Array) => blobContentHash(content),
      exists: async () => true
    };
    // The graph was projected from the original ingestion's spans, so the lane looks them up by source version.
    (fixture.storage.evidence as unknown as Record<string, unknown>).searchEvidence = async () =>
      [{ span: { id: "evidence.original" }, score: 1 }];
    const sliceQueries: Array<Record<string, unknown>> = [];
    (fixture.storage as unknown as Record<string, unknown>).graph = {
      getSlice: async (query: Record<string, unknown>) => {
        sliceQueries.push(query);
        return { nodes: [], edges: [], hyperedges: [], bounded: true, query };
      }
    };

    const report = await trainStoredCorpusConstructions({ storage: fixture.storage, batchBytes: 4096, maxTotalBytes: 65_536 });

    // Alignment lattices are built only from a batch that carries its graph. Training used to pass none at all,
    // so the construction lane compiled nothing on every run the trainer had ever made.
    expect(report.batchesFailed).toEqual([]);
    expect(report.batchesTrained).toBeGreaterThanOrEqual(1);
    expect(sliceQueries.length).toBeGreaterThan(0);
    expect((sliceQueries[0]!.evidenceIds as unknown[]).length).toBeGreaterThan(0);
    expect(report.batchesFailed).toEqual([]);
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

describe("dialogue corpus training", () => {
  const ownerLabel: InformationLabel = {
    tenantId: "owner.tenant",
    principals: ["owner.principal"],
    compartments: [],
    exportClass: "restricted",
    mergePolicy: "isolated"
  };

  it("trains human-authored dialogue as its own source system, never as corrections or gutenberg", async () => {
    const root = await tempDir("dialogue-fixture-");
    await writeFile(path.join(root, "session.txt"), [
      "so what do you think of that?",
      "honestly not much. it reads fine but it does not answer me.",
      "fair enough. want me to try again?",
      "yeah go on then."
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    const result = await trainDialogueCorpus({
      storage: fixture.storage,
      rootPath: root,
      authorship: "human_authored",
      informationLabel: ownerLabel,
      maxFilesPerRun: 1,
      maxFileBytes: 100_000,
      ngramMaxOrder: 3,
      ngramMaxCountersPerOrder: 64
    });

    expect(result.filesTrained).toBe(1);
    expect(result.totals.ngramModels).toBeGreaterThan(0);
    expect(allSourceSystems(fixture.state)).toEqual(new Set(["dialogue"]));
    expect(result.corpusRoleId).toBe(CORPUS_ROLE_IDS.dialogue);
    expect(result.corpusRoleId).not.toBe(CORPUS_ROLE_IDS.interactionCorrection);
    expect(fixture.state.models.every(row => informationLabelOf(row.informationLabel).exportClass !== "public")).toBe(true);
  });

  it("refuses to train on SCCE's own generations", async () => {
    const root = await tempDir("dialogue-selftrain-");
    await writeFile(path.join(root, "generated.txt"), "a surface this system produced", "utf8");
    const fixture = memoryStorage();

    await expect(trainDialogueCorpus({
      storage: fixture.storage,
      rootPath: root,
      authorship: "system_generated",
      informationLabel: ownerLabel
    })).rejects.toThrow(/self-training/);
    expect(fixture.state.models.length).toBe(0);
  });

  it("refuses a public export class for a transcript", async () => {
    const root = await tempDir("dialogue-public-");
    await writeFile(path.join(root, "session.txt"), "so what do you think of that?", "utf8");
    const fixture = memoryStorage();

    await expect(trainDialogueCorpus({
      storage: fixture.storage,
      rootPath: root,
      authorship: "human_authored",
      informationLabel: { ...ownerLabel, exportClass: "public" }
    })).rejects.toThrow(/owner-private/);
    expect(fixture.state.models.length).toBe(0);
  });
});

function informationLabelOf(value: InformationLabel | undefined): { exportClass?: string } {
  return value ?? {};
}

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
  blobs: Uint8Array[];
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
    frames: [],
    blobs: []
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
    transaction: async <T>(fn: () => Promise<T>) => {
      const before = Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, [...rows]]));
      try { return await fn(); } catch (error) { Object.assign(state, before); throw error; }
    },
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined,
    conversation: unusedStore(),
    ingestion: unusedStore(),
    graph: { getSlice: async (query: unknown) => ({ bounded: true, query, nodes: [], edges: [], hyperedges: [] }) },
    blobs: { put: async (bytes: Uint8Array) => { state.blobs.push(new Uint8Array(bytes)); return blobContentHash(bytes); } },
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

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function recordOf(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function unusedStore(): Record<string, (...args: never[]) => Promise<unknown>> {
  return new Proxy({}, { get: () => async () => null }) as Record<string, (...args: never[]) => Promise<unknown>>;
}
