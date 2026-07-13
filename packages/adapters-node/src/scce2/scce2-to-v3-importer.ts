import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createClock,
  createEventFactory,
  createHasher,
  createIdFactory,
  featureSet,
  stableVector,
  toJsonValue,
  validateBrainManifestContract,
  validationDisposition,
  type BrainLifecycleState,
  type BrainLifecycleRecord,
  type BrainManifestContract,
  type BrainValidationReport,
  type BrainShardImportOptions,
  type BrainShardImportResult,
  type BrainShardImportWarning,
  type BrainImportLedgerRecord,
  type BrainShardProvenanceClass,
  type BrainShardImporter,
  type BrainShardManifest,
  type Clock,
  type EvidenceId,
  type EvidenceSpan,
  type GraphEdge,
  type GraphNode,
  type Hasher,
  type Hyperedge,
  type IdFactory,
  type JsonValue,
  type LanguagePatternRecord,
  type LanguageUnitRecord,
  type NgramModelRecord,
  type NgramObservation,
  type ScceStorage,
  type SemanticFrameRecord,
  type SourceVersion,
  type SourceVersionId
} from "@scce/kernel";
import {
  Scce2BrainShardReader,
  readScce2ConceptSnapshot,
  type Scce2Concept,
  type Scce2Relation
} from "./brain-shard-reader.js";
import { readScce2LanguageProfile, type Scce2LanguageProfileShard, type Scce2ProfileFileEvidence, type Scce2TopEntry } from "./scce2-ingest-manifest.js";
import { streamScce2ConceptGraph } from "./concept-graph-stream.js";
import { hashScce2SourcePath, parseBrainEntryPath, readBoundedScce2Source } from "./brain-bundle.js";
import { streamScce2NgramState, type Scce2NgramStreamItem } from "./ngram-stream.js";

export interface Scce2ToV3ImporterOptions {
  storage: ScceStorage;
  idFactory?: IdFactory;
  hasher?: Hasher;
  clock?: Clock;
  reader?: Scce2BrainShardReader;
  namespace?: string;
}

interface SourceVersionRef {
  sourceVersion: SourceVersion;
  bytes: Uint8Array;
}

interface ImportedLanguageProfile {
  languageUnits: number;
  languagePatterns: number;
  ngramObservations: number;
  semanticFrames: number;
  evidenceIds: EvidenceId[];
  directEvidenceIds: EvidenceId[];
  profileExcerptEvidenceIds: EvidenceId[];
  sourceVersionIds: SourceVersionId[];
  directEvidenceSourceVersionIds: SourceVersionId[];
  profileExcerptSourceVersionIds: SourceVersionId[];
  directEvidenceSemanticFrames: number;
  profileExcerptSemanticFrames: number;
  programPriors: number;
  programLanguageUnits: number;
  programLanguagePatterns: number;
  programNgramObservations: number;
}

const IMPORT_PAGE_ROWS = 2048;
const DEFAULT_IMPORT_HASH_WORK_EXTENT_BYTES = 512 * 1024 * 1024;
const DEFAULT_IMPORT_MAX_HASH_BYTES_PER_FILE = 96 * 1024 * 1024;

export class Scce2ToV3Importer implements BrainShardImporter {
  private readonly storage: ScceStorage;
  private readonly reader: Scce2BrainShardReader;
  private readonly hasher: Hasher;
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly namespace: string;

  constructor(options: Scce2ToV3ImporterOptions) {
    this.storage = options.storage;
    this.reader = options.reader ?? new Scce2BrainShardReader();
    this.hasher = options.hasher ?? createHasher();
    this.clock = options.clock ?? createClock();
    this.ids = options.idFactory ?? createIdFactory({ clock: this.clock, hasher: this.hasher, namespace: options.namespace ?? "scce2-bootstrap" });
    this.namespace = options.namespace ?? "scce2-bootstrap";
  }

  inspect(rootPath: string) {
    return this.reader.inspect(rootPath);
  }

  readManifest(rootPath: string) {
    return this.reader.readManifest(rootPath);
  }

