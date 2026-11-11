// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  createHasher,
  materializeKneserNey,
  persistedKneserNey,
  persistedKneserNeyDigest,
  replayKneserNeyTraining,
  validateKneserNeyTrainingReplay,
  type JsonValue,
  type KneserNeyTrainingReplayRecipe
} from "@scce/kernel";
import {
  DECODED_JSON_BYTE_LEDGER_KEY,
  DECODED_JSON_BYTE_LEDGER_SCHEMA,
  decodedJsonByteLengths
} from "./durable-artifact-storage.js";

export const NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA = "scce.ngram_model_training_replay.storage.v2" as const;
const LEGACY_RESERVED_NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA = "scce.ngram_model_training_replay.storage.v1";

const hasher = createHasher();
const fail = (): never => { throw new Error("invalid stored Kneser-Ney training replay"); };

interface StoredReplayModel {
  schema: typeof NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA;
  totalUnigramCount: number;
  /** Producer symbols not present in the source dictionary (for example sentence sentinels). */
  projectionSymbols: string[];
  /** [replay-vocabulary id, count, ...] for SQL-side continuation aggregation. */
  continuationCountPairs: number[];
  /**
   * The smaller side of the source dictionary's retained/excluded split.
   * SQL uses this with the replay tape to reproduce vocabulary clipping and
   * derive exact order-two counts without persisting those counts again.
   */
  vocabularyPartition: VocabularyPartition;
  introducedLedger: boolean;
  replay: KneserNeyTrainingReplayRecipe;
}

interface VocabularyPartition {
  listed: "excluded" | "retained";
  symbolIds: number[];
}

/** Replace only the expanded sufficient-statistics object; SQL query roots stay inline. */
export function encodeNgramModelTrainingReplay(
  value: JsonValue,
  recipe: Readonly<KneserNeyTrainingReplayRecipe> | undefined
): JsonValue {
  if (!recipe) {
    const schema = recordOrUndefined(recordOrUndefined(value)?.model)?.schema;
    // Storage markers are adapter-owned physical forms. Imported logical JSON
    // may not impersonate one and bypass the replay/digest validation below.
    if (schema === NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA
      || schema === LEGACY_RESERVED_NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA) return fail();
    return value;
  }
  const root = record(value);
  const logicalModel = materializeKneserNey(root.model as JsonValue | undefined);
  if (!logicalModel) return fail();
  const validated = validateKneserNeyTrainingReplay(recipe, hasher);
  if (persistedKneserNeyDigest(logicalModel, hasher) !== validated.expectedPersistedModelDigest) return fail();
  const introducedLedger = !Object.hasOwn(root, DECODED_JSON_BYTE_LEDGER_KEY);
  const sourceSymbols = new Set(validated.vocabulary);
  const projectionSymbols = Object.keys(logicalModel.continuationCounts)
    .filter(symbol => !sourceSymbols.has(symbol))
    .sort(compareText);
  const symbolIds = new Map([...validated.vocabulary, ...projectionSymbols].map((symbol, index) => [symbol, index] as const));
  const stored: StoredReplayModel = {
    schema: NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA,
    totalUnigramCount: logicalModel.totalUnigramCount,
    projectionSymbols,
    continuationCountPairs: Object.entries(logicalModel.continuationCounts)
      .flatMap(([symbol, count]) => [symbolIds.get(symbol)!, count]),
    vocabularyPartition: vocabularyPartition(logicalModel.vocabulary, validated.vocabulary),
    introducedLedger,
    replay: validated
  };
  return {
    ...root,
    ...(introducedLedger ? { [DECODED_JSON_BYTE_LEDGER_KEY]: {
      schema: DECODED_JSON_BYTE_LEDGER_SCHEMA,
      ...decodedJsonByteLengths(root)
    } } : {}),
    model: stored
  } as unknown as JsonValue;
}

/** Restore the exact public model before any outer metadata codec verifies the logical record. */
export function decodeNgramModelTrainingReplay(value: JsonValue): JsonValue {
  const root = recordOrUndefined(value);
  const marker = recordOrUndefined(root?.model);
  if (!root || !marker || marker.schema !== NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA) return value;
  const replay = storedNgramModelTrainingReplay(value);
  if (!replay) return fail();
  const model = replayKneserNeyTraining({ recipe: replay, hasher });
  const projectionSymbols = marker.projectionSymbols as string[];
  const continuationCounts = countPairs(marker.continuationCountPairs, replay.vocabulary, projectionSymbols);
  if (model.totalUnigramCount !== marker.totalUnigramCount
    || !sameCounts(model.continuationCounts, continuationCounts)
    || !sameVocabularyPartition(
      vocabularyPartition(model.vocabulary, replay.vocabulary),
      marker.vocabularyPartition,
      replay.vocabulary.length
    )) return fail();
  const logical: Record<string, unknown> = { ...root, model: persistedKneserNey(model) };
  if (marker.introducedLedger) {
    const ledger = recordOrUndefined(logical[DECODED_JSON_BYTE_LEDGER_KEY]);
    delete logical[DECODED_JSON_BYTE_LEDGER_KEY];
    const sizes = decodedJsonByteLengths(logical);
    if (ledger?.schema !== DECODED_JSON_BYTE_LEDGER_SCHEMA
      || ledger.decodedJsonBytes !== sizes.decodedJsonBytes
      || ledger.decodedJsonbBytes !== sizes.decodedJsonbBytes) return fail();
  }
  return logical as unknown as JsonValue;
}

