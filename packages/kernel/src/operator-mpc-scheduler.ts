// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { COGNITIVE_OPERATOR_IDS, type ActivatedOperator, type CognitiveOperatorId, type TurnRequirementField } from "./turn-requirements.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

/** The compact state exposed to the operator scheduler. Values are typed state, not request text. */
export interface CognitiveMpcState {
  signature: string;
  progress: number;
  unresolved: number;
  uncertainty: number;
  contradiction: number;
  budget: number;
}

/** A predicted or observed change to the typed cognitive state. */
export interface CognitiveMpcDelta {
  progressDelta: number;
  unresolvedReduction: number;
  uncertaintyDelta: number;
  contradictionDelta: number;
  cost: number;
}

export interface CognitiveOperatorPrediction {
  operatorId: CognitiveOperatorId;
  predictedDelta: JsonValue;
  delta: CognitiveMpcDelta;
  confidence: number;
  trace: JsonValue;
}

export interface CognitiveMpcActionNode {
  id: string;
  operatorId: CognitiveOperatorId;
  depth: number;
  predictedEnergy: number;
  metadata: JsonValue;
}

export interface CognitiveMpcActionGraph {
  id: string;
  nodes: CognitiveMpcActionNode[];
  edges: Array<{ source: string; target: string; relation: "precedes"; weight: number }>;
}

export interface CognitiveMpcStep {
  operator: ActivatedOperator;
  prediction: CognitiveOperatorPrediction;
  stateBefore: CognitiveMpcState;
}

export interface CognitiveMpcObservation {
  outcome: boolean;
  delta: CognitiveMpcDelta;
  /** The exact typed observation passed to the outcome learner. */
  actualDelta?: JsonValue;
  trace?: JsonValue;
}

export interface CognitiveMpcPlan {
  horizon: number;
  beamWidth: number;
  initialState: CognitiveMpcState;
  selectedFirst?: CognitiveMpcStep;
  sequence: CognitiveMpcStep[];
  alternatives: Array<{ operatorId: CognitiveOperatorId; predictedEnergy: number; score: number }>;
  terminalState: CognitiveMpcState;
  energyBefore: number;
  predictedEnergyAfter: number;
  actionGraph: CognitiveMpcActionGraph;
  trace: JsonValue;
}

export interface CognitiveMpcInput {
  requirements: TurnRequirementField;
  operators: readonly ActivatedOperator[];
  state: CognitiveMpcState;
  horizon?: number;
  beamWidth?: number;
  /** Optional learned transition model. The default uses only operator activation/support. */
  predict?: (operator: ActivatedOperator, state: CognitiveMpcState) => CognitiveOperatorPrediction;
  /** Stop once the typed state reaches the caller's goal. */
  goalReached?: (state: CognitiveMpcState) => boolean;
}

export interface CognitiveMpcRunInput extends CognitiveMpcInput {
  execute: (step: CognitiveMpcStep) => Promise<CognitiveMpcObservation> | CognitiveMpcObservation;
  maxSteps?: number;
  /** Disable when one execution exhausts a static operator family. */
  allowOperatorReentry?: boolean;
  /** Number of consecutive worsening observations tolerated before the loop is stopped. */
  maxEnergyWorseningSteps?: number;
}

export interface CognitiveMpcSyncRunInput extends CognitiveMpcInput {
  execute: (step: CognitiveMpcStep) => CognitiveMpcObservation;
  maxSteps?: number;
  /** Disable when one execution exhausts a static operator family. */
  allowOperatorReentry?: boolean;
  /** Number of consecutive worsening observations tolerated before the loop is stopped. */
  maxEnergyWorseningSteps?: number;
}

export interface CognitiveMpcRunResult {
  status: "completed" | "stopped_no_action" | "stopped_energy_guard" | "stopped_budget" | "stopped_step_bound";
  finalState: CognitiveMpcState;
  energyHistory: number[];
  observations: Array<{
    operatorId: CognitiveOperatorId;
    predictedDelta: JsonValue;
    actualDelta: JsonValue;
    outcome: boolean;
    energyBefore: number;
    energyAfter: number;
  }>;
  plans: CognitiveMpcPlan[];
  trace: JsonValue;
}

const DEFAULT_HORIZON = 3;
const DEFAULT_BEAM_WIDTH = 4;
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_WORSENING_STEPS = 2;

