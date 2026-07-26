import type { EvidenceId, SemanticEntailmentResult } from "./types.js";

/**
 * Valid pairwise-label extraction contract for FTRL outcome-based learning
 * (Part A finding 9, stage 3). Every function here takes only externally-
 * defensible outcome signals resolved *after* retrieval -- proof/
 * certification verdicts and their evidenceIds. None of these functions
 * accept an FTRL score, ranking, or model-derived confidence as an input:
 * that is not an oversight, it is how self-reinforcement labels are made
 * structurally impossible to construct through this module's API (a
 * ranker cannot learn "I was right" from its own output, only from an
 * outcome that was determined independently of it).
 */

export type PairwiseLabelSource = "proof_certification";

export interface PairwiseLabelCandidate {
  source: PairwiseLabelSource;
  preferredEvidenceIds: readonly EvidenceId[];
  rejectedEvidenceIds: readonly EvidenceId[];
  weight: number;
  reason: string;
}

/**
 * Extracts a pairwise preference from one turn's final semantic entailment
 * result, contrasting the evidence the proof actually certified against
 * evidence that was in the same retrieval candidate pool but not certified.
 * Returns undefined whenever the verdict does not give a defensible,
 * unambiguous contrast ("underdetermined" or "unknown", or an
 * "entailed" result whose evidenceIds don't leave any candidate pool
 * evidence unused to contrast against).
 */
export function pairwiseLabelFromEntailment(input: {
  entailment: SemanticEntailmentResult;
  candidatePoolEvidenceIds: readonly EvidenceId[];
}): PairwiseLabelCandidate | undefined {
  const verdict = input.entailment.verdict;
  if (verdict === "underdetermined" || verdict === "unknown") return undefined;
  const certified = uniqueIds(input.entailment.evidenceIds);
  if (!certified.length) return undefined;
  const certifiedSet = new Set(certified.map(String));
  const rejected = uniqueIds(input.candidatePoolEvidenceIds)
    .filter(id => !certifiedSet.has(String(id)));
  if (!rejected.length) return undefined;
  if (verdict === "contradicted") {
    // A contradicted verdict means this evidence should be pushed away
    // from, not preferred -- the label direction inverts rather than
    // being dropped, so the ranker can actually learn to avoid it.
    return {
      source: "proof_certification",
      preferredEvidenceIds: rejected,
      rejectedEvidenceIds: certified,
      weight: clampWeight(input.entailment.faithfulnessLcb),
      reason: "contradicted verdict: candidate pool evidence preferred over contradicted evidence"
    };
  }
  // entailed: the certified evidence is the preferred side. Weight by
  // faithfulnessLcb (a lower-confidence bound, not the raw support
  // score) so a shaky entailment contributes a small update rather than
  // being treated as equally certain as a strong one.
  return {
    source: "proof_certification",
    preferredEvidenceIds: certified,
    rejectedEvidenceIds: rejected,
    weight: clampWeight(input.entailment.faithfulnessLcb),
    reason: "entailed verdict: certified evidence preferred over uncertified candidate pool evidence"
  };
}

function uniqueIds(ids: readonly EvidenceId[]): EvidenceId[] {
  const seen = new Set<string>();
  const result: EvidenceId[] = [];
  for (const id of ids) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(id);
  }
  return result;
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}