  async import(rootPath: string, options: BrainShardImportOptions = {}): Promise<BrainShardImportResult> {
    const manifest = await this.readManifest(rootPath);
    const now = options.now ?? this.clock.now();
    const identity = scce2ImportIdentity({ manifest, rootPath, ids: this.ids, hasher: this.hasher, now });
    try {
      return await this.importManifest(rootPath, manifest, identity, options);
    } catch (error) {
      const lifecycle = await this.storage.brainImports.getLifecycle(identity.manifest.importRunId).catch(() => null);
      if (lifecycle && (["CREATED", "IMPORTING", "VALIDATING"] as BrainLifecycleState[]).includes(lifecycle.state)) {
        await this.storage.brainImports.transitionLifecycle({
          importRunId: lifecycle.importRunId,
          expectedState: lifecycle.state,
          toState: "FAILED",
          updatedAt: now,
          reason: messageOf(error)
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async importManifest(
    rootPath: string,
    manifest: BrainShardManifest,
    identity: { rootHash: string; manifestHash: string; importRunId: string; activeBrainVersion: string; manifest: BrainManifestContract },
    options: BrainShardImportOptions
  ): Promise<BrainShardImportResult> {
    const now = options.now ?? this.clock.now();
    const trust = options.trust ?? 0.62;
    const alpha = options.alpha ?? 0.56;
    const importDirectEvidence = options.importDirectEvidence ?? true;
    const importLearnedPriors = options.importLearnedPriors ?? true;
    const warnings: BrainShardImportWarning[] = [];
    const { rootHash, manifestHash, importRunId, activeBrainVersion } = identity;
    const existingLedger = await this.storage.brainImports.listLedger({ importRunId, limit: 100000 });
    const completedLedger = existingLedger.find(row => row.sectionId === "__import_complete__" && Boolean(row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) && (row.metadata as { complete?: unknown }).complete === true));
    let lifecycle = await this.storage.brainImports.getLifecycle(importRunId);
    if (!lifecycle) {
      await this.storage.brainImports.putLifecycle({
        importRunId,
        brainVersion: activeBrainVersion,
        rootPath: path.resolve(rootPath),
        state: "CREATED",
        manifest: identity.manifest,
        revision: 0,
        createdAt: now,
        updatedAt: now
      });
      lifecycle = await this.storage.brainImports.getLifecycle(importRunId);
    }
    if (!lifecycle) throw new Error(`brain lifecycle creation failed for ${importRunId}`);
    if (lifecycle.brainVersion !== activeBrainVersion || lifecycle.manifest.manifestHash !== manifestHash) {
      throw new Error(`brain lifecycle identity conflict for ${importRunId}`);
    }
    if (lifecycle.state === "QUARANTINED" || lifecycle.state === "INCOMPATIBLE") {
      throw new Error(`brain import ${importRunId} is ${lifecycle.state}`);
    }
    if (lifecycle.state === "CREATED" || lifecycle.state === "STOPPED" || lifecycle.state === "FAILED") {
      lifecycle = await this.storage.brainImports.transitionLifecycle({
        importRunId,
        expectedState: lifecycle.state,
        toState: "IMPORTING",
        updatedAt: now,
        reason: lifecycle.state === "CREATED" ? "import started" : "import resumed"
      });
    }
    if (completedLedger) {
      if (lifecycle.state === "IMPORTING" || lifecycle.state === "VALIDATING") {
        lifecycle = await this.validateCompletedImport({ lifecycleState: lifecycle.state, manifest: identity.manifest, importRunId, activeBrainVersion, manifestHash, completedLedger, now });
      }
      if (lifecycle.state === "READY") await this.storage.brainImports.activateReady({ brainVersion: activeBrainVersion, importRunId, updatedAt: now });
      else if (lifecycle.state !== "ACTIVE") throw new Error(`completed brain import ${importRunId} is not activatable from ${lifecycle.state}`);
      return importResultFromLedger({ manifest, importRunId, activeBrainVersion, ledger: existingLedger });
    }
    if (existingLedger.length) {
      warnings.push({
        code: "scce2_import_resume_incomplete",
        message: `resuming incomplete SCCE2 import ${importRunId}; brain remains inactive until validation and completion`
      });
    }
    const importEpisodeId = this.ids.episodeId();
    const events = createEventFactory({ idFactory: this.ids, clock: this.clock, hasher: this.hasher });
    await this.storage.events.append(events.create({ episodeId: importEpisodeId, typeId: "Scce2ImportStarted", payload: { importRunId, activeBrainVersion, rootPath: path.resolve(rootPath), sourceId: manifest.sourceId ?? null } }));
    const sourceVersionIds: SourceVersionId[] = [];
    const evidenceIds: EvidenceId[] = [];
    const nodeIds: GraphNode["id"][] = [];
    let stopped = false;
    let stopReason: string | undefined;
    let sectionsProcessed = 0;
    let hashWorkExtentRemaining = Math.max(0, options.hashWorkExtentBytes ?? DEFAULT_IMPORT_HASH_WORK_EXTENT_BYTES);
    const maxHashBytesPerFile = Math.max(0, options.maxHashBytesPerFile ?? DEFAULT_IMPORT_MAX_HASH_BYTES_PER_FILE);
    let hashOmitted = 0;
    let hashComputed = 0;
    let hashBytes = 0;
    const counters = {
      sourceVersions: 0,
      directEvidenceSpans: 0,
      profileExcerptEvidenceSpans: 0,
      graphNodes: 0,
      graphEdges: 0,
      graphHyperedges: 0,
      languageUnits: 0,
      languagePatterns: 0,
      ngramStates: 0,
      ngramObservations: 0,
      skipped: 0
    };
    const emitStatus = async (state: "starting" | "running" | "stopping" | "completed" | "failed", currentSection?: string): Promise<void> => {
      await options.onStatus?.(toJsonValue({
        schema: "scce.scce2ImportStatus.v1",
        state,
        pid: process.pid,
        importRunId,
        activeBrainVersion,
        rootPath: path.resolve(rootPath),
        sourceId: manifest.sourceId ?? null,
        currentSection: currentSection ?? null,
        sectionsProcessed,
        counters,
        hash: { remainingBytes: hashWorkExtentRemaining, hashedBytes: hashBytes, hashedFiles: hashComputed, omittedFiles: hashOmitted },
        heapMiB: heapMiB(),
        rssMiB: rssMiB(),
        stopped,
        stopReason: stopReason ?? null,
        warnings: warnings.slice(-64)
      }));
    };
    const checkStop = async (currentSection: string): Promise<boolean> => {
      if (options.stopFile && existsSync(options.stopFile)) {
        stopped = true;
        stopReason = `owner stop file present at ${options.stopFile}`;
      }
      if (!stopped && options.heapCheckpointMb && options.heapCheckpointMb > 0 && heapMiB() >= options.heapCheckpointMb) {
        stopped = true;
        stopReason = `heap safety checkpoint (${heapMiB()} MiB >= ${options.heapCheckpointMb} MiB)`;
      }
      if (stopped) {
        warnings.push({ code: "scce2_import_stopped", message: stopReason ?? "SCCE2 import stopped", shardId: currentSection });
        await emitStatus("stopping", currentSection);
      }
      return stopped;
    };
    const hashSource = async (filePath: string, byteLength: number | undefined, sectionId: string) => {
      const estimated = Math.max(0, byteLength ?? 0);
      if (maxHashBytesPerFile === 0 || hashWorkExtentRemaining === 0 || estimated > maxHashBytesPerFile || estimated > hashWorkExtentRemaining) {
        hashOmitted++;
        return undefined;
      }
      const result = await hashScce2SourcePath(filePath).catch(() => undefined);
      if (!result) return undefined;
      hashWorkExtentRemaining = Math.max(0, hashWorkExtentRemaining - result.byteLength);
      hashBytes += result.byteLength;
      hashComputed++;
      void sectionId;
      return result;
    };

    await emitStatus("starting", "manifest");

    const manifestRef = await this.putDescriptorSourceVersion({
      namespace: `${this.namespace}:manifest`,
      canonicalUri: `scce2://manifest/${encodeURIComponent(path.resolve(rootPath))}`,
      descriptor: manifest,
      mediaType: "application/json",
      trust,
      observedAt: now,
      provenanceClass: "unknown_prior"
    });
    await this.storage.brainImports.putLedger({
      id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: "manifest", rootHash }),
      importRunId,
      brainVersion: activeBrainVersion,
      rootPath: path.resolve(rootPath),
      sectionId: "manifest",
      sectionKind: "manifest",
      forceClass: "unknown_prior",
      sourceVersionId: manifestRef.sourceVersion.sourceVersionId,
      evidenceIds: [],
      nodeIds: [],
      rowCounts: { source_versions: 1 },
      warnings: manifest.warnings,
      metadata: toJsonValue({ sourceSystem: "scce2", sourceId: manifest.sourceId ?? null, importable: manifest.metadata }),
      importedAt: now
    });
    sourceVersionIds.push(manifestRef.sourceVersion.sourceVersionId);
    counters.sourceVersions++;

    if (importLearnedPriors) {
      const graphShards = options.graphShardLimit === undefined ? (manifest.graph?.shards ?? []) : (manifest.graph?.shards ?? []).slice(0, Math.max(0, options.graphShardLimit));
      for (const shard of graphShards) {
        if (await checkStop(shard.shardId)) break;
        await emitStatus("running", shard.shardId);
        const ref = await this.putDescriptorSourceVersion({
          namespace: `${this.namespace}:graph-shard`,
          canonicalUri: `scce2://graph-shard/${encodeURIComponent(shard.shardId)}`,
          descriptor: { manifestSourceVersionId: manifestRef.sourceVersion.sourceVersionId, shard },
          mediaType: "application/vnd.scce2.graph-shard+json",
          trust,
          observedAt: now,
          provenanceClass: "learned_concept_prior"
        });
        sourceVersionIds.push(ref.sourceVersion.sourceVersionId);
        counters.sourceVersions++;
        const shardHash = await hashSource(shard.snapshotPath, shard.byteLength, shard.shardId);
        const result = await this.importGraphShard(shard, ref.sourceVersion.sourceVersionId, { ...options, alpha, now, trust }, warnings);
        counters.graphNodes += result.nodes;
        counters.graphEdges += result.edges;
        counters.graphHyperedges += result.hyperedges;
        counters.skipped += result.skipped;
        nodeIds.push(...result.nodeIds);
        await this.storage.brainImports.putLedger({
          id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: shard.shardId, forceClass: "learned_concept_prior", shardHash }),
          importRunId,
          brainVersion: activeBrainVersion,
          rootPath: path.resolve(rootPath),
          sectionId: shard.shardId,
          sectionKind: "graph_shard",
          forceClass: "learned_concept_prior",
          sourcePath: shard.snapshotPath,
          fileHash: shardHash?.sha256,
          shardHash: shardHash?.sha256,
          sourceVersionId: ref.sourceVersion.sourceVersionId,
          evidenceIds: [],
          nodeIds: result.nodeIds.map(String),
          rowCounts: { source_versions: 1, graph_nodes: result.nodes, graph_edges: result.edges, graph_hyperedges: result.hyperedges },
          warnings: warnings.filter(warning => warning.shardId === shard.shardId).map(warning => warning.message),
          metadata: toJsonValue({ sourceSystem: "scce2", shard, provenanceClass: "learned_concept_prior" }),
          importedAt: now
        });
        sectionsProcessed++;
      }

      const languageShards = stopped ? [] : options.languageShardLimit === undefined ? (manifest.language?.shards ?? []) : (manifest.language?.shards ?? []).slice(0, Math.max(0, options.languageShardLimit));
      for (const shard of languageShards) {
        if (await checkStop(shard.shardId)) break;
        await emitStatus("running", shard.shardId);
        const profile = await readScce2LanguageProfile(shard.profilePath);
        if (!profile) {
          warnings.push({ path: shard.profilePath, shardId: shard.shardId, code: "language_profile_unreadable", message: "SCCE2 language profile could not be read" });
          counters.skipped++;
          continue;
        }
        const ref = await this.putSmallFileOrDescriptor({
          namespace: `${this.namespace}:language-profile`,
          canonicalUri: `scce2://language-profile/${encodeURIComponent(shard.shardId)}`,
          filePath: shard.profilePath,
          descriptor: { manifestSourceVersionId: manifestRef.sourceVersion.sourceVersionId, shard, profileDigest: profileDigest(profile) },
          mediaType: "application/vnd.scce2.language-profile+json",
          trust,
          observedAt: now,
          provenanceClass: "learned_language_prior"
        });
        const profileHash = await hashSource(shard.profilePath, shard.byteLength, shard.shardId);
        sourceVersionIds.push(ref.sourceVersion.sourceVersionId);
        counters.sourceVersions++;
        const imported = await this.importLanguageProfile(profile, ref.sourceVersion.sourceVersionId, { alpha, now, trust, importDirectEvidence, fileEvidenceLimitPerShard: options.fileEvidenceLimitPerShard ?? Number.MAX_SAFE_INTEGER });
        counters.languageUnits += imported.languageUnits;
        counters.languagePatterns += imported.languagePatterns;
        counters.ngramObservations += imported.ngramObservations;
        counters.directEvidenceSpans += imported.directEvidenceIds.length;
        counters.profileExcerptEvidenceSpans += imported.profileExcerptEvidenceIds.length;
        counters.sourceVersions += imported.sourceVersionIds.length;
        evidenceIds.push(...imported.evidenceIds);
        sourceVersionIds.push(...imported.sourceVersionIds);
        await this.storage.brainImports.putLedger({
          id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: shard.shardId, forceClass: "learned_language_prior", profileHash }),
          importRunId,
          brainVersion: activeBrainVersion,
          rootPath: path.resolve(rootPath),
          sectionId: shard.shardId,
          sectionKind: "language_profile",
          forceClass: "learned_language_prior",
          sourcePath: shard.profilePath,
          fileHash: profileHash?.sha256,
          shardHash: profileHash?.sha256,
          sourceVersionId: ref.sourceVersion.sourceVersionId,
          evidenceIds: imported.evidenceIds,
          nodeIds: [],
          rowCounts: {
            source_versions: 1 + imported.sourceVersionIds.length,
            evidence_spans: imported.evidenceIds.length,
            direct_evidence_spans: imported.directEvidenceIds.length,
            profile_excerpt_evidence_spans: imported.profileExcerptEvidenceIds.length,
            language_units: imported.languageUnits,
            language_patterns: imported.languagePatterns,
            ngram_observations: imported.ngramObservations,
            semantic_frames: imported.semanticFrames
          },
          warnings: [],
          metadata: toJsonValue({ sourceSystem: "scce2", shard, profileDigest: profileDigest(profile), provenanceClass: "learned_language_prior" }),
          importedAt: now
        });
        if (imported.directEvidenceIds.length) {
          await this.storage.brainImports.putLedger({
            id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: `${shard.shardId}:direct_evidence`, forceClass: "direct_evidence", profileHash }),
            importRunId,
            brainVersion: activeBrainVersion,
            rootPath: path.resolve(rootPath),
            sectionId: `${shard.shardId}:direct_evidence`,
            sectionKind: "direct_evidence",
            forceClass: "direct_evidence",
            sourcePath: shard.profilePath,
            fileHash: profileHash?.sha256,
            shardHash: profileHash?.sha256,
            sourceVersionId: ref.sourceVersion.sourceVersionId,
            evidenceIds: imported.directEvidenceIds,
            nodeIds: [],
            rowCounts: { source_versions: imported.directEvidenceSourceVersionIds.length, evidence_spans: imported.directEvidenceIds.length, semantic_frames: imported.directEvidenceSemanticFrames },
            warnings: [],
            metadata: toJsonValue({ sourceSystem: "scce2", shardId: shard.shardId, provenanceClass: "direct_evidence", rule: "external source URI/version/span preserved by SCCE2 profile excerpt" }),
            importedAt: now
          });
        }
        if (imported.profileExcerptEvidenceIds.length) {
          await this.storage.brainImports.putLedger({
            id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: `${shard.shardId}:profile_excerpt_evidence`, forceClass: "profile_excerpt_evidence", profileHash }),
            importRunId,
            brainVersion: activeBrainVersion,
            rootPath: path.resolve(rootPath),
            sectionId: `${shard.shardId}:profile_excerpt_evidence`,
            sectionKind: "profile_excerpt_evidence",
            forceClass: "profile_excerpt_evidence",
            sourcePath: shard.profilePath,
            fileHash: profileHash?.sha256,
            shardHash: profileHash?.sha256,
            sourceVersionId: ref.sourceVersion.sourceVersionId,
            evidenceIds: imported.profileExcerptEvidenceIds,
            nodeIds: [],
            rowCounts: { source_versions: imported.profileExcerptSourceVersionIds.length, evidence_spans: imported.profileExcerptEvidenceIds.length, semantic_frames: imported.profileExcerptSemanticFrames },
            warnings: [],
            metadata: toJsonValue({
              sourceSystem: "scce2",
              shardId: shard.shardId,
              provenanceClass: "profile_excerpt_evidence",
              rule: "SCCE2 profile excerpt proves profile-contained text only; it is not external factual evidence without original URI/version/span"
            }),
            importedAt: now
          });
        }
        if (imported.programPriors > 0) {
          await this.storage.brainImports.putLedger({
            id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: `${shard.shardId}:program_priors`, forceClass: "learned_program_prior", profileHash }),
            importRunId,
            brainVersion: activeBrainVersion,
            rootPath: path.resolve(rootPath),
            sectionId: `${shard.shardId}:program_priors`,
            sectionKind: "language_profile",
            forceClass: "learned_program_prior",
            sourcePath: shard.profilePath,
            fileHash: profileHash?.sha256,
            shardHash: profileHash?.sha256,
            sourceVersionId: ref.sourceVersion.sourceVersionId,
            evidenceIds: [],
            nodeIds: [],
            rowCounts: {
              language_units: imported.programLanguageUnits,
              language_patterns: imported.programLanguagePatterns,
              ngram_observations: imported.programNgramObservations,
              program_patterns: imported.programPriors
            },
            warnings: [],
            metadata: toJsonValue({ sourceSystem: "scce2", shardId: shard.shardId, provenanceClass: "learned_program_prior", rule: "SCCE2 profile program fields hydrated into LanguageMemory" }),
            importedAt: now
          });
        }
        sectionsProcessed++;
      }

      const ngramStates = stopped ? [] : options.ngramStateLimit === undefined ? manifest.ngramStates : manifest.ngramStates.slice(0, Math.max(0, options.ngramStateLimit));
      for (const state of ngramStates) {
        if (await checkStop(state.stateId)) break;
        await emitStatus("running", state.stateId);
        const ref = await this.putDescriptorSourceVersion({
          namespace: `${this.namespace}:ngram-state`,
          canonicalUri: `scce2://ngram-state/${encodeURIComponent(state.stateId)}`,
          descriptor: { manifestSourceVersionId: manifestRef.sourceVersion.sourceVersionId, state, sourcePath: state.path },
          mediaType: "application/vnd.scce2.ngram-state+json",
          trust,
          observedAt: now,
          provenanceClass: state.forceClass ?? "learned_language_prior"
        });
        sourceVersionIds.push(ref.sourceVersion.sourceVersionId);
        counters.sourceVersions++;
        const stateHash = await hashSource(state.path, state.byteLength, state.stateId);
        const imported = await this.importNgramState(state.path, state.stateId, state.forceClass ?? "learned_language_prior", ref.sourceVersion.sourceVersionId, { ...options, now, trust }, warnings);
        counters.ngramStates += imported.states;
        counters.ngramObservations += imported.observations;
        counters.skipped += imported.skipped;
        await this.storage.brainImports.putLedger({
          id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: state.stateId, forceClass: state.forceClass ?? "learned_language_prior", stateHash }),
          importRunId,
          brainVersion: activeBrainVersion,
          rootPath: path.resolve(rootPath),
          sectionId: state.stateId,
          sectionKind: "ngram_state",
          forceClass: state.forceClass ?? "learned_language_prior",
          sourcePath: state.path,
          fileHash: stateHash?.sha256,
          shardHash: stateHash?.sha256,
          sourceVersionId: ref.sourceVersion.sourceVersionId,
          evidenceIds: [],
          nodeIds: [],
          rowCounts: { source_versions: 1, ngram_models: imported.states, ngram_observations: imported.observations },
          warnings: warnings.filter(warning => warning.path === state.path).map(warning => warning.message),
          metadata: toJsonValue({ sourceSystem: "scce2", state, provenanceClass: state.forceClass ?? "learned_language_prior" }),
          importedAt: now
        });
        sectionsProcessed++;
      }
      for (const section of stopped ? [] : manifest.priorSections) {
        if (await checkStop(section.sectionId)) break;
        await emitStatus("running", section.sectionId);
        const sectionImported = await this.importPriorSection(section, { now, trust, alpha }, warnings);
        counters.sourceVersions += sectionImported.sourceVersions;
        counters.languageUnits += sectionImported.languageUnits;
        counters.languagePatterns += sectionImported.languagePatterns;
        counters.skipped += sectionImported.skipped;
        sourceVersionIds.push(...sectionImported.sourceVersionIds);
        await this.storage.brainImports.putLedger({
          id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: section.sectionId, forceClass: section.forceClass, path: section.path, sha256: section.sha256 }),
          importRunId,
          brainVersion: activeBrainVersion,
          rootPath: path.resolve(rootPath),
          sectionId: section.sectionId,
          sectionKind: section.sectionKind,
          forceClass: section.forceClass,
          sourcePath: section.path,
          fileHash: section.sha256,
          shardHash: section.sha256,
          sourceVersionId: sectionImported.sourceVersionIds[0],
          evidenceIds: [],
          nodeIds: [],
          rowCounts: {
            source_versions: sectionImported.sourceVersions,
            language_units: sectionImported.languageUnits,
            language_patterns: sectionImported.languagePatterns
          },
          warnings: [
            ...(section.sectionKind === "unknown" ? ["unsupported SCCE2 brain section semantics; preserved in ledger only"] : []),
            ...warnings.filter(warning => warning.path === section.path).map(warning => warning.message)
          ],
          metadata: toJsonValue({ sourceSystem: "scce2", section, provenanceClass: section.forceClass }),
          importedAt: now
        });
        sectionsProcessed++;
      }
    }
    if (hashOmitted > 0) warnings.push({ code: "scce2_hash_work_extent_exhausted", message: `omitted hashes for ${hashOmitted} SCCE2 files under bounded import hash work extent` });

    if (stopped) {
      const stoppedLifecycle = await this.storage.brainImports.getLifecycle(importRunId);
      if (stoppedLifecycle?.state === "IMPORTING") {
        await this.storage.brainImports.transitionLifecycle({
          importRunId,
          expectedState: "IMPORTING",
          toState: "STOPPED",
          updatedAt: now,
          reason: stopReason ?? "SCCE2 import stopped"
        });
      }
      await this.storage.events.append(events.create({
        episodeId: importEpisodeId,
        typeId: "Scce2ImportStopped",
        payload: { importRunId, activeBrainVersion, counters, warnings, stopped: true, stopReason: stopReason ?? null }
      }));
      await emitStatus("stopping");
      return {
        manifest,
        counters,
        importRunId,
        activeBrainVersion,
        sourceVersionIds,
        evidenceIds,
        nodeIds,
        warnings,
        stopped: true,
        stopReason
      };
    }

    await this.storage.brainImports.putLedger({
      id: this.ids.semanticId("scce2_import_ledger", { importRunId, sectionId: "__import_complete__", manifestHash }),
      importRunId,
      brainVersion: activeBrainVersion,
      rootPath: path.resolve(rootPath),
      sectionId: "__import_complete__",
      sectionKind: "manifest",
      forceClass: "learned_concept_prior",
      fileHash: manifestHash,
      evidenceIds: [],
      nodeIds: [],
      rowCounts: {},
      warnings: [],
      metadata: toJsonValue({ complete: true, stopped: false, manifestHash, rootHash, counters }),
      importedAt: now
    });
    const completionRecord = (await this.storage.brainImports.listLedger({ importRunId, limit: 100000 }))
      .find(row => row.sectionId === "__import_complete__");
    if (!completionRecord) throw new Error(`completion sentinel missing for ${importRunId}`);
    const readyLifecycle = await this.validateCompletedImport({ lifecycleState: "IMPORTING", manifest: identity.manifest, importRunId, activeBrainVersion, manifestHash, completedLedger: completionRecord, now });
    if (readyLifecycle.state !== "READY") throw new Error(`brain import ${importRunId} did not reach READY`);
    await this.storage.events.append(events.create({ episodeId: importEpisodeId, typeId: "Scce2ImportCompleted", payload: { importRunId, activeBrainVersion, counters, warnings, stopped: false, stopReason: null } }));
    await emitStatus("completed");
    await this.storage.brainImports.activateReady({ brainVersion: activeBrainVersion, importRunId, updatedAt: now });
    return {
      manifest,
      counters,
      importRunId,
      activeBrainVersion,
      sourceVersionIds,
      evidenceIds,
      nodeIds,
      warnings,
      stopped,
      stopReason
    };
  }

  private async validateCompletedImport(input: {
    lifecycleState: "IMPORTING" | "VALIDATING";
    manifest: BrainManifestContract;
    importRunId: string;
    activeBrainVersion: string;
    manifestHash: string;
    completedLedger: BrainImportLedgerRecord;
    now: number;
  }): Promise<BrainLifecycleRecord> {
    let lifecycle = await this.storage.brainImports.getLifecycle(input.importRunId);
    if (!lifecycle) throw new Error(`brain lifecycle not found for ${input.importRunId}`);
    if (input.lifecycleState === "IMPORTING") {
      lifecycle = await this.storage.brainImports.transitionLifecycle({
        importRunId: input.importRunId,
        expectedState: "IMPORTING",
        toState: "VALIDATING",
        updatedAt: input.now,
        reason: "completion sentinel written; validation started"
      });
    }
    const metadata = asRecord(input.completedLedger.metadata);
    const checks = [
      ...validateBrainManifestContract(input.manifest),
      {
        id: "import.completion_sentinel",
        passed: metadata.complete === true && metadata.stopped === false,
        severity: "error" as const,
        message: "completion sentinel records an unstopped completed import"
      },
      {
        id: "import.manifest_hash",
        passed: input.completedLedger.fileHash === input.manifestHash && metadata.manifestHash === input.manifestHash,
        severity: "error" as const,
        message: "completion sentinel is bound to the validated manifest"
      },
      {
        id: "import.identity",
        passed: input.completedLedger.importRunId === input.importRunId && input.completedLedger.brainVersion === input.activeBrainVersion,
        severity: "error" as const,
        message: "completion sentinel is bound to the lifecycle identity"
      }
    ];
    const validation: BrainValidationReport = {
      schema: "scce.brainValidationReport.v1",
      importRunId: input.importRunId,
      brainVersion: input.activeBrainVersion,
      manifestHash: input.manifestHash,
      validatorVersion: "scce2-import-lifecycle.v1",
      disposition: validationDisposition(checks),
      checks,
      validatedAt: input.now
    };
    if (validation.disposition !== "PASSED") {
      await this.storage.brainImports.transitionLifecycle({
        importRunId: input.importRunId,
        expectedState: "VALIDATING",
        toState: "FAILED",
        updatedAt: input.now,
        reason: "brain validation failed",
        validation
      });
      throw new Error(`brain validation failed for ${input.importRunId}`);
    }
    return this.storage.brainImports.transitionLifecycle({
      importRunId: input.importRunId,
      expectedState: "VALIDATING",
      toState: "READY",
      updatedAt: input.now,
      reason: "brain validation passed",
      validation
    });
  }

  private async importPriorSection(
    section: BrainShardManifest["priorSections"][number],
    options: BrainShardImportOptions & { now: number; trust: number; alpha: number },
    warnings: BrainShardImportWarning[]
  ): Promise<{ sourceVersions: number; languageUnits: number; languagePatterns: number; skipped: number; sourceVersionIds: SourceVersionId[] }> {
    const sourceVersionIds: SourceVersionId[] = [];
    let languageUnits = 0;
    let languagePatterns = 0;
    let skipped = 0;
    const canHydrateLanguage = section.sectionKind === "primitives" || section.sectionKind === "templates" || section.sectionKind === "mouth";
    const canonicalUri = `scce2://prior-section/${encodeURIComponent(section.sectionId)}`;

    if (!canHydrateLanguage) {
      const ref = await this.putDescriptorSourceVersion({
        namespace: `${this.namespace}:prior-section`,
        canonicalUri,
        descriptor: section,
        mediaType: "application/vnd.scce2.prior-section+json",
        trust: options.trust,
        observedAt: options.now,
        provenanceClass: section.forceClass
      });
      return { sourceVersions: 1, languageUnits, languagePatterns, skipped, sourceVersionIds: [ref.sourceVersion.sourceVersionId] };
    }

    let bytes: Buffer;
    try {
      bytes = await readBoundedScce2Source(section.path, options.maxStateBytes ?? 256 * 1024 * 1024);
    } catch (error) {
      const ref = await this.putDescriptorSourceVersion({
        namespace: `${this.namespace}:prior-section`,
        canonicalUri,
        descriptor: { section, readFailure: messageOf(error) },
        mediaType: "application/vnd.scce2.prior-section+json",
        trust: options.trust,
        observedAt: options.now,
        provenanceClass: section.forceClass
      });
      warnings.push({ path: section.path, code: "prior_section_not_read", message: messageOf(error) });
      return { sourceVersions: 1, languageUnits, languagePatterns, skipped: 1, sourceVersionIds: [ref.sourceVersion.sourceVersionId] };
    }

    const ref = await this.putSourceVersionBytes({
      namespace: `${this.namespace}:prior-section`,
      canonicalUri,
      bytes,
      mediaType: "application/json",
      trust: options.trust,
      observedAt: options.now,
      metadata: { descriptor: section, sourceSystem: "scce2", provenanceClass: section.forceClass }
    });
    sourceVersionIds.push(ref.sourceVersion.sourceVersionId);

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      warnings.push({ path: section.path, code: "prior_section_json_unreadable", message: messageOf(error) });
      return { sourceVersions: 1, languageUnits, languagePatterns, skipped: 1, sourceVersionIds };
    }

    const profileId = `scce2:${section.sectionKind}`;
    if (section.sectionKind === "primitives") {
      const imported = await this.importPrimitivesPrior(parsed, ref.sourceVersion.sourceVersionId, profileId, options.alpha, options.now, section.forceClass);
      languageUnits += imported.languageUnits;
      languagePatterns += imported.languagePatterns;
    } else if (section.sectionKind === "templates") {
      const imported = await this.importTemplatePrior(parsed, ref.sourceVersion.sourceVersionId, profileId, options.alpha, options.now, section.forceClass);
      languageUnits += imported.languageUnits;
      languagePatterns += imported.languagePatterns;
    } else if (section.sectionKind === "mouth") {
      const imported = await this.importMouthPrior(parsed, ref.sourceVersion.sourceVersionId, profileId, options.alpha, options.now, section.forceClass);
      languageUnits += imported.languageUnits;
      languagePatterns += imported.languagePatterns;
    }
    return { sourceVersions: 1, languageUnits, languagePatterns, skipped, sourceVersionIds };
  }

  private async importPrimitivesPrior(
    raw: unknown,
    sourceVersionId: SourceVersionId,
    profileId: string,
    alpha: number,
    now: number,
    forceClass: BrainShardProvenanceClass
  ): Promise<{ languageUnits: number; languagePatterns: number }> {
    const root = asRecord(raw);
    let languageUnits = 0;
    let languagePatterns = 0;
    for (const [lexiconName, patternKind] of [
      ["predicateLexicon", "semantic_role"],
      ["domainLexicon", "semantic_role"],
      ["morphology", "morphology"],
      ["intentLexicon", "syntax"]
    ] as const) {
      const lexicon = asRecord(root[lexiconName]);
      for (const [surface, labelsRaw] of Object.entries(lexicon)) {
        const labels = numberRecord(labelsRaw);
        const support = sumNumberRecord(labels);
        await this.putPriorLanguageUnit(profileId, sourceVersionId, surface, support || 1, unitKindForPriorSurface(surface), alpha, now, { sectionKind: "primitives", lexiconName, forceClass });
        languageUnits++;
        for (const [label, count] of Object.entries(labels)) {
          await this.putPriorLanguageUnit(profileId, sourceVersionId, label, count, unitKindForPriorSurface(label), alpha * 0.94, now, { sectionKind: "primitives", lexiconName, surface, forceClass });
          languageUnits++;
        }
        await this.putPriorLanguagePattern(profileId, patternKind, support, labels, sourceVersionId, alpha, now, { sectionKind: "primitives", lexiconName, surface, forceClass });
        languagePatterns++;
      }
    }
    return { languageUnits, languagePatterns };
  }

  private async importTemplatePrior(
    raw: unknown,
    sourceVersionId: SourceVersionId,
    profileId: string,
    alpha: number,
    now: number,
    forceClass: BrainShardProvenanceClass
  ): Promise<{ languageUnits: number; languagePatterns: number }> {
    let languageUnits = 0;
    let languagePatterns = 0;
    for (const item of collectTemplateLikeValues(raw)) {
      await this.putPriorLanguageUnit(profileId, sourceVersionId, item.text, item.support, "phrase", alpha, now, { sectionKind: "templates", path: item.path, forceClass });
      languageUnits++;
      await this.putPriorLanguagePattern(profileId, "syntax", item.support, { [item.text]: item.support }, sourceVersionId, alpha, now, { sectionKind: "templates", path: item.path, forceClass });
      languagePatterns++;
    }
    return { languageUnits, languagePatterns };
  }

  private async importMouthPrior(
    raw: unknown,
    sourceVersionId: SourceVersionId,
    profileId: string,
    alpha: number,
    now: number,
    forceClass: BrainShardProvenanceClass
  ): Promise<{ languageUnits: number; languagePatterns: number }> {
    let languageUnits = 0;
    let languagePatterns = 0;
    for (const item of collectMouthLikeValues(raw)) {
      await this.putPriorLanguageUnit(profileId, sourceVersionId, item.text, item.support, unitKindForPriorSurface(item.text), alpha, now, { sectionKind: "mouth", path: item.path, forceClass });
      languageUnits++;
      await this.putPriorLanguagePattern(profileId, item.kind, item.support, { [item.text]: item.support }, sourceVersionId, alpha, now, { sectionKind: "mouth", path: item.path, forceClass });
      languagePatterns++;
    }
    return { languageUnits, languagePatterns };
  }

  private async importGraphShard(
    shard: NonNullable<BrainShardManifest["graph"]>["shards"][number],
    sourceVersionId: SourceVersionId,
    options: BrainShardImportOptions & { alpha: number; now: number; trust: number },
    warnings: BrainShardImportWarning[]
  ): Promise<{ nodes: number; edges: number; hyperedges: number; skipped: number; nodeIds: GraphNode["id"][] }> {
    const now = options.now;
    const typeId = this.ids.dimensionId({ source: "scce2", kind: "concept_prior" });
    const summaryNode: GraphNode = {
      id: this.ids.nodeId({ source: "scce2", kind: "graph_shard", shardId: shard.shardId }),
      typeId,
      representation: toJsonValue({
        sourceSystem: "scce2",
        shardId: shard.shardId,
        pages: shard.pages,
        triples: shard.triples,
        concepts: shard.concepts,
        relations: shard.relations,
        provenanceClass: "learned_concept_prior"
      }),
      alpha: options.alpha,
      evidenceIds: [],
      features: ["scce2", "brain-shard", "concept-prior", shard.shardId],
      createdAt: now,
      updatedAt: now,
      metadata: toJsonValue({ sourceVersionId, snapshotPath: shard.snapshotPath, statsPath: shard.statsPath ?? null })
    };
    await this.storage.graph.upsertNode(summaryNode);
    const nodeIds = [summaryNode.id];
    let nodes = 1;
    let edges = 0;
    let skipped = 0;

    let hyperedges = 0;
    let hyperedgeMembers: GraphNode["id"][] = [];
    let hyperedgePage = 0;
    const rememberNodeId = (id: GraphNode["id"]) => {
      if (nodeIds.length < 512) nodeIds.push(id);
    };
    const flushHyperedge = async () => {
      if (hyperedgeMembers.length < 2) {
        hyperedgeMembers = [];
        return;
      }
      const relationId = this.ids.relationId({ source: "scce2", predicate: "shard_contains_concepts" });
      const members = hyperedgeMembers;
      const hyperedge: Hyperedge = {
        id: this.ids.hyperedgeId({ relationId, members, provenanceHash: this.hasher.digestHex(`${sourceVersionId}:${shard.shardId}:${hyperedgePage}:${members.length}`) }),
        relationId,
        memberNodeIds: members,
        weightVector: toJsonValue({ sourceSystem: "scce2", memberCount: members.length, page: hyperedgePage, provenanceClass: "learned_concept_prior" }),
        temporalScope: toJsonValue({ validFrom: now }),
        provenanceRefs: [String(sourceVersionId), shard.shardId],
        createdAt: now,
        updatedAt: now
      };
      await this.storage.graph.upsertHyperedge(hyperedge);
      hyperedges++;
      hyperedgePage++;
      hyperedgeMembers = [];
    };

    if (shard.format === "scce2_concept_json" || shard.snapshotPath.toLocaleLowerCase().endsWith(".json")) {
      const summary = await streamScce2ConceptGraph(
        shard.snapshotPath,
        async (conceptId, concept) => {
          if (options.graphConceptLimit !== undefined && nodes >= Math.max(0, options.graphConceptLimit) + 1) return;
          const node = this.graphNodeFromConcept(conceptId, concept, sourceVersionId, options.alpha, now);
          await this.storage.graph.upsertNode(node);
          rememberNodeId(node.id);
          hyperedgeMembers.push(node.id);
          if (hyperedgeMembers.length >= 2048) await flushHyperedge();
          nodes++;
        },
        async relation => {
          if (options.graphRelationLimit !== undefined && edges >= Math.max(0, options.graphRelationLimit)) return;
          const edge = this.graphEdgeFromRelationDirect(relation, sourceVersionId, options.alpha, now);
          await this.storage.graph.upsertEdge(edge);
          edges++;
        }
      );
      for (const message of summary.warnings) warnings.push({ path: shard.snapshotPath, shardId: shard.shardId, code: "concept_graph_stream_warning", message });
      await flushHyperedge();
      return { nodes, edges, hyperedges, skipped, nodeIds };
    }

    const snapshot = await readScce2ConceptSnapshot(shard.snapshotPath, { maxBytes: options.v8DecodeWorkExtentBytes ?? options.maxStateBytes ?? 768 * 1024 * 1024 });
    if (!snapshot.ok || !snapshot.value) {
      warnings.push({ path: shard.snapshotPath, shardId: shard.shardId, code: "concept_snapshot_not_decoded", message: snapshot.warning ?? "concept snapshot not decoded" });
      return { nodes, edges, hyperedges, skipped: skipped + 1, nodeIds };
    }
    for (const [conceptId, concept] of snapshot.value.concepts) {
      if (options.graphConceptLimit !== undefined && nodes >= Math.max(0, options.graphConceptLimit) + 1) break;
      const node = this.graphNodeFromConcept(conceptId, concept, sourceVersionId, options.alpha, now);
      await this.storage.graph.upsertNode(node);
      rememberNodeId(node.id);
      hyperedgeMembers.push(node.id);
      if (hyperedgeMembers.length >= 2048) await flushHyperedge();
      nodes++;
    }
    for (const relation of snapshot.value.relations) {
      if (options.graphRelationLimit !== undefined && edges >= Math.max(0, options.graphRelationLimit)) break;
      const edge = this.graphEdgeFromRelationDirect(relation, sourceVersionId, options.alpha, now);
      await this.storage.graph.upsertEdge(edge);
      edges++;
    }
    await flushHyperedge();
    return { nodes, edges, hyperedges, skipped, nodeIds };
  }

  private graphNodeFromConcept(conceptId: string, concept: Scce2Concept, sourceVersionId: SourceVersionId, alpha: number, now: number): GraphNode {
    const names = concept.names instanceof Set ? [...concept.names] : Array.isArray(concept.names) ? concept.names : [conceptId];
    const properties = concept.properties instanceof Map ? Object.fromEntries(concept.properties) : concept.properties ?? {};
    return {
      id: this.ids.nodeId({ source: "scce2", conceptId }),
      typeId: this.ids.dimensionId({ source: "scce2", kind: "concept" }),
      representation: toJsonValue({ conceptId, names, type: concept.type ?? "unknown", domain: concept.domain ?? "unknown", properties }),
      alpha,
      evidenceIds: [],
      features: ["scce2", "concept-prior", ...featureSet(`${conceptId} ${names.join(" ")} ${concept.domain ?? ""} ${concept.type ?? ""}`, 256)],
      createdAt: now,
      updatedAt: now,
      metadata: toJsonValue({ sourceSystem: "scce2", sourceVersionId, provenanceClass: "learned_concept_prior" })
    };
  }

  private graphEdgeFromRelation(relation: Scce2Relation, conceptNodeIds: Map<string, GraphNode["id"]>, sourceVersionId: SourceVersionId, alpha: number, now: number): GraphEdge | undefined {
    const source = conceptNodeIds.get(relation.subject);
    const target = conceptNodeIds.get(relation.object);
    if (!source || !target) return undefined;
    const relationId = this.ids.relationId({ source: "scce2", predicate: relation.predicate });
    return {
      id: this.ids.edgeId({ source, target, relationId, provenanceHash: this.hasher.digestHex(`${sourceVersionId}:${relation.subject}:${relation.predicate}:${relation.object}`) }),
      source,
      target,
      relationId,
      alpha: alpha * Math.max(0.1, Math.min(1, relation.confidence ?? 0.55)),
      weight: Math.max(0.01, Math.min(1, relation.confidence ?? 0.55)),
      temporalScope: { validFrom: now },
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
      metadata: toJsonValue({ sourceSystem: "scce2", sourceVersionId, relation, provenanceClass: "learned_concept_prior" })
    };
  }

  private graphEdgeFromRelationDirect(relation: Scce2Relation, sourceVersionId: SourceVersionId, alpha: number, now: number): GraphEdge {
    const source = this.ids.nodeId({ source: "scce2", conceptId: relation.subject });
    const target = this.ids.nodeId({ source: "scce2", conceptId: relation.object });
    const relationId = this.ids.relationId({ source: "scce2", predicate: relation.predicate });
    return {
      id: this.ids.edgeId({ source, target, relationId, provenanceHash: this.hasher.digestHex(`${sourceVersionId}:${relation.subject}:${relation.predicate}:${relation.object}`) }),
      source,
      target,
      relationId,
      alpha: alpha * Math.max(0.1, Math.min(1, relation.confidence ?? 0.55)),
      weight: Math.max(0.01, Math.min(1, relation.confidence ?? 0.55)),
      temporalScope: { validFrom: now },
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
      metadata: toJsonValue({ sourceSystem: "scce2", sourceVersionId, relation, provenanceClass: "learned_concept_prior" })
    };
  }

  private async importLanguageProfile(
    profile: Scce2LanguageProfileShard,
    sourceVersionId: SourceVersionId,
    options: { alpha: number; now: number; trust: number; importDirectEvidence: boolean; fileEvidenceLimitPerShard: number }
  ): Promise<ImportedLanguageProfile> {
    const evidenceIds: EvidenceId[] = [];
    const directEvidenceIds: EvidenceId[] = [];
    const profileExcerptEvidenceIds: EvidenceId[] = [];
    const sourceVersionIds: SourceVersionId[] = [];
    const directEvidenceSourceVersionIds: SourceVersionId[] = [];
    const profileExcerptSourceVersionIds: SourceVersionId[] = [];
    let languageUnits = 0;
    let languagePatterns = 0;
    let ngramObservations = 0;
    let semanticFrames = 0;
    let directEvidenceSemanticFrames = 0;
    let profileExcerptSemanticFrames = 0;
    let programLanguageUnits = 0;
    let programLanguagePatterns = 0;
    let programNgramObservations = 0;
    const profileId = profile.languageId ?? `learned:${profile.sourceId ?? "scce2"}`;
    const script = profile.script ?? "unknown";

    for (const entry of observedSymbolEntries(profile)) {
      await this.putSymbolUnit(profileId, sourceVersionId, script, entry, "symbol", options.alpha, options.now);
      await this.putNgramObservation(profileId, sourceVersionId, entry, 1, [], options.now, { source: "language-profile", shardId: profile.shardId ?? null });
      languageUnits++;
      ngramObservations++;
    }
    for (const entry of (profile.tokenizationProfile?.observedTitleTokens ?? [])) {
      await this.putSymbolUnit(profileId, sourceVersionId, script, entry, "phrase", options.alpha * 0.92, options.now);
      languageUnits++;
    }
    for (const [kind, entries] of [
      ["segmentation", profile.tokenizationProfile?.codepointBuckets ?? []],
      ["cadence", profile.syntaxProfile?.punctuation ?? []],
      ["syntax", profile.syntaxProfile?.linePatterns ?? []]
    ] as const) {
      if (!entries.length) continue;
      const pattern: LanguagePatternRecord = {
        id: this.ids.semanticId("language_pattern", { profileId, kind, shardId: profile.shardId, entries }),
        profileId,
        patternKind: kind,
        support: entries.reduce((sum, entry) => sum + entry.count, 0),
        entropy: entropyFromCounts(entries.map(entry => entry.count)),
        patternJson: toJsonValue({ sourceSystem: "scce2", shardId: profile.shardId, entries, provenanceClass: "learned_language_prior" }),
        evidenceIds: [],
        updatedAt: options.now
      };
      await this.storage.languageMemory.putLanguagePattern(pattern);
      languagePatterns++;
    }

    for (const group of profilePatternGroups(profile)) {
      if (!group.entries.length) continue;
      const counts: Record<string, number> = {};
      let support = 0;
      for (const entry of group.entries) {
        const text = entry.value.trim();
        if (!text) continue;
        const normalized = { value: text, count: Math.max(1, entry.count) };
        counts[text] = (counts[text] ?? 0) + normalized.count;
        support += normalized.count;
        await this.putSymbolUnit(profileId, sourceVersionId, script, normalized, group.unitKind, options.alpha * group.alphaScale, options.now, {
          profileField: group.field,
          forceClass: group.forceClass
        });
        languageUnits++;
        if (group.forceClass === "learned_program_prior") programLanguageUnits++;
        if (group.emitNgram) {
          await this.putNgramObservation(profileId, sourceVersionId, normalized, 1, [], options.now, {
            source: "language-profile",
            shardId: profile.shardId ?? null,
            profileField: group.field,
            provenanceClass: group.forceClass
          });
          ngramObservations++;
          if (group.forceClass === "learned_program_prior") programNgramObservations++;
        }
      }
      if (support > 0) {
        await this.putPriorLanguagePattern(profileId, group.patternKind, support, counts, sourceVersionId, options.alpha * group.alphaScale, options.now, {
          sectionKind: "language-profile",
          profileField: group.field,
          shardId: profile.shardId ?? null,
          forceClass: group.forceClass
        });
        languagePatterns++;
        if (group.forceClass === "learned_program_prior") programLanguagePatterns++;
      }
    }

    if (options.importDirectEvidence) {
      for (const example of (profile.fileEvidence ?? []).slice(0, options.fileEvidenceLimitPerShard)) {
        const text = String(example.excerpt ?? "").trim();
        if (!text) continue;
        const classification = classifyProfileFileEvidence(profile, example);
        const evidence = await this.putExcerptEvidence({
          sourceVersionId,
          title: String(example.title ?? ""),
          text,
          trust: options.trust,
          alpha: options.alpha,
          observedAt: options.now,
          forceClass: classification.forceClass,
          provenance: classification.provenance
        });
        evidenceIds.push(evidence.id);
        sourceVersionIds.push(evidence.sourceVersionId);
        if (classification.forceClass === "direct_evidence") {
          directEvidenceIds.push(evidence.id);
          directEvidenceSourceVersionIds.push(evidence.sourceVersionId);
        } else {
          profileExcerptEvidenceIds.push(evidence.id);
          profileExcerptSourceVersionIds.push(evidence.sourceVersionId);
        }
        const frame: SemanticFrameRecord = {
          id: this.ids.semanticId("semantic_frame", { sourceVersionId, evidenceId: evidence.id, title: example.title ?? "" }),
          frameJson: toJsonValue({
            title: example.title ?? "",
            excerpt: text.slice(0, 1000),
            sourceSystem: "scce2",
            provenanceClass: classification.forceClass,
            evidenceSemantics: classification.forceClass === "direct_evidence" ? "external_source_span" : "profile_excerpt_only"
          }),
          embedding: stableVector(featureSet(text, 512), this.hasher, 64),
          evidenceIds: [evidence.id],
          alpha: options.alpha,
          createdAt: options.now
        };
        await this.storage.languageMemory.putSemanticFrame(frame);
        semanticFrames++;
        if (classification.forceClass === "direct_evidence") directEvidenceSemanticFrames++;
        else profileExcerptSemanticFrames++;
      }
    }
    return {
      languageUnits,
      languagePatterns,
      ngramObservations,
      semanticFrames,
      evidenceIds,
      directEvidenceIds,
      profileExcerptEvidenceIds,
      sourceVersionIds,
      directEvidenceSourceVersionIds,
      profileExcerptSourceVersionIds,
      directEvidenceSemanticFrames,
      profileExcerptSemanticFrames,
      programPriors: programLanguageUnits + programLanguagePatterns + programNgramObservations,
      programLanguageUnits,
      programLanguagePatterns,
      programNgramObservations
    };
  }

  private async putSymbolUnit(profileId: string, sourceVersionId: SourceVersionId, script: string, entry: Scce2TopEntry, kind: LanguageUnitRecord["unitKind"], alpha: number, now: number, metadata: unknown = {}): Promise<void> {
    const text = entry.value;
    const meta = asRecord(metadata);
    const unit: LanguageUnitRecord = {
      id: this.ids.semanticId("language_unit", { profileId, sourceVersionId, kind, text }),
      profileId,
      sourceVersionId,
      script,
      unitKind: kind,
      text,
      features: featureSet(text, 64),
      competenceVector: stableVector(featureSet(text, 64), this.hasher, 64),
      alpha,
      evidenceIds: [],
      metadata: toJsonValue({ ...meta, sourceSystem: "scce2", count: entry.count, provenanceClass: meta.forceClass ?? "learned_language_prior" })
    };
    await this.storage.languageMemory.putLanguageUnit(unit);
    void now;
  }

  private async putNgramObservation(streamId: string, sourceVersionId: SourceVersionId, entry: Scce2TopEntry, order: number, history: string[], now: number, metadata: JsonValue): Promise<void> {
    const observation: NgramObservation = {
      id: this.ids.semanticId("ngram_observation", { streamId, sourceVersionId, order, history, symbol: entry.value }),
      streamId,
      languageHint: streamId,
      order,
      history,
      symbol: entry.value,
      count: entry.count,
      fieldWeight: 1,
      sourceVersionId,
      observedAt: now,
      metadata
    };
    await this.storage.languageMemory.putNgramObservation(observation);
  }

  private async putPriorLanguageUnit(
    profileId: string,
    sourceVersionId: SourceVersionId,
    text: string,
    support: number,
    unitKind: LanguageUnitRecord["unitKind"],
    alpha: number,
    now: number,
    metadata: unknown
  ): Promise<void> {
    const normalizedText = text.trim();
    if (!normalizedText) return;
    const features = featureSet(normalizedText, 96);
    const unit: LanguageUnitRecord = {
      id: this.ids.semanticId("language_unit", { profileId, sourceVersionId, unitKind, text: normalizedText }),
      profileId,
      sourceVersionId,
      script: "learned",
      unitKind,
      text: normalizedText,
      features,
      competenceVector: stableVector(features, this.hasher, 64),
      alpha: alpha * Math.max(0.2, Math.min(1.4, Math.log10(Math.max(1, support) + 1))),
      evidenceIds: [],
      metadata: toJsonValue({ ...asRecord(metadata), sourceSystem: "scce2", support, provenanceClass: asRecord(metadata).forceClass ?? "learned_language_prior" })
    };
    await this.storage.languageMemory.putLanguageUnit(unit);
    void now;
  }

  private async putPriorLanguagePattern(
    profileId: string,
    patternKind: LanguagePatternRecord["patternKind"],
    support: number,
    counts: Record<string, number>,
    sourceVersionId: SourceVersionId,
    alpha: number,
    now: number,
    metadata: unknown
  ): Promise<void> {
    const pattern: LanguagePatternRecord = {
      id: this.ids.semanticId("language_pattern", { profileId, patternKind, sourceVersionId, counts, metadata }),
      profileId,
      patternKind,
      support,
      entropy: entropyFromCounts(Object.values(counts)),
      patternJson: toJsonValue({ ...asRecord(metadata), sourceSystem: "scce2", sourceVersionId, counts, alpha, provenanceClass: asRecord(metadata).forceClass ?? "learned_language_prior" }),
      evidenceIds: [],
      updatedAt: now
    };
    await this.storage.languageMemory.putLanguagePattern(pattern);
  }

  private async importNgramState(
    filePath: string,
    stateId: string,
    forceClass: BrainShardProvenanceClass,
    sourceVersionId: SourceVersionId,
    options: BrainShardImportOptions & { now: number; trust: number },
    warnings: BrainShardImportWarning[]
  ): Promise<{ states: number; observations: number; skipped: number }> {
    const streamId = `scce2:${stateId}`;
    const languageHint = forceClass === "learned_program_prior" ? "learned:program" : "learned:scce2";
    const record: NgramModelRecord = {
      id: this.ids.semanticId("ngram_state", { stateId, sourceVersionId }),
      streamId,
      languageHint,
      maxOrder: 6,
      discount: 0.75,
      modelJson: toJsonValue({ sourceSystem: "scce2", stateId, sourcePath: filePath, provenanceClass: forceClass, term: "ngram_state_not_llm", streaming: true }),
      updatedAt: options.now
    };
    let observations = 0;
    const batch: NgramObservation[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.storage.languageMemory.putNgramObservationsBatch(batch.splice(0, batch.length));
    };
    const summary = await streamScce2NgramState(filePath, async (item: Scce2NgramStreamItem) => {
      const obs: NgramObservation = {
        id: this.ids.semanticId("ngram_observation", { sourceVersionId, order: item.order, history: item.history, symbol: item.symbol }),
        streamId,
        languageHint,
        order: item.order,
        history: item.history,
        symbol: item.symbol,
        count: item.count,
        fieldWeight: Math.max(0.1, Math.min(4, Math.log10(item.count + 1))),
        sourceVersionId,
        observedAt: options.now,
        metadata: toJsonValue({ sourceSystem: "scce2", stateId, provenanceClass: forceClass })
      };
      batch.push(obs);
      observations++;
      if (batch.length >= IMPORT_PAGE_ROWS) await flush();
    }, { maxBytes: options.v8DecodeWorkExtentBytes ?? options.maxStateBytes ?? 768 * 1024 * 1024 }).catch(error => {
      warnings.push({ path: filePath, code: "ngram_state_not_decoded", message: error instanceof Error ? error.message : String(error) });
      return undefined;
    });
    await flush();
    if (!summary) return { states: 0, observations, skipped: 1 };
    if (summary.warnings.length) {
      for (const message of summary.warnings) warnings.push({ path: filePath, code: "ngram_state_partial", message });
    }
    if (observations === 0 && summary.warnings.length) {
      return { states: 0, observations, skipped: 1 };
    }
    await this.storage.languageMemory.putNgramModel({
      ...record,
      maxOrder: summary.orders.reduce((max, row) => Math.max(max, row.order), 0) || 6,
      modelJson: toJsonValue({ sourceSystem: "scce2", stateId, sourcePath: filePath, summary, provenanceClass: forceClass, term: "ngram_state_not_llm", streaming: true })
    });
    return { states: 1, observations, skipped: 0 };
  }

  private async putExcerptEvidence(input: { sourceVersionId: SourceVersionId; title: string; text: string; trust: number; alpha: number; observedAt: number; forceClass: BrainShardProvenanceClass; provenance: JsonValue }): Promise<EvidenceSpan> {
    const bytes = Buffer.from(input.text, "utf8");
    const contentHash = await this.storage.blobs.put(bytes, "text/plain");
    const canonicalUri = `scce2://profile-excerpt/${encodeURIComponent(String(input.sourceVersionId))}/${encodeURIComponent(input.title).slice(0, 160)}`;
    const sourceId = this.ids.sourceId(`${this.namespace}:excerpt`, canonicalUri);
    const excerptSourceVersionId = this.ids.sourceVersionId(bytes);
    const sourceVersion: SourceVersion = {
      sourceId,
      sourceVersionId: excerptSourceVersionId,
      namespace: `${this.namespace}:excerpt`,
      canonicalUri,
      contentHash,
      mediaType: "text/plain",
      observedAt: input.observedAt,
      byteLength: bytes.byteLength,
      trust: input.trust,
      metadata: toJsonValue({ title: input.title, profileSourceVersionId: input.sourceVersionId, provenanceClass: input.forceClass, provenance: input.provenance })
    };
    await this.storage.evidence.putSourceVersion(sourceVersion);
    const spanHash = this.ids.contentHash(bytes);
    const evidence: EvidenceSpan = {
      id: this.ids.evidenceId({ sourceVersionId: excerptSourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash }),
      sourceId,
      sourceVersionId: excerptSourceVersionId,
      chunkId: this.ids.chunkId({ sourceVersionId: excerptSourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: spanHash }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: bytes.byteLength,
      charStart: 0,
      charEnd: input.text.length,
      text: input.text,
      textPreview: input.text.slice(0, 600),
      languageHints: toJsonValue({ source: "scce2-language-profile", provenanceClass: input.forceClass }),
      scriptHints: toJsonValue({}),
      trustVector: toJsonValue({ trust: input.trust, sourceTrust: input.trust, imported: true, provenanceClass: input.forceClass }),
      provenance: input.provenance,
      features: featureSet(input.text, 512),
      status: "promoted",
      alpha: input.alpha,
      observedAt: input.observedAt
    };
    await this.storage.evidence.putEvidenceSpan(evidence);
    return evidence;
  }

  private async putSmallFileOrDescriptor(input: {
    namespace: string;
    canonicalUri: string;
    filePath: string;
    descriptor: unknown;
    mediaType: string;
    trust: number;
    observedAt: number;
    provenanceClass: string;
  }): Promise<SourceVersionRef> {
    const maxInlineBytes = 16 * 1024 * 1024;
    const virtualRef = parseBrainEntryPath(input.filePath);
    if (virtualRef) {
      const original = await hashScce2SourcePath(input.filePath).catch(() => undefined);
      if (!original || original.byteLength > maxInlineBytes) {
        return this.putDescriptorSourceVersion({
          ...input,
          descriptor: { ...asRecord(input.descriptor), originalFile: original ?? null, inlineOmitted: !original ? "unreadable SCCE2 brain entry" : "SCCE2 brain entry exceeds inline source-version work extent" }
        });
      }
      const bytes = await readBoundedScce2Source(input.filePath, maxInlineBytes);
      return this.putSourceVersionBytes({ ...input, bytes, metadata: { descriptor: input.descriptor, sourceSystem: "scce2", provenanceClass: input.provenanceClass } });
    }
    const stat = await fileStatForDescriptor(input.filePath);
    if (stat.size > maxInlineBytes) {
      const original = await hashFile(input.filePath);
      return this.putDescriptorSourceVersion({ ...input, descriptor: { ...asRecord(input.descriptor), originalFile: original } });
    }
    const bytes = await readFile(input.filePath);
    return this.putSourceVersionBytes({ ...input, bytes, metadata: { descriptor: input.descriptor, sourceSystem: "scce2", provenanceClass: input.provenanceClass } });
  }

  private async putDescriptorSourceVersion(input: { namespace: string; canonicalUri: string; descriptor: unknown; mediaType: string; trust: number; observedAt: number; provenanceClass: string }): Promise<SourceVersionRef> {
    const bytes = Buffer.from(JSON.stringify({ descriptor: input.descriptor, sourceSystem: "scce2", provenanceClass: input.provenanceClass }, null, 2), "utf8");
    return this.putSourceVersionBytes({ ...input, bytes, metadata: { descriptor: input.descriptor, sourceSystem: "scce2", provenanceClass: input.provenanceClass } });
  }

  private async putSourceVersionBytes(input: { namespace: string; canonicalUri: string; bytes: Uint8Array; mediaType: string; trust: number; observedAt: number; metadata: unknown }): Promise<SourceVersionRef> {
    const contentHash = await this.storage.blobs.put(input.bytes, input.mediaType);
    const sourceId = this.ids.sourceId(input.namespace, input.canonicalUri);
    const sourceVersionId = this.ids.sourceVersionId(input.bytes);
    const sourceVersion: SourceVersion = {
      sourceId,
      sourceVersionId,
      namespace: input.namespace,
      canonicalUri: input.canonicalUri,
      contentHash,
      mediaType: input.mediaType,
      observedAt: input.observedAt,
      byteLength: input.bytes.byteLength,
      trust: input.trust,
      metadata: toJsonValue(input.metadata)
    };
    await this.storage.evidence.putSourceVersion(sourceVersion);
    return { sourceVersion, bytes: input.bytes };
  }
}

