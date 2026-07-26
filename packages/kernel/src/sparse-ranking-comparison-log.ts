import { createFtrlProximalRanker, type FtrlHyperparameters, type SparseVector } from "./sparse-ranking.js";
import type { PairwiseLabelSource } from "./sparse-ranking-labels.js";
import type { InformationLabel } from "./types.js";

/**
 * One durable, replayable record of a real pairwise comparison decided by
 * a turn's proof/certification outcome (Part A finding 9, stage 3/6). This
 * is deliberately a separate append-only log from the FTRL model's own
 * online `coordinates` state: the online state only remembers the *current
 * weights*, which cannot be un-trained on any one example or replayed
 * against a temporal holdout. Without this log, "held-out evaluation"
 * would have nothing real to hold out -- it would have to fabricate a
 * pass/fail signal instead of measuring one.
 */
export interface SparseRankingComparisonExample {
  id: string;
  taskClass: string;
  featureSchemaId: string;
  recordedAt: number;
  /** The full candidate set as shadow-ranked at decision time (not just the one pair used for the online update), so list-wise metrics (Recall@k, NDCG@k) can be computed later. */
  candidates: SparseVector[];
  /** Index into `candidates` of the one the proof/certification outcome preferred. */
  preferredIndex: number;
  weight: number;
  source: PairwiseLabelSource;
  informationLabel: InformationLabel;
}

export interface SparseRankingComparisonLogStore {
  append(example: SparseRankingComparisonExample): Promise<void>;
  /** Ascending by recordedAt, bounded by limit (most recent `limit` examples if the underlying set is larger). */
  listRecent(input: { taskClass: string; featureSchemaId: string; limit: number }): Promise<SparseRankingComparisonExample[]>;
}

export interface FtrlHeldOutEvaluation {
  taskClass: string;
  featureSchemaId: string;
  trainingExampleCount: number;
  heldOutExampleCount: number;
  /** k -> average Recall@k over the held-out set. */
  recallAtK: Record<number, number>;
  /** k -> average NDCG@k (binary relevance, exactly one relevant candidate per example) over the held-out set. */
  ndcgAtK: Record<number, number>;
  /** Fraction of (preferred, other) candidate pairs across the held-out set where the trained model scored the preferred candidate higher. Not computed from proof-completion telemetry -- that is a separate, not-yet-wired production signal (see plan item 32's notes). */
  pairwiseAccuracy: number;
}

/**
 * Held-out evaluation gate (Part A finding 9, stage 6): trains a fresh
 * FTRL ranker only on the temporally-earlier portion of `examples`,
 * evaluates Recall@k/NDCG@k/pairwise accuracy against the temporally-
 * later held-out portion using each held-out example's *original*
 * candidate set (not resampled or fabricated), and returns undefined
 * when there isn't enough real data on either side to produce a
 * meaningful number -- this never manufactures a pass from an empty or
 * near-empty set.
 */
export function evaluateFtrlHeldOut(input: {
  examples: readonly SparseRankingComparisonExample[];
  modelId: string;
  featureSchemaId: string;
  hyperparameters?: Partial<FtrlHyperparameters>;
  holdoutFraction: number;
  kValues?: readonly number[];
}): FtrlHeldOutEvaluation | undefined {
  if (input.holdoutFraction <= 0 || input.holdoutFraction >= 1) {
    throw new Error("holdoutFraction must be strictly between 0 and 1");
  }
  const ordered = [...input.examples].sort((left, right) => left.recordedAt - right.recordedAt);
  const splitIndex = Math.floor(ordered.length * (1 - input.holdoutFraction));
  const training = ordered.slice(0, splitIndex);
  const heldOut = ordered.slice(splitIndex);
  if (!training.length || !heldOut.length) return undefined;

  const ranker = createFtrlProximalRanker({
    modelId: input.modelId,
    featureSchemaId: input.featureSchemaId,
    hyperparameters: input.hyperparameters
  });
  for (const example of training) {
    const preferred = example.candidates[example.preferredIndex];
    if (!preferred) continue;
    for (let index = 0; index < example.candidates.length; index++) {
      if (index === example.preferredIndex) continue;
      const rejected = example.candidates[index]!;
      ranker.updatePair({ preferred, rejected, weight: example.weight / Math.max(1, example.candidates.length - 1) });
    }
  }

  const kValues = input.kValues ?? [1, 3, 5];
  const recallHits: Record<number, number> = {};
  const ndcgSums: Record<number, number> = {};
  for (const k of kValues) {
    recallHits[k] = 0;
    ndcgSums[k] = 0;
  }
  let pairwiseCorrect = 0;
  let pairwiseTotal = 0;
  let usableHeldOut = 0;

  for (const example of heldOut) {
    const preferredVector = example.candidates[example.preferredIndex];
    if (!preferredVector || example.candidates.length < 2) continue;
    usableHeldOut += 1;
    const scored = example.candidates.map((vector, index) => ({ index, score: ranker.score(vector).rawScore }));
    const rankOfPreferred = [...scored]
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .findIndex(entry => entry.index === example.preferredIndex);
    for (const k of kValues) {
      if (rankOfPreferred < k) {
        recallHits[k]! += 1;
        ndcgSums[k]! += 1 / Math.log2(rankOfPreferred + 2);
      }
    }
    const preferredScore = scored[example.preferredIndex]!.score;
    for (let index = 0; index < example.candidates.length; index++) {
      if (index === example.preferredIndex) continue;
      pairwiseTotal += 1;
      if (preferredScore > scored[index]!.score) pairwiseCorrect += 1;
    }
  }
  if (!usableHeldOut) return undefined;

  const recallAtK: Record<number, number> = {};
  const ndcgAtK: Record<number, number> = {};
  for (const k of kValues) {
    recallAtK[k] = recallHits[k]! / usableHeldOut;
    ndcgAtK[k] = ndcgSums[k]! / usableHeldOut;
  }

  return {
    taskClass: training[0]!.taskClass,
    featureSchemaId: input.featureSchemaId,
    trainingExampleCount: training.length,
    heldOutExampleCount: usableHeldOut,
    recallAtK,
    ndcgAtK,
    pairwiseAccuracy: pairwiseTotal > 0 ? pairwiseCorrect / pairwiseTotal : 0
  };
}
