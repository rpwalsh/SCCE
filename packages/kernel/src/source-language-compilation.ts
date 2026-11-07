// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalDigestHex } from "./canonical-json-digest.js";
import { corpusSourceAlias } from "./corpus-registry.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import { LANGUAGE_TRAINING_BATCH_RECIPE_ID, LANGUAGE_TRAINING_MIN_CHUNK_UTF16_LENGTH } from "./language-training-recipe.js";
import { canonicalNgramModelId, sourceLanguageTrainingStreamId } from "./source-language-training-identity.js";
import { toJsonValue } from "./primitives.js";
import type { LanguageUnitRecord, LanguagePatternRecord, SemanticFrameRecord, NgramModelRecord } from "./storage.js";
import type { ContentHash, Hasher, JsonValue, SourceId, SourceVersionId } from "./types.js";

export interface SourceCompilationOwner { sourceId: SourceId; sourceVersionId: SourceVersionId; contentHash: ContentHash }

function modelMaterial(record: NgramModelRecord): JsonValue {
  const row = jsonRecord(record.modelJson);
  return toJsonValue({ id: record.id, streamId: record.streamId, languageHint: record.languageHint, maxOrder: record.maxOrder, discount: record.discount,
    profileId: row.profileId, sourceVersionId: row.sourceVersionId, sourceSystem: row.sourceSystem, model: row.model, compact: row.compact });
}

export function stampSourceLanguageCompilation(input: {
  owner: SourceCompilationOwner; profileId: string; sourceSystem: string; streamId: string; text: string; chunks: readonly string[];
  models: readonly NgramModelRecord[]; options: { maxOrder: number; maxCountersPerOrder: number; vocabularyLimit: number; languageOnly: boolean; retainNgramObservations: boolean };
  artifacts: { units: readonly LanguageUnitRecord[]; patterns: readonly LanguagePatternRecord[]; semanticFrames: readonly SemanticFrameRecord[] }; hasher: Hasher;
}): { models: NgramModelRecord[]; units: LanguageUnitRecord[]; patterns: LanguagePatternRecord[]; semanticFrames: SemanticFrameRecord[] } {
  if (input.models.length !== input.chunks.length) throw new Error("canonical source compiler must produce its complete chunk set");
  const sourceArtifacts = { ...input.artifacts, patterns: input.artifacts.patterns.filter(record => record.patternKind !== "source_compilation") };
  const componentReceipts = input.artifacts.patterns.filter(record => record.patternKind === "source_compilation"
    && jsonRecord(record.patternJson).schema !== "scce.source_language_compilation_receipt.v1");
  const artifacts = Object.fromEntries(Object.entries(sourceArtifacts).map(([kind, rows]) => [kind,
    { count: rows.length, identityDigest: canonicalDigestHex(rows.map(row => row.id).sort(), input.hasher) }]));
  const common = { schema: "scce.source_language_compilation.v1", compilerRecipe: LANGUAGE_TRAINING_BATCH_RECIPE_ID, ...input.owner,
    profileId: input.profileId, sourceSystem: corpusSourceAlias(input.sourceSystem), parentStreamId: input.streamId,
    sourceTextHash: input.hasher.digestHex(input.text), sourceUtf16Length: input.text.length, options: input.options, artifacts, chunkCount: input.chunks.length };
  const compilationId = canonicalDigestHex(common, input.hasher);
  let offset = 0;
  const chunks = input.chunks.map((text, index) => { const start = offset; offset += text.length; return { index, start, end: offset, textHash: input.hasher.digestHex(text) }; });
  return { models: input.models.map((record, index) => ({ ...record, modelJson: toJsonValue({ ...jsonRecord(record.modelJson),
    sourceCompilation: { ...common, compilationId, chunk: chunks[index], modelDigest: canonicalDigestHex(modelMaterial(record), input.hasher) } }) })),
    units: input.artifacts.units.map(record => ({ ...record, metadata: toJsonValue({ ...jsonRecord(record.metadata), sourceCompilationId: compilationId }) })),
    patterns: [...sourceArtifacts.patterns.map(record => ({ ...record, patternJson: toJsonValue({ ...jsonRecord(record.patternJson), sourceCompilationId: compilationId }) })), ...componentReceipts,
      { id: `source.language.compilation.${compilationId}`, profileId: input.profileId, patternKind: "source_compilation", support: 1, entropy: 0,
        evidenceIds: [], updatedAt: input.models[0]!.updatedAt, patternJson: toJsonValue({ schema: "scce.source_language_compilation_receipt.v1", sourceSystem: common.sourceSystem,
          compilation: { ...common, compilationId, modelInventory: input.models.map((record, index) => ({ id: record.id, streamId: record.streamId,
            chunk: chunks[index], modelDigest: canonicalDigestHex(modelMaterial(record), input.hasher) })) } }) }],
    semanticFrames: input.artifacts.semanticFrames.map(record => ({ ...record, frameJson: toJsonValue({ ...jsonRecord(record.frameJson), sourceCompilationId: compilationId }) })) };

}