export function createScce2ToV3Importer(options: Scce2ToV3ImporterOptions): Scce2ToV3Importer {
  return new Scce2ToV3Importer(options);
}

function scce2ImportIdentity(input: { manifest: BrainShardManifest; rootPath: string; ids: IdFactory; hasher: Hasher; now: number }): {
  rootHash: string;
  manifestHash: string;
  importRunId: string;
  activeBrainVersion: string;
  manifest: BrainManifestContract;
} {
  const rootPath = path.resolve(input.rootPath);
  const rootHash = input.hasher.digestHex(rootPath);
  const manifestHash = input.hasher.digestHex(JSON.stringify(stableImportManifestIdentity(input.manifest)));
  const importRunId = input.ids.semanticId("scce2_import_run", { rootPath, manifestHash });
  const activeBrainVersion = `scce2:${input.hasher.digestHex(JSON.stringify({ sourceId: input.manifest.sourceId, rootPath: input.manifest.rootPath, graph: input.manifest.graph, language: input.manifest.language, ngramStates: input.manifest.ngramStates })).slice(0, 32)}`;
  return {
    rootHash,
    manifestHash,
    importRunId,
    activeBrainVersion,
    manifest: {
      schema: "scce.brainManifestContract.v1",
      importRunId,
      brainVersion: activeBrainVersion,
      rootPath,
      manifestHash,
      sourceId: input.manifest.sourceId,
      sourceSchema: input.manifest.schema,
      runtimeContractVersion: 1,
      content: {
        graphShardCount: input.manifest.graph?.shards.length ?? 0,
        languageShardCount: input.manifest.language?.shards.length ?? 0,
        ngramStateCount: input.manifest.ngramStates.length,
        priorSectionCount: input.manifest.priorSections.length
      },
      metadata: toJsonValue({ sourceSystem: input.manifest.sourceSystem, observedAt: input.manifest.observedAt }),
      createdAt: input.now
    }
  };
}

