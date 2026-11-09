// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  canonicalCorpusSourceSystemId,
  corpusSourceAlias,
  createUniversalCreativeEventConstructionCompiler,
  joinInformationLabels,
  type CreativeEventConstructionCompiler,
  type EvidenceSpan,
  type EvidenceBackedSourceVersionQuery,
  type EvidenceBackedSourceVersionInventory,
  type JsonValue,
  type LanguageProfile,
  type ScceStorage,
  type SourceVersion
} from "@scce/kernel";
import { LANGUAGE_CORPUS_TRAINING_RECIPE_ID, trainLanguageCorpusText, type LanguageCorpusTrainingReport, type LanguageCorpusTrainingInput, corpusCheckpointId } from "./language-corpus-trainer.js";
import { readSourceTranscriptArchive } from "./source-transcript-archive.js";
import { prepareLanguageTrainingSegmentationInput, type LanguageTrainingSegmentationDeclaration, type PreparedLanguageTrainingSegmentation } from "./language-training-segmentation.js";
import { persistDialogueContextualQaComponent, type DialogueContextualQaReport } from "./dialogue-contextual-qa-component.js";
import { canonicalStringify, createHasher, type InformationLabel, type TranscriptTurn } from "@scce/kernel";

import { sourceBrainBuildReceipt, type SourceBrainBuildReceipt, type SourceBrainBuildResult } from "./source-brain-build.js";

export interface StoredCorpusConstructionTrainingOptions {
  onSourceBrainTrainingComplete?: (report: StoredCorpusConstructionTrainingReport) => Promise<SourceBrainBuildResult | SourceBrainBuildReceipt | void>;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  corpusSegmentation?: LanguageTrainingSegmentationDeclaration;
  storage: ScceStorage;
  sourceSystem?: string;
  maxTotalBytes?: number;
  /** IO bound; failed and zero-byte documents still consume one attempt. Default 1024. */
  maxSourceAttempts?: number;
  /** A batch schedules bounded existing documents; it never concatenates their provenance. */
  batchBytes?: number;
  startBatchIndex?: number;
  afterSourceVersionId?: string;
  sourcePageSize?: number;
  heapCheckpointMb?: number;
  excludeUriPrefixes?: readonly string[];
  sourceVersionIds?: readonly string[];
  minArticleBytes?: number;
  maxArticleBytes?: number;
  creativeEventCompiler?: CreativeEventConstructionCompiler;
  languageOnly?: boolean;
  includeUriPrefixes?: readonly string[];
  signal?: AbortSignal;
}

export interface StoredCorpusConstructionTrainingReport {
  schema: "scce.storedCorpusConstructionTrainReport.v1";
  sourceSystem: string;
  recipeId: string;
  startBatchIndex: number;
  startSourceVersionId: string | null;
  nextSourceVersionId: string | null;
  exhausted: boolean;
  sourcePageSize: number;
  sourcesEnumerated: number;
  sourcesConsidered: number;
  sourcesAttempted: number;
  maxSourceAttempts: number;
  legacyBatchSourcesSkipped: number;
  bytesScheduled: number;
  inventory: EvidenceBackedSourceVersionInventory | null;
  inventoryScope: "after_start_cursor";
  eligibleSourcesRemaining: number | null;
  articleBounds: { minBytes: number; maxBytes: number };
  batchesTrained: number;
  articlesTrained: number;
  bytesTrained: number;
  nextBatchIndex: number;
  stoppedByHeapSafetyBound: boolean;
  stoppedByStorageFailure: boolean;
  stoppedByInterruption: boolean;
  storageFailure: { code: string; reason: string; sourceVersionId: string } | null;
  heapMiBAtExit: number;
  batchesFailed: Array<{ batchIndex: number; sourceVersionId?: string; reason: string }>;
  sourcesSkipped: Array<{ sourceVersionId: string; reason: string }>;
  reports: LanguageCorpusTrainingReport[];
  selection?: {
    schema: "scce.storedCorpusSourceSelection.v1";
    selectedSourceVersionIds: string[];
    completedSourceVersionIds: string[];
    languageTrainingComplete: boolean;
  };
  sourceBrainBuild?: SourceBrainBuildReceipt;
  contextualQa?: { reports: DialogueContextualQaReport[]; deferred: Array<{ sourceVersionId: string; reason: string }> };
}

