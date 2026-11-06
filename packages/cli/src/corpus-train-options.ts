// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { OssCorpusTrainOptions, StoredCorpusConstructionTrainingOptions } from "@scce/adapters-node";

export interface CorpusTrainOptions {
  maxFiles?: number;
  maxFilesPerRun?: number;
  maxFilesPerRepo?: number;
  expectedSnapshotHash?: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxSourceAttempts?: number;
  maxDepth?: number;
  startFileIndex?: number;
  includeDocs?: boolean;
  includeSource?: boolean;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  languageAliases?: string[];
  heapCheckpointMb?: number;
  sourceVersionIds?: string[];
  languageOnly?: boolean;
  includeUriPrefixes?: string[];
  batchBytes?: number;
  actsOnly?: boolean;
  commitSha?: string;
  sourceUriBase?: string;
  sourceSystem?: string;
  afterSourceVersionId?: string;
  sourcePageSize?: number;
  minArticleBytes?: number;
  maxArticleBytes?: number;
}

export function parseCorpusTrainOptions(args: string[]): CorpusTrainOptions {
  const out: CorpusTrainOptions = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--max-files" && Number.isFinite(num)) out.maxFiles = Math.max(1, Math.floor(num));
    else if (flag === "--max-files-per-run" && Number.isFinite(num)) out.maxFilesPerRun = Math.max(1, Math.floor(num));
    else if (flag === "--max-files-per-repo" && Number.isFinite(num)) out.maxFilesPerRepo = Math.max(1, Math.floor(num));
    else if (flag === "--expected-snapshot-hash" && raw?.trim()) out.expectedSnapshotHash = raw.trim();
    else if ((flag === "--start-file" || flag === "--start-file-index" || flag === "--start-batch") && Number.isFinite(num)) out.startFileIndex = Math.max(0, Math.floor(num));
    else if (flag === "--max-file-bytes" && Number.isFinite(num)) out.maxFileBytes = Math.max(1024, Math.floor(num));
    else if (flag === "--max-source-attempts" && Number.isFinite(num)) out.maxSourceAttempts = Math.max(1, Math.floor(num));
    else if (flag === "--max-total-bytes" && Number.isFinite(num)) out.maxTotalBytes = Math.max(1024, Math.floor(num));
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(0, Math.floor(num));
    else if (flag === "--ngram-max-order" && Number.isFinite(num)) out.ngramMaxOrder = Math.max(1, Math.min(6, Math.floor(num)));
    else if (flag === "--ngram-max-counters" && Number.isFinite(num)) out.ngramMaxCountersPerOrder = Math.max(32, Math.floor(num));
    else if (flag === "--ngram-vocabulary-limit" && Number.isFinite(num)) out.ngramVocabularyLimit = Math.max(128, Math.floor(num));
    else if (flag === "--heap-checkpoint-mb" && Number.isFinite(num)) out.heapCheckpointMb = Math.max(1, Math.floor(num));
    else if (flag === "--commit" && raw?.trim()) out.commitSha = raw.trim();
    else if ((flag === "--after-source-version" || flag === "--after-source-version-id") && raw?.trim()) out.afterSourceVersionId = raw.trim();
    else if (flag === "--source-page-size" && Number.isFinite(num)) out.sourcePageSize = Math.max(1, Math.min(1024, Math.floor(num)));
    else if (flag === "--source-system" && raw?.trim()) out.sourceSystem = raw.trim();
    else if (flag === "--min-article-bytes" && Number.isFinite(num)) out.minArticleBytes = Math.max(0, Math.floor(num));
    else if (flag === "--max-article-bytes" && Number.isFinite(num)) out.maxArticleBytes = Math.max(1, Math.floor(num));
    else if (flag === "--source-uri-base" && raw?.trim()) out.sourceUriBase = raw.trim();
    else if (flag === "--language" && raw?.trim()) {
      out.languageAliases = [...new Set(raw.split(",").map(value => value.trim()).filter(Boolean))];
    }
    else if (flag === "--source-version-ids" && raw?.trim()) {
      out.sourceVersionIds = [...new Set(raw.split(",").map(value => value.trim()).filter(Boolean))];
    }
    else if (arg === "--docs-only") {
      out.includeDocs = true;
      out.includeSource = false;
    } else if (arg === "--language-only") {
      out.languageOnly = true;
    } else if (arg === "--acts-only") {
      out.actsOnly = true;
    } else if (flag === "--uri-prefix" && raw?.trim()) {
      out.includeUriPrefixes = [...new Set(raw.split(",").map(value => value.trim()).filter(Boolean))];
    } else if (flag === "--batch-bytes" && Number.isFinite(num)) {
      out.batchBytes = Math.max(1024, Math.floor(num));
    } else if (arg === "--code-only") {
      out.includeDocs = false;
      out.includeSource = true;
    } else throw new Error(`unknown corpus train option: ${arg}`);
  }
  return out;
}

