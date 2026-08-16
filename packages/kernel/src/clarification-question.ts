/**
 * Plan item 144. Expected-information-gain clarification question
 * generation with the smallest-graph-separator selection rule.
 *
 * Model: a set of competing hypotheses, each a real weighted alternative
 * interpretation, and each associated with the set of candidate
 * "distinguishing facts" it is consistent with being true (a fact not in
 * a hypothesis's set is treated as that hypothesis being consistent with
 * the fact being false -- a real, simple binary consistency model, the
 * same shape a real yes/no clarifying question has). For each candidate
 * fact, this computes the *real* expected information gain a yes/no
 * question about it would produce -- standard Shannon entropy reduction
 * (`H(hypotheses) - E[H(hypotheses | answer)]`), the same real quantity
 * decision-tree question selection (ID3/C4.5) and optimal-search
 * (20-questions) use -- never an ad hoc heuristic score.
 *
 * "Smallest graph separator": a fact's yes/no answer partitions the
 * hypothesis set into two groups (a real graph cut, "which hypotheses
 * survive a yes" vs "which survive a no"). Among facts tied (or within
 * epsilon) on maximum expected information gain, this prefers the one
 * whose smaller partition is smallest -- a minimal, surgical
 * clarification that isolates the fewest hypotheses at a time, rather
 * than an equally-informative but broader question.
 */

export const CLARIFICATION_QUESTION_SCHEMA = "scce.clarification_question.v1" as const;

export interface ClarificationHypothesis {
  id: string;
  /** Real, unnormalized prior weight/probability mass -- never assumed uniform. */
  weight: number;
  /** The candidate facts this hypothesis is consistent with being true. */
  trueFactIds: ReadonlySet<string>;
}

export interface ClarificationCandidate {
  factId: string;
  expectedInformationGainBits: number;
  /** min(|yes-consistent hypotheses|, |no-consistent hypotheses|) -- the real separator size this fact's answer would cut. */
  separatorSize: number;
  yesHypothesisIds: string[];
  noHypothesisIds: string[];
}

export interface ClarificationQuestionResult {
  schema: typeof CLARIFICATION_QUESTION_SCHEMA;
  selected?: ClarificationCandidate;
  /** Every real candidate considered, sorted the same way selection ranks them -- for inspection, not just the winner. */
  candidates: ClarificationCandidate[];
  priorEntropyBits: number;
}

function entropyBits(weights: readonly number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const weight of weights) {
    if (weight <= 0) continue;
    const probability = weight / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

const EPSILON_BITS = 1e-9;

/**
 * Evaluates every candidate fact's real expected information gain and
 * selects the winner by (1) maximum expected information gain, ties
 * broken by (2) smallest real separator size, then (3) factId for full
 * determinism. Returns every candidate with nonzero real information
 * gain (a fact every hypothesis agrees on, or no hypothesis mentions,
 * provides exactly zero gain and is correctly excluded, not merely
 * ranked last) sorted the same way.
 */
export function selectClarificationQuestion(input: {
  hypotheses: readonly ClarificationHypothesis[];
  candidateFactIds: readonly string[];
}): ClarificationQuestionResult {
  // Real validation, not a formality: `entropyBits`'s `weight <= 0` guard
  // silently *drops* a negative weight's contribution to the entropy sum
  // while `total` below still includes it uncorrected -- corrupting every
  // other hypothesis's probability denominator, not just the invalid
  // one's own entry. A NaN weight is worse: `weight <= 0` is false for
  // NaN, so it isn't even dropped, and poisons the entropy calculation
  // with NaN outright. Both must be rejected before any arithmetic runs.
  for (const hypothesis of input.hypotheses) {
    if (!Number.isFinite(hypothesis.weight) || hypothesis.weight < 0) {
      throw new RangeError(`hypothesis ${hypothesis.id} has an invalid weight (${hypothesis.weight}); must be finite and nonnegative`);
    }
  }
  const weights = input.hypotheses.map(hypothesis => hypothesis.weight);
  const priorEntropyBits = entropyBits(weights);

  // Real deduplication: a caller-supplied duplicate factId would
  // otherwise produce two distinct candidate entries for the same real
  // fact, distorting any downstream consumer that counts or indexes
  // candidates by factId.
  const candidateFactIds = [...new Set(input.candidateFactIds)];

  const candidates: ClarificationCandidate[] = [];
  for (const factId of candidateFactIds) {
    const yes = input.hypotheses.filter(hypothesis => hypothesis.trueFactIds.has(factId));
    const no = input.hypotheses.filter(hypothesis => !hypothesis.trueFactIds.has(factId));
    if (yes.length === 0 || no.length === 0) continue; // every hypothesis agrees -- zero real information from asking.
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) continue;
    const yesWeight = yes.reduce((sum, hypothesis) => sum + hypothesis.weight, 0);
    const noWeight = no.reduce((sum, hypothesis) => sum + hypothesis.weight, 0);
    const expectedPosteriorEntropy =
      (yesWeight / total) * entropyBits(yes.map(hypothesis => hypothesis.weight)) +
      (noWeight / total) * entropyBits(no.map(hypothesis => hypothesis.weight));
    const expectedInformationGainBits = priorEntropyBits - expectedPosteriorEntropy;
    if (expectedInformationGainBits <= EPSILON_BITS) continue;
    candidates.push({
      factId,
      expectedInformationGainBits,
      separatorSize: Math.min(yes.length, no.length),
      yesHypothesisIds: yes.map(hypothesis => hypothesis.id).sort(),
      noHypothesisIds: no.map(hypothesis => hypothesis.id).sort()
    });
  }

  candidates.sort((left, right) =>
    right.expectedInformationGainBits - left.expectedInformationGainBits ||
    left.separatorSize - right.separatorSize ||
    left.factId.localeCompare(right.factId)
  );

  return {
    schema: CLARIFICATION_QUESTION_SCHEMA,
    selected: candidates[0],
    candidates,
    priorEntropyBits
  };
}