/**
 * Bounded model-predictive control for the cognitive operator lane.
 * It plans a short sequence, executes only its first step, observes the
 * typed result, and replans from that result. No operator is selected from
 * request text; only the already activated typed operator set is admitted.
 */
export function planCognitiveOperatorSteps(input: CognitiveMpcInput): CognitiveMpcPlan {
  const horizon = boundedInteger(input.horizon, 2, 5, DEFAULT_HORIZON);
  const beamWidth = boundedInteger(input.beamWidth, 1, 16, DEFAULT_BEAM_WIDTH);
  const operators = input.operators.filter(operator => operator.active && operator.activation > 0);
  const predict = input.predict ?? defaultPrediction;
  const initialState = normalizeState(input.state);
  const energyBefore = cognitiveMpcEnergy(initialState);
  if (operators.length === 0) return emptyPlan({ ...input, state: initialState, horizon, beamWidth }, energyBefore);

  type Beam = { state: CognitiveMpcState; sequence: CognitiveMpcStep[]; score: number; used: Set<CognitiveOperatorId> };
  let beam: Beam[] = [{ state: initialState, sequence: [], score: energyBefore, used: new Set() }];
  const allSteps: CognitiveMpcStep[] = [];

  for (let depth = 0; depth < horizon; depth++) {
    const expanded: Beam[] = [];
    for (const item of beam) {
      for (const operator of operators) {
        const prediction = finitePrediction(predict(operator, item.state), operator, item.state);
        const nextState = applyDelta(item.state, prediction.delta, operator.operatorId);
        const step: CognitiveMpcStep = { operator, prediction, stateBefore: item.state };
        const repeatedPenalty = item.used.has(operator.operatorId) ? 0.08 : 0;
        const activationBenefit = operator.activation * 0.03;
        const score = cognitiveMpcEnergy(nextState) + prediction.delta.cost * 0.12 + repeatedPenalty - activationBenefit - prediction.confidence * 0.04;
        expanded.push({ state: nextState, sequence: [...item.sequence, step], score, used: new Set([...item.used, operator.operatorId]) });
      }
    }
    expanded.sort((left, right) => left.score - right.score || left.sequence.map(step => step.operator.operatorId).join("\u0000").localeCompare(right.sequence.map(step => step.operator.operatorId).join("\u0000")));
    beam = expanded.slice(0, beamWidth);
    allSteps.push(...beam.flatMap(item => item.sequence.slice(-1)));
    if (beam.length === 0) break;
  }

  const winner = [...beam].sort((left, right) => cognitiveMpcEnergy(left.state) - cognitiveMpcEnergy(right.state) || left.score - right.score)[0];
  if (!winner) return emptyPlan({ ...input, state: initialState, horizon, beamWidth }, energyBefore);
  const sequence = winner.sequence;
  const terminalState = winner.state;
  const selectedFirst = sequence[0];
  const firstAlternatives = allSteps
    .filter(step => step.stateBefore.signature === initialState.signature)
    .map(step => ({ operatorId: step.operator.operatorId, predictedEnergy: cognitiveMpcEnergy(applyDelta(initialState, step.prediction.delta, step.operator.operatorId)), score: step.operator.activation }))
    .sort((left, right) => left.predictedEnergy - right.predictedEnergy || right.score - left.score || left.operatorId.localeCompare(right.operatorId))
    .filter((row, index, rows) => index === rows.findIndex(other => other.operatorId === row.operatorId));
  const graph = actionGraphFor(sequence, input.requirements, energyBefore);
  const plan: CognitiveMpcPlan = {
    horizon,
    beamWidth,
    initialState,
    selectedFirst,
    sequence,
    alternatives: firstAlternatives,
    terminalState,
    energyBefore,
    predictedEnergyAfter: cognitiveMpcEnergy(terminalState),
    actionGraph: graph,
    trace: toJsonValue({
      schema: "scce.cognitive_mpc.plan.v1",
      horizon,
      beamWidth,
      requirementConfidence: input.requirements.confidence,
      candidateCount: operators.length,
      selectedOperatorId: selectedFirst?.operator.operatorId ?? null,
      sequence: sequence.map(step => ({ operatorId: step.operator.operatorId, prediction: step.prediction.predictedDelta, energy: cognitiveMpcEnergy(applyDelta(step.stateBefore, step.prediction.delta, step.operator.operatorId)) })),
      energyBefore,
      predictedEnergyAfter: cognitiveMpcEnergy(terminalState)
    })
  };
  return plan;
}

