// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Brick 2b: feed real ingested data into the structural aligner. Read each language's bigram co-occurrence and
// its closed class -- both already produced by ordinary ingest -- run the unsupervised structural alignment,
// and store the result as translation seeds. No parallel corpus, no dictionary; the only inputs are two
// languages' monolingual statistics. Runs off the turn path, at rest, over a brain that already holds >=2
// languages.
import {
  induceStructuralAlignment,
  type CooccurrenceBigram,
  type TranslationSeed
} from "@scce/kernel";
import { NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA } from "./ngram-model-training-replay-storage.js";

/** The minimum storage surface this needs; the real PostgreSQL adapter satisfies it, and tests fake it. */
export interface CrossLingualTranslationStorage {
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  table(name: string): string;
  languageIdentities: {
    listIdentities(): Promise<Array<{ id: string; script: string; closedClass: Array<{ word: string; documentShare: number }>; families: Array<{ family: string }> }>>;
  };
  translationSeeds: {
    putSeeds(input: { sourceLanguage: string; targetLanguage: string; seeds: readonly TranslationSeed[]; observedAt: number }): Promise<void>;
  };
}

interface NgramObservationRow {
  previous: string;
  next: string;
  total: string | number;
}

interface ProfileRow {
  id: string;
}

/**
 * Read the compiled model signal for one learned language identity. Models are the durable equivalent of the raw
 * observation rows: the trainer emits the same order-two counts into each model, while optimized training can omit
 * the much larger observation table. The raw table remains a compatibility fallback for older brains.
 */
export async function readLanguageBigrams(
  storage: CrossLingualTranslationStorage,
  languageId: string,
  maxBigrams: number
): Promise<CooccurrenceBigram[]> {
  const profiles = await storage.query<ProfileRow>(
    `SELECT id FROM ${storage.table("language_profiles")} WHERE language_id = $1 ORDER BY id`,
    [languageId]
  );
  const profileIds = [...new Set(profiles.map(row => row.id).filter(Boolean))];
  if (!profileIds.length) return [];

  // Replay-backed rows derive exact order-two counts from their source-symbol
  // tape and compact vocabulary partition. Legacy expanded rows expose the
  // same facts through counts. PostgreSQL aggregates both without hydrating
  // full Kneser-Ney models or retaining a corpus-sized JS map.
  const modelRows = await storage.query<NgramObservationRow>(
    `WITH population AS MATERIALIZED (
       SELECT model.id,model.model_json->'model' AS stored_model
       FROM ${storage.table("ngram_models")} model
       WHERE model.profile_id = ANY($1::text[])
     ), replay_population AS MATERIALIZED (
       SELECT population.id,population.stored_model,
              (population.stored_model->'replay'->>'order')::int AS model_order,
              jsonb_array_length(population.stored_model->'replay'->'symbolIds') AS symbol_count,
              population.stored_model->'vocabularyPartition'->>'listed' AS partition_listed
       FROM population
       WHERE population.stored_model->>'schema'='${NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA}'
         AND jsonb_typeof(population.stored_model->'replay'->'order')='number'
         AND population.stored_model->'replay'->>'order' ~ '^[1-6]$'
         AND jsonb_typeof(population.stored_model->'replay'->'symbolIds')='array'
         AND jsonb_typeof(population.stored_model->'replay'->'vocabulary')='array'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(population.stored_model->'replay'->'vocabulary') vocabulary_symbol(value)
           WHERE jsonb_typeof(vocabulary_symbol.value)<>'string'
         )
         AND population.stored_model->'vocabularyPartition'->>'listed' IN ('retained','excluded')
         AND jsonb_typeof(population.stored_model->'vocabularyPartition'->'symbolIds')='array'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(population.stored_model->'replay'->'symbolIds') source_id(value)
           WHERE CASE WHEN source_id.value ~ '^(0|[1-9][0-9]*)$'
             THEN source_id.value::numeric >= jsonb_array_length(population.stored_model->'replay'->'vocabulary')
             ELSE TRUE END
         )
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(population.stored_model->'vocabularyPartition'->'symbolIds') partition_id(value)
           WHERE CASE WHEN partition_id.value ~ '^(0|[1-9][0-9]*)$'
             THEN partition_id.value::numeric >= jsonb_array_length(population.stored_model->'replay'->'vocabulary')
             ELSE TRUE END
         )
     ), partition_ids AS MATERIALIZED (
       SELECT DISTINCT replay.id AS model_id,listed.value::int AS symbol_id
       FROM replay_population replay
       CROSS JOIN LATERAL jsonb_array_elements_text(replay.stored_model->'vocabularyPartition'->'symbolIds') listed(value)
     ), padded_replay AS (
       SELECT replay.id AS model_id,prefix.position::bigint AS position,'<s>'::text AS symbol
       FROM replay_population replay
       CROSS JOIN LATERAL generate_series(2-replay.model_order,0) prefix(position)
       WHERE replay.model_order>=2
       UNION ALL
       SELECT replay.id AS model_id,source.ordinality::bigint AS position,
              CASE WHEN (replay.partition_listed='retained')=(partition.symbol_id IS NOT NULL)
                THEN replay.stored_model->'replay'->'vocabulary'->>source.value::int
                ELSE '<unk>' END AS symbol
       FROM replay_population replay
       CROSS JOIN LATERAL jsonb_array_elements_text(replay.stored_model->'replay'->'symbolIds') WITH ORDINALITY source(value,ordinality)
       LEFT JOIN partition_ids partition ON partition.model_id=replay.id AND partition.symbol_id=source.value::int
       WHERE replay.model_order>=2
       UNION ALL
       SELECT replay.id AS model_id,(replay.symbol_count+1)::bigint AS position,'</s>'::text AS symbol
       FROM replay_population replay
       WHERE replay.model_order>=2
     ), replay_grams AS (
       SELECT model_id,LAG(symbol) OVER(PARTITION BY model_id ORDER BY position) AS previous,symbol AS next
       FROM padded_replay
     ), grams AS (
       SELECT legacy.key,legacy.value::double precision AS value
       FROM population
       CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(population.stored_model->'counts')='object'
         THEN population.stored_model->'counts' ELSE '{}'::jsonb END) legacy
       UNION ALL
       SELECT replay.previous||chr(1)||replay.next AS key,COUNT(*)::double precision AS value
       FROM replay_grams replay
       WHERE replay.previous IS NOT NULL
       GROUP BY replay.previous,replay.next
     )
     SELECT split_part(gram.key, chr(1), 1) AS previous,
            split_part(gram.key, chr(1), 2) AS next,
            SUM(gram.value) AS total
       FROM grams gram
      WHERE cardinality(string_to_array(gram.key, chr(1))) = 2
      GROUP BY split_part(gram.key, chr(1), 1), split_part(gram.key, chr(1), 2)
      ORDER BY SUM(gram.value) DESC
      LIMIT $2`,
    [profileIds, Math.max(1, maxBigrams)]
  );
  const compiledBigrams = modelRows
    .filter(row => row.previous && row.next)
    .map(row => ({ previous: row.previous, next: row.next, count: Number(row.total) }))
    .filter(row => Number.isFinite(row.count) && row.count > 0);
  if (compiledBigrams.length) return compiledBigrams;

  // order_n = 2 is the co-occurrence signal; summed over the identity's profiles and taken by weight so the
  // working vocabulary is the language's most-used structure, not its long tail.
  const rows = await storage.query<NgramObservationRow>(
    `SELECT history[1] AS previous, symbol AS next, SUM(count)::bigint AS total
       FROM ${storage.table("ngram_observations")}
      WHERE order_n = 2 AND profile_id = ANY($1::text[]) AND array_length(history, 1) = 1
      GROUP BY history[1], symbol
      ORDER BY SUM(count) DESC
      LIMIT $2`,
    [profileIds, Math.max(1, maxBigrams)]
  );
  return rows
    .filter(row => row.previous && row.next)
    .map(row => ({ previous: row.previous, next: row.next, count: Number(row.total) }))
    .filter(row => Number.isFinite(row.count) && row.count > 0);
}

