// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { OssCorpusTrainOptions } from "@scce/adapters-node";

export interface CorpusTrainOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
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
}

export function parseCorpusTrainOptions(args: string[]): CorpusTrainOptions {
  const out: CorpusTrainOptions = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if ((flag === "--max-files" || flag === "--max-files-per-run" || flag === "--max-files-per-repo") && Number.isFinite(num)) out.maxFiles = Math.max(1, Math.floor(num));
    else if ((flag === "--start-file" || flag === "--start-file-index") && Number.isFinite(num)) out.startFileIndex = Math.max(0, Math.floor(num));
    else if (flag === "--max-file-bytes" && Number.isFinite(num)) out.maxFileBytes = Math.max(1024, Math.floor(num));
    else if (flag === "--max-total-bytes" && Number.isFinite(num)) out.maxTotalBytes = Math.max(1024, Math.floor(num));
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(0, Math.floor(num));
    else if (flag === "--ngram-max-order" && Number.isFinite(num)) out.ngramMaxOrder = Math.max(1, Math.min(6, Math.floor(num)));
    else if (flag === "--ngram-max-counters" && Number.isFinite(num)) out.ngramMaxCountersPerOrder = Math.max(32, Math.floor(num));
    else if (flag === "--ngram-vocabulary-limit" && Number.isFinite(num)) out.ngramVocabularyLimit = Math.max(128, Math.floor(num));
    else if (flag === "--heap-checkpoint-mb" && Number.isFinite(num)) out.heapCheckpointMb = Math.max(1, Math.floor(num));
    else if (flag === "--commit" && raw?.trim()) out.commitSha = raw.trim();
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
