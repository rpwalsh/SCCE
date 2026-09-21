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
async function readLanguageBigrams(
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

  // A model contains counts for every order. Extract and aggregate only order-two keys in Postgres so a full corpus
  // does not load every model/count object into Node. This is the same symbol-level count envelope emitted by the
  // trainer (`model_json.model.counts`), and the LIMIT bounds the result handed to the quadratic aligner.
  const modelRows = await storage.query<NgramObservationRow>(
    `SELECT split_part(gram.key, chr(1), 1) AS previous,
            split_part(gram.key, chr(1), 2) AS next,
            SUM(gram.value::double precision) AS total
       FROM ${storage.table("ngram_models")} model
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(model.model_json->'model'->'counts', '{}'::jsonb)) gram
      WHERE model.profile_id = ANY($1::text[])
        AND cardinality(string_to_array(gram.key, chr(1))) = 2
      GROUP BY split_part(gram.key, chr(1), 1), split_part(gram.key, chr(1), 2)
      ORDER BY SUM(gram.value::double precision) DESC
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