/** Execute one planned first step at a time, recording the observation and replanning after every result. */
export async function runCognitiveOperatorMpc(input: CognitiveMpcRunInput): Promise<CognitiveMpcRunResult> {
  const maxSteps = boundedInteger(input.maxSteps, 1, 64, DEFAULT_MAX_STEPS);
  const maxWorsening = boundedInteger(input.maxEnergyWorseningSteps, 1, 8, DEFAULT_MAX_WORSENING_STEPS);
  let state = normalizeState(input.state);
  let operatorBias = new Map<CognitiveOperatorId, number>();
  let failedOperators = new Set<CognitiveOperatorId>();
  const attemptedOperators = new Set<CognitiveOperatorId>();
  let worseningRun = 0;
  const plans: CognitiveMpcPlan[] = [];
  const observations: CognitiveMpcRunResult["observations"] = [];
  const energyHistory = [cognitiveMpcEnergy(state)];
  let status: CognitiveMpcRunResult["status"] = "stopped_step_bound";

  for (let attempt = 0; attempt < maxSteps; attempt++) {
    if (input.goalReached?.(state) ?? defaultGoal(state)) { status = "completed"; break; }
    if (state.budget <= 0) { status = "stopped_budget"; break; }
    const routedOperators = input.operators.map(operator => ({
      ...operator,
      activation: clamp01(operator.activation + (operatorBias.get(operator.operatorId) ?? 0)),
      active: operator.active
        && !failedOperators.has(operator.operatorId)
        && (input.allowOperatorReentry !== false || !attemptedOperators.has(operator.operatorId))
        && operator.activation + (operatorBias.get(operator.operatorId) ?? 0) > 0
    }));
    const plan = planCognitiveOperatorSteps({ ...input, state, operators: routedOperators });
    plans.push(plan);
    const step = plan.selectedFirst;
    if (!step) { status = "stopped_no_action"; break; }
    const before = cognitiveMpcEnergy(state);
    const observation = await input.execute(step);
    attemptedOperators.add(step.operator.operatorId);
    const delta = finiteDelta(observation.delta, step.prediction.delta);
    const actualDelta = observation.actualDelta ?? toJsonValue(delta);
    const nextState = applyDelta(state, delta, step.operator.operatorId);
    const after = cognitiveMpcEnergy(nextState);
    energyHistory.push(after);
    observations.push({ operatorId: step.operator.operatorId, predictedDelta: step.prediction.predictedDelta, actualDelta, outcome: observation.outcome, energyBefore: before, energyAfter: after });
    operatorBias.set(step.operator.operatorId, clamp(-0.45, 0.2, (operatorBias.get(step.operator.operatorId) ?? 0) + (observation.outcome ? 0.08 : -0.28)));
    if (observation.outcome) failedOperators.delete(step.operator.operatorId);
    else failedOperators.add(step.operator.operatorId);
    worseningRun = after > before + 1e-9 ? worseningRun + 1 : 0;
    state = nextState;
    if (worseningRun >= maxWorsening) { status = "stopped_energy_guard"; break; }
  }
  if (status === "stopped_step_bound" && (input.goalReached?.(state) ?? defaultGoal(state))) status = "completed";
  return mpcRunResult(status, state, energyHistory, observations, plans, maxWorsening);
}