function stableImportManifestIdentity(manifest: BrainShardManifest): JsonValue {
  return toJsonValue({
    schema: manifest.schema,
    sourceSystem: manifest.sourceSystem,
    sourceId: manifest.sourceId ?? null,
    rootPath: manifest.rootPath,
    graph: manifest.graph ? {
      manifestPath: manifest.graph.manifestPath ?? null,
      shardCount: manifest.graph.shardCount,
      shards: manifest.graph.shards.map(shard => ({
        shardId: shard.shardId,
        snapshotPath: shard.snapshotPath,
        format: shard.format ?? null,
        statsPath: shard.statsPath ?? null,
        pages: shard.pages ?? null,
        triples: shard.triples ?? null,
        concepts: shard.concepts ?? null,
        relations: shard.relations ?? null,
        byteLength: shard.byteLength ?? null,
        readable: shard.readable,
        metadata: shard.metadata
      }))
    } : null,
    language: manifest.language ? {
      manifestPath: manifest.language.manifestPath ?? null,
      languageId: manifest.language.languageId ?? null,
      shardCount: manifest.language.shardCount,
      shards: manifest.language.shards.map(shard => ({
        shardId: shard.shardId,
        profilePath: shard.profilePath,
        pages: shard.pages ?? null,
        chars: shard.chars ?? null,
        byteLength: shard.byteLength ?? null,
        script: shard.script ?? null,
        languageId: shard.languageId ?? null,
        confidence: shard.confidence ?? null,
        observedSymbolCount: shard.observedSymbols ?? null,
        titleSymbolCount: shard.titleSymbols ?? null,
        punctuationPatterns: shard.punctuationPatterns ?? null,
        linePatterns: shard.linePatterns ?? null,
        fileEvidence: shard.fileEvidence ?? null,
        readable: shard.readable,
        metadata: shard.metadata
      }))
    } : null,
    ngramStates: manifest.ngramStates.map(state => ({
      stateId: state.stateId,
      path: state.path,
      format: state.format,
      forceClass: state.forceClass ?? null,
      byteLength: state.byteLength,
      readable: state.readable,
      maxOrder: state.maxOrder ?? null,
      vocabularySize: state.vocabularySize ?? null,
      totalUnigrams: state.totalUnigrams ?? null,
      orders: state.orders ?? [],
      metadata: state.metadata
    })),
    priorSections: manifest.priorSections.map(section => ({
      sectionId: section.sectionId,
      path: section.path,
      sectionKind: section.sectionKind,
      forceClass: section.forceClass,
      byteLength: section.byteLength,
      readable: section.readable,
      sha256: section.sha256 ?? null,
      metadata: section.metadata
    })),
    sourceRefs: manifest.sourceRefs.map(ref => ({
      namespace: ref.namespace,
      canonicalUri: ref.canonicalUri,
      sourceId: ref.sourceId ?? null,
      sourceVersionId: ref.sourceVersionId ?? null,
      contentHash: ref.contentHash ?? null,
      mediaType: ref.mediaType ?? null,
      byteLength: ref.byteLength ?? null,
      trust: ref.trust ?? null,
      metadata: ref.metadata ?? null
    })),
    warnings: manifest.warnings
  });
}