interface ReplaySource {
  source: SourceVersion;
  profile?: LanguageProfile;
  evidence: EvidenceSpan[];
  text: string;
  bytes: number;
  transcriptTurns?: readonly TranscriptTurn[];
  transcriptRetainedBytes?: number;
}

/** Recompile existing promoted documents, keeping the graph, evidence, profile and labels under their original owners. */
export async function trainStoredCorpusConstructions(input: StoredCorpusConstructionTrainingOptions): Promise<StoredCorpusConstructionTrainingReport> {
  const list = input.storage.evidence.listEvidenceBackedSourceVersions;
  if (!list) throw new Error("storage adapter does not support listEvidenceBackedSourceVersions");
  const maxTotalBytes = Math.max(1024, Math.floor(input.maxTotalBytes ?? 64 * 1024 * 1024));
  const maxSourceAttempts = Math.max(1, Math.floor(input.maxSourceAttempts ?? 1024));
  const batchBytes = Math.max(1024, Math.floor(input.batchBytes ?? 1024 * 1024));
  const startBatchIndex = Math.max(0, Math.floor(input.startBatchIndex ?? 0));
  const heapCheckpointMb = input.heapCheckpointMb !== undefined && input.heapCheckpointMb > 0 ? Math.floor(input.heapCheckpointMb) : undefined;
  const sourceSystem = canonicalCorpusSourceSystemId(input.sourceSystem ?? CORPUS_SOURCE_SYSTEM_IDS.wikipedia);
  const compiler = input.creativeEventCompiler ?? createUniversalCreativeEventConstructionCompiler();
  if (input.afterSourceVersionId !== undefined && startBatchIndex > 0) throw new Error("choose a source cursor or a legacy batch cursor, not both");
  const sourcePageSize = Math.max(1, Math.min(1024, Math.floor(input.sourcePageSize ?? 128)));
  const minArticleBytes = Math.max(0, Math.floor(input.minArticleBytes ?? 2000));
  const maxArticleBytes = Math.max(1, Math.floor(input.maxArticleBytes ?? 400000));
  if (minArticleBytes > maxArticleBytes) throw new Error("minimum article bytes exceeds maximum article bytes");
  const query: EvidenceBackedSourceVersionQuery = {
    sourceSystems: [sourceSystem, corpusSourceAlias(sourceSystem)],
    excludeUriPrefixes: input.excludeUriPrefixes ?? [],
    ...(input.includeUriPrefixes?.length ? { includeUriPrefixes: input.includeUriPrefixes } : {}),
    ...(input.sourceVersionIds?.length ? { sourceVersionIds: input.sourceVersionIds } : {}),
    ...(input.afterSourceVersionId !== undefined ? { afterSourceVersionId: input.afterSourceVersionId } : {}),
    minByteLength: minArticleBytes, maxByteLength: maxArticleBytes,
    orderBySourceVersionId: true, excludeTrainingDerived: true, limit: sourcePageSize
  };
  const inventory = input.signal?.aborted ? null : await input.storage.evidence.countEvidenceBackedSourceVersions?.(query) ?? null;
  const reports: LanguageCorpusTrainingReport[] = [];
  const batchesFailed: StoredCorpusConstructionTrainingReport["batchesFailed"] = [];
  const sourcesSkipped: StoredCorpusConstructionTrainingReport["sourcesSkipped"] = [];
  let batchIndex = 0;
  let segmentationBatch: { index: number; selection: PreparedLanguageTrainingSegmentation } | undefined;
  let articlesTrained = 0;
  let bytesTrained = 0;
  let stoppedByHeapSafetyBound = false;
  let nextSourceVersionId = input.afterSourceVersionId ?? null;
  let exhausted = false;
  let stoppedByInterruption = Boolean(input.signal?.aborted);
  let sourcesEnumerated = 0;
  let sourcesConsidered = 0;
  let sourcesAttempted = 0;
  let storageFailure: StoredCorpusConstructionTrainingReport["storageFailure"] = null;
  let legacyBatchSourcesSkipped = 0;
  let bytesScheduled = 0;
  let currentBatchBytes = 0;
  const successfulBatches = new Set<number>();
  const qaEnabled = sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.dialogue && !input.languageOnly;
  const qaPools = new Map<string, { rootUri: string; informationLabel: InformationLabel; authorship: string; sources: Array<{
    sourceUri: string; text: string; sourceVersionId: string; transcriptTurns: readonly TranscriptTurn[] }>; deferred: Array<{ sourceVersionId: string; reason: string }> }>();
  const contextualQa: NonNullable<StoredCorpusConstructionTrainingReport["contextualQa"]> = { reports: [], deferred: [] };
  let qaRetainedBytes = 0;

  const trainSource = async (item: ReplaySource): Promise<void> => {
    if (segmentationBatch?.index !== batchIndex) segmentationBatch = {
      index: batchIndex, selection: await prepareLanguageTrainingSegmentationInput(input.storage, input.corpusSegmentation)
    };
    const initialLearning = item.profile === undefined;
    let trainingLabel: InformationLabel | undefined;
    try {
      const { transcriptArchive: _archive, ...metadata } = recordOf(item.source.metadata);
      const informationLabel = joinInformationLabels([
        ...(item.source.informationLabel ? [item.source.informationLabel] : []),
        ...(item.profile?.informationLabel ? [item.profile.informationLabel] : []),
        ...item.evidence.map(span => span.informationLabel!)
      ], { explicitMergeAuthority: false });
      trainingLabel = informationLabel;
      const prefix = input.includeUriPrefixes?.find(value => item.source.canonicalUri.startsWith(value)) ?? canonicalCorpusRoot(item.source.canonicalUri);
      let trainingInput: LanguageCorpusTrainingInput = {
        corpusSegmentation: input.corpusSegmentation,
        ...(segmentationBatch ? { preparedCorpusSegmentation: segmentationBatch.selection } : {}),
        storage: input.storage,
        sourceSystem,
        streamUri: typeof metadata.streamUri === "string" ? metadata.streamUri : item.source.canonicalUri,
        sourceUri: item.source.canonicalUri,
        sourceVersionId: item.source.sourceVersionId,
        evidence: item.evidence,
        profile: item.profile,
        text: item.text,
        ...(item.transcriptTurns ? { transcriptTurns: item.transcriptTurns } : {}),
        mediaType: item.source.mediaType,
        namespace: item.source.namespace,
        createdAt: item.source.observedAt,
        informationLabel,
        persistSource: false,
        persistProfile: initialLearning || Boolean(input.corpusSegmentation),
        skipNgramPersistence: !initialLearning && !input.languageOnly && !input.corpusSegmentation,
        skipNgramObservationPersistence: true,
        ...(input.languageOnly ? { languageOnly: true } : {}),
        ...(initialLearning || input.corpusSegmentation || input.languageOnly ? { ngramMaxOrder: input.ngramMaxOrder, ngramMaxCountersPerOrder: input.ngramMaxCountersPerOrder,
          ngramVocabularyLimit: input.ngramVocabularyLimit } : { ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 4096 }),
        creativeEventCompiler: compiler,
        graphSnapshotSourceVersionIds: [String(item.source.sourceVersionId)],
        constructionPoolUriPrefix: prefix,
        corpusCheckpoint: {
          rootUri: `scce://stored-corpus-replay/${sourceSystem}/${LANGUAGE_CORPUS_TRAINING_RECIPE_ID}${initialLearning && !input.corpusSegmentation ? "/initial-language-learning" : ""}`,
          itemUri: item.source.canonicalUri,
          contentHash: String(item.source.contentHash),
          byteLength: item.source.byteLength
        },
        corpusMetadata: { ...metadata, lane: "stored-corpus-construction-replay", replayRecipeId: LANGUAGE_CORPUS_TRAINING_RECIPE_ID } as JsonValue
      };
      if (item.profile && !input.corpusSegmentation) {
        const initialInput: LanguageCorpusTrainingInput = { ...trainingInput, profile: undefined, persistProfile: true, skipNgramPersistence: false,
          ngramMaxOrder: input.ngramMaxOrder, ngramMaxCountersPerOrder: input.ngramMaxCountersPerOrder, ngramVocabularyLimit: input.ngramVocabularyLimit,
          corpusCheckpoint: { ...trainingInput.corpusCheckpoint!, rootUri: `${trainingInput.corpusCheckpoint!.rootUri}/initial-language-learning` } };
        const initialId = corpusCheckpointId(initialInput)!;
        // A completed initial learn keeps its exact declared phase and inputs on retry.
        // The canonical trainer below validates the entire checkpoint binding, including malformed/stale receipts.
        if (await input.storage.ingestion.get(initialId)) trainingInput = initialInput;
      }
      const report = await trainLanguageCorpusText(trainingInput);
      reports.push(report);
      articlesTrained++;
      bytesTrained += item.bytes;
      successfulBatches.add(batchIndex);
      if (qaEnabled && item.transcriptTurns) {
        qaRetainedBytes += item.transcriptRetainedBytes!;
        qaPool(item.source, informationLabel).sources.push({ sourceUri: item.source.canonicalUri,
          sourceVersionId: String(item.source.sourceVersionId), text: item.text, transcriptTurns: item.transcriptTurns });
      }
    } catch (error) {
      if (qaEnabled && item.transcriptTurns && trainingLabel) qaPool(item.source, trainingLabel).deferred.push({
        sourceVersionId: String(item.source.sourceVersionId), reason: "base_source_training_failed" });
      batchesFailed.push({ batchIndex, sourceVersionId: String(item.source.sourceVersionId), reason: errorText(error) });
      markStorageFailure(error, String(item.source.sourceVersionId));
    }
  };

  pages: while (true) {
    if (interrupted()) break;
    if (bytesScheduled >= maxTotalBytes || sourcesAttempted >= maxSourceAttempts) break;
    if (heapCheckpointMb !== undefined && heapMiB() >= heapCheckpointMb) { stoppedByHeapSafetyBound = true; break; }
    const versions = await list.call(input.storage.evidence, { ...query,
      ...(nextSourceVersionId !== null ? { afterSourceVersionId: nextSourceVersionId } : {}) });
    if (versions.length > sourcePageSize) throw new Error("storage replay page exceeded its requested bound");
    if (!versions.length) { exhausted = true; break; }
    sourcesEnumerated += versions.length;
    let previous = nextSourceVersionId;
    for (const version of versions) {
      if (interrupted()) break pages;
      const sourceId = String(version.sourceVersionId);
      if (previous !== null && Buffer.compare(Buffer.from(sourceId), Buffer.from(previous)) <= 0) throw new Error("storage replay page did not advance in source-version order");
      previous = sourceId;
      if (bytesScheduled >= maxTotalBytes || sourcesAttempted >= maxSourceAttempts) break pages;
      if (heapCheckpointMb !== undefined && heapMiB() >= heapCheckpointMb) { stoppedByHeapSafetyBound = true; break pages; }
      if (batchIndex < startBatchIndex) {
        legacyBatchSourcesSkipped++;
      } else {
        bytesScheduled += version.byteLength;
        sourcesAttempted++;
        if (!await loadAndTrain(version)) break pages;
        if (storageFailure) break pages;
      }
      nextSourceVersionId = sourceId;
      sourcesConsidered++;
      currentBatchBytes += version.byteLength;
      if (currentBatchBytes >= batchBytes) { batchIndex++; currentBatchBytes = 0; }
    }
    if (versions.length < sourcePageSize) { exhausted = true; break; }
  }
  if (inventory && sourcesConsidered >= inventory.eligibleSources) exhausted = true;
  const batchesTrained = successfulBatches.size;
  const nextBatchIndex = batchIndex + (exhausted && currentBatchBytes > 0 ? 1 : 0);
  if (qaEnabled) for (const pool of qaPools.values()) {
    if (pool.deferred.length || storageFailure !== null || stoppedByInterruption) {
      contextualQa.deferred.push(...pool.deferred, ...pool.sources.map(source => ({ sourceVersionId: source.sourceVersionId, reason: "incomplete_owner_pool" })));
      continue;
    }
    if (pool.sources.length) {
      try { contextualQa.reports.push(await persistDialogueContextualQaComponent({ storage: input.storage, rootUri: pool.rootUri,
        informationLabel: pool.informationLabel, authorship: pool.authorship, sources: pool.sources })); }
      catch (error) {
        contextualQa.deferred.push(...pool.sources.map(source => ({ sourceVersionId: source.sourceVersionId, reason: errorText(error) })));
        if (markStorageFailure(error, pool.sources[0]!.sourceVersionId)) batchesFailed.push({ batchIndex,
          sourceVersionId: pool.sources[0]!.sourceVersionId, reason: errorText(error) });
      }
    }
  }
  const selectedSourceVersionIds = [...new Set(input.sourceVersionIds ?? [])].sort();
  const completedSourceVersionIds = reports.map(report => report.sourceVersionId).sort();
  const languageTrainingComplete = selectedSourceVersionIds.length > 0 && input.afterSourceVersionId === undefined
    && startBatchIndex === 0 && exhausted && !stoppedByHeapSafetyBound && !storageFailure && !stoppedByInterruption
    && batchesFailed.length === 0 && sourcesSkipped.length === 0
    && canonicalStringify(selectedSourceVersionIds) === canonicalStringify(completedSourceVersionIds)
    && reports.every(report => report.languageProfiles > 0 && report.ngramModels > 0 && report.evidence > 0
      && report.artifacts.languageProfileId && report.artifacts.ngramModelIds.length > 0 && report.artifacts.evidenceIds.length > 0);
  const result: StoredCorpusConstructionTrainingReport = { schema: "scce.storedCorpusConstructionTrainReport.v1", sourceSystem, recipeId: LANGUAGE_CORPUS_TRAINING_RECIPE_ID,
    startBatchIndex, startSourceVersionId: input.afterSourceVersionId ?? null, nextSourceVersionId, exhausted, sourcePageSize,
    sourcesEnumerated, sourcesConsidered, sourcesAttempted, maxSourceAttempts, legacyBatchSourcesSkipped, bytesScheduled, inventory, inventoryScope: "after_start_cursor",
    eligibleSourcesRemaining: inventory ? Math.max(0, inventory.eligibleSources - sourcesConsidered) : null,
    articleBounds: { minBytes: minArticleBytes, maxBytes: maxArticleBytes },
    batchesTrained, articlesTrained, bytesTrained, nextBatchIndex, stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB(), stoppedByStorageFailure: storageFailure !== null, stoppedByInterruption, storageFailure, batchesFailed, sourcesSkipped, reports,
    selection: { schema: "scce.storedCorpusSourceSelection.v1", selectedSourceVersionIds, completedSourceVersionIds, languageTrainingComplete },
    ...(qaEnabled ? { contextualQa } : {}) };
  const sourceBrainBuild = languageTrainingComplete ? await input.onSourceBrainTrainingComplete?.(result) : undefined;
  if (sourceBrainBuild) result.sourceBrainBuild = "lifecycle" in sourceBrainBuild ? sourceBrainBuildReceipt(sourceBrainBuild) : sourceBrainBuild;
  return result;

  function qaPool(source: SourceVersion, informationLabel: InformationLabel) {
    const prefix = input.includeUriPrefixes?.find(value => source.canonicalUri.startsWith(value)) ?? canonicalCorpusRoot(source.canonicalUri);
    const authorship = recordOf(source.metadata).authorship;
    const key = canonicalStringify({ prefix, informationLabel, authorship });
    let pool = qaPools.get(key);
    if (!pool) { pool = { rootUri: `scce://stored-dialogue-qa/${createHasher().digestHex(key)}`, informationLabel,
      authorship: typeof authorship === "string" ? authorship : "unmeasured", sources: [], deferred: [] }; qaPools.set(key, pool); }
    return pool;
  }

  function interrupted(): boolean {
    if (input.signal?.aborted) stoppedByInterruption = true;
    return stoppedByInterruption;
  }

  async function loadAndTrain(version: Awaited<ReturnType<NonNullable<typeof list>>>[number]): Promise<boolean> {
    try {
      const found = await input.storage.evidence.searchEvidence({ sourceVersionId: version.sourceVersionId, status: "promoted", limit: 4096 });
      if (interrupted()) return false;
      const evidence = found.map(row => row.span).filter(span => String(span.sourceVersionId) === String(version.sourceVersionId) && span.status === "promoted")
        .sort((left, right) => left.charStart - right.charStart || String(left.id).localeCompare(String(right.id)));
      if (!evidence.length || evidence.some(span => !span.informationLabel)) throw new Error("promoted source evidence or information label is missing");
      if (version.promotedSpanCount > evidence.length) throw new Error("source evidence exceeds bounded replay read");
      const sources = await input.storage.evidence.sourceVersionsForEvidence(evidence.map(span => span.id));
      if (interrupted()) return false;
      const source = sources.find(row => String(row.sourceVersionId) === String(version.sourceVersionId));
      if (!source) throw new Error("original source version is missing");
      const metadata = recordOf(source.metadata);
      if (source.canonicalUri.startsWith("scce://construction-training/") || source.canonicalUri.startsWith("scce://construction-probe/")
        || metadata.derivation === "construction_training" || metadata.derivation === "construction_probe" || metadata.sourceKind === "construction_probe"
        || metadata.lane === "stored-corpus-construction-training" || metadata.sourceClass === "generated"
        || recordOf(metadata.sourceAdmission ?? null).sourceClass === "generated") {
        sourcesSkipped.push({ sourceVersionId: String(version.sourceVersionId), reason: "derived_training_source" });
        return true;
      }
      const declaredSystem = metadata.sourceSystemId ?? metadata.sourceSystem;
      if (typeof declaredSystem !== "string" || canonicalCorpusSourceSystemId(declaredSystem) !== sourceSystem) {
        sourcesSkipped.push({ sourceVersionId: String(version.sourceVersionId), reason: "different_or_undeclared_source_system" });
        return true;
      }
      const profiles = await input.storage.model.listLanguageProfiles({ sourceVersionIds: [source.sourceVersionId], limit: 4096 });
      if (interrupted()) return false;
      const profile = profiles.filter(row => String(row.sourceVersionId) === String(source.sourceVersionId))
        .sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt) || left.id.localeCompare(right.id))[0];
      if (String(source.contentHash) !== String(version.contentHash) || source.byteLength !== version.byteLength) throw new Error("source content ownership changed during replay");
      const bytes = await input.storage.blobs.get(source.contentHash);
      if (interrupted()) return false;
      const text = Buffer.from(bytes).toString("utf8");
      const points = [...text];
      if (bytes.byteLength !== source.byteLength || evidence.some(span => points.slice(span.charStart, span.charEnd).join("") !== span.text)) throw new Error("stored source/evidence coordinates do not match");
      if (!text.trim()) throw new Error("stored source is empty");
      let transcriptTurns: readonly TranscriptTurn[] | undefined;
      let transcriptRetainedBytes: number | undefined;
      if (qaEnabled) {
        const informationLabel = joinInformationLabels([...(source.informationLabel ? [source.informationLabel] : []),
          ...(profile?.informationLabel ? [profile.informationLabel] : []), ...evidence.map(span => span.informationLabel!)], { explicitMergeAuthority: false });
        try { transcriptTurns = await readSourceTranscriptArchive(input.storage, source, text,
          { maxExpandedSurfaceBytes: Math.max(0, maxTotalBytes - qaRetainedBytes - bytes.byteLength) }); }
        catch (error) { qaPool(source, informationLabel).deferred.push({ sourceVersionId: String(source.sourceVersionId), reason: errorText(error) }); throw error; }
        if (!transcriptTurns && metadata.transcriptSchema === "scce.dialogue_transcript.v1") {
          qaPool(source, informationLabel).deferred.push({ sourceVersionId: String(source.sourceVersionId), reason: "transcript_annotations_unavailable" });
          sourcesSkipped.push({ sourceVersionId: String(source.sourceVersionId), reason: "transcript_annotations_unavailable" });
          return true;
        }
        if (transcriptTurns) transcriptRetainedBytes = bytes.byteLength + Number(recordOf(metadata.transcriptArchive ?? null).archiveByteLength)
          + transcriptTurns.reduce((total, turn) => total + Buffer.byteLength(turn.surface, "utf8")
            + (turn.supportingSourceRanges ?? []).reduce((total, range) => total + Buffer.byteLength(range.surface, "utf8"), 0), 0);
      }
      await trainSource({ source, profile, evidence, text, bytes: bytes.byteLength,
        ...(transcriptTurns ? { transcriptTurns, transcriptRetainedBytes } : {}) });
      interrupted();
    } catch (error) {
      if (markStorageFailure(error, String(version.sourceVersionId))) batchesFailed.push({ batchIndex, sourceVersionId: String(version.sourceVersionId), reason: errorText(error) });
      else sourcesSkipped.push({ sourceVersionId: String(version.sourceVersionId), reason: errorText(error) });
    }
    return true;
  }

  function markStorageFailure(error: unknown, sourceVersionId: string): boolean {
    const visited = new Set<unknown>();
    for (let cause = error; cause && typeof cause === "object" && !visited.has(cause); cause = (cause as { cause?: unknown }).cause) {
      visited.add(cause);
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string" && (/^(?:08|42|3F)/u.test(code) || ["57P01", "57P02", "57P03"].includes(code))) {
        storageFailure = { code, reason: errorText(error), sourceVersionId };
        return true;
      }
    }
    return false;
  }

}

function recordOf(value: JsonValue): Record<string, JsonValue> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function canonicalCorpusRoot(uri: string): string { try { return new URL(".", uri).href; } catch { return uri; } }
function errorText(error: unknown): string { return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200); }
function heapMiB(): number { return Math.round(process.memoryUsage().heapUsed / (1024 * 1024)); }
