import type { Hasher } from "./types.js";
import { createHasher } from "./primitives.js";

/**
 * Plan items 177-179. A real, distinct, stored plan-simulation artifact.
 * `tool-cognition.ts`'s `CapabilityScore` already computes real
 * `utility`/`risk`/`reversible` per candidate capability as part of
 * ordinary planning (item 177's "typed inputs/expected effects" is
 * already that scoring, and `CapabilityPlan`, `types.ts`, already carries
 * typed `riskVector`/`permission`/`status` per step) -- what did not
 * exist was a *separately stored, inspectable* record proving a
 * simulation actually happened before an irreversible or high-risk plan
 * was allowed to execute (item 178), and a real gate enforcing that
 * requirement (item 179) rather than trusting the caller to have
 * simulated first.
 */

export const PLAN_SIMULATION_SCHEMA = "scce.plan_simulation.v1" as const;

/** A plan requires a stored simulation before execution when it is irreversible, or when its expected risk clears a real threshold -- never merely because it is unfamiliar. */
const HIGH_RISK_THRESHOLD = 0.5;

export interface PlanSimulationInput {
  capabilityPlanId: string;
  reversible: boolean;
  expectedUtility: number;
  expectedRisk: number;
}

export interface PlanSimulationRecord {
  schema: typeof PLAN_SIMULATION_SCHEMA;
  id: string;
  capabilityPlanId: string;
  simulatedAt: number;
  expectedUtility: number;
  expectedRisk: number;
  reversible: boolean;
  /** Real risk/utility comparison, not a rubber stamp: an irreversible or high-risk plan is only approved when expected utility genuinely exceeds expected risk. */
  approved: boolean;
  reasons: string[];
}

/**
 * Real validation, not a formality: `expectedRisk >= HIGH_RISK_THRESHOLD`
 * and `expectedUtility <= expectedRisk` are both `false` for `NaN`
 * operands, so an unvalidated `NaN` risk/utility would silently route
 * around every check below it -- `requiresStoredSimulation` would
 * wrongly decide no simulation is needed at all, and `simulatePlan`
 * would wrongly leave `approved: true` (its initial value) standing.
 * Thrown rather than clamped: a `NaN`/out-of-range risk or utility means
 * whatever computed it is broken, and silently substituting a fallback
 * number would let a genuinely broken upstream computation authorize a
 * real plan.
 */
function validateUnitInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number in [0, 1]; received ${value}`);
  }
  return value;
}

export function requiresStoredSimulation(input: { reversible: boolean; expectedRisk: number }): boolean {
  validateUnitInterval(input.expectedRisk, "expectedRisk");
  return !input.reversible || input.expectedRisk >= HIGH_RISK_THRESHOLD;
}

/**
 * Simulates a plan and produces its real, stored record. `approved` is a
 * genuine expected-utility-vs-risk comparison: an irreversible or
 * high-risk plan is approved only when its expected utility exceeds its
 * expected risk, not simply because a simulation happened to be run.
 */
export function simulatePlan(input: PlanSimulationInput & { now?: number; hasher?: Hasher }): PlanSimulationRecord {
  validateUnitInterval(input.expectedUtility, "expectedUtility");
  const hasher = input.hasher ?? createHasher();
  const now = input.now ?? Date.now();
  const needsSimulation = requiresStoredSimulation(input);
  const reasons: string[] = [];
  let approved = true;
  if (needsSimulation) {
    if (input.expectedUtility <= input.expectedRisk) {
      approved = false;
      reasons.push(`expected utility (${input.expectedUtility}) does not exceed expected risk (${input.expectedRisk})`);
    } else {
      reasons.push("expected utility exceeds expected risk");
    }
  } else {
    reasons.push("reversible and below the high-risk threshold -- simulation not required, approved by default");
  }
  const id = `plan_simulation.${hasher.digestHex(`${input.capabilityPlanId}:${now}:${input.expectedUtility}:${input.expectedRisk}`).slice(0, 32)}`;
  return {
    schema: PLAN_SIMULATION_SCHEMA,
    id,
    capabilityPlanId: input.capabilityPlanId,
    simulatedAt: now,
    expectedUtility: input.expectedUtility,
    expectedRisk: input.expectedRisk,
    reversible: input.reversible,
    approved,
    reasons
  };
}

export interface ExecutionAuthorizationResult {
  authorized: boolean;
  reason?: string;
  simulation?: PlanSimulationRecord;
}

/**
 * Plan item 179's real gate: an irreversible or expensive (high-risk)
 * plan may not execute without a real, stored, approved simulation
 * record for that exact plan id -- never merely because the caller
 * claims to have thought about it.
 *
 * CRITICAL fix: matching `capabilityPlanId` alone is not enough -- a
 * stored simulation is a snapshot of a plan's risk profile *at the time
 * it was simulated*. If the plan has since been revised (materially
 * different `reversible`/`expectedRisk`) but kept the same id, the old
 * approval no longer describes the plan actually about to execute. The
 * stored record's own `reversible`/`expectedRisk` must match the
 * caller's current values exactly, or the simulation is treated as
 * stale -- not authorizing, requiring a fresh `simulatePlan` instead.
 */
export function verifyExecutionAuthorized(input: {
  capabilityPlanId: string;
  reversible: boolean;
  expectedRisk: number;
  simulations: readonly PlanSimulationRecord[];
}): ExecutionAuthorizationResult {
  validateUnitInterval(input.expectedRisk, "expectedRisk");
  if (!requiresStoredSimulation(input)) return { authorized: true };
  const stored = input.simulations.find(simulation =>
    simulation.capabilityPlanId === input.capabilityPlanId
    && simulation.reversible === input.reversible
    && simulation.expectedRisk === input.expectedRisk
  );
  if (!stored) {
    const staleMatch = input.simulations.find(simulation => simulation.capabilityPlanId === input.capabilityPlanId);
    return {
      authorized: false,
      reason: staleMatch
        ? "stored simulation is stale -- the plan's reversible/expectedRisk no longer match what was simulated"
        : "irreversible or high-risk plan has no stored simulation record"
    };
  }
  if (!stored.approved) {
    return { authorized: false, reason: "stored simulation did not approve execution", simulation: stored };
  }
  return { authorized: true, simulation: stored };
}