/** Return validated producer state so a cold record can retain it across a later rewrite. */
export function storedNgramModelTrainingReplay(
  value: JsonValue
): Readonly<KneserNeyTrainingReplayRecipe> | undefined {
  const root = recordOrUndefined(value);
  const marker = recordOrUndefined(root?.model);
  if (!root || !marker || marker.schema !== NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA) return undefined;
  if (Object.keys(marker).sort().join(",") !== "continuationCountPairs,introducedLedger,projectionSymbols,replay,schema,totalUnigramCount,vocabularyPartition"
    || typeof marker.introducedLedger !== "boolean"
    || typeof marker.totalUnigramCount !== "number" || !Number.isSafeInteger(marker.totalUnigramCount) || marker.totalUnigramCount < 0) return fail();
  const replay = validateKneserNeyTrainingReplay(marker.replay, hasher);
  if (!Array.isArray(marker.projectionSymbols) || !marker.projectionSymbols.every(symbol => typeof symbol === "string")
    || marker.projectionSymbols.some((symbol, index, symbols) => replay.vocabulary.includes(symbol)
      || index > 0 && compareText(symbols[index - 1]!, symbol) >= 0)) return fail();
  countPairs(marker.continuationCountPairs, replay.vocabulary, marker.projectionSymbols as string[]);
  validateVocabularyPartition(marker.vocabularyPartition, replay.vocabulary.length);
  return replay;
}

function record(value: unknown): Record<string, unknown> {
  return recordOrUndefined(value) ?? fail();
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameCounts(left: Readonly<Record<string, number>>, right: unknown): boolean {
  const row = recordOrUndefined(right);
  if (!row) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(row).length && keys.every(key => row[key] === left[key]);
}

function countPairs(value: unknown, vocabulary: readonly string[], projectionSymbols: readonly string[]): Record<string, number> {
  if (!Array.isArray(value) || value.length % 2 !== 0) return fail();
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (let index = 0; index < value.length; index += 2) {
    const symbol = projectedSymbol(value[index], vocabulary, projectionSymbols), count = projectedCount(value[index + 1]);
    if (Object.hasOwn(result, symbol)) return fail();
    result[symbol] = count;
  }
  return result;
}

function projectedSymbol(value: unknown, vocabulary: readonly string[], projectionSymbols: readonly string[]): string {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= vocabulary.length + projectionSymbols.length) return fail();
  return Number(value) < vocabulary.length ? vocabulary[Number(value)]! : projectionSymbols[Number(value) - vocabulary.length]!;
}

function projectedCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail();
  return Number(value);
}

function vocabularyPartition(
  modelVocabulary: readonly string[],
  sourceVocabulary: readonly string[]
): VocabularyPartition {
  const retainedSymbols = new Set(modelVocabulary);
  const retained: number[] = [], excluded: number[] = [];
  sourceVocabulary.forEach((symbol, id) => (retainedSymbols.has(symbol) ? retained : excluded).push(id));
  return retained.length < excluded.length
    ? { listed: "retained", symbolIds: retained }
    : { listed: "excluded", symbolIds: excluded };
}

function validateVocabularyPartition(value: unknown, vocabularySize: number): VocabularyPartition {
  const row = record(value);
  if (Object.keys(row).sort().join(",") !== "listed,symbolIds"
    || row.listed !== "excluded" && row.listed !== "retained"
    || !Array.isArray(row.symbolIds)
    || !(row.symbolIds as unknown[]).every((id, index, ids) => Number.isSafeInteger(id)
      && Number(id) >= 0 && Number(id) < vocabularySize
      && (index === 0 || Number(ids[index - 1]) < Number(id)))) return fail();
  return { listed: row.listed, symbolIds: [...row.symbolIds] as number[] };
}

function sameVocabularyPartition(expected: VocabularyPartition, observed: unknown, vocabularySize: number): boolean {
  const actual = validateVocabularyPartition(observed, vocabularySize);
  return actual.listed === expected.listed
    && actual.symbolIds.length === expected.symbolIds.length
    && actual.symbolIds.every((id, index) => id === expected.symbolIds[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
