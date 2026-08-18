import {
  CORPUS_SOURCE_SYSTEM_IDS,
  createUniversalCreativeEventConstructionCompiler,
  type CreativeEventConstructionCompiler,
  type ScceStorage
} from "@scce/kernel";
import { trainLanguageCorpusText, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";

export interface StoredCorpusConstructionTrainingOptions {
  storage: ScceStorage;
  /** Cumulative text budget across this run. Default 64MB. */
  maxTotalBytes?: number;
  /** Target concatenated-batch size. Default 3MB (novel-sized units). */
  batchBytes?: number;
  /** Resume point: skip this many batches' worth of articles first. */
  startBatchIndex?: number;
  /** Stop with a resumable report when heap crosses this bound (MiB). */
  heapCheckpointMb?: number;
  /** Sources to exclude (local files re-train through their own lanes). */
  excludeUriPrefixes?: readonly string[];
  minArticleBytes?: number;
  maxArticleBytes?: number;
  creativeEventCompiler?: CreativeEventConstructionCompiler;
}

export interface StoredCorpusConstructionTrainingReport {
  schema: "scce.storedCorpusConstructionTrainReport.v1";
  sourceSystem: string;
  startBatchIndex: number;
  batchesTrained: number;
  articlesTrained: number;
  bytesTrained: number;
  nextBatchIndex: number;
  stoppedByHeapSafetyBound: boolean;
  heapMiBAtExit: number;
  batchesFailed: Array<{ batchIndex: number; reason: string }>;
  reports: LanguageCorpusTrainingReport[];
}

/**
 * Re-run the language-construction training lane over text the blob store
 * already holds, prioritized by the evidence alpha of the source versions
 * promoted evidence actually draws on. This is how the generation
 * inventory (constructions, n-gram continuation mass) gets built from the
 * same corpus retrieval already trusts -- the knowledge extraction ran at
 * ingest time, but no production trainer ever ran the construction lane
 * over Wikipedia until this existed (the compiler was built and tested,
 * yet wired to no trainer; the Mouth could retrieve facts it had no
 * learned sentence shapes to express).
 *
 * Same operational contract as the gutenberg trainer: bounded batches,
 * heap checkpoint honored as given, per-batch failures recorded as skips,
 * resumable via startBatchIndex, never a crash.
 */
export async function trainStoredCorpusConstructions(
  input: StoredCorpusConstructionTrainingOptions
): Promise<StoredCorpusConstructionTrainingReport> {
  const list = input.storage.evidence.listEvidenceBackedSourceVersions;
  if (!list) throw new Error("storage adapter does not support listEvidenceBackedSourceVersions");
  const maxTotalBytes = Math.max(1024, Math.floor(input.maxTotalBytes ?? 64 * 1024 * 1024));
  const batchBytes = Math.max(1024, Math.floor(input.batchBytes ?? 3 * 1024 * 1024));
  const startBatchIndex = Math.max(0, Math.floor(input.startBatchIndex ?? 0));
  const heapCheckpointMb = input.heapCheckpointMb !== undefined && input.heapCheckpointMb > 0
    ? Math.floor(input.heapCheckpointMb)
    : undefined;
  const sourceSystem = CORPUS_SOURCE_SYSTEM_IDS.wikipedia;
  const compiler = input.creativeEventCompiler ?? createUniversalCreativeEventConstructionCompiler();

  const versions = await list.call(input.storage.evidence, {
    excludeUriPrefixes: input.excludeUriPrefixes ?? ["file://"],
    minByteLength: Math.max(0, Math.floor(input.minArticleBytes ?? 2000)),
    maxByteLength: Math.max(1, Math.floor(input.maxArticleBytes ?? 400000)),
    limit: 100000
  });

  const reports: LanguageCorpusTrainingReport[] = [];
  const batchesFailed: StoredCorpusConstructionTrainingReport["batchesFailed"] = [];
  let batchIndex = 0;
  let articlesTrained = 0;
  let bytesTrained = 0;
  let stoppedByHeapSafetyBound = false;
  let pending: string[] = [];
  let pendingBytes = 0;

  const trainPending = async (): Promise<void> => {
    if (!pending.length) return;
    const currentIndex = batchIndex++;
    const text = pending.join("\n\n");
    const articleCount = pending.length;
    pending = [];
    const currentBytes = pendingBytes;
    pendingBytes = 0;
    if (currentIndex < startBatchIndex) return;
    try {
      reports.push(await trainLanguageCorpusText({
        storage: input.storage,
        sourceSystem,
        streamUri: `${sourceSystem}:construction-training:batch-${String(currentIndex).padStart(4, "0")}`,
        sourceUri: `scce://construction-training/${sourceSystem}/batch-${String(currentIndex).padStart(4, "0")}`,
        text,
        mediaType: "text/plain",
        namespace: `corpus:${sourceSystem}`,
        maxEvidenceChunkBytes: 64 * 1024,
        creativeEventCompiler: compiler,
        corpusMetadata: {
          lane: "stored-corpus-construction-training",
          batchIndex: currentIndex,
          articleCount,
          purpose: "generation construction inventory from the retrieval corpus"
        }
      }));
      articlesTrained += articleCount;
      bytesTrained += currentBytes;
    } catch (error) {
      batchesFailed.push({
        batchIndex: currentIndex,
        reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
      });
    }
  };

  for (const version of versions) {
    // Pending text counts against the budget too, or articles accumulate
    // past the cap before the first flush.
    if (bytesTrained + pendingBytes >= maxTotalBytes) break;
    if (heapCheckpointMb !== undefined && heapMiB() >= heapCheckpointMb) {
      stoppedByHeapSafetyBound = true;
      break;
    }
    let text = "";
    try {
      const bytes = await input.storage.blobs.get(version.contentHash);
      text = Buffer.from(bytes).toString("utf8").trim();
    } catch {
      continue;
    }
    if (!text) continue;
    pending.push(text);
    pendingBytes += Buffer.byteLength(text, "utf8");
    if (pendingBytes >= batchBytes) await trainPending();
  }
  if (!stoppedByHeapSafetyBound) await trainPending();

  return {
    schema: "scce.storedCorpusConstructionTrainReport.v1",
    sourceSystem,
    startBatchIndex,
    batchesTrained: reports.length,
    articlesTrained,
    bytesTrained,
    nextBatchIndex: batchIndex,
    stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB(),
    batchesFailed,
    reports
  };
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
}