/** Synchronous form used by the synchronous proposal planner's canonical production path. */
export function runCognitiveOperatorMpcSync(input: CognitiveMpcSyncRunInput): CognitiveMpcRunResult {
  const maxSteps = boundedInteger(input.maxSteps, 1, 64, DEFAULT_MAX_STEPS);
  const maxWorsening = boundedInteger(input.maxEnergyWorseningSteps, 1, 8, DEFAULT_MAX_WORSENING_STEPS);
  let state = normalizeState(input.state);
  let operatorBias = new Map<CognitiveOperatorId, number>();
  let failedOperators = new Set<CognitiveOperatorId>();
  const attemptedOperators = new Set<CognitiveOperatorId>();
  let worseningRun = 0;
  const plans: CognitiveMpcPlan[] = [];
  const observations: CognitiveMpcRunResult["observations"] = [];
  const energyHistory = [cognitiveMpcEnergy(state)];
  let status: CognitiveMpcRunResult["status"] = "stopped_step_bound";

  for (let attempt = 0; attempt < maxSteps; attempt++) {
    if (input.goalReached?.(state) ?? defaultGoal(state)) { status = "completed"; break; }
    if (state.budget <= 0) { status = "stopped_budget"; break; }
    const routedOperators = input.operators.map(operator => ({
      ...operator,
      activation: clamp01(operator.activation + (operatorBias.get(operator.operatorId) ?? 0)),
      active: operator.active
        && !failedOperators.has(operator.operatorId)
        && (input.allowOperatorReentry !== false || !attemptedOperators.has(operator.operatorId))
        && operator.activation + (operatorBias.get(operator.operatorId) ?? 0) > 0
    }));
    const plan = planCognitiveOperatorSteps({ ...input, state, operators: routedOperators });
    plans.push(plan);
    const step = plan.selectedFirst;
    if (!step) { status = "stopped_no_action"; break; }
    const before = cognitiveMpcEnergy(state);
    const observation = input.execute(step);
    attemptedOperators.add(step.operator.operatorId);
    const delta = finiteDelta(observation.delta, step.prediction.delta);
    const actualDelta = observation.actualDelta ?? toJsonValue(delta);
    const nextState = applyDelta(state, delta, step.operator.operatorId);
    const after = cognitiveMpcEnergy(nextState);
    energyHistory.push(after);
    observations.push({ operatorId: step.operator.operatorId, predictedDelta: step.prediction.predictedDelta, actualDelta, outcome: observation.outcome, energyBefore: before, energyAfter: after });
    operatorBias.set(step.operator.operatorId, clamp(-0.45, 0.2, (operatorBias.get(step.operator.operatorId) ?? 0) + (observation.outcome ? 0.08 : -0.28)));
    if (observation.outcome) failedOperators.delete(step.operator.operatorId);
    else failedOperators.add(step.operator.operatorId);
    worseningRun = after > before + 1e-9 ? worseningRun + 1 : 0;
    state = nextState;
    if (worseningRun >= maxWorsening) { status = "stopped_energy_guard"; break; }
  }
  if (status === "stopped_step_bound" && (input.goalReached?.(state) ?? defaultGoal(state))) status = "completed";
  return mpcRunResult(status, state, energyHistory, observations, plans, maxWorsening);
}

function mpcRunResult(
  status: CognitiveMpcRunResult["status"],
  state: CognitiveMpcState,
  energyHistory: readonly number[],
  observations: CognitiveMpcRunResult["observations"],
  plans: readonly CognitiveMpcPlan[],
  maxWorsening: number
): CognitiveMpcRunResult {
  return {
    status,
    finalState: state,
    energyHistory: [...energyHistory],
    observations,
    plans: [...plans],
    trace: toJsonValue({
      schema: "scce.cognitive_mpc.run.v1",
      status,
      steps: observations.length,
      energyHistory,
      worseningGuard: maxWorsening,
      operatorIds: observations.map(row => row.operatorId),
      transitions: observations.map(row => ({ operatorId: row.operatorId, predictedDelta: row.predictedDelta, actualDelta: row.actualDelta, outcome: row.outcome, energyBefore: row.energyBefore, energyAfter: row.energyAfter }))
    })
  };
}

export function cognitiveMpcEnergy(state: CognitiveMpcState): number {
  return clamp01(
    0.30 * clamp01(state.unresolved)
    + 0.24 * clamp01(state.uncertainty)
    + 0.20 * clamp01(state.contradiction)
    + 0.18 * (1 - clamp01(state.progress))
    + 0.08 * (1 - clamp01(state.budget))
  );
}

function defaultPrediction(operator: ActivatedOperator, state: CognitiveMpcState): CognitiveOperatorPrediction {
  const support = operator.support;
  const confidence = clamp01(0.48 * operator.activation + 0.14 * clamp01(Math.abs(support.requirement)) + 0.14 * clamp01(Math.abs(support.graph)) + 0.14 * clamp01(Math.abs(support.dialogue)) + 0.10 * clamp01(Math.max(0, support.outcome)));
  const progressDelta = clamp01(0.04 + 0.30 * operator.activation + 0.10 * confidence);
  const unresolvedReduction = clamp01(progressDelta * 0.9);
  const uncertaintyDelta = clamp(-0.18, 0.16, 0.08 - confidence * 0.24);
  const contradictionDelta = clamp(-0.10, 0.14, operator.support.outcome < 0 ? 0.08 : 0.03 - confidence * 0.10);
  const cost = clamp01(0.10 + (1 - operator.activation) * 0.16);
  const delta = { progressDelta, unresolvedReduction, uncertaintyDelta, contradictionDelta, cost };
  return {
    operatorId: operator.operatorId,
    predictedDelta: toJsonValue({ schema: "scce.cognitive_mpc.delta.v1", operatorId: operator.operatorId, ...delta }),
    delta,
    confidence,
    trace: toJsonValue({ schema: "scce.cognitive_mpc.prediction.v1", support, confidence })
  };
}

