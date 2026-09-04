// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CORPUS_SOURCE_SYSTEM_IDS, type InformationLabel, type ScceStorage } from "@scce/kernel";
import { inspectEngineeringCorpusFolder, type EngineeringCorpusFolderOptions } from "./engineering-corpus-folder.js";
import { trainLanguageCorpusText, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";

export interface OssCorpusTrainOptions extends EngineeringCorpusFolderOptions {
  storage: ScceStorage;
  rootPath: string;
  maxFilesPerRepo?: number;
  includeDocs?: boolean;
  includeSource?: boolean;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  /**
   * Heap-safety checkpoint in MiB, same contract as
   * `wikipedia-v3-ingestor.ts`'s `heapCheckpointMb` and
   * `gutenberg-corpus.ts`'s option of the same name: checked before each
   * file; reaching the bound stops the run gracefully with
   * `stoppedByHeapSafetyBound` instead of risking a process OOM that
   * loses the whole in-process run.
   */
  heapCheckpointMb?: number;
}

export interface OssCorpusTrainReport {
  schema: "scce.ossCorpusTrainReport.v1";
  rootPath: string;
  docsTrained: number;
  codeTrained: number;
  filesSkipped: Array<{ path: string; reason: string; byteLength?: number }>;
  totals: {
    oss_docs: OssCorpusTrainingTotals;
    oss_code: OssCorpusTrainingTotals;
  };
  reports: LanguageCorpusTrainingReport[];
  stoppedByHeapSafetyBound: boolean;
  heapMiBAtExit: number;
}

export interface OssCorpusTrainingTotals {
  languageProfiles: number;
  evidence: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  constructionCandidates: number;
  languageConstructions: number;
  rejectedLanguageConstructions: number;
}

type OssCorpusSourceSystem = typeof CORPUS_SOURCE_SYSTEM_IDS.ossDocs | typeof CORPUS_SOURCE_SYSTEM_IDS.ossCode;

export async function trainOssCorpus(input: OssCorpusTrainOptions): Promise<OssCorpusTrainReport> {
  const root = path.resolve(input.rootPath);
  const inspection = await inspectEngineeringCorpusFolder(root, {
    maxFiles: input.maxFiles ?? input.maxFilesPerRepo ?? 2000,
    maxFileBytes: input.maxFileBytes ?? 1_000_000,
    maxDepth: input.maxDepth ?? 12,
    includeUnsupported: false
  });
  const reports: LanguageCorpusTrainingReport[] = [];
  const skipped: OssCorpusTrainReport["filesSkipped"] = [...inspection.skipped];
  const includeDocs = input.includeDocs !== false;
  const includeSource = input.includeSource !== false;
  // Same contract as wikipedia-v3-ingestor.ts: the caller-supplied bound is
  // honored as given (no floor) -- an explicitly tiny bound is an explicit
  // request to stop immediately with a resumable report, which is honest
  // and testable, never a crash.
  const heapCheckpointMb = input.heapCheckpointMb !== undefined && input.heapCheckpointMb > 0
    ? Math.floor(input.heapCheckpointMb)
    : undefined;
  let stoppedByHeapSafetyBound = false;
  for (const file of inspection.files.filter(file => file.importable)) {
    if (heapCheckpointMb !== undefined && heapMiB() >= heapCheckpointMb) {
      stoppedByHeapSafetyBound = true;
      break;
    }
    const sourceSystem = sourceSystemForPath(file.path);
    if (!sourceSystem) {
      skipped.push({ path: file.path, reason: "not_language_training_material", byteLength: file.byteLength });
      continue;
    }
    if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs && !includeDocs) continue;
    if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossCode && !includeSource) continue;
    const raw = await readFile(file.absolutePath, "utf8");
    const text = sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs ? raw : codeAdjacentTrainingText(file.path, raw);
    if (!text.trim()) {
      skipped.push({ path: file.path, reason: "empty_language_training_projection", byteLength: file.byteLength });
      continue;
    }
    // Same failure-containment contract as gutenberg-corpus.ts: one
    // pathological file records an explicit skip with the real reason;
    // it never costs the rest of the in-process run.
    try {
      reports.push(await trainLanguageCorpusText({
        storage: input.storage,
        sourceSystem,
        streamUri: `${sourceSystem}:${normalizeRelative(file.path)}`,
        sourceUri: pathToFileURL(file.absolutePath).href,
        text,
        mediaType: file.mediaType,
        namespace: `corpus:${sourceSystem}`,
        maxEvidenceChunkBytes: 64 * 1024,
        ngramMaxOrder: input.ngramMaxOrder,
        ngramMaxCountersPerOrder: input.ngramMaxCountersPerOrder,
        ngramVocabularyLimit: input.ngramVocabularyLimit,
        informationLabel: OSS_CORPUS_INFORMATION_LABEL,
        corpusMetadata: {
          relativePath: normalizeRelative(file.path),
          sourceHash: file.contentHash ?? sha256(raw),
          extractor: file.extractor,
          supportedSections: file.supportedSections
        }
      }));
    } catch (error) {
      skipped.push({
        path: file.path,
        reason: `training_failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
        byteLength: file.byteLength
      });
    }
  }
  return {
    schema: "scce.ossCorpusTrainReport.v1",
    rootPath: root,
    docsTrained: reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs).length,
    codeTrained: reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode).length,
    filesSkipped: skipped,
    totals: {
      oss_docs: sumReports(reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs)),
      oss_code: sumReports(reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode))
    },
    reports,
    stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB()
  };
}

export function sourceSystemForPath(relativePath: string): OssCorpusSourceSystem | undefined {
  const normalized = normalizeRelative(relativePath).toLowerCase();
  const base = path.posix.basename(normalized);
  if (normalized.includes("/docs/") || normalized.startsWith("docs/")) return CORPUS_SOURCE_SYSTEM_IDS.ossDocs;
  if (/^(readme|changelog|contributing|license|security|code_of_conduct)(\.[a-z0-9]+)?$/u.test(base)) return CORPUS_SOURCE_SYSTEM_IDS.ossDocs;
  if (/\.(md|mdx|rst|adoc|txt)$/u.test(normalized)) return CORPUS_SOURCE_SYSTEM_IDS.ossDocs;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|css|scss|html|json|yaml|yml)$/u.test(normalized)) return CORPUS_SOURCE_SYSTEM_IDS.ossCode;
  return undefined;
}

export function codeAdjacentTrainingText(relativePath: string, text: string): string {
  const comments = [
    ...text.matchAll(/\/\*[\s\S]*?\*\//gu),
    ...text.matchAll(/\/\/[^\n]*/gu),
    ...text.matchAll(/#[^\n]*/gu)
  ].map(match => match[0].replace(/^\/\*+|\*+\/$/gu, "").replace(/^\s*(?:\/\/|#)\s?/gu, "").trim())
    .filter(Boolean)
    .slice(0, 512);
  const identifiers = [...new Set(text.match(/[$_\p{Letter}][$_\p{Letter}\p{Number}]{2,}/gu) ?? [])]
    .slice(0, 1200)
    .map(splitIdentifierSurface)
    .filter(Boolean);
  return [
    normalizeRelative(relativePath),
    ...comments,
    identifiers.join(" ")
  ].filter(Boolean).join("\n").slice(0, 1_000_000);
}

function splitIdentifierSurface(value: string): string {
  return value
    .replace(/[_$]+/gu, " ")
    .replace(/([\p{Ll}\p{Number}])([\p{Lu}])/gu, "$1 $2")
    .trim();
}

function sumReports(reports: readonly LanguageCorpusTrainingReport[]): OssCorpusTrainingTotals {
  return reports.reduce((sum, report) => ({
    languageProfiles: sum.languageProfiles + report.languageProfiles,
    evidence: sum.evidence + report.evidence,
    ngramObservations: sum.ngramObservations + report.ngramObservations,
    ngramModels: sum.ngramModels + report.ngramModels,
    languageUnits: sum.languageUnits + report.languageUnits,
    languagePatterns: sum.languagePatterns + report.languagePatterns,
    semanticFrames: sum.semanticFrames + report.semanticFrames,
    constructionCandidates: sum.constructionCandidates + report.constructionCandidates,
    languageConstructions: sum.languageConstructions + report.languageConstructions,
    rejectedLanguageConstructions: sum.rejectedLanguageConstructions + report.rejectedLanguageConstructions
  }), { languageProfiles: 0, evidence: 0, ngramObservations: 0, ngramModels: 0, languageUnits: 0, languagePatterns: 0, semanticFrames: 0, constructionCandidates: 0, languageConstructions: 0, rejectedLanguageConstructions: 0 });
}

const OSS_CORPUS_INFORMATION_LABEL: InformationLabel = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public",
  mergePolicy: "same_owner"
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}