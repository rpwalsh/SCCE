// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  type CreativeEventConstructionCompiler,
  type ScceStorage
} from "@scce/kernel";
import { trainLanguageCorpusText, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";

export interface GutenbergCorpusTrainOptions {
  storage: ScceStorage;
  rootPath: string;
  startFileIndex?: number;
  maxFilesPerRun?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  languageAliases?: readonly string[];
  creativeEventCompiler?: CreativeEventConstructionCompiler;
  /**
   * Heap-safety checkpoint in MiB, same contract as
   * `wikipedia-v3-ingestor.ts`'s `heapCheckpointMb`: checked before each
   * file, and when current heap usage reaches the bound the run stops
   * gracefully with `stoppedByHeapSafetyBound` set instead of risking a
   * process OOM that loses the whole run. This trainer runs file training
   * fully in-process (unlike the wikipedia lane's child-process
   * decompression boundary), so without a bound one pathological file's
   * training could take down the entire multi-file run.
   */
  heapCheckpointMb?: number;
}

export interface GutenbergCorpusTrainReport {
  schema: "scce.gutenbergCorpusTrainReport.v1";
  rootPath: string;
  sourceSystem: typeof CORPUS_SOURCE_SYSTEM_IDS.gutenberg;
  startFileIndex: number;
  filesTrained: number;
  filesSkipped: Array<{ path: string; reason: string; byteLength?: number }>;
  totals: GutenbergCorpusTrainingTotals;
  reports: LanguageCorpusTrainingReport[];
  /**
   * True when the run stopped early at the heap-safety checkpoint. The
   * report's startFileIndex + filesTrained + filesSkipped tell the caller
   * exactly where to resume (`startFileIndex` of the next run =
   * this run's startFileIndex + filesTrained + filesSkipped.length).
   */
  stoppedByHeapSafetyBound: boolean;
  heapMiBAtExit: number;
}

export interface GutenbergCorpusTrainingTotals {
  languageProfiles: number;
  evidence: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
}

interface FoundFile {
  absolutePath: string;
  relativePath: string;
  byteLength: number;
}

const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 4_000_000;
const DEFAULT_MAX_DEPTH = 8;

export async function trainGutenbergCorpus(input: GutenbergCorpusTrainOptions): Promise<GutenbergCorpusTrainReport> {
  const root = path.resolve(input.rootPath);
  const startFileIndex = Math.max(0, Math.floor(input.startFileIndex ?? 0));
  const maxFiles = Math.max(1, Math.floor(input.maxFilesPerRun ?? DEFAULT_MAX_FILES));
  const maxFileBytes = Math.max(1024, Math.floor(input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  const files = (
    await walkTextFiles(
      root,
      Math.max(0, Math.floor(input.maxDepth ?? DEFAULT_MAX_DEPTH)),
      startFileIndex + maxFiles
    )
  ).slice(startFileIndex, startFileIndex + maxFiles);
  const reports: LanguageCorpusTrainingReport[] = [];
  const skipped: GutenbergCorpusTrainReport["filesSkipped"] = [];
  // Same contract as wikipedia-v3-ingestor.ts: the caller-supplied bound is
  // honored as given (no floor) -- an explicitly tiny bound is an explicit
  // request to stop immediately with a resumable report, which is honest
  // and testable, never a crash.
  const heapCheckpointMb = input.heapCheckpointMb !== undefined && input.heapCheckpointMb > 0
    ? Math.floor(input.heapCheckpointMb)
    : undefined;
  let stoppedByHeapSafetyBound = false;
  for (const file of files) {
    if (heapCheckpointMb !== undefined && heapMiB() >= heapCheckpointMb) {
      stoppedByHeapSafetyBound = true;
      break;
    }
    if (file.byteLength > maxFileBytes) {
      skipped.push({ path: file.relativePath, reason: "file_exceeds_maxFileBytes", byteLength: file.byteLength });
      continue;
    }
    const raw = await readFile(file.absolutePath, "utf8");
    const text = stripGutenbergBoilerplate(raw).trim();
    if (!text) {
      skipped.push({ path: file.relativePath, reason: "empty_after_boilerplate_strip", byteLength: file.byteLength });
      continue;
    }
    const languageAliases = sourceLanguageAliases(raw, input.languageAliases);
    // One pathological file must cost that file, never the whole
    // multi-file run: training runs fully in-process here (no child-process
    // boundary like the wikipedia lane's decompressor), so a per-file
    // failure is recorded as an explicit skip with the real reason and the
    // loop continues. A process-level OOM cannot be caught this way --
    // that is what the heap checkpoint above is for.
    try {
      reports.push(await trainLanguageCorpusText({
        storage: input.storage,
        sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.gutenberg,
        streamUri: `${CORPUS_SOURCE_SYSTEM_IDS.gutenberg}:${normalizeRelative(file.relativePath)}`,
        sourceUri: pathToFileURL(file.absolutePath).href,
        text,
        mediaType: "text/plain",
        namespace: `corpus:${CORPUS_SOURCE_SYSTEM_IDS.gutenberg}`,
        maxEvidenceChunkBytes: 64 * 1024,
        ngramMaxOrder: input.ngramMaxOrder,
        ngramMaxCountersPerOrder: input.ngramMaxCountersPerOrder,
        ngramVocabularyLimit: input.ngramVocabularyLimit,
        languageAliases,
        creativeEventCompiler: input.creativeEventCompiler,
        corpusMetadata: {
          relativePath: normalizeRelative(file.relativePath),
          sourceHash: sha256(raw),
          boilerplateStripped: text.length !== raw.trim().length,
          languageAliases
        }
      }));
    } catch (error) {
      skipped.push({
        path: file.relativePath,
        reason: `training_failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
        byteLength: file.byteLength
      });
    }
  }
  return {
    schema: "scce.gutenbergCorpusTrainReport.v1",
    rootPath: root,
    sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.gutenberg,
    startFileIndex,
    filesTrained: reports.length,
    filesSkipped: skipped,
    totals: sumReports(reports),
    reports,
    stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB()
  };
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function sourceLanguageAliases(raw: string, supplied: readonly string[] | undefined): string[] {
  const explicit = supplied?.map(value => value.trim()).filter(Boolean) ?? [];
  if (explicit.length) return [...new Set(explicit)].sort(compareCodePoint);
  const header = raw.slice(0, Math.min(raw.length, 32_768));
  const declared = /^Language:\s*(.+?)\s*$/imu.exec(header)?.[1]
    ?.split(/[,;/]/u)
    .map(value => value.trim())
    .filter(Boolean) ?? [];
  return [...new Set(declared)].sort(compareCodePoint);
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stripGutenbergBoilerplate(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\u0000/g, " ");
  const start = markerEnd(normalized, [
    /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/imu,
    /^START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/imu
  ]);
  const end = markerStart(normalized, [
    /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*$/imu,
    /^END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*$/imu
  ]);
  return normalized.slice(start, end ?? normalized.length).trim();
}

async function walkTextFiles(root: string, maxDepth: number, maxFiles: number): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const visit = async (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) break;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".txt") continue;
      const info = await stat(absolute);
      out.push({ absolutePath: absolute, relativePath: path.relative(root, absolute), byteLength: info.size });
    }
  };
  await visit(root, 0);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath)).slice(0, maxFiles);
}

function markerEnd(text: string, patterns: readonly RegExp[]): number {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match.index + match[0].length;
  }
  return 0;
}

function markerStart(text: string, patterns: readonly RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match.index;
  }
  return undefined;
}

function sumReports(reports: readonly LanguageCorpusTrainingReport[]): GutenbergCorpusTrainingTotals {
  return reports.reduce((sum, report) => ({
    languageProfiles: sum.languageProfiles + report.languageProfiles,
    evidence: sum.evidence + report.evidence,
    ngramObservations: sum.ngramObservations + report.ngramObservations,
    ngramModels: sum.ngramModels + report.ngramModels,
    languageUnits: sum.languageUnits + report.languageUnits,
    languagePatterns: sum.languagePatterns + report.languagePatterns,
    semanticFrames: sum.semanticFrames + report.semanticFrames
  }), { languageProfiles: 0, evidence: 0, ngramObservations: 0, ngramModels: 0, languageUnits: 0, languagePatterns: 0, semanticFrames: 0 });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}
