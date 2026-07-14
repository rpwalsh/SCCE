import path from "node:path";
import { existsSync } from "node:fs";
import {
  createClock,
  createEventFactory,
  createEvidenceExtractor,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  languageAliasSurfacesFromMetadata,
  createSourceAdmissionController,
  createSourceGraphBuilder,
  createTypedIngestProjector,
  toJsonValue,
  validateBrainManifestContract,
  validationDisposition,
  type BrainLifecycleRecord,
  type BrainManifestContract,
  type BrainValidationReport,
  type BrainShardProvenanceClass,
  type Clock,
  type ContentHash,
  type EvidenceSpan,
  type GraphEdge,
  type GraphNode,
  type Hasher,
  type IdFactory,
  type IngestedSourceFile,
  type IngestionCheckpoint,
  type JsonValue,
  type ScceStorage,
  type SourceVersion,
  type SourceVersionId
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { trainLanguageCorpusText } from "./language-corpus-trainer.js";
import { resolveWikipediaCorpusTarget, streamWikipediaMultistream, wikipediaRootUri, type ResolvedWikipediaCorpus } from "./wikipedia.js";

export interface WikipediaV3IngestOptions {
  dumpPath: string;
  indexPath?: string;
  maxPages?: number;
  maxBlocks?: number;
  resume?: boolean;
  fresh?: boolean;
  startOffset?: number;
  memorySafetyBoundMb?: number;
  heapCheckpointMb?: number;
  stopFile?: string;
  onStatus?: (status: WikipediaV3IngestStatus) => Promise<void> | void;
}

export interface WikipediaV3IngestResult {
  episodeId: string;
  rootUri: string;
  dumpPath: string;
  indexPath?: string;
  resumedFromOffset: number;
  blocks: number;
  pages: number;
  sources: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  languageProfiles: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  lastCheckpointOffset: number;
  heapMiB: number;
  rssMiB: number;
  stoppedByHeapSafetyBound: boolean;
  stoppedByOwner: boolean;
  stopReason?: string;
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
}

interface WikipediaLanguageShardSample {
  uri: string;
  title?: string;
  sourceVersionId: SourceVersionId;
  text: string;
  evidence: EvidenceSpan[];
  createdAt: number;
  languageAliases: string[];
}

interface WikipediaPageImport {
  sources: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  languageProfiles: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  languageSample?: WikipediaLanguageShardSample;
  warnings: string[];
}

interface WikipediaLanguageShardImport {
  languageProfiles: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  warnings: string[];
}

export interface WikipediaV3IngestStatus {
  schema: "scce.wikipediaV3FirehoseStatus.v1";
  pid: number;
  state: "starting" | "running" | "stopping" | "stopped" | "completed" | "failed";
  episodeId: string;
  rootUri: string;
  dumpPath: string;
  indexPath?: string;
  resumedFromOffset: number;
  blocks: number;
  pages: number;
  sources: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  lastCheckpointOffset: number;
  heapMiB: number;
  rssMiB: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  stoppedByHeapSafetyBound: boolean;
  stoppedByOwner: boolean;
  fullTrainingRequested: boolean;
  fullTrainingComplete: boolean;
  stopReason?: string;
  warnings: string[];
}

export interface WikipediaV3IngestorOptions {
  storage: ScceStorage;
  config: ScceRuntimeConfig;
  idFactory?: IdFactory;
  hasher?: Hasher;
  clock?: Clock;
}

export function createWikipediaV3Ingestor(options: WikipediaV3IngestorOptions): WikipediaV3Ingestor {
  return new WikipediaV3Ingestor(options);
}

export class WikipediaV3Ingestor {
  private readonly storage: ScceStorage;
  private readonly config: ScceRuntimeConfig;
  private readonly clock: Clock;
  private readonly hasher: Hasher;
  private readonly ids: IdFactory;
  private readonly events;
  private readonly evidenceExtractor;
  private readonly admission;
  private readonly language;
  private readonly graphBuilder;
  private readonly typedIngest;

  constructor(options: WikipediaV3IngestorOptions) {
    this.storage = options.storage;
    this.config = options.config;
    this.clock = options.clock ?? createClock();
    this.hasher = options.hasher ?? createHasher();
    this.ids = options.idFactory ?? createIdFactory({ clock: this.clock, hasher: this.hasher, namespace: "wiki-v3-ingestor" });
    this.events = createEventFactory({ idFactory: this.ids, clock: this.clock, hasher: this.hasher });
    this.evidenceExtractor = createEvidenceExtractor({ idFactory: this.ids, hasher: this.hasher });
    this.admission = createSourceAdmissionController();
    this.language = createLanguageAcquisitionEngine({ idFactory: this.ids });
    this.graphBuilder = createSourceGraphBuilder({ idFactory: this.ids });
    this.typedIngest = createTypedIngestProjector({ idFactory: this.ids, hasher: this.hasher });
  }

  async ingest(input: WikipediaV3IngestOptions): Promise<WikipediaV3IngestResult> {
    const target = path.resolve(input.dumpPath);
    const resolved = resolveWikipediaCorpusTarget(this.config, target);
    if (!resolved) throw new Error(`not a configured Wikipedia multistream dump: ${target}`);
    const corpus: ResolvedWikipediaCorpus = {
      ...resolved,
      indexPath: input.indexPath ? path.resolve(input.indexPath) : resolved.indexPath,
      maxPagesPerRun: input.maxPages ?? resolved.maxPagesPerRun,
      maxBlocksPerRun: input.maxBlocks ?? resolved.maxBlocksPerRun,
      memorySafetyBoundMb: input.memorySafetyBoundMb ?? resolved.memorySafetyBoundMb
    };
    const rootUri = wikipediaRootUri(corpus);
    const resumedFromOffset = input.startOffset !== undefined ? Math.max(0, Math.floor(input.startOffset)) : input.fresh ? 0 : input.resume === false ? 0 : await this.resumeOffset(rootUri);
    const episodeId = this.ids.episodeId();
    const startedAt = nowMs();
    await this.storage.events.append(this.events.create({
      episodeId,
      typeId: "OwnerAsked",
      payload: { command: "ingest.wikipedia.v3", dumpPath: corpus.dumpPath, indexPath: corpus.indexPath ?? null, resumedFromOffset, memorySafetyBoundMb: corpus.memorySafetyBoundMb }
    }));

    const result: WikipediaV3IngestResult = {
      episodeId: String(episodeId),
      rootUri,
      dumpPath: corpus.dumpPath,
      indexPath: corpus.indexPath,
      resumedFromOffset,
      blocks: 0,
      pages: 0,
      sources: 0,
      evidence: 0,
      graphNodes: 0,
      graphEdges: 0,
      languageProfiles: 0,
      ngramObservations: 0,
      ngramModels: 0,
      languageUnits: 0,
      languagePatterns: 0,
      semanticFrames: 0,
      lastCheckpointOffset: resumedFromOffset,
      heapMiB: heapMiB(),
      rssMiB: rssMiB(),
      stoppedByHeapSafetyBound: false,
      stoppedByOwner: false,
      skipped: [],
      warnings: []
    };
    const fullTrainingRequested = corpus.maxBlocksPerRun === 0 && input.maxPages === undefined;
    let stopReason: string | undefined;
    let streamReachedEnd = false;
    let lastStatusAt = 0;
    let activeLanguageShardUri = rootUri;
    let languageShardSamples: WikipediaLanguageShardSample[] = [];
    const applyLanguageShardImport = (imported: WikipediaLanguageShardImport): void => {
      result.languageProfiles += imported.languageProfiles;
      result.ngramObservations += imported.ngramObservations;
      result.ngramModels += imported.ngramModels;
      result.languageUnits += imported.languageUnits;
      result.languagePatterns += imported.languagePatterns;
      result.semanticFrames += imported.semanticFrames;
      result.warnings.push(...imported.warnings);
    };
    const flushLanguageShard = async (shardUri: string): Promise<void> => {
      if (!languageShardSamples.length) return;
      const samples = languageShardSamples;
      languageShardSamples = [];
      applyLanguageShardImport(await this.ingestLanguageShard(samples, shardUri, episodeId));
    };
    const emitStatus = async (state: WikipediaV3IngestStatus["state"], finishedAt?: number): Promise<void> => {
      result.heapMiB = heapMiB();
      result.rssMiB = rssMiB();
      await input.onStatus?.({
        schema: "scce.wikipediaV3FirehoseStatus.v1",
        pid: typeof process !== "undefined" ? process.pid : 0,
        state,
        episodeId: String(episodeId),
        rootUri,
        dumpPath: corpus.dumpPath,
        indexPath: corpus.indexPath,
        resumedFromOffset,
        blocks: result.blocks,
        pages: result.pages,
        sources: result.sources,
        evidence: result.evidence,
        graphNodes: result.graphNodes,
        graphEdges: result.graphEdges,
        ngramObservations: result.ngramObservations,
        ngramModels: result.ngramModels,
        languageUnits: result.languageUnits,
        languagePatterns: result.languagePatterns,
        semanticFrames: result.semanticFrames,
        lastCheckpointOffset: result.lastCheckpointOffset,
        heapMiB: result.heapMiB,
        rssMiB: result.rssMiB,
        startedAt,
        updatedAt: nowMs(),
        finishedAt,
        stoppedByHeapSafetyBound: result.stoppedByHeapSafetyBound,
        stoppedByOwner: result.stoppedByOwner,
        fullTrainingRequested,
        fullTrainingComplete: fullTrainingRequested && streamReachedEnd && !result.stoppedByHeapSafetyBound && !result.stoppedByOwner,
        stopReason,
        warnings: result.warnings.slice(-64)
      });
    };
    await emitStatus("starting");

    try {
      for await (const item of streamWikipediaMultistream(corpus, { resumeOffset: resumedFromOffset })) {
        await this.storage.ingestion.put(item.checkpoint);
        result.lastCheckpointOffset = Math.max(result.lastCheckpointOffset, item.checkpoint.offsetBytes);
        if (item.type === "checkpoint") {
          const blockCheckpoint = isBlockCheckpoint(item.checkpoint);
          if (blockCheckpoint && item.checkpoint.phase === "extracting" && item.checkpoint.status === "running") {
            await flushLanguageShard(activeLanguageShardUri);
            activeLanguageShardUri = item.checkpoint.itemUri;
          }
          if (blockCheckpoint && item.checkpoint.phase === "stored" && item.checkpoint.status === "complete") {
            await flushLanguageShard(item.checkpoint.itemUri);
            result.blocks++;
          } else if (!blockCheckpoint && item.checkpoint.phase === "stored" && item.checkpoint.status === "complete") {
            await flushLanguageShard(activeLanguageShardUri);
          }
          const now = nowMs();
          if (now - lastStatusAt > 5000) {
            lastStatusAt = now;
            await emitStatus("running");
          }
          const stop = stopDecision(input, result);
          if (stop) {
            stopReason = stop.reason;
            result.stoppedByHeapSafetyBound = stop.kind === "heap";
            result.stoppedByOwner = stop.kind === "owner";
            await emitStatus("stopping");
            break;
          }
          continue;
        }
        if (item.type === "skipped") {
          result.skipped.push(item.skipped);
          continue;
        }
        const imported = await this.ingestPage(item.file, item.checkpoint, episodeId);
        result.pages++;
        result.sources += imported.sources;
        result.evidence += imported.evidence;
        result.graphNodes += imported.graphNodes;
        result.graphEdges += imported.graphEdges;
        result.languageProfiles += imported.languageProfiles;
        result.ngramObservations += imported.ngramObservations;
        result.ngramModels += imported.ngramModels;
        result.languageUnits += imported.languageUnits;
        result.languagePatterns += imported.languagePatterns;
        result.semanticFrames += imported.semanticFrames;
        if (imported.languageSample) languageShardSamples.push(imported.languageSample);
        result.warnings.push(...imported.warnings);
        const now = nowMs();
        if (now - lastStatusAt > 5000) {
          lastStatusAt = now;
          await emitStatus("running");
        }
        const stop = stopDecision(input, result);
        if (stop) {
          stopReason = stop.reason;
          result.stoppedByHeapSafetyBound = stop.kind === "heap";
          result.stoppedByOwner = stop.kind === "owner";
          await emitStatus("stopping");
          break;
        }
      }
      await flushLanguageShard(activeLanguageShardUri);
      streamReachedEnd = !result.stoppedByHeapSafetyBound && !result.stoppedByOwner;
    } catch (error) {
      stopReason = messageOf(error);
      await emitStatus("failed", nowMs()).catch(() => undefined);
      throw error;
    }
    result.stopReason = stopReason;

    if (result.sources > 0) await this.registerActiveWikipediaImport({ result, rootUri, corpus, importedAt: nowMs() });
    await this.storage.events.append(this.events.create({
      episodeId,
      typeId: "EpisodeClosed",
      payload: {
        output: `wiki ingested ${result.pages} pages, ${result.evidence} evidence spans, ${result.ngramObservations} n-gram observations`,
        rootUri,
        stoppedByHeapSafetyBound: result.stoppedByHeapSafetyBound,
        stoppedByOwner: result.stoppedByOwner,
        stopReason: stopReason ?? null,
        counts: toJsonValue(result)
      }
    }));
    await emitStatus(result.stoppedByHeapSafetyBound || result.stoppedByOwner ? "stopped" : "completed", nowMs());
    return result;
  }

  private async registerActiveWikipediaImport(input: { result: WikipediaV3IngestResult; rootUri: string; corpus: ResolvedWikipediaCorpus; importedAt: number }): Promise<void> {
    const versionSeed = {
      rootUri: input.rootUri,
      dumpPath: input.corpus.dumpPath,
      indexPath: input.corpus.indexPath ?? null,
      resumedFromOffset: input.result.resumedFromOffset,
      lastCheckpointOffset: input.result.lastCheckpointOffset,
      pages: input.result.pages,
      evidence: input.result.evidence,
      graphNodes: input.result.graphNodes,
      graphEdges: input.result.graphEdges,
      languageUnits: input.result.languageUnits,
      languagePatterns: input.result.languagePatterns,
      ngramModels: input.result.ngramModels,
      stoppedByHeapSafetyBound: input.result.stoppedByHeapSafetyBound,
      stoppedByOwner: input.result.stoppedByOwner,
      stopReason: input.result.stopReason ?? null
    };
    const brainVersion = `wikipedia:${this.hasher.digestHex(JSON.stringify(versionSeed)).slice(0, 32)}`;
    const importRunId = String(this.ids.semanticId("wiki_import_run", versionSeed));
    const base = {
      importRunId,
      brainVersion,
      rootPath: input.corpus.dumpPath,
      sourcePath: input.corpus.dumpPath,
      fileHash: undefined,
      shardHash: this.hasher.digestHex(JSON.stringify(versionSeed)),
      sourceVersionId: undefined,
      evidenceIds: [],
      nodeIds: [],
      warnings: input.result.warnings.slice(0, 64),
      importedAt: input.importedAt
    };
    const metadata = {
      sourceSystem: "wikipedia",
      rootUri: input.rootUri,
      dumpPath: input.corpus.dumpPath,
      indexPath: input.corpus.indexPath ?? null,
      brainVersion,
      importRunId,
      resumable: true
    };
    const manifestHash = this.hasher.digestHex(JSON.stringify(versionSeed));
    const manifest: BrainManifestContract = {
      schema: "scce.brainManifestContract.v1",
      importRunId,
      brainVersion,
      rootPath: input.corpus.dumpPath,
      manifestHash,
      sourceId: input.rootUri,
      sourceSchema: "scce.wikipediaV3Import.v1",
      runtimeContractVersion: 1,
      content: {
        graphShardCount: input.result.graphNodes > 0 ? 1 : 0,
        languageShardCount: input.result.languageUnits + input.result.languagePatterns + input.result.ngramModels > 0 ? 1 : 0,
        ngramStateCount: input.result.ngramModels,
        priorSectionCount: 3
      },
      metadata: toJsonValue({ sourceSystem: "wikipedia", rootUri: input.rootUri, result: versionSeed }),
      createdAt: input.importedAt
    };
    let lifecycle = await this.ensureWikipediaLifecycle(manifest, input.importedAt);
    if (lifecycle.state === "ACTIVE") return;
    if (lifecycle.state === "READY") {
      await this.storage.brainImports.activateReady({ brainVersion, importRunId, updatedAt: input.importedAt });
      return;
    }
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "direct-evidence" })),
      sectionId: "direct-evidence",
      sectionKind: "wiki_stream",
      forceClass: "direct_evidence",
      rowCounts: { source_versions: input.result.sources, evidence_spans: input.result.evidence },
      metadata: toJsonValue({ ...metadata, forceClass: "direct_evidence" })
    });
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "language-priors" })),
      sectionId: "language-priors",
      sectionKind: "wiki_stream",
      forceClass: "learned_language_prior",
      rowCounts: {
        language_profiles: input.result.languageProfiles,
        ngram_observations: input.result.ngramObservations,
        ngram_models: input.result.ngramModels,
        language_units: input.result.languageUnits,
        language_patterns: input.result.languagePatterns,
        semantic_frames: input.result.semanticFrames
      },
      metadata: toJsonValue({ ...metadata, forceClass: "learned_language_prior" })
    });
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "graph-priors" })),
      sectionId: "graph-priors",
      sectionKind: "wiki_stream",
      forceClass: "learned_concept_prior",
      rowCounts: { graph_nodes: input.result.graphNodes, graph_edges: input.result.graphEdges },
      metadata: toJsonValue({ ...metadata, forceClass: "learned_concept_prior" })
    });
    if (!wikipediaImportCanActivate(input.result)) {
      if (lifecycle.state === "IMPORTING") {
        await this.storage.brainImports.transitionLifecycle({
          importRunId,
          expectedState: "IMPORTING",
          toState: "STOPPED",
          updatedAt: input.importedAt,
          reason: input.result.stopReason ?? "Wikipedia import stopped before validation"
        });
      }
      return;
    }
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "__import_complete__", manifestHash })),
      sectionId: "__import_complete__",
      sectionKind: "manifest",
      forceClass: "learned_concept_prior",
      fileHash: manifestHash,
      rowCounts: {},
      warnings: [],
      metadata: toJsonValue({ complete: true, stopped: false, manifestHash, sourceSystem: "wikipedia" })
    });
    if (lifecycle.state === "IMPORTING") {
      lifecycle = await this.storage.brainImports.transitionLifecycle({
        importRunId,
        expectedState: "IMPORTING",
        toState: "VALIDATING",
        updatedAt: input.importedAt,
        reason: "Wikipedia completion sentinel written; validation started"
      });
    }
    if (lifecycle.state === "VALIDATING") {
      const checks = [
        ...validateBrainManifestContract(manifest),
        { id: "wikipedia.sources", passed: input.result.sources > 0, severity: "error" as const, message: "Wikipedia import contains source versions" },
        { id: "wikipedia.not_stopped", passed: wikipediaImportCanActivate(input.result), severity: "error" as const, message: "Wikipedia import reached its declared batch boundary without an owner or heap stop" }
      ];
      const validation: BrainValidationReport = {
        schema: "scce.brainValidationReport.v1",
        importRunId,
        brainVersion,
        manifestHash,
        validatorVersion: "wikipedia-v3-import-lifecycle.v1",
        disposition: validationDisposition(checks),
        checks,
        validatedAt: input.importedAt
      };
      if (validation.disposition !== "PASSED") {
        await this.storage.brainImports.transitionLifecycle({ importRunId, expectedState: "VALIDATING", toState: "FAILED", updatedAt: input.importedAt, reason: "Wikipedia brain validation failed", validation });
        throw new Error(`Wikipedia brain validation failed for ${importRunId}`);
      }
      lifecycle = await this.storage.brainImports.transitionLifecycle({ importRunId, expectedState: "VALIDATING", toState: "READY", updatedAt: input.importedAt, reason: "Wikipedia brain validation passed", validation });
    }
    if (lifecycle.state !== "READY") throw new Error(`Wikipedia brain ${importRunId} is not activatable from ${lifecycle.state}`);
    await this.storage.brainImports.activateReady({ brainVersion, importRunId, updatedAt: input.importedAt });
  }

  private async ensureWikipediaLifecycle(manifest: BrainManifestContract, updatedAt: number): Promise<BrainLifecycleRecord> {
    let lifecycle = await this.storage.brainImports.getLifecycle(manifest.importRunId);
    if (!lifecycle) {
      await this.storage.brainImports.putLifecycle({
        importRunId: manifest.importRunId,
        brainVersion: manifest.brainVersion,
        rootPath: manifest.rootPath,
        state: "CREATED",
        manifest,
        revision: 0,
        createdAt: updatedAt,
        updatedAt
      });
      lifecycle = await this.storage.brainImports.getLifecycle(manifest.importRunId);
    }
    if (!lifecycle) throw new Error(`Wikipedia brain lifecycle creation failed for ${manifest.importRunId}`);
    if (lifecycle.brainVersion !== manifest.brainVersion || lifecycle.manifest.manifestHash !== manifest.manifestHash) throw new Error(`Wikipedia brain lifecycle identity conflict for ${manifest.importRunId}`);
    if (lifecycle.state === "CREATED" || lifecycle.state === "STOPPED" || lifecycle.state === "FAILED") {
      lifecycle = await this.storage.brainImports.transitionLifecycle({
        importRunId: manifest.importRunId,
        expectedState: lifecycle.state,
        toState: "IMPORTING",
        updatedAt,
        reason: lifecycle.state === "CREATED" ? "Wikipedia import registration started" : "Wikipedia import registration resumed"
      });
    }
    if (lifecycle.state === "QUARANTINED" || lifecycle.state === "INCOMPATIBLE") throw new Error(`Wikipedia brain import ${manifest.importRunId} is ${lifecycle.state}`);
    return lifecycle;
  }

  private async resumeOffset(rootUri: string): Promise<number> {
    const checkpoints = await this.storage.ingestion.list({ rootUri, status: "complete", limit: 2000 });
    let offset = 0;
    for (const checkpoint of checkpoints) {
      if (!checkpoint.itemUri.includes("/block/")) continue;
      if (checkpoint.phase !== "stored") continue;
      offset = Math.max(offset, checkpoint.offsetBytes);
    }
    return offset;
  }

  private async ingestPage(file: IngestedSourceFile, checkpoint: IngestionCheckpoint, episodeId: ReturnType<IdFactory["episodeId"]>): Promise<WikipediaPageImport> {
    const now = this.clock.now();
    const warnings: string[] = [];
    const contentHash = await this.storage.blobs.put(file.bytes, file.mediaType);
    const sourceId = this.ids.sourceId(file.namespace, file.uri);
    const sourceVersionId = this.ids.sourceVersionId(file.bytes);
    const metadata = wikiMetadata(file.metadata);
    const source: SourceVersion = {
      sourceId,
      sourceVersionId,
      namespace: file.namespace,
      canonicalUri: file.uri,
      contentHash,
      mediaType: file.mediaType,
      observedAt: now,
      byteLength: file.bytes.byteLength,
      trust: 0.76,
      metadata
    };
    await this.storage.evidence.putSourceVersion(source);
    await this.storage.events.append(this.events.create({ episodeId, typeId: "SourceObserved", payload: { sourceId, uri: file.uri, namespace: file.namespace, sourceSystem: "wikipedia" } }));
    await this.storage.events.append(this.events.create({ episodeId, typeId: "SourceVersionObserved", payload: { sourceVersionId, contentHash, byteLength: file.bytes.byteLength } }));

    const profile = this.language.acquire({ sourceVersionId, text: file.text, createdAt: now });
    const extracted = this.evidenceExtractor.extract({
      sourceId,
      sourceVersionId,
      namespace: file.namespace,
      uri: file.uri,
      mediaType: file.mediaType,
      text: file.text,
      languageProfile: profile,
      observedAt: now,
      maxChunkBytes: this.config.runtime.maxChunkBytes,
      metadata
    });
    const decision = this.admission.decide({ source, evidence: extracted.spans, metadata });
    await this.storage.quarantine.put({
      id: `${sourceVersionId}:wiki-admission`,
      sourceId,
      sourceVersionId,
      uri: file.uri,
      contentHash,
      mediaType: file.mediaType,
      fetchedAt: now,
      trustVector: decision.audit,
      permissionVector: { disposition: decision.disposition, lane: "wiki_stream" },
      decision: decision.disposition === "reject" ? "rejected" : "promoted",
      decisionJson: decision.audit
    });
    if (decision.disposition === "reject") {
      await this.storage.ingestion.put({ ...checkpoint, phase: "skipped", status: "complete", reason: "admission-rejected", updatedAt: now });
      return zeroPage({ warnings: decision.reasons });
    }

    const admittedSpans = stampEvidence(extracted.spans, metadata);
    for (const span of admittedSpans) await this.storage.blobs.put(Buffer.from(span.text, "utf8"), file.mediaType);
    if (this.storage.evidence.putEvidenceSpans) await this.storage.evidence.putEvidenceSpans(admittedSpans);
    else for (const span of admittedSpans) await this.storage.evidence.putEvidenceSpan(span);

    let graphNodes = 0;
    let graphEdges = 0;
    const typedProjection = this.typedIngest.project({ sourceId, sourceVersionId, uri: file.uri, mediaType: file.mediaType, text: file.text, metadata, evidence: admittedSpans, observedAt: now });
    const typedNodes = stampGraphNodes(typedProjection.graphNodes);
    const typedEdges = stampGraphEdges(typedProjection.graphEdges);
    if (this.storage.graph.upsertNodes) await this.storage.graph.upsertNodes(typedNodes);
    else for (const node of typedNodes) await this.storage.graph.upsertNode(node);
    if (this.storage.graph.upsertEdges) await this.storage.graph.upsertEdges(typedEdges);
    else for (const edge of typedEdges) await this.storage.graph.upsertEdge(edge);
    graphNodes += typedProjection.graphNodes.length;
    graphEdges += typedProjection.graphEdges.length;
    const builtGraph = this.graphBuilder.build({ sourceVersionId, uri: file.uri, mediaType: file.mediaType, languageProfile: profile, evidence: admittedSpans, observedAt: now });
    const builtNodes = stampGraphNodes(builtGraph.nodes);
    const builtEdges = stampGraphEdges(builtGraph.edges);
    if (this.storage.graph.upsertNodes) await this.storage.graph.upsertNodes(builtNodes);
    else for (const node of builtNodes) await this.storage.graph.upsertNode(node);
    if (this.storage.graph.upsertEdges) await this.storage.graph.upsertEdges(builtEdges);
    else for (const edge of builtEdges) await this.storage.graph.upsertEdge(edge);
    if (this.storage.graph.upsertHyperedges) await this.storage.graph.upsertHyperedges(builtGraph.hyperedges);
    else for (const hyperedge of builtGraph.hyperedges) await this.storage.graph.upsertHyperedge(hyperedge);
    graphNodes += builtGraph.nodes.length;
    graphEdges += builtGraph.edges.length;

    await this.storage.ingestion.put({
      ...checkpoint,
      phase: "stored",
      status: "complete",
      offsetBytes: checkpoint.offsetBytes,
      contentHash,
      byteLength: file.bytes.byteLength,
      updatedAt: now,
      metadata: {
        ...objectOrEmpty(wikiMetadata(checkpoint.metadata)),
        typedIngest: typedProjection.diagnostics,
        languageMemory: { deferredToShard: true, sourceSystem: "wikipedia" },
        sourceSystem: "wikipedia"
      }
    });
    await this.storage.events.append(this.events.create({ episodeId, typeId: "EvidenceLinked", payload: { sourceVersionId, evidence: admittedSpans.length, sourceSystem: "wikipedia" } }));
    await this.storage.events.append(this.events.create({ episodeId, typeId: "GraphUpdated", payload: { sourceVersionId, typed: typedProjection.diagnostics, built: builtGraph.diagnostics } }));

    return {
      sources: 1,
      evidence: admittedSpans.length,
      graphNodes,
      graphEdges,
      // Page profiles are transient extraction aids. Only bounded, trained
      // language-shard profiles become durable turn-time surface profiles.
      languageProfiles: 0,
      ngramObservations: 0,
      ngramModels: 0,
      languageUnits: 0,
      languagePatterns: 0,
      semanticFrames: 0,
      languageSample: {
        uri: file.uri,
        title: stringValue(objectOrEmpty(metadata).title),
        sourceVersionId,
        text: file.text,
        evidence: admittedSpans,
        createdAt: now,
        languageAliases: languageAliasSurfacesFromMetadata(metadata)
      },
      warnings
    };
  }

  private async ingestLanguageShard(samples: readonly WikipediaLanguageShardSample[], shardUri: string, episodeId: ReturnType<IdFactory["episodeId"]>): Promise<WikipediaLanguageShardImport> {
    if (!samples.length) return zeroLanguageShard({ warnings: [] });
    const createdAt = samples.reduce((max, sample) => Math.max(max, sample.createdAt), 0) || this.clock.now();
    const text = boundedLanguageShardText(samples, 1_200_000);
    const sourceVersionId = this.ids.sourceVersionId(`${shardUri}\u001f${text}`);
    const profile = this.language.acquire({ sourceVersionId, text, createdAt });
    const evidence = selectShardEvidence(samples, 2048);
    const ngramMaxOrder = this.config.runtime.corpora?.wikipedia?.ngramMaxOrder ?? 4;
    const ngramMaxCounters = this.config.runtime.corpora?.wikipedia?.ngramMaxCountersPerOrder ?? 128;
    const vocabularyLimit = this.config.runtime.corpora?.wikipedia?.ngramVocabularyLimit ?? 8192;
    const trained = await trainLanguageCorpusText({
      storage: this.storage,
      sourceSystem: "wikipedia",
      streamUri: shardUri,
      sourceUri: shardUri,
      sourceVersionId,
      text,
      evidence,
      profile,
      languageAliases: [...new Set(samples.flatMap(sample => sample.languageAliases))].sort(),
      createdAt,
      ngramMaxOrder,
      ngramMaxCountersPerOrder: ngramMaxCounters,
      ngramVocabularyLimit: vocabularyLimit,
      corpusMetadata: {
        shardUri,
        pages: samples.length,
        sourceVersionIds: samples.map(sample => String(sample.sourceVersionId)).slice(0, 256)
      },
      persistSource: false,
      episodeId
    });
    return {
      languageProfiles: trained.languageProfiles,
      ngramObservations: trained.ngramObservations,
      ngramModels: trained.ngramModels,
      languageUnits: trained.languageUnits,
      languagePatterns: trained.languagePatterns,
      semanticFrames: trained.semanticFrames,
      warnings: trained.warnings
    };
  }
}

