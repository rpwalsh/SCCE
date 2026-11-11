// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { constructionSourceExampleStorageJson as exactJson } from "./construction-source-example-storage.js";
import {
  persistedKneserNey,
  trainKneserNey,
  type KneserNeyModel
} from "./kneser-ney.js";
import type { NgramModelRecord } from "./storage.js";
import type { Hasher, JsonValue } from "./types.js";

export const KNESER_NEY_TRAINING_REPLAY_SCHEMA = "scce.kneser_ney_training_replay.v1" as const;

/**
 * Lossless producer tape for one Kneser-Ney model.
 *
 * `vocabulary` is the complete input-symbol dictionary, not the model's
 * frequency-bounded prediction vocabulary. `symbolIds` therefore restores the
 * exact ordered training sequence, including symbols that the trainer maps to
 * `<unk>`. The expected digest makes replay fail closed if trainer behavior or
 * any sufficient statistic changes.
 */
export interface KneserNeyTrainingReplayRecipe {
  schema: typeof KNESER_NEY_TRAINING_REPLAY_SCHEMA;
  vocabulary: string[];
  symbolIds: number[];
  order: number;
  discount: number;
  vocabularyLimit: number;
  expectedPersistedModelDigest: string;
  digest: string;
}

const replayByModelJson = new WeakMap<object, Readonly<KneserNeyTrainingReplayRecipe>>();
const fail = (): never => { throw new Error("invalid Kneser-Ney training replay recipe"); };

/** Capture state already owned by the producer; this performs no training. */
export function captureKneserNeyTrainingReplay(input: {
  symbols: readonly string[];
  model: KneserNeyModel;
  vocabularyLimit: number;
  hasher: Hasher;
}): Readonly<KneserNeyTrainingReplayRecipe> {
  if (!Number.isSafeInteger(input.vocabularyLimit) || input.vocabularyLimit < 1) return fail();
  const vocabulary = [...new Set(input.symbols)].sort(compareText);
  const ordinals = new Map(vocabulary.map((symbol, index) => [symbol, index] as const));
  const material = {
    schema: KNESER_NEY_TRAINING_REPLAY_SCHEMA,
    vocabulary,
    symbolIds: input.symbols.map(symbol => ordinals.get(symbol)!),
    order: input.model.order,
    discount: input.model.discount,
    vocabularyLimit: input.vocabularyLimit,
    expectedPersistedModelDigest: persistedModelDigest(input.model, input.hasher)
  };
  const recipe = { ...material, digest: input.hasher.digestHex(exactJson(material)) };
  return Object.freeze(validateKneserNeyTrainingReplay(recipe, input.hasher));
}

/** Validate an untrusted physical recipe without expanding its model. */
export function validateKneserNeyTrainingReplay(
  value: unknown,
  hasher: Hasher
): KneserNeyTrainingReplayRecipe {
  const row = record(value);
  if (Object.keys(row).sort().join(",") !== "digest,discount,expectedPersistedModelDigest,order,schema,symbolIds,vocabulary,vocabularyLimit"
    || row.schema !== KNESER_NEY_TRAINING_REPLAY_SCHEMA
    || !Number.isSafeInteger(row.order) || Number(row.order) < 1 || Number(row.order) > 6
    || typeof row.discount !== "number" || !Number.isFinite(row.discount) || row.discount < 0 || row.discount > 1
    || !Number.isSafeInteger(row.vocabularyLimit) || Number(row.vocabularyLimit) < 1
    || typeof row.expectedPersistedModelDigest !== "string" || !digest(row.expectedPersistedModelDigest)
    || typeof row.digest !== "string" || !digest(row.digest)
    || !Array.isArray(row.vocabulary) || !row.vocabulary.every(symbol => typeof symbol === "string")
    || !Array.isArray(row.symbolIds)) return fail();
  const vocabulary = row.vocabulary as string[];
  if (vocabulary.some((symbol, index) => index > 0 && compareText(vocabulary[index - 1]!, symbol) >= 0)) return fail();
  if (!(row.symbolIds as unknown[]).every(id => Number.isSafeInteger(id) && Number(id) >= 0 && Number(id) < vocabulary.length)) return fail();
  if (vocabulary.length === 0 && row.symbolIds.length !== 0) return fail();
  const { digest: observed, ...material } = row;
  if (hasher.digestHex(exactJson(material)) !== observed) return fail();
  return JSON.parse(exactJson(row)) as KneserNeyTrainingReplayRecipe;
}

/** Re-run the frozen producer and require byte-identical sufficient statistics. */
export function replayKneserNeyTraining(input: {
  recipe: KneserNeyTrainingReplayRecipe;
  hasher: Hasher;
}): KneserNeyModel {
  const recipe = validateKneserNeyTrainingReplay(input.recipe, input.hasher);
  const symbols = recipe.symbolIds.map(id => recipe.vocabulary[id]!);
  const model = trainKneserNey(symbols, {
    order: recipe.order,
    discount: recipe.discount,
    vocabularyLimit: recipe.vocabularyLimit
  });
  if (persistedModelDigest(model, input.hasher) !== recipe.expectedPersistedModelDigest) {
    throw new Error("Kneser-Ney training replay changed persisted sufficient statistics");
  }
  return model;
}

/** Keep replay state outside logical JSON while a compiled record travels to its physical store. */
export function bindNgramModelTrainingReplay(
  record: NgramModelRecord,
  recipe: Readonly<KneserNeyTrainingReplayRecipe>
): void {
  const owner = modelJsonOwner(record.modelJson);
  if (owner) replayByModelJson.set(owner, recipe);
}

/** Physical adapters use this to replace the expanded model with its verified producer tape. */
export function exportNgramModelTrainingReplay(
  record: Pick<NgramModelRecord, "modelJson">
): Readonly<KneserNeyTrainingReplayRecipe> | undefined {
  const owner = modelJsonOwner(record.modelJson);
  return owner ? replayByModelJson.get(owner) : undefined;
}

/** Preserve ephemeral state across metadata stamping that clones model JSON. */
export function transferNgramModelTrainingReplay(
  source: Pick<NgramModelRecord, "modelJson">,
  target: Pick<NgramModelRecord, "modelJson">
): void {
  const recipe = exportNgramModelTrainingReplay(source);
  if (recipe) bindNgramModelTrainingReplay(target as NgramModelRecord, recipe);
}

export function persistedKneserNeyDigest(model: KneserNeyModel, hasher: Hasher): string {
  return persistedModelDigest(model, hasher);
}

function persistedModelDigest(model: KneserNeyModel, hasher: Hasher): string {
  return hasher.digestHex(exactJson(persistedKneserNey(model)));
}

function modelJsonOwner(value: JsonValue): object | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fail();
}

function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