function finitePrediction(value: CognitiveOperatorPrediction, operator: ActivatedOperator, state: CognitiveMpcState): CognitiveOperatorPrediction {
  if (!value || value.operatorId !== operator.operatorId) return defaultPrediction(operator, state);
  return { ...value, operatorId: operator.operatorId, delta: finiteDelta(value.delta, defaultPrediction(operator, state).delta), confidence: clamp01(value.confidence), predictedDelta: value.predictedDelta ?? toJsonValue(value.delta) };
}

function finiteDelta(value: CognitiveMpcDelta | undefined, fallback: CognitiveMpcDelta): CognitiveMpcDelta {
  return {
    progressDelta: finite(value?.progressDelta, fallback.progressDelta),
    unresolvedReduction: finite(value?.unresolvedReduction, fallback.unresolvedReduction),
    uncertaintyDelta: finite(value?.uncertaintyDelta, fallback.uncertaintyDelta),
    contradictionDelta: finite(value?.contradictionDelta, fallback.contradictionDelta),
    cost: Math.max(0, finite(value?.cost, fallback.cost))
  };
}

function applyDelta(state: CognitiveMpcState, delta: CognitiveMpcDelta, operatorId: CognitiveOperatorId): CognitiveMpcState {
  const next = {
    progress: clamp01(state.progress + delta.progressDelta),
    unresolved: clamp01(state.unresolved - delta.unresolvedReduction),
    uncertainty: clamp01(state.uncertainty + delta.uncertaintyDelta),
    contradiction: clamp01(state.contradiction + delta.contradictionDelta),
    budget: clamp01(state.budget - delta.cost)
  };
  const hasher = createHasher();
  return { ...next, signature: hasher.digestHex(JSON.stringify({ previous: state.signature, operatorId, delta: next })) };
}

function actionGraphFor(sequence: readonly CognitiveMpcStep[], requirements: TurnRequirementField, energyBefore: number): CognitiveMpcActionGraph {
  const nodes = sequence.map((step, index) => ({
    id: `mpc:${index}:${step.operator.operatorId}`,
    operatorId: step.operator.operatorId,
    depth: index,
    predictedEnergy: cognitiveMpcEnergy(applyDelta(step.stateBefore, step.prediction.delta, step.operator.operatorId)),
    metadata: toJsonValue({ activation: step.operator.activation, confidence: step.prediction.confidence, requirementConfidence: requirements.confidence })
  }));
  return {
    id: `cognitive_mpc:${nodes.length}:${energyBefore.toFixed(6)}`,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id, relation: "precedes" as const, weight: clamp01(1 - node.predictedEnergy) }))
  };
}

function emptyPlan(input: CognitiveMpcInput & { horizon: number; beamWidth: number }, energyBefore: number): CognitiveMpcPlan {
  return { horizon: input.horizon, beamWidth: input.beamWidth, initialState: input.state, sequence: [], alternatives: [], terminalState: input.state, energyBefore, predictedEnergyAfter: energyBefore, actionGraph: { id: "cognitive_mpc:empty", nodes: [], edges: [] }, trace: toJsonValue({ schema: "scce.cognitive_mpc.plan.v1", candidateCount: 0, selectedOperatorId: null, energyBefore, predictedEnergyAfter: energyBefore }) };
}

function normalizeState(state: CognitiveMpcState): CognitiveMpcState {
  return { signature: String(state.signature), progress: clamp01(finite(state.progress, 0)), unresolved: clamp01(finite(state.unresolved, 1)), uncertainty: clamp01(finite(state.uncertainty, 1)), contradiction: clamp01(finite(state.contradiction, 0)), budget: clamp01(finite(state.budget, 1)) };
}

function defaultGoal(state: CognitiveMpcState): boolean {
  return state.progress >= 0.99 || (state.unresolved <= 0.01 && state.uncertainty <= 0.12);
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value!))) : fallback;
}

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

function clamp(minimum: number, maximum: number, value: number): number {
  return Math.max(minimum, Math.min(maximum, finite(value, 0)));
}