function importResultFromLedger(input: {
  manifest: BrainShardManifest;
  importRunId: string;
  activeBrainVersion: string;
  ledger: readonly BrainImportLedgerRecord[];
}): BrainShardImportResult {
  const counters = {
    sourceVersions: sumLedgerCount(input.ledger, "source_versions"),
    directEvidenceSpans: sumLedgerCount(input.ledger, "direct_evidence_spans"),
    profileExcerptEvidenceSpans: sumLedgerCount(input.ledger, "profile_excerpt_evidence_spans"),
    graphNodes: sumLedgerCount(input.ledger, "graph_nodes"),
    graphEdges: sumLedgerCount(input.ledger, "graph_edges"),
    graphHyperedges: sumLedgerCount(input.ledger, "graph_hyperedges"),
    languageUnits: sumLedgerCount(input.ledger, "language_units"),
    languagePatterns: sumLedgerCount(input.ledger, "language_patterns"),
    ngramStates: sumLedgerCount(input.ledger, "ngram_models"),
    ngramObservations: sumLedgerCount(input.ledger, "ngram_observations"),
    skipped: sumLedgerCount(input.ledger, "skipped")
  };
  return {
    manifest: input.manifest,
    counters,
    importRunId: input.importRunId,
    activeBrainVersion: input.activeBrainVersion,
    sourceVersionIds: uniqueLedgerSourceVersionIds(input.ledger),
    evidenceIds: [...new Set(input.ledger.flatMap(row => row.evidenceIds))],
    nodeIds: [...new Set(input.ledger.flatMap(row => row.nodeIds))] as BrainShardImportResult["nodeIds"],
    warnings: uniqueLedgerWarnings(input.ledger).map(message => ({ code: "scce2_import_idempotent_replay", message })),
    stopped: false
  };
}

