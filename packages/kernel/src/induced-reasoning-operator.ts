/**
 * Plan items 161-162. Induces a candidate reasoning operator from real
 * episode traces (the action-type sequences `episodic-memory-
 * consolidation.ts` already extracts as `actionEventIds`, reduced here to
 * their event *types* rather than ids) -- not hand-authored: the candidate
 * sequence is whichever repeated, contiguous action-type subsequence has
 * the strongest MDL-style support in a fit set, and it is only promoted if
 * a *disjoint* held-out set shows it actually correlates with success
 * (`heldOutGain > 0`), not merely that it once preceded one success.
 */

export interface EpisodeTrace {
  episodeId: string;
  actionTypeSequence: string[];
  succeeded: boolean;
}

export interface InducedOperatorCandidate {
  actionTypeSequence: string[];
  /** How many fit-set episodes contain this exact contiguous subsequence. */
  supportCount: number;
  /** Description-length units saved by compiling this into one operator instead of repeating it inline in every occurrence -- (occurrences - 1) * length, the real reason this candidate was preferred over a shorter/rarer one. */
  descriptionLengthSavedUnits: number;
}

const MIN_SEQUENCE_LENGTH = 2;
const MAX_SEQUENCE_LENGTH = 5;

/**
 * Finds the contiguous action-type subsequence (length 2-5) with the
 * greatest MDL-style savings across the fit set, requiring at least
 * `minimumSupport` occurrences. Returns undefined if nothing clears the
 * support bar -- there is no fallback to a hand-authored default.
 */
export function induceOperatorCandidate(
  fitTraces: readonly EpisodeTrace[],
  options: { minimumSupport?: number } = {}
): InducedOperatorCandidate | undefined {
  const minimumSupport = options.minimumSupport ?? 3;
  const counts = new Map<string, { sequence: string[]; support: number }>();
  for (const trace of fitTraces) {
    const seen = new Set<string>();
    for (let length = MIN_SEQUENCE_LENGTH; length <= MAX_SEQUENCE_LENGTH; length++) {
      for (let start = 0; start + length <= trace.actionTypeSequence.length; start++) {
        const sequence = trace.actionTypeSequence.slice(start, start + length);
        const key = sequence.join("");
        // Count each distinct sequence at most once per episode -- support
        // means "how many episodes exhibit this pattern", not how many
        // times it repeats within a single long episode.
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = counts.get(key);
        counts.set(key, existing ? { sequence, support: existing.support + 1 } : { sequence, support: 1 });
      }
    }
  }
  const candidates: InducedOperatorCandidate[] = [...counts.values()]
    .filter(entry => entry.support >= minimumSupport)
    .map(entry => ({
      actionTypeSequence: entry.sequence,
      supportCount: entry.support,
      descriptionLengthSavedUnits: (entry.support - 1) * entry.sequence.length
    }));
  if (!candidates.length) return undefined;
  candidates.sort((left, right) =>
    right.descriptionLengthSavedUnits - left.descriptionLengthSavedUnits
    || right.supportCount - left.supportCount
    || left.actionTypeSequence.join(",").localeCompare(right.actionTypeSequence.join(",")));
  return candidates[0];
}

export interface OperatorPromotionResult {
  promoted: boolean;
  candidate: InducedOperatorCandidate;
  heldOutMatchingCount: number;
  heldOutMatchingSuccessRate: number;
  heldOutBaselineSuccessRate: number;
  heldOutGain: number;
  reason: string;
}

function containsSequence(actionTypeSequence: readonly string[], pattern: readonly string[]): boolean {
  for (let start = 0; start + pattern.length <= actionTypeSequence.length; start++) {
    if (pattern.every((step, offset) => actionTypeSequence[start + offset] === step)) return true;
  }
  return false;
}

/**
 * Promotion requires the candidate to have a genuinely positive held-out
 * outcome gain: episodes in a *disjoint* held-out set that contain the
 * pattern must succeed at a higher rate than held-out episodes that don't
 * -- not just that the pattern once appeared in a single successful
 * episode during induction (plan item 162's real requirement).
 */
export function evaluateOperatorPromotion(
  candidate: InducedOperatorCandidate,
  heldOutTraces: readonly EpisodeTrace[]
): OperatorPromotionResult {
  const matching = heldOutTraces.filter(trace => containsSequence(trace.actionTypeSequence, candidate.actionTypeSequence));
  const nonMatching = heldOutTraces.filter(trace => !containsSequence(trace.actionTypeSequence, candidate.actionTypeSequence));
  if (!matching.length) {
    return {
      promoted: false,
      candidate,
      heldOutMatchingCount: 0,
      heldOutMatchingSuccessRate: 0,
      heldOutBaselineSuccessRate: successRate(nonMatching),
      heldOutGain: 0,
      reason: "no held-out episode exhibits the induced pattern"
    };
  }
  const heldOutMatchingSuccessRate = successRate(matching);
  const heldOutBaselineSuccessRate = successRate(nonMatching);
  const heldOutGain = heldOutMatchingSuccessRate - heldOutBaselineSuccessRate;
  return {
    promoted: heldOutGain > 0,
    candidate,
    heldOutMatchingCount: matching.length,
    heldOutMatchingSuccessRate,
    heldOutBaselineSuccessRate,
    heldOutGain,
    reason: heldOutGain > 0
      ? "positive held-out outcome gain"
      : `non-positive held-out outcome gain (${heldOutGain.toFixed(3)})`
  };
}

function successRate(traces: readonly EpisodeTrace[]): number {
  if (!traces.length) return 0;
  return traces.filter(trace => trace.succeeded).length / traces.length;
}