function zeroPage(input: { warnings: string[] }): WikipediaPageImport {
  return {
    sources: 0,
    evidence: 0,
    graphNodes: 0,
    graphEdges: 0,
    languageProfiles: 0,
    ngramObservations: 0,
    ngramModels: 0,
    languageUnits: 0,
    languagePatterns: 0,
    semanticFrames: 0,
    warnings: input.warnings
  };
}

function zeroLanguageShard(input: { warnings: string[] }): WikipediaLanguageShardImport {
  return {
    languageProfiles: 0,
    ngramObservations: 0,
    ngramModels: 0,
    languageUnits: 0,
    languagePatterns: 0,
    semanticFrames: 0,
    warnings: input.warnings
  };
}

function boundedLanguageShardText(samples: readonly WikipediaLanguageShardSample[], maxChars: number): string {
  const parts: string[] = [];
  let remaining = Math.max(0, maxChars);
  for (const sample of samples) {
    if (remaining <= 0) break;
    const text = sample.title ? `${sample.title}\n${sample.text}` : sample.text;
    if (!text) continue;
    if (parts.length && remaining > 1) {
      parts.push("\n\n");
      remaining -= 2;
    }
    if (text.length <= remaining) {
      parts.push(text);
      remaining -= text.length;
      continue;
    }
    parts.push(text.slice(0, remaining));
    break;
  }
  return parts.join("");
}

