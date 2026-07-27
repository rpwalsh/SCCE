import type { JsonValue } from "./types.js";
import { canonicalStringify } from "./primitives.js";

/**
 * Plan items 213-214. Merges equivalent claims about the same subject
 * through canonical identity (grouping by subject id + canonicalized
 * value, not just subject id) -- so two sources genuinely disagreeing
 * about a subject never collapse into one false-consensus entry. Each
 * distinct value a subject has been claimed to have keeps its own
 * source/time/dependency trail; nothing here decides which claim is
 * "right".
 */

export interface SemanticClaimObservation {
  id: string;
  subjectId: string;
  canonicalValue: JsonValue;
  sourceId: string;
  observedAt: number;
  evidenceIds: string[];
}

export interface ConsolidatedSemanticClaim {
  subjectId: string;
  canonicalValue: JsonValue;
  supportingObservationIds: string[];
  sourceIds: string[];
  evidenceIds: string[];
  firstObservedAt: number;
  lastObservedAt: number;
}

export interface SemanticConsolidationResult {
  subjectId: string;
  claims: ConsolidatedSemanticClaim[];
  /** True when this subject has more than one distinct canonical value across its observations -- a genuine, preserved disagreement, not an error. */
  contradictory: boolean;
}

export function consolidateSemanticClaims(
  observations: readonly SemanticClaimObservation[]
): SemanticConsolidationResult[] {
  const bySubject = new Map<string, SemanticClaimObservation[]>();
  for (const observation of observations) {
    const bucket = bySubject.get(observation.subjectId) ?? [];
    bucket.push(observation);
    bySubject.set(observation.subjectId, bucket);
  }
  const results: SemanticConsolidationResult[] = [];
  for (const [subjectId, subjectObservations] of [...bySubject.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const byValue = new Map<string, { canonicalValue: JsonValue; observations: SemanticClaimObservation[] }>();
    for (const observation of subjectObservations) {
      const valueKey = canonicalStringify(observation.canonicalValue);
      const existing = byValue.get(valueKey);
      if (existing) existing.observations.push(observation);
      else byValue.set(valueKey, { canonicalValue: observation.canonicalValue, observations: [observation] });
    }
    const claims: ConsolidatedSemanticClaim[] = [...byValue.values()]
      .map(group => {
        const ordered = [...group.observations].sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id));
        return {
          subjectId,
          canonicalValue: group.canonicalValue,
          supportingObservationIds: ordered.map(observation => observation.id),
          sourceIds: [...new Set(ordered.map(observation => observation.sourceId))].sort(),
          evidenceIds: [...new Set(ordered.flatMap(observation => observation.evidenceIds))].sort(),
          firstObservedAt: ordered[0]!.observedAt,
          lastObservedAt: ordered[ordered.length - 1]!.observedAt
        };
      })
      .sort((left, right) => canonicalStringify(left.canonicalValue).localeCompare(canonicalStringify(right.canonicalValue)));
    results.push({ subjectId, claims, contradictory: claims.length > 1 });
  }
  return results;
}
