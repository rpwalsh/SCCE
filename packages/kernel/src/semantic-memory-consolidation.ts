// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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
  sourceVersionId?: string;
  graphReference?: SemanticClaimGraphReference;
}

export interface SemanticClaimGraphReference {
  schema: "scce.semantic_claim_graph_reference.v1";
  subjectNodeId: string;
  targetNodeId: string;
  relationId: string;
  edgeId: string;
  subjectFingerprint: string;
  targetFingerprint: string;
  edgeFingerprint: string;
  evidenceWitnesses: Array<{
    evidenceId: string;
    sourceId: string;
    sourceVersionId: string;
    contentHash: string;
    textHash: string;
  }>;
}

export interface ConsolidatedSemanticClaim {
  subjectId: string;
  canonicalValue: JsonValue;
  supportingObservationIds: string[];
  sourceIds: string[];
  evidenceIds: string[];
  sourceVersionIds: string[];
  supportingObservations: SemanticClaimObservation[];
  firstObservedAt: number;
  lastObservedAt: number;
}

export interface SemanticConsolidationResult {
  subjectId: string;
  claims: ConsolidatedSemanticClaim[];
  /** True when this subject has more than one distinct canonical value across its observations -- a genuine, preserved disagreement, not an error. */
  contradictory: boolean;
  canonicalSubjectId?: string;
  canonicalRelationId?: string;
}

export function consolidateSemanticClaims(
  observations: readonly SemanticClaimObservation[]
): SemanticConsolidationResult[] {
  const bySubject = new Map<string, SemanticClaimObservation[]>();
  for (const observation of observations) {
    const key = observation.graphReference
      ? canonicalStringify({ subjectNodeId: observation.graphReference.subjectNodeId, relationId: observation.graphReference.relationId })
      : canonicalStringify({ subjectId: observation.subjectId });
    const bucket = bySubject.get(key) ?? [];
    bucket.push(observation);
    bySubject.set(key, bucket);
  }
  const results: SemanticConsolidationResult[] = [];
  for (const [, subjectObservations] of [...bySubject.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const subjectId = subjectObservations[0]!.subjectId;
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
          supportingObservationIds: [...new Set(ordered.map(observation => observation.id))],
          sourceIds: [...new Set(ordered.flatMap(observation => observation.graphReference
            ? observation.graphReference.evidenceWitnesses.map(witness => witness.sourceId) : [observation.sourceId]))].sort(),
          evidenceIds: [...new Set(ordered.flatMap(observation => observation.evidenceIds))].sort(),
          sourceVersionIds: [...new Set(ordered.flatMap(observation => observation.graphReference
            ? observation.graphReference.evidenceWitnesses.map(witness => witness.sourceVersionId)
            : observation.sourceVersionId ? [observation.sourceVersionId] : []))].sort(),
          supportingObservations: ordered,
          firstObservedAt: ordered[0]!.observedAt,
          lastObservedAt: ordered[ordered.length - 1]!.observedAt
        };
      })
      .sort((left, right) => canonicalStringify(left.canonicalValue).localeCompare(canonicalStringify(right.canonicalValue)));
    const reference = subjectObservations[0]!.graphReference;
    results.push({ subjectId, claims, contradictory: claims.length > 1,
      ...(reference ? { canonicalSubjectId: reference.subjectNodeId, canonicalRelationId: reference.relationId } : {}) });
  }
  return results;
}
