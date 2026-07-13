/**
 * Algebraic claim-support contract.
 *
 * These values are inspectable support masses, not calibrated confidence.
 * A caller may expose a probability only when it supplies a reliable,
 * versioned calibration record.
 */
export type SupportCategory =
  | "retrieval_support"
  | "semantic_support"
  | "statistical_support"
  | "rule_entailment"
  | "formal_proof"
  | "creative_or_speculative";

export type EvidencePolarity = "support" | "contradiction" | "unknown";

export interface SupportEvidenceWeight {
  evidenceId: string;
  polarity: EvidencePolarity;
  sourceReliability: number;
  directness: number;
  freshness: number;
  extractionReliability: number;
  sourceDiversity: number;
}

export interface FormalProofReplay {
  axioms: readonly string[];
  rules: readonly string[];
  substitutions: Readonly<Record<string, string>>;
  steps: readonly {
    rule: string;
    premises: readonly string[];
    conclusion: string;
  }[];
  replayVerified: boolean;
}

export interface CalibrationEvidence {
  calibrationId: string;
  targetEvent: string;
  probability: number;
  reliable: boolean;
}

export interface ClaimSupportAssessment {
  category: SupportCategory;
  supportMass: number;
  contradictionMass: number;
  uncertaintyMass: number;
  belief: number;
  plausibility: number;
  contradictionRatio: number;
  calibratedProbability?: number;
  calibrationId?: string;
  formalProofReplay?: FormalProofReplay;
  evidenceWeights: readonly { evidenceId: string; polarity: EvidencePolarity; weight: number }[];
  limitations: readonly string[];
}

export interface ClaimSupportInput {
  evidence: readonly SupportEvidenceWeight[];
  semanticAlignmentEstablished?: boolean;
  ruleEntailed?: boolean;
  formalProofReplay?: FormalProofReplay;
  calibration?: CalibrationEvidence;
  uncertaintyFloor?: number;
}

export function assessClaimSupport(input: ClaimSupportInput): ClaimSupportAssessment {
  const evidenceWeights = input.evidence.map(item => ({
    evidenceId: item.evidenceId,
    polarity: item.polarity,
    weight: product01(item.sourceReliability, item.directness, item.freshness, item.extractionReliability, item.sourceDiversity)
  }));
  const supportMass = sumByPolarity(evidenceWeights, "support");
  const contradictionMass = sumByPolarity(evidenceWeights, "contradiction");
  const uncertaintyMass = sumByPolarity(evidenceWeights, "unknown") + boundedFloor(input.uncertaintyFloor);
  const denominator = supportMass + contradictionMass + uncertaintyMass;
  const belief = denominator > 0 ? supportMass / denominator : 0;
  const plausibility = denominator > 0 ? (supportMass + uncertaintyMass) / denominator : 0;
  const contradictionRatio = denominator > 0 ? contradictionMass / denominator : 0;
  const limitations: string[] = [];

  let category: SupportCategory = "creative_or_speculative";
  if (supportMass > 0) category = "retrieval_support";
  if (category === "retrieval_support" && input.semanticAlignmentEstablished === true) category = "semantic_support";
  if (input.calibration?.reliable === true) category = "statistical_support";
  if (input.ruleEntailed === true) category = "rule_entailment";
  if (isReplayableFormalProof(input.formalProofReplay)) category = "formal_proof";

  if (contradictionMass > 0) limitations.push("contradiction-mass-present");
  if (uncertaintyMass > 0) limitations.push("uncertainty-mass-present");
  if (input.calibration && !input.calibration.reliable) limitations.push("calibration-not-reliable");
  if (input.formalProofReplay && !isReplayableFormalProof(input.formalProofReplay)) limitations.push("formal-proof-replay-not-verified");
  if (category === "creative_or_speculative") limitations.push("no-factual-support-category-established");

  return {
    category,
    supportMass,
    contradictionMass,
    uncertaintyMass,
    belief,
    plausibility,
    contradictionRatio,
    ...(input.calibration?.reliable === true
      ? { calibratedProbability: unit(input.calibration.probability, "calibration.probability"), calibrationId: requiredText(input.calibration.calibrationId, "calibration.calibrationId") }
      : {}),
    ...(isReplayableFormalProof(input.formalProofReplay) ? { formalProofReplay: input.formalProofReplay } : {}),
    evidenceWeights,
    limitations
  };
}

export function isReplayableFormalProof(proof: FormalProofReplay | undefined): proof is FormalProofReplay {
  if (!proof?.replayVerified || proof.axioms.length === 0 || proof.rules.length === 0 || proof.steps.length === 0) return false;
  const available = new Set(proof.axioms);
  for (const step of proof.steps) {
    if (!proof.rules.includes(step.rule) || !step.premises.every(premise => available.has(premise)) || !step.conclusion.trim()) return false;
    available.add(step.conclusion);
  }
  return true;
}

function sumByPolarity(items: readonly { polarity: EvidencePolarity; weight: number }[], polarity: EvidencePolarity): number {
  return items.reduce((sum, item) => item.polarity === polarity ? sum + item.weight : sum, 0);
}

function product01(...values: number[]): number {
  return values.reduce((product, value) => product * unit(value, "evidence weight factor"), 1);
}

function boundedFloor(value: number | undefined): number {
  if (value === undefined) return Number.EPSILON;
  if (!Number.isFinite(value) || value < 0) throw new RangeError("uncertaintyFloor must be finite and nonnegative");
  return value;
}

function unit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be finite and within [0, 1]`);
  return value;
}

function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new TypeError(`${label} must be non-empty`);
  return value;
}