function sumLedgerCount(ledger: readonly BrainImportLedgerRecord[], key: string): number {
  return ledger.reduce((sum, row) => sum + Math.max(0, row.rowCounts[key] ?? 0), 0);
}

function uniqueLedgerSourceVersionIds(ledger: readonly BrainImportLedgerRecord[]): BrainShardImportResult["sourceVersionIds"] {
  const out: BrainShardImportResult["sourceVersionIds"] = [];
  const seen = new Set<string>();
  for (const row of ledger) {
    if (!row.sourceVersionId || seen.has(String(row.sourceVersionId))) continue;
    seen.add(String(row.sourceVersionId));
    out.push(row.sourceVersionId);
  }
  return out;
}

function uniqueLedgerWarnings(ledger: readonly BrainImportLedgerRecord[]): string[] {
  return [...new Set(ledger.flatMap(row => row.warnings))];
}

async function hashFile(filePath: string): Promise<{ path: string; byteLength: number; sha256: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", chunk => {
      const buf = Buffer.from(chunk as Buffer);
      byteLength += buf.byteLength;
      hash.update(buf);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { path: filePath, byteLength, sha256: hash.digest("hex") };
}

async function fileStatForDescriptor(filePath: string): Promise<{ size: number }> {
  const { stat } = await import("node:fs/promises");
  return stat(filePath).catch(() => ({ size: 0 }));
}