export function closedClassFor(
  identities: Array<{ id: string; script: string; closedClass: Array<{ word: string; documentShare: number }> }>,
  languageId: string,
  languageScript: string
): Array<{ word: string; documentShare: number }> {
  const identity = identities.find(row => row.id === languageId && row.script === languageScript);
  return identity?.closedClass ?? [];
}

export interface CrossLingualSeedCompilation {
  sourceLanguage: string;
  targetLanguage: string;
  seedCount: number;
  aligned: number;
  skippedReason?: string;
}

/**
 * Compile and store structural translation seeds between two ingested languages. Returns what it did rather
 * than throwing on an empty language, so a brain that only holds one language is a no-op, not a failure.
 */
export async function compileCrossLingualTranslationSeeds(
  storage: CrossLingualTranslationStorage,
  input: {
    sourceLanguage: string;
    targetLanguage: string;
    sourceScript: string;
    targetScript: string;
    maxBigrams?: number;
    minSeedScore?: number;
    observedAt: number;
  }
): Promise<CrossLingualSeedCompilation> {
  const maxBigrams = input.maxBigrams ?? 20000;
  const minSeedScore = input.minSeedScore ?? 0.2;
  const identities = await storage.languageIdentities.listIdentities();
  const sourceIdentity = identities.find(identity => identity.id === input.sourceLanguage);
  const targetIdentity = identities.find(identity => identity.id === input.targetLanguage);
  if (!sourceIdentity || !targetIdentity) {
    const missing = [!sourceIdentity ? `source identity ${input.sourceLanguage}` : "", !targetIdentity ? `target identity ${input.targetLanguage}` : ""].filter(Boolean).join(" and ");
    return { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, seedCount: 0, aligned: 0, skippedReason: `no learned ${missing}; pass stable language identity ids` };
  }
  if (sourceIdentity.script !== input.sourceScript || targetIdentity.script !== input.targetScript) {
    return { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, seedCount: 0, aligned: 0, skippedReason: "language identity/script mismatch; refusing an unverified profile binding" };
  }
  const [sourceBigrams, targetBigrams] = await Promise.all([
    readLanguageBigrams(storage, sourceIdentity.id, maxBigrams),
    readLanguageBigrams(storage, targetIdentity.id, maxBigrams)
  ]);
  if (!sourceBigrams.length || !targetBigrams.length) {
    return { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, seedCount: 0, aligned: 0, skippedReason: "a language has no bigram structure yet" };
  }

  const pairs = induceStructuralAlignment({
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    sourceBigrams,
    targetBigrams,
    sourceClosedClass: closedClassFor(identities, sourceIdentity.id, input.sourceScript),
    targetClosedClass: closedClassFor(identities, targetIdentity.id, input.targetScript)
  });

  // Structural alignment is shared-context correspondence by construction; the seed carries no invented
  // evidence because it is a corpus-wide statistical correspondence, not a span-level observation.
  const seeds: TranslationSeed[] = pairs
    .filter(pair => pair.score >= minSeedScore)
    .map(pair => ({ sourceSymbol: pair.sourceSymbol, targetSymbol: pair.targetSymbol, score: pair.score, basis: "shared_context", evidenceIds: [] }));

  if (seeds.length) {
    await storage.translationSeeds.putSeeds({
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      seeds,
      observedAt: input.observedAt
    });
  }
  return { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, seedCount: seeds.length, aligned: pairs.length };
}