/**
 * Everything the local OSS trainer needs from the command line, in one place so a parsed flag cannot be
 * silently dropped on the way to the trainer. `--heap-checkpoint-mb` and `--start-file-index` were both
 * parsed and then not forwarded, which left a 47,404-file corpus unbounded and unable to resume.
 */
export function ossCorpusTrainOptionsFrom(options: CorpusTrainOptions): Omit<OssCorpusTrainOptions, "storage" | "rootPath"> {
  return {
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxFilesPerRun !== undefined ? { maxFilesPerRun: options.maxFilesPerRun } : {}),
    ...(options.maxFilesPerRepo !== undefined ? { maxFilesPerRepo: options.maxFilesPerRepo } : {}),
    ...(options.expectedSnapshotHash !== undefined ? { expectedSnapshotHash: options.expectedSnapshotHash } : {}),
    ...(options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.startFileIndex !== undefined ? { startFileIndex: options.startFileIndex } : {}),
    ...(options.heapCheckpointMb !== undefined ? { heapCheckpointMb: options.heapCheckpointMb } : {}),
    ...(options.sourceUriBase !== undefined ? { sourceUriBase: options.sourceUriBase } : {}),
    ...(options.includeDocs !== undefined ? { includeDocs: options.includeDocs } : {}),
    ...(options.includeSource !== undefined ? { includeSource: options.includeSource } : {}),
    ...(options.ngramMaxOrder !== undefined ? { ngramMaxOrder: options.ngramMaxOrder } : {}),
    ...(options.ngramMaxCountersPerOrder !== undefined ? { ngramMaxCountersPerOrder: options.ngramMaxCountersPerOrder } : {}),
    ...(options.ngramVocabularyLimit !== undefined ? { ngramVocabularyLimit: options.ngramVocabularyLimit } : {}),
    ...(options.languageAliases !== undefined ? { languageAliases: options.languageAliases } : {})
  };
}

/** Forward replay bounds and ownership selection without conflating total bytes with one article. */
export function storedCorpusTrainOptionsFrom(options: CorpusTrainOptions): Omit<StoredCorpusConstructionTrainingOptions, "storage"> {
  return {
    ...(options.maxSourceAttempts !== undefined ? { maxSourceAttempts: options.maxSourceAttempts } : {}),
    ...(options.sourceSystem !== undefined ? { sourceSystem: options.sourceSystem } : {}),
    ...(options.afterSourceVersionId !== undefined ? { afterSourceVersionId: options.afterSourceVersionId } : {}),
    ...(options.sourcePageSize !== undefined ? { sourcePageSize: options.sourcePageSize } : {}),
    ...(options.startFileIndex !== undefined ? { startBatchIndex: options.startFileIndex } : {}),
    ...(options.maxTotalBytes !== undefined || options.maxFileBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes ?? options.maxFileBytes } : {}),
    ...(options.heapCheckpointMb !== undefined ? { heapCheckpointMb: options.heapCheckpointMb } : {}),
    ...(options.sourceVersionIds !== undefined ? { sourceVersionIds: options.sourceVersionIds } : {}),
    ...(options.languageOnly !== undefined ? { languageOnly: options.languageOnly } : {}),
    ...(options.includeUriPrefixes !== undefined ? { includeUriPrefixes: options.includeUriPrefixes } : {}),
    ...(options.batchBytes !== undefined ? { batchBytes: options.batchBytes } : {}),
    ...(options.minArticleBytes !== undefined ? { minArticleBytes: options.minArticleBytes } : {}),
    ...(options.maxArticleBytes !== undefined ? { maxArticleBytes: options.maxArticleBytes } : {})
  };
}