function selectShardEvidence(samples: readonly WikipediaLanguageShardSample[], limit: number): EvidenceSpan[] {
  const selected: EvidenceSpan[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    for (const span of sample.evidence) {
      const key = String(span.id);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(span);
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

function stampEvidence(spans: EvidenceSpan[], metadata: JsonValue): EvidenceSpan[] {
  const sourceFeatures = sourceAnchorFeaturesFromMetadata(metadata);
  return spans.map(span => ({
    ...span,
    features: [...new Set([...sourceFeatures, ...span.features])].slice(0, 720),
    status: "promoted",
    provenance: {
      ...objectOrEmpty(span.provenance),
      ...objectOrEmpty(metadata),
      sourceSystem: "wikipedia",
      forceClass: "direct_evidence" satisfies BrainShardProvenanceClass
    },
    trustVector: {
      ...objectOrEmpty(span.trustVector),
      sourceSystem: "wikipedia",
      forceClass: "direct_evidence"
    }
  }));
}

function sourceAnchorFeaturesFromMetadata(metadata: JsonValue): string[] {
  const record = objectOrEmpty(metadata);
  const surfaces = [
    stringValue(record.title),
    stringValue(record.uri),
    stringValue(record.canonicalUri),
    stringValue(record.sourceUri)
  ].filter((value): value is string => Boolean(value));
  const features: string[] = [];
  for (const surface of surfaces) {
    const units = sourceAnchorUnits(surface);
    for (const unit of units) features.push(`sym:${unit}`);
    for (let index = 0; index < units.length - 1; index++) features.push(`bi:${units[index]}|${units[index + 1]}`);
    for (let index = 0; index < units.length - 2; index++) features.push(`tri:${units[index]}|${units[index + 1]}|${units[index + 2]}`);
  }
  return [...new Set(features)].slice(0, 96);
}

function sourceAnchorUnits(surface: string): string[] {
  return (surface.normalize("NFC").toLocaleLowerCase().match(/[\p{Letter}\p{Number}_]+/gu) ?? [])
    .filter(unit => unit.length >= 2)
    .slice(0, 24);
}

function stampGraphNodes(nodes: GraphNode[]): GraphNode[] {
  return nodes.map(node => ({
    ...node,
    features: [...new Set(["wikipedia", "wiki-stream", ...node.features])],
    metadata: { ...objectOrEmpty(node.metadata), sourceSystem: "wikipedia", forceClass: "learned_concept_prior" }
  }));
}

function stampGraphEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.map(edge => ({
    ...edge,
    metadata: { ...objectOrEmpty(edge.metadata), sourceSystem: "wikipedia", forceClass: "learned_concept_prior" }
  }));
}

function wikiMetadata(value: JsonValue): JsonValue {
  return { ...objectOrEmpty(value), sourceSystem: "wikipedia", sourceKind: "wikimedia_dump", ingestionLane: "wiki_stream" };
}

function isBlockCheckpoint(checkpoint: IngestionCheckpoint): boolean {
  return checkpoint.itemUri.includes("/block/");
}

function stopDecision(input: WikipediaV3IngestOptions, result: WikipediaV3IngestResult): { kind: "heap" | "owner"; reason: string } | undefined {
  if (input.stopFile && existsSync(input.stopFile)) return { kind: "owner", reason: `owner stop file present at ${input.stopFile}` };
  const limit = input.heapCheckpointMb;
  if (limit && limit > 0) {
    const current = heapMiB();
    result.heapMiB = current;
    result.rssMiB = rssMiB();
    if (current >= limit) return { kind: "heap", reason: `heap safety checkpoint (${current} MiB >= ${limit} MiB)` };
  }
  return undefined;
}

export function wikipediaImportCanActivate(result: Pick<WikipediaV3IngestResult, "sources" | "stoppedByHeapSafetyBound" | "stoppedByOwner">): boolean {
  return result.sources > 0 && !result.stoppedByHeapSafetyBound && !result.stoppedByOwner;
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function rssMiB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function nowMs(): number {
  return Date.now();
}

function objectOrEmpty(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