export function validateSourceLanguageCompilation(input: {
  owner: SourceCompilationOwner; profileId: string; sourceSystem: string; models: readonly NgramModelRecord[]; hasher: Hasher;
}): { models: number; compilationId: string; artifacts: JsonValue; options: JsonValue } | undefined {
  if (!input.models.length) return undefined;
  const fail = (): never => { throw new Error(`canonical language compilation for ${input.owner.sourceVersionId} is incomplete or changed; recompile through its source producer`); };
  const expectedStream = sourceLanguageTrainingStreamId({ ...input.owner, sourceSystem: input.sourceSystem, hasher: input.hasher });
  let headerDigest: string | undefined;
  let offset = 0;
  const rows = input.models.map(record => ({ record, receipt: jsonRecord(jsonRecord(record.modelJson).sourceCompilation) }));
  rows.sort((a, b) => Number(jsonRecord(a.receipt.chunk).index) - Number(jsonRecord(b.receipt.chunk).index));
  for (const [index, { record, receipt }] of rows.entries()) {
    const { chunk: rawChunk, modelDigest, compilationId, ...common } = receipt;
    const chunk = jsonRecord(rawChunk);
    const model = jsonRecord(record.modelJson);
    const options = jsonRecord(receipt.options);
    if (receipt.schema !== "scce.source_language_compilation.v1" || receipt.compilerRecipe !== LANGUAGE_TRAINING_BATCH_RECIPE_ID
      || receipt.sourceId !== input.owner.sourceId || receipt.sourceVersionId !== input.owner.sourceVersionId || receipt.contentHash !== input.owner.contentHash
      || receipt.profileId !== input.profileId || receipt.sourceSystem !== corpusSourceAlias(input.sourceSystem) || receipt.parentStreamId !== expectedStream
      || receipt.chunkCount !== rows.length || chunk.index !== index || chunk.start !== offset || typeof chunk.end !== "number" || chunk.end < offset
      || typeof chunk.textHash !== "string" || typeof receipt.sourceTextHash !== "string" || typeof receipt.sourceUtf16Length !== "number"
      || typeof options.maxOrder !== "number" || typeof options.maxCountersPerOrder !== "number" || typeof options.vocabularyLimit !== "number"
      || typeof options.languageOnly !== "boolean" || typeof options.retainNgramObservations !== "boolean" || !Object.keys(jsonRecord(receipt.artifacts)).length
      || record.maxOrder !== options.maxOrder || model.sourceVersionId !== input.owner.sourceVersionId || model.profileId !== input.profileId
      || modelDigest !== canonicalDigestHex(modelMaterial(record), input.hasher)) fail();
    const streamId = rows.length === 1 ? expectedStream : `${expectedStream}#training-chunk-${String(index + 1).padStart(6, "0")}`;
    if (record.streamId !== streamId || record.id !== canonicalNgramModelId({ streamId, profileId: input.profileId, sourceVersionId: input.owner.sourceVersionId,
      sourceSystem: input.sourceSystem, languageHint: record.languageHint, order: record.maxOrder, hasher: input.hasher })) fail();
    const digest = canonicalDigestHex(common, input.hasher);
    if (compilationId !== digest) fail();
    if (headerDigest !== undefined && headerDigest !== digest) fail();
    headerDigest = digest;
    offset = chunk.end as number;
    if (index === rows.length - 1 && offset !== receipt.sourceUtf16Length) fail();
  }
  return { models: rows.length, compilationId: String(rows[0]!.receipt.compilationId), artifacts: rows[0]!.receipt.artifacts!, options: rows[0]!.receipt.options! };
}

