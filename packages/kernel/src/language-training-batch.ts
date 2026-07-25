import {
  compileLanguageConstructionPattern,
  type SourceBoundLanguageConstructionTrainingSet
} from "./language-construction-memory.js";
import { induceSourceBoundConstructionTrainingSets } from "./graph-surface-alignment.js";
import type { LanguageMemoryRuntime } from "./language-memory-runtime.js";
import { toJsonValue } from "./primitives.js";
import type {
  LanguagePatternRecord,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  SemanticFrameRecord
} from "./storage.js";
import type { ScceStorage } from "./storage.js";
import { dominantScriptId, segmentUnicodeSurfaceV2 } from "./unicode-segmentation-v2.js";
import type {
  EvidenceSpan,
  Hasher,
  JsonValue,
  LanguageProfile,
  SourceVersionId
} from "./types.js";

/**
 * The single in-memory compilation boundary shared by file ingestion, corpus
 * ingestion, and explicit training. Persistence and source admission remain
 * caller responsibilities, but identical language-bearing input now produces
 * the same family of linguistic artifacts regardless of entry point.
 */
export interface LanguageTrainingBatch {
  streamId: string;
  sourceSystem?: string;
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  text: string;
  evidence: EvidenceSpan[];
  createdAt: number;
  maxOrder?: number;
  maxCountersPerOrder?: number;
  vocabularyLimit?: number;
  constructionSets?: readonly SourceBoundLanguageConstructionTrainingSet[];
  additionalPatterns?: readonly LanguagePatternRecord[];
}

export interface CompiledLanguageTrainingBatch {
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  semanticFrames: SemanticFrameRecord[];
  constructionPatterns: LanguagePatternRecord[];
  warnings: string[];
  audit: JsonValue;
}

export function compileLanguageTrainingBatch(input: {
  batch: LanguageTrainingBatch;
  runtime: LanguageMemoryRuntime;
  hasher: Hasher;
}): CompiledLanguageTrainingBatch {
  const { batch } = input;
  const textChunks = boundedTrainingTextChunks(batch.text);
  const memories = textChunks.map((text, index) => input.runtime.train({
    streamId: textChunks.length === 1
      ? batch.streamId
      : `${batch.streamId}#training-chunk-${String(index + 1).padStart(6, "0")}`,
    sourceSystem: batch.sourceSystem,
    profile: batch.profile,
    sourceVersionId: batch.sourceVersionId,
    text,
    evidence: batch.evidence,
    createdAt: batch.createdAt,
    maxOrder: batch.maxOrder,
    maxCountersPerOrder: batch.maxCountersPerOrder,
    vocabularyLimit: batch.vocabularyLimit
  }));
  const inducedSets = induceSourceBoundConstructionTrainingSets({
    evidence: batch.evidence,
    profileId: batch.profile.id,
    hasher: input.hasher
  });
  const constructionPatterns: LanguagePatternRecord[] = [];
  const warnings: string[] = [];
  const sets = uniqueConstructionSets([
    ...(batch.constructionSets ?? []),
    ...inducedSets
  ]);
  for (const set of sets) {
    const compiled = compileLanguageConstructionPattern({
      bindingId: set.bindingId,
      profileId: batch.profile.id,
      observations: set.observations,
      evidence: batch.evidence,
      hasher: input.hasher,
      updatedAt: batch.createdAt
    });
    if (compiled.status === "compiled") constructionPatterns.push(compiled.pattern);
    else warnings.push(...compiled.issues.map(issue => issue.code));
  }

  return {
    observations: uniqueRecords(memories.flatMap(memory => memory.observations)),
    models: uniqueRecords(memories.flatMap(memory => memory.models)),
    units: uniqueRecords(memories.flatMap(memory => memory.units)),
    patterns: uniquePatterns([
      ...memories.flatMap(memory => memory.patterns),
      ...constructionPatterns,
      ...(batch.additionalPatterns ?? [])
    ]),
    semanticFrames: uniqueRecords(memories.flatMap(memory => memory.semanticFrames)),
    constructionPatterns,
    warnings: [...new Set(warnings)].sort(),
    audit: toJsonValue({
      compiler: "kernel.language_training_batch.v1",
      inputUtf16Length: batch.text.length,
      chunks: textChunks.length,
      chunkUtf16Lengths: textChunks.map(text => text.length),
      completeInputCoverage: textChunks.join("") === batch.text,
      memory: memories.map(memory => jsonObject(memory.audit)),
      suppliedConstructionSets: batch.constructionSets?.length ?? 0,
      inducedConstructionSets: inducedSets.length,
      compiledConstructions: constructionPatterns.length,
      constructionWarnings: [...new Set(warnings)].sort()
    })
  };
}

export async function observeLanguageTrainingSegmentation(input: {
  storage: ScceStorage;
  batch: Pick<LanguageTrainingBatch, "text" | "createdAt">;
  tenantId: string;
  corpusRole: string;
  activeImportVersion: string;
  hasher: Hasher;
}): Promise<void> {
  if (!input.storage.segmentationAggregates || !input.batch.text.trim()) return;
  const model = segmentUnicodeSurfaceV2(input.batch.text, input.hasher);
  await input.storage.segmentationAggregates.observeDocument({
    key: {
      segmentationVersion: model.schemaVersion,
      languageCluster: dominantScriptId(input.batch.text),
      tenantId: input.tenantId,
      corpusRole: input.corpusRole,
      activeImportVersion: input.activeImportVersion
    },
    model,
    observedAt: input.batch.createdAt
  });
}

function uniqueConstructionSets(
  sets: readonly SourceBoundLanguageConstructionTrainingSet[]
): SourceBoundLanguageConstructionTrainingSet[] {
  const byBindingId = new Map<string, SourceBoundLanguageConstructionTrainingSet>();
  for (const set of sets) {
    const current = byBindingId.get(set.bindingId);
    if (!current) {
      byBindingId.set(set.bindingId, set);
      continue;
    }
    byBindingId.set(set.bindingId, {
      bindingId: set.bindingId,
      observations: [...current.observations, ...set.observations].slice(0, 256)
    });
  }
  return [...byBindingId.values()].sort((left, right) => left.bindingId.localeCompare(right.bindingId));
}

function uniquePatterns(patterns: readonly LanguagePatternRecord[]): LanguagePatternRecord[] {
  const byId = new Map<string, LanguagePatternRecord>();
  for (const pattern of patterns) if (!byId.has(pattern.id)) byId.set(pattern.id, pattern);
  return [...byId.values()];
}

function uniqueRecords<T extends { id: string }>(records: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) if (!byId.has(record.id)) byId.set(record.id, record);
  return [...byId.values()];
}

function boundedTrainingTextChunks(text: string, maxUtf16Length = 150_000): string[] {
  if (!text.length) return [""];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxUtf16Length);
    if (end < text.length) {
      const searchStart = Math.max(start + Math.floor(maxUtf16Length * 0.75), start + 1);
      const boundary = lastTrainingBoundary(text, searchStart, end);
      if (boundary > start) end = boundary;
      if (end > start && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end--;
    }
    if (end <= start) end = Math.min(text.length, start + maxUtf16Length);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function lastTrainingBoundary(text: string, minimum: number, end: number): number {
  for (let index = end; index >= minimum; index--) {
    const char = text[index - 1];
    if (char === "\n" || char === "\r" || char === "." || char === "!" || char === "?"
      || char === "\u3002" || char === "\uff01" || char === "\uff1f" || /\s/u.test(char ?? "")) {
      return index;
    }
  }
  return end;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
