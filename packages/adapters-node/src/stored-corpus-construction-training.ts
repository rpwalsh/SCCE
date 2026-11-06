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
import { LANGUAGE_CORPUS_TRAINING_RECIPE_ID, trainLanguageCorpusText, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";

export interface StoredCorpusConstructionTrainingOptions {
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
  storageFailure: { code: string; reason: string; sourceVersionId: string } | null;
  heapMiBAtExit: number;
  batchesFailed: Array<{ batchIndex: number; sourceVersionId?: string; reason: string }>;
  sourcesSkipped: Array<{ sourceVersionId: string; reason: string }>;
  reports: LanguageCorpusTrainingReport[];
}

interface ReplaySource {
  source: SourceVersion;
  profile: LanguageProfile;
  evidence: EvidenceSpan[];
  text: string;
  bytes: number;
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
  const inventory = await input.storage.evidence.countEvidenceBackedSourceVersions?.(query) ?? null;
  const reports: LanguageCorpusTrainingReport[] = [];
  const batchesFailed: StoredCorpusConstructionTrainingReport["batchesFailed"] = [];
  const sourcesSkipped: StoredCorpusConstructionTrainingReport["sourcesSkipped"] = [];
  let batchIndex = 0;
  let articlesTrained = 0;
  let bytesTrained = 0;
  let stoppedByHeapSafetyBound = false;
  let nextSourceVersionId = input.afterSourceVersionId ?? null;
  let exhausted = false;
  let sourcesEnumerated = 0;
  let sourcesConsidered = 0;
  let sourcesAttempted = 0;
  let storageFailure: StoredCorpusConstructionTrainingReport["storageFailure"] = null;
  let legacyBatchSourcesSkipped = 0;
  let bytesScheduled = 0;
  let currentBatchBytes = 0;
  const successfulBatches = new Set<number>();

  const trainSource = async (item: ReplaySource): Promise<void> => {
    try {
      const metadata = recordOf(item.source.metadata);
      const informationLabel = joinInformationLabels([
        ...(item.source.informationLabel ? [item.source.informationLabel] : []),
        ...(item.profile.informationLabel ? [item.profile.informationLabel] : []),
        ...item.evidence.map(span => span.informationLabel!)
      ], { explicitMergeAuthority: false });
      const prefix = input.includeUriPrefixes?.find(value => item.source.canonicalUri.startsWith(value)) ?? canonicalCorpusRoot(item.source.canonicalUri);
      const report = await trainLanguageCorpusText({
        storage: input.storage,
        sourceSystem,
        streamUri: typeof metadata.streamUri === "string" ? metadata.streamUri : item.source.canonicalUri,
        sourceUri: item.source.canonicalUri,
        sourceVersionId: item.source.sourceVersionId,
        evidence: item.evidence,
        profile: item.profile,
        text: item.text,
        mediaType: item.source.mediaType,
        namespace: item.source.namespace,
        createdAt: item.source.observedAt,
        informationLabel,
        persistSource: false,
        persistProfile: false,
        skipNgramPersistence: !input.languageOnly,
        ...(input.languageOnly ? { languageOnly: true } : { ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 4096 }),
        creativeEventCompiler: compiler,
        graphSnapshotSourceVersionIds: [String(item.source.sourceVersionId)],
        constructionPoolUriPrefix: prefix,
        corpusCheckpoint: {
          rootUri: `scce://stored-corpus-replay/${sourceSystem}/${LANGUAGE_CORPUS_TRAINING_RECIPE_ID}`,
          itemUri: item.source.canonicalUri,
          contentHash: String(item.source.contentHash),
          byteLength: item.source.byteLength
        },
        corpusMetadata: { ...metadata, lane: "stored-corpus-construction-replay", replayRecipeId: LANGUAGE_CORPUS_TRAINING_RECIPE_ID } as JsonValue
      });
      reports.push(report);
      articlesTrained++;
      bytesTrained += item.bytes;
      successfulBatches.add(batchIndex);
    } catch (error) {
      batchesFailed.push({ batchIndex, sourceVersionId: String(item.source.sourceVersionId), reason: errorText(error) });
      markStorageFailure(error, String(item.source.sourceVersionId));
    }
  };

  pages: while (true) {
    if (bytesScheduled >= maxTotalBytes || sourcesAttempted >= maxSourceAttempts) break;
    if (heapCheckpointMb !== undefined && heapMiB() >= heapCheckpointMb) { stoppedByHeapSafetyBound = true; break; }
    const versions = await list.call(input.storage.evidence, { ...query,
      ...(nextSourceVersionId !== null ? { afterSourceVersionId: nextSourceVersionId } : {}) });
    if (versions.length > sourcePageSize) throw new Error("storage replay page exceeded its requested bound");
    if (!versions.length) { exhausted = true; break; }
    sourcesEnumerated += versions.length;
    let previous = nextSourceVersionId;
    for (const version of versions) {
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
        await loadAndTrain(version);
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
  return { schema: "scce.storedCorpusConstructionTrainReport.v1", sourceSystem, recipeId: LANGUAGE_CORPUS_TRAINING_RECIPE_ID,
    startBatchIndex, startSourceVersionId: input.afterSourceVersionId ?? null, nextSourceVersionId, exhausted, sourcePageSize,
    sourcesEnumerated, sourcesConsidered, sourcesAttempted, maxSourceAttempts, legacyBatchSourcesSkipped, bytesScheduled, inventory, inventoryScope: "after_start_cursor",
    eligibleSourcesRemaining: inventory ? Math.max(0, inventory.eligibleSources - sourcesConsidered) : null,
    articleBounds: { minBytes: minArticleBytes, maxBytes: maxArticleBytes },
    batchesTrained, articlesTrained, bytesTrained, nextBatchIndex, stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB(), stoppedByStorageFailure: storageFailure !== null, storageFailure, batchesFailed, sourcesSkipped, reports };

  async function loadAndTrain(version: Awaited<ReturnType<NonNullable<typeof list>>>[number]): Promise<void> {
    try {
      const found = await input.storage.evidence.searchEvidence({ sourceVersionId: version.sourceVersionId, status: "promoted", limit: 4096 });
      const evidence = found.map(row => row.span).filter(span => String(span.sourceVersionId) === String(version.sourceVersionId) && span.status === "promoted")
        .sort((left, right) => left.charStart - right.charStart || String(left.id).localeCompare(String(right.id)));
      if (!evidence.length || evidence.some(span => !span.informationLabel)) throw new Error("promoted source evidence or information label is missing");
      if (version.promotedSpanCount > evidence.length) throw new Error("source evidence exceeds bounded replay read");
      const sources = await input.storage.evidence.sourceVersionsForEvidence(evidence.map(span => span.id));
      const source = sources.find(row => String(row.sourceVersionId) === String(version.sourceVersionId));
      if (!source) throw new Error("original source version is missing");
      const metadata = recordOf(source.metadata);
      if (source.canonicalUri.startsWith("scce://construction-training/") || source.canonicalUri.startsWith("scce://construction-probe/")
        || metadata.derivation === "construction_training" || metadata.derivation === "construction_probe" || metadata.sourceKind === "construction_probe"
        || metadata.lane === "stored-corpus-construction-training" || metadata.sourceClass === "generated"
        || recordOf(metadata.sourceAdmission ?? null).sourceClass === "generated") {
        sourcesSkipped.push({ sourceVersionId: String(version.sourceVersionId), reason: "derived_training_source" });
        return;
      }
      const declaredSystem = metadata.sourceSystemId ?? metadata.sourceSystem;
      if (typeof declaredSystem !== "string" || canonicalCorpusSourceSystemId(declaredSystem) !== sourceSystem) {
        sourcesSkipped.push({ sourceVersionId: String(version.sourceVersionId), reason: "different_or_undeclared_source_system" });
        return;
      }
      const profiles = await input.storage.model.listLanguageProfiles({ sourceVersionIds: [source.sourceVersionId], limit: 4096 });
      const profile = profiles.filter(row => String(row.sourceVersionId) === String(source.sourceVersionId))
        .sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt) || left.id.localeCompare(right.id))[0];
      if (!profile) throw new Error("original language profile is missing");
      if (String(source.contentHash) !== String(version.contentHash) || source.byteLength !== version.byteLength) throw new Error("source content ownership changed during replay");
      const bytes = await input.storage.blobs.get(source.contentHash);
      const text = Buffer.from(bytes).toString("utf8");
      const points = [...text];
      if (bytes.byteLength !== source.byteLength || evidence.some(span => points.slice(span.charStart, span.charEnd).join("") !== span.text)) throw new Error("stored source/evidence coordinates do not match");
      if (!text.trim()) throw new Error("stored source is empty");
      await trainSource({ source, profile, evidence, text, bytes: bytes.byteLength });
    } catch (error) {
      if (markStorageFailure(error, String(version.sourceVersionId))) batchesFailed.push({ batchIndex, sourceVersionId: String(version.sourceVersionId), reason: errorText(error) });
      else sourcesSkipped.push({ sourceVersionId: String(version.sourceVersionId), reason: errorText(error) });
    }
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