export function sourceCompilationChunkCount(receiptValue: JsonValue, sourceByteLength: number): number {
  const receipt = jsonRecord(receiptValue);
  const count = receipt.chunkCount;
  const length = receipt.sourceUtf16Length;
  if (receipt.schema !== "scce.source_language_compilation.v1" || !Number.isSafeInteger(count) || !Number.isSafeInteger(length)
    || Number(count) < 1 || Number(length) < 0 || Number(length) > sourceByteLength || Number(count) > Math.max(1, Math.ceil(Number(length) / LANGUAGE_TRAINING_MIN_CHUNK_UTF16_LENGTH))) {
    throw new Error("canonical source compilation has an invalid bounded chunk inventory");
  }
  return count as number;
}

export async function validateSourceCompilationArtifactInventory(input: {
  compilation: { compilationId: string; artifacts: JsonValue }; profileId: string; hasher: Hasher;
  list: (query: { compilationId: string; profileId: string; family: "units" | "patterns" | "semanticFrames"; afterId?: string; limit: number }) => Promise<string[]>;
}): Promise<void> {
  const summary = jsonRecord(input.compilation.artifacts);
  for (const family of ["units", "patterns", "semanticFrames"] as const) {
    const expected = jsonRecord(summary[family]);
    if (!Number.isSafeInteger(expected.count) || Number(expected.count) < 0 || typeof expected.identityDigest !== "string") throw new Error("canonical source compilation has an invalid artifact inventory");
    const ids: string[] = [];
    let afterId: string | undefined;
    while (true) {
      const page = await input.list({ compilationId: input.compilation.compilationId, profileId: input.profileId, family, afterId, limit: 256 });
      if (page.some((id, index) => id <= (index ? page[index - 1]! : afterId ?? ""))) throw new Error("canonical artifact inventory page is not ordered");
      ids.push(...page);
      if (ids.length > Number(expected.count)) throw new Error("canonical source compilation artifact inventory changed");
      if (page.length < 256) break;
      afterId = page[page.length - 1];
    }
    if (ids.length !== expected.count || canonicalDigestHex(ids, input.hasher) !== expected.identityDigest) throw new Error("canonical source compilation artifact inventory is incomplete or changed");
  }
}

export function validateSourceCompilationReceipt(receiptValue: JsonValue, models: readonly NgramModelRecord[], hasher: Hasher): void {
  const receipt = jsonRecord(receiptValue);
  const { compilationId, modelInventory, ...common } = receipt;
  if (compilationId !== canonicalDigestHex(common, hasher) || !Array.isArray(modelInventory)) throw new Error("canonical source compilation receipt changed");
  if (modelInventory.length !== models.length) throw new Error("canonical source compilation model inventory is incomplete or changed");
  const actual = models.map(record => ({ id: record.id, streamId: record.streamId, chunk: jsonRecord(jsonRecord(record.modelJson).sourceCompilation).chunk,
    modelDigest: canonicalDigestHex(modelMaterial(record), hasher) })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const expected = [...modelInventory].sort((left, right) => String(jsonRecord(left).id) < String(jsonRecord(right).id) ? -1 : String(jsonRecord(left).id) > String(jsonRecord(right).id) ? 1 : 0);
  if (canonicalDigestHex(actual, hasher) !== canonicalDigestHex(expected, hasher)) throw new Error("canonical source compilation model inventory is incomplete or changed");
}