interface ProfileFileEvidenceClassification {
  forceClass: "direct_evidence" | "profile_excerpt_evidence";
  provenance: JsonValue;
}

function classifyProfileFileEvidence(profile: Scce2LanguageProfileShard, example: Scce2ProfileFileEvidence): ProfileFileEvidenceClassification {
  const exactSource = exactProfileFileEvidenceSource(example);
  const base = {
    sourceSystem: "scce2",
    shardId: profile.shardId ?? null,
    profileSourceId: profile.sourceId ?? null,
    profileLanguageId: profile.languageId ?? null,
    originalEvidenceId: example.id ?? null,
    title: example.title ?? null
  };
  if (exactSource) {
    return {
      forceClass: "direct_evidence",
      provenance: toJsonValue({
        ...base,
        provenanceClass: "direct_evidence",
        evidenceSemantics: "external_source_span",
        uri: exactSource.uri,
        sourceVersionId: exactSource.version,
        byteRange: exactSource.byteRange ?? null,
        charRange: exactSource.charRange ?? null,
        originalSource: exactSource
      })
    };
  }
  return {
    forceClass: "profile_excerpt_evidence",
    provenance: toJsonValue({
      ...base,
      provenanceClass: "profile_excerpt_evidence",
      evidenceSemantics: "profile_excerpt_only",
      limitation: "This evidence proves only that the SCCE2 language profile contained the excerpt. It is not original external-source evidence for factual proof."
    })
  };
}

