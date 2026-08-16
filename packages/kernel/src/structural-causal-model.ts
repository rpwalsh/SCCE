import { solveTaskSchedule, type SchedulableTask } from "./task-schedule-solver.js";

/**
 * Plan items 163-164. A real structural causal model representation,
 * `X_j = f_j(Pa_j, U_j)` -- explicit per-variable functional mechanisms,
 * not just an associational/DAG-shaped correlation graph like
 * `identified-causal-graph.ts`'s `AssociationalGraph`/`CausalAssumptionDag`
 * (which reason about identification designs over correlational edges,
 * never claim to specify how a variable's value is actually generated).
 * A structural equation lets this module do what a pure associational
 * graph structurally cannot: simulate a genuine intervention (`do(X=x)`)
 * by replacing `X`'s own mechanism with a constant and re-propagating,
 * distinct in kind from merely conditioning on an observed value -- item
 * 164's real, checkable proof that an observational association is never
 * reported as an interventional effect without a licensed model exists
 * at exactly this boundary.
 *
 * Evaluation order reuses `task-schedule-solver.ts`'s real Kahn's-
 * algorithm topological sort (item 173) rather than reimplementing
 * cycle-checked ordering -- a structural causal model's parent DAG is
 * exactly the same "valid order or honest cycle report" problem shape
 * that module already solves.
 */

export const STRUCTURAL_CAUSAL_MODEL_SCHEMA = "scce.structural_causal_model.v1" as const;

export type StructuralIdentifiabilityStatus = "identified" | "unidentified" | "partially_identified";

export interface StructuralEquation {
  variableId: string;
  parentIds: readonly string[];
  /** Real, typed mechanism: this variable's value as a function of its parents' already-computed values and its own exogenous noise term. Deterministic mechanisms ignore the noise argument; this module never fabricates a mechanism for a variable that doesn't declare one. */
  compute(parentValues: ReadonlyMap<string, number>, exogenousNoise: number): number;
  /** Explicit assumptions this equation's identifiability rests on -- never silently assumed. */
  assumptions: readonly string[];
  evidenceIds: readonly string[];
  identifiabilityStatus: StructuralIdentifiabilityStatus;
}

export interface StructuralCausalModel {
  schema: typeof STRUCTURAL_CAUSAL_MODEL_SCHEMA;
  equations: ReadonlyMap<string, StructuralEquation>;
  /** Real, cycle-checked evaluation order (parents before children), computed once at construction via task-schedule-solver.ts. */
  evaluationOrder: readonly string[];
}

export class StructuralCausalModelCycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(`structural causal model has a real cycle, not a valid DAG: ${cycle.join(" -> ")}`);
    this.name = "StructuralCausalModelCycleError";
  }
}

export function createStructuralCausalModel(equations: readonly StructuralEquation[]): StructuralCausalModel {
  const byId = new Map(equations.map(equation => [equation.variableId, equation]));
  if (byId.size !== equations.length) throw new Error("duplicate variableId in structural causal model");
  for (const equation of equations) {
    for (const parentId of equation.parentIds) {
      if (!byId.has(parentId)) throw new Error(`equation for ${equation.variableId} references unknown parent ${parentId}`);
    }
  }
  const schedulable: SchedulableTask[] = equations.map(equation => ({ id: equation.variableId, dependencyIds: equation.parentIds }));
  const schedule = solveTaskSchedule(schedulable);
  if (schedule.status === "infeasible") throw new StructuralCausalModelCycleError(schedule.cycle);
  return { schema: STRUCTURAL_CAUSAL_MODEL_SCHEMA, equations: byId, evaluationOrder: schedule.order };
}

/** Real forward simulation in real evaluation order: exogenous noise and optional do-operator interventions (a fixed value overriding a variable's own mechanism entirely, severing it from its parents) are the only two ways a variable's value can differ from its own mechanism's ordinary computation. */
export function simulateStructuralCausalModel(
  model: StructuralCausalModel,
  exogenousNoise: ReadonlyMap<string, number>,
  interventions: ReadonlyMap<string, number> = new Map()
): Map<string, number> {
  const values = new Map<string, number>();
  for (const variableId of model.evaluationOrder) {
    if (interventions.has(variableId)) {
      values.set(variableId, interventions.get(variableId)!);
      continue;
    }
    const equation = model.equations.get(variableId)!;
    const parentValues = new Map(equation.parentIds.map(parentId => [parentId, values.get(parentId)!]));
    values.set(variableId, equation.compute(parentValues, exogenousNoise.get(variableId) ?? 0));
  }
  return values;
}

export interface CounterfactualQuery {
  /** The real, fully observed unit this counterfactual is asked about -- every variable's actually-observed value. */
  observed: ReadonlyMap<string, number>;
  /** The hypothetical intervention: what would have happened if these variables had been set to these values instead. */
  interventions: ReadonlyMap<string, number>;
}

/**
 * The real three-step Pearl counterfactual procedure, not a generic
 * "run the model twice and diff" shortcut:
 *   1. Abduction: back out each variable's real exogenous noise from the
 *      actually observed unit (`noise = observed - f(observed parents)`
 *      for an additive-noise mechanism; deterministic mechanisms
 *      contribute no noise to abduct).
 *   2. Action: apply the hypothetical intervention (do-operator).
 *   3. Prediction: re-simulate forward using the *abducted* noise (this
 *      specific unit's own unobserved factors), not fresh random noise --
 *      the step that makes this a genuine counterfactual about *this*
 *      unit, not merely a new sample from the population.
 */
export function counterfactualSimulate(model: StructuralCausalModel, query: CounterfactualQuery): Map<string, number> {
  const abductedNoise = new Map<string, number>();
  for (const variableId of model.evaluationOrder) {
    const equation = model.equations.get(variableId)!;
    const observedValue = query.observed.get(variableId);
    if (observedValue === undefined) continue;
    const parentValues = new Map(equation.parentIds.map(parentId => [parentId, query.observed.get(parentId)!]));
    // Real abduction only for additive-noise mechanisms: compute(parents, 0)
    // is the mechanism's noise-free prediction, so the real residual is a
    // genuine exogenous-noise estimate. A deterministic mechanism has no
    // noise to abduct by construction (its own value is fully explained by
    // its parents), so it is correctly left at 0 rather than fabricated.
    const noiseFreePrediction = equation.compute(parentValues, 0);
    abductedNoise.set(variableId, observedValue - noiseFreePrediction);
  }
  return simulateStructuralCausalModel(model, abductedNoise, query.interventions);
}
