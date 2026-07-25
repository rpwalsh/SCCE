import type { InformationLabel, PolicyProfile } from "./types.js";
import type { PolicyGenome } from "./functional-cognition.js";

/**
 * Versioned so a future change to what the five dimensions mean can never
 * silently reinterpret an already-stored genome/evaluation under the old
 * meaning.
 */
export const POLICY_OBJECTIVE_SCHEMA_ID = "scce.policy-objectives.v1";

/** One real, evidence-backed evaluation of one policy configuration over one window. */
export interface PolicyEvaluation {
  id: string;
  policyFingerprint: string;
  objectiveSchemaId: string;
  vector: Record<string, number>;
  /** Maximization-oriented per `POLICY_OBJECTIVE_SCHEMA_ID` — always build with `policyObjectiveVector()`. */
  objectives: number[];
  evaluationWindow: { firstEventId: string; lastEventId: string };
  observations: number;
  createdAt: number;
  informationLabel: InformationLabel;
}

/**
 * The aggregated, Pareto-population-eligible record for one distinct policy
 * configuration. Distinct genome count for `pareto.available`'s >=2 check
 * must be `unique(policyFingerprint + objectiveSchemaId)`, never raw
 * evaluation-row count — two evaluations of one fingerprint are one genome,
 * not two.
 */
export interface DurablePolicyGenome {
  policyFingerprint: string;
  objectiveSchemaId: string;
  vector: Record<string, number>;
  /** Running mean of every contributing evaluation's `objectives`, index-wise. */
  aggregatedObjectives: number[];
  evaluationCount: number;
  firstEvaluatedAt: number;
  lastEvaluatedAt: number;
  informationLabel: InformationLabel;
}

/**
 * Builds a schema-v1 objective vector from named, real rates. Rates that
 * describe "amount of a bad thing" (contradiction, rollback) are inverted
 * here so every dimension is maximization-oriented, matching what
 * `paretoPolicyEvolution`'s `dominates()` assumes (every coordinate:
 * higher is better, compared positionally) — callers must never construct
 * the `objectives` array by hand.
 */
export function policyObjectiveVector(input: {
  evidenceCoverage: number;
  governanceSuccessRate: number;
  contradictionRate: number;
  rollbackRate: number;
  taskSuccessRate: number;
}): number[] {
  return [
    clamp01(input.evidenceCoverage),
    clamp01(input.governanceSuccessRate),
    clamp01(1 - input.contradictionRate),
    clamp01(1 - input.rollbackRate),
    clamp01(input.taskSuccessRate)
  ];
}

/** Deterministic identity for a policy configuration — same fields, same fingerprint, every time. */
export function policyFingerprint(policy: PolicyProfile): string {
  const canonical = [
    `allowMutation:${policy.allowMutation}`,
    `requireTwoPhaseCommit:${policy.requireTwoPhaseCommit}`,
    `dryRunByDefault:${policy.dryRunByDefault}`,
    `maxNetworkRequests:${policy.maxNetworkRequests}`,
    `maxToolCalls:${policy.maxToolCalls}`,
    `maxSpendCents:${policy.maxSpendCents}`,
    `alphaRiskCeiling:${policy.alphaRiskCeiling}`,
    `encryptSecretsAtRest:${policy.encryptSecretsAtRest}`
  ].join("|");
  return `policy_${fnv1a(canonical)}`;
}

/**
 * Folds one new real evaluation into the running aggregate for its
 * fingerprint. Pure function so both the Postgres adapter and any future
 * in-process store implementation compute the identical aggregate.
 */
export function aggregateGenome(previous: DurablePolicyGenome | undefined, evaluation: PolicyEvaluation): DurablePolicyGenome {
  if (!previous) {
    return {
      policyFingerprint: evaluation.policyFingerprint,
      objectiveSchemaId: evaluation.objectiveSchemaId,
      vector: evaluation.vector,
      aggregatedObjectives: evaluation.objectives,
      evaluationCount: 1,
      firstEvaluatedAt: evaluation.createdAt,
      lastEvaluatedAt: evaluation.createdAt,
      informationLabel: evaluation.informationLabel
    };
  }
  const n = previous.evaluationCount;
  const aggregatedObjectives = previous.aggregatedObjectives.map((value, index) => {
    const next = evaluation.objectives[index];
    return next === undefined ? value : (value * n + next) / (n + 1);
  });
  return {
    ...previous,
    vector: evaluation.vector,
    aggregatedObjectives,
    evaluationCount: n + 1,
    lastEvaluatedAt: Math.max(previous.lastEvaluatedAt, evaluation.createdAt)
  };
}

/** Converts a durable, aggregated genome into the `PolicyGenome` shape `functionalCognitionEngine.project()` consumes. */
export function policyGenomeFromDurable(genome: DurablePolicyGenome): PolicyGenome {
  return {
    id: `${genome.policyFingerprint}:${genome.objectiveSchemaId}`,
    vector: genome.vector,
    objectives: genome.aggregatedObjectives
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function fnv1a(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