function exactProfileFileEvidenceSource(example: Scce2ProfileFileEvidence): { uri: string; version: string; byteRange?: [number, number]; charRange?: [number, number] } | undefined {
  const record = asRecord(example);
  const source = objectField(record, "source");
  const original = objectField(record, "original") ?? objectField(record, "originalSource");
  const uri = stringFrom(
    record.originalSourceUri,
    record.sourceUri,
    record.canonicalUri,
    record.uri,
    record.url,
    source?.originalSourceUri,
    source?.sourceUri,
    source?.canonicalUri,
    source?.uri,
    source?.url,
    original?.originalSourceUri,
    original?.sourceUri,
    original?.canonicalUri,
    original?.uri,
    original?.url
  );
  const version = stringFrom(
    record.originalSourceVersionId,
    record.sourceVersionId,
    record.revisionId,
    record.contentHash,
    source?.originalSourceVersionId,
    source?.sourceVersionId,
    source?.revisionId,
    source?.contentHash,
    original?.originalSourceVersionId,
    original?.sourceVersionId,
    original?.revisionId,
    original?.contentHash
  );
  const byteRange = rangeFrom(record.originalByteRange, record.byteRange, source?.originalByteRange, source?.byteRange, original?.originalByteRange, original?.byteRange)
    ?? rangeFromStartEnd(record.byteStart, record.byteEnd)
    ?? rangeFromStartEnd(source?.byteStart, source?.byteEnd)
    ?? rangeFromStartEnd(original?.byteStart, original?.byteEnd);
  const charRange = rangeFrom(record.originalCharRange, record.charRange, source?.originalCharRange, source?.charRange, original?.originalCharRange, original?.charRange)
    ?? rangeFromStartEnd(record.charStart, record.charEnd)
    ?? rangeFromStartEnd(source?.charStart, source?.charEnd)
    ?? rangeFromStartEnd(original?.charStart, original?.charEnd);
  if (!uri || !version || (!byteRange && !charRange)) return undefined;
  return { uri, version, byteRange, charRange };
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringFrom(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function rangeFrom(...values: readonly unknown[]): [number, number] | undefined {
  for (const value of values) {
    if (!Array.isArray(value) || value.length < 2) continue;
    const range = rangeFromStartEnd(value[0], value[1]);
    if (range) return range;
  }
  return undefined;
}

function rangeFromStartEnd(start: unknown, end: unknown): [number, number] | undefined {
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return [start, end];
}

function profilePatternGroups(profile: Scce2LanguageProfileShard): Array<{
  field: string;
  entries: Scce2TopEntry[];
  unitKind: LanguageUnitRecord["unitKind"];
  patternKind: LanguagePatternRecord["patternKind"];
  forceClass: BrainShardProvenanceClass;
  alphaScale: number;
  emitNgram: boolean;
}> {
  const program = "learned_program_prior" as const;
  return [
    { field: "commentPatterns", entries: topEntries(profile.commentPatterns), unitKind: "phrase", patternKind: "syntax", forceClass: program, alphaScale: 0.82, emitNgram: true },
    { field: "stringLiteralPatterns", entries: topEntries(profile.stringLiteralPatterns), unitKind: "phrase", patternKind: "cadence", forceClass: program, alphaScale: 0.78, emitNgram: true },
    { field: "identifierPatterns", entries: topEntries(profile.identifierPatterns), unitKind: "symbol", patternKind: "morphology", forceClass: program, alphaScale: 0.9, emitNgram: true },
    { field: "importPatterns", entries: topEntries(profile.importPatterns), unitKind: "phrase", patternKind: "syntax", forceClass: program, alphaScale: 0.95, emitNgram: true },
    { field: "declarationPatterns", entries: topEntries(profile.declarationPatterns), unitKind: "phrase", patternKind: "syntax", forceClass: program, alphaScale: 0.95, emitNgram: true },
    { field: "buildSystemHints", entries: topEntries(profile.buildSystemHints), unitKind: "phrase", patternKind: "semantic_role", forceClass: program, alphaScale: 0.88, emitNgram: true },
    { field: "testRunnerHints", entries: topEntries(profile.testRunnerHints), unitKind: "phrase", patternKind: "semantic_role", forceClass: program, alphaScale: 0.88, emitNgram: true },
    { field: "packageManagerHints", entries: topEntries(profile.packageManagerHints), unitKind: "phrase", patternKind: "semantic_role", forceClass: program, alphaScale: 0.88, emitNgram: true },
    { field: "formatterHints", entries: topEntries(profile.formatterHints), unitKind: "phrase", patternKind: "semantic_role", forceClass: program, alphaScale: 0.82, emitNgram: true },
    { field: "linterHints", entries: topEntries(profile.linterHints), unitKind: "phrase", patternKind: "semantic_role", forceClass: program, alphaScale: 0.82, emitNgram: true },
    { field: "documentationPatterns", entries: topEntries(profile.documentationPatterns), unitKind: "phrase", patternKind: "syntax", forceClass: program, alphaScale: 0.8, emitNgram: true },
    { field: "examplePatterns", entries: topEntriesFromLoose(profile.examplePatterns), unitKind: "phrase", patternKind: "syntax", forceClass: program, alphaScale: 0.8, emitNgram: true }
  ];
}

function topEntries(value: unknown): Scce2TopEntry[] {
  if (!Array.isArray(value)) return [];
  const out: Scce2TopEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawValue = record.value;
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;
    const count = Number(record.count ?? 1);
    out.push({ value: rawValue, count: Number.isFinite(count) && count > 0 ? count : 1 });
  }
  return out;
}

function observedSymbolEntries(profile: Scce2LanguageProfileShard): Scce2TopEntry[] {
  return profile.tokenizationProfile?.observedSymbols ?? profile.tokenizationProfile?.observedTokens ?? [];
}

function topEntriesFromLoose(value: unknown): Scce2TopEntry[] {
  return collectStringCountValues(value, ["examplePatterns"]).map(item => ({ value: item.text, count: item.support }));
}

function profileDigest(profile: Scce2LanguageProfileShard): JsonValue {
  return toJsonValue({
    schema: profile.schema,
    sourceId: profile.sourceId,
    shardId: profile.shardId,
    languageId: profile.languageId,
    script: profile.script,
    confidence: profile.confidence,
    observedSymbolEntries: observedSymbolEntries(profile).length,
    fileEvidence: profile.fileEvidence?.length ?? 0,
    programPatternFields: Object.fromEntries(profilePatternGroups(profile).map(group => [group.field, group.entries.length]))
  });
}

function entropyFromCounts(counts: number[]): number {
  const total = counts.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const count of counts) {
    const p = Math.max(0, count) / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

function kneserModelFromImportedCounts(items: Array<{ order: number; history: string[]; symbol: string; count: number }>) {
  const maxOrder = items.reduce((max, item) => Math.max(max, item.order), 1);
  const counts = new Map<string, number>();
  const contextCounts = new Map<string, number>();
  const continuationContexts = new Map<string, Set<string>>();
  const contextContinuationTypes = new Map<string, Set<string>>();
  const unigramCounts = new Map<string, number>();
  for (const item of items) {
    const gram = [...item.history.slice(-(item.order - 1)), item.symbol];
    const key = gram.join("\u0001");
    counts.set(key, (counts.get(key) ?? 0) + item.count);
    if (item.order === 1) unigramCounts.set(item.symbol, (unigramCounts.get(item.symbol) ?? 0) + item.count);
    if (item.order > 1) {
      const context = gram.slice(0, -1).join("\u0001");
      contextCounts.set(context, (contextCounts.get(context) ?? 0) + item.count);
      if (!continuationContexts.has(item.symbol)) continuationContexts.set(item.symbol, new Set());
      continuationContexts.get(item.symbol)!.add(context);
      if (!contextContinuationTypes.has(context)) contextContinuationTypes.set(context, new Set());
      contextContinuationTypes.get(context)!.add(item.symbol);
    }
  }
  const continuationCounts = new Map<string, number>();
  for (const [symbol, contexts] of continuationContexts) continuationCounts.set(symbol, contexts.size);
  const vocabulary = [...unigramCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24000).map(([symbol]) => symbol);
  return {
    order: Math.max(1, Math.min(6, maxOrder)),
    discount: 0.75,
    observedSymbolCount: [...unigramCounts.values()].reduce((sum, count) => sum + count, 0),
    vocabularySize: vocabulary.length,
    counts: Object.fromEntries(counts),
    contextCounts: Object.fromEntries(contextCounts),
    continuationCounts: Object.fromEntries(continuationCounts),
    contextContinuationTypes: Object.fromEntries([...contextContinuationTypes.entries()].map(([key, set]) => [key, set.size])),
    totalContinuationTypes: [...continuationContexts.values()].reduce((sum, contexts) => sum + contexts.size, 0),
    unigramCounts: Object.fromEntries(unigramCounts),
    totalUnigramCount: [...unigramCounts.values()].reduce((sum, count) => sum + count, 0),
    vocabulary
  };
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

function sumNumberRecord(value: Record<string, number>): number {
  return Object.values(value).reduce((sum, count) => sum + Math.max(0, count), 0);
}

function unitKindForPriorSurface(text: string): LanguageUnitRecord["unitKind"] {
  for (const ch of text) {
    if (ch === " " || ch === "|" || ch === "\t" || ch === "\n") return "phrase";
  }
  return "symbol";
}

function collectTemplateLikeValues(value: unknown): Array<{ text: string; support: number; path: string }> {
  return collectStringCountValues(value, []);
}

function collectMouthLikeValues(value: unknown): Array<{ text: string; support: number; path: string; kind: LanguagePatternRecord["patternKind"] }> {
  return collectStringCountValues(value, []).map(item => ({ ...item, kind: patternKindFromPath(item.path) }));
}

function collectStringCountValues(value: unknown, pathParts: string[]): Array<{ text: string; support: number; path: string }> {
  const out: Array<{ text: string; support: number; path: string }> = [];
  const visit = (current: unknown, currentPath: string[]) => {
    if (typeof current === "string") {
      const text = current.trim();
      if (text) out.push({ text, support: 1, path: currentPath.join(".") });
      return;
    }
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) visit(current[i], [...currentPath, String(i)]);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (typeof child === "number" && Number.isFinite(child) && child > 0) {
        const text = key.trim();
        if (text) out.push({ text, support: child, path: [...currentPath, key].join(".") });
      } else {
        visit(child, [...currentPath, key]);
      }
    }
  };
  visit(value, pathParts);
  return out;
}

function patternKindFromPath(value: string): LanguagePatternRecord["patternKind"] {
  const segments = pathSegments(value);
  if (hasSegment(segments, "cadence") || hasSegment(segments, "rhythm") || hasSegment(segments, "tone") || hasSegment(segments, "punctuation") || hasSegment(segments, "stringliteralpatterns")) return "cadence";
  if (hasSegment(segments, "morphology") || hasSegment(segments, "morph") || hasSegment(segments, "identifierpatterns")) return "morphology";
  if (hasSegment(segments, "semantic") || hasSegment(segments, "role") || hasSegment(segments, "buildsystemhints") || hasSegment(segments, "testrunnerhints") || hasSegment(segments, "packagemanagerhints")) return "semantic_role";
  if (hasSegment(segments, "segmentation") || hasSegment(segments, "segment") || hasSegment(segments, "codepointbuckets")) return "segmentation";
  return "syntax";
}

function pathSegments(value: string): string[] {
  const out: string[] = [];
  let current = "";
  const flush = () => {
    const clean = current.trim().toLocaleLowerCase();
    if (clean) out.push(clean);
    current = "";
  };
  for (const ch of value) {
    if (ch === "." || ch === "/" || ch === "\\" || ch === "#") flush();
    else current += ch;
  }
  flush();
  return out;
}

function hasSegment(segments: readonly string[], segment: string): boolean {
  return segments.some(item => item === segment);
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function rssMiB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
