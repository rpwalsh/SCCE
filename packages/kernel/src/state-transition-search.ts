// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/** A callable invocation in a state-transition scenario. */
export interface StateTransitionInvocation {
  readonly operationId: string;
  readonly arguments: readonly unknown[];
}

/** A complete ordered trace with one observation at its final invocation. */
export interface StateTransitionScenario {
  readonly id: string;
  readonly invocations: readonly StateTransitionInvocation[];
  readonly expectedResult: unknown;
  readonly verificationRole: "fit" | "held_out";
}

export type StateTransitionOperator = "associate" | "lookup" | "dissociate" | "noop";

export type StateTransitionInstruction =
  | { readonly kind: "associate"; readonly operationId: string; readonly keyArgumentIndex: number; readonly valueArgumentIndex: number }
  | { readonly kind: "lookup"; readonly operationId: string; readonly keyArgumentIndex: number }
  | { readonly kind: "dissociate"; readonly operationId: string; readonly keyArgumentIndex: number }
  | { readonly kind: "noop"; readonly operationId: string };

export type StateTransitionPrecondition =
  | { readonly kind: "ordered_invocations" }
  | { readonly kind: "keyed_state" }
  | { readonly kind: "associate_argument_count"; readonly minimum: 2 }
  | { readonly kind: "key_argument"; readonly index: number };

export interface StateTransitionCandidate {
  readonly id: string;
  readonly operatorAssignments: Readonly<Record<string, StateTransitionOperator>>;
  readonly transitionIr: readonly StateTransitionInstruction[];
  /** The observed result for a missing keyed value, chosen only from fit traces. */
  readonly absentValue: unknown;
  readonly preconditions: readonly StateTransitionPrecondition[];
  readonly predictedFitIds: readonly string[];
  readonly heldoutIds: readonly string[];
  readonly score: number;
  readonly fitError: number;
  readonly complexity: number;
  readonly provenance: {
    readonly kind: "fit_scenarios";
    readonly fitScenarioIds: readonly string[];
  };
}

export interface StateTransitionSearchOptions {
  readonly maxCandidates?: number;
}

export interface StateTransitionSearchResult {
  readonly candidates: readonly StateTransitionCandidate[];
  readonly selected: readonly StateTransitionCandidate[];
}

const DEFAULT_MAX_CANDIDATES = 128;

/**
 * Searches a bounded, source-neutral keyed state machine. Only fit scenario
 * results participate in candidate identity, ranking, or role assignment.
 * Held-out results are intentionally never read; their ids are carried for
 * later evaluation.
 */
export function searchStateTransitions(
  scenarios: readonly StateTransitionScenario[],
  options: StateTransitionSearchOptions = {}
): StateTransitionSearchResult {
  const fit = scenarios.filter(scenario => scenario.verificationRole === "fit").slice().sort(compareScenarios);
  if (fit.length === 0) return { candidates: [], selected: [] };
  const heldoutIds = scenarios.filter(scenario => scenario.verificationRole === "held_out").map(scenario => scenario.id).sort(compareStrings);
  const operationIds = [...new Set(fit.flatMap(scenario => scenario.invocations.map(invocation => invocation.operationId)))].sort(compareStrings);
  const arities = operationArity(fit);
  const absentValues = distinctValues([undefined, ...fit.map(scenario => scenario.expectedResult)]);
  const candidates: StateTransitionCandidate[] = [];

  for (const associateId of operationIds.filter(id => (arities.get(id) ?? 0) >= 2)) {
    for (const lookupId of operationIds.filter(id => id !== associateId && (arities.get(id) ?? 0) >= 1)) {
      const dissociateIds = operationIds.filter(id => id !== associateId && id !== lookupId && (arities.get(id) ?? 0) >= 1);
      // Dissociation is optional: a keyed store needs only association and
      // lookup to explain a two-operation trace. A third operation is tested
      // as dissociation when one is available.
      for (const dissociateId of [undefined, ...dissociateIds]) {
        const assignments: Record<string, StateTransitionOperator> = {};
        for (const id of operationIds) assignments[id] = id === associateId ? "associate" : id === lookupId ? "lookup" : id === dissociateId ? "dissociate" : "noop";
        const transitionIr = operationIds.map(id => instructionFor(id, assignments[id]!));
        for (const absentValue of absentValues) {
          const stats = fitStats(transitionIr, absentValue, fit);
          const complexity = transitionIr.filter(instruction => instruction.kind !== "noop").length;
          const candidate: StateTransitionCandidate = {
            id: candidateId(assignments, absentValue),
            operatorAssignments: assignments,
            transitionIr,
            absentValue,
            preconditions: preconditionsFor(transitionIr),
            predictedFitIds: stats.predictedIds,
            heldoutIds,
            score: stats.fitError + complexity * 1e-9,
            fitError: stats.fitError,
            complexity,
            provenance: { kind: "fit_scenarios", fitScenarioIds: fit.map(scenario => scenario.id) }
          };
          candidates.push(candidate);
        }
      }
    }
  }

  const ranked = candidates.sort(compareCandidates).slice(0, boundedInteger(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 1, 2048));
  return { candidates: ranked, selected: ranked.length ? [ranked[0]!] : [] };
}

/** Executes one candidate against an ordered invocation trace. */
export function evaluateStateTransitionScenario(candidate: StateTransitionCandidate, scenario: StateTransitionScenario): unknown {
  const instructionByOperation = new Map(candidate.transitionIr.map(instruction => [instruction.operationId, instruction]));
  const state = new Map<string, unknown>();
  let result: unknown;
  for (const invocation of scenario.invocations) {
    const instruction = instructionByOperation.get(invocation.operationId);
    if (!instruction || instruction.kind === "noop") {
      result = undefined;
      continue;
    }
    const key = argumentAt(invocation.arguments, instruction.keyArgumentIndex);
    if (instruction.kind === "associate") {
      state.set(keyIdentity(key), invocation.arguments[instruction.valueArgumentIndex]);
      result = undefined;
    } else if (instruction.kind === "lookup") {
      result = state.has(keyIdentity(key)) ? state.get(keyIdentity(key)) : candidate.absentValue;
    } else {
      result = state.get(keyIdentity(key));
      state.delete(keyIdentity(key));
    }
  }
  return result;
}

/** Executes a candidate against many scenarios, returning final observations. */
export function evaluateStateTransition(candidate: StateTransitionCandidate, scenarios: readonly StateTransitionScenario[]): readonly unknown[] {
  return scenarios.map(scenario => evaluateStateTransitionScenario(candidate, scenario));
}

function fitStats(instructions: readonly StateTransitionInstruction[], absentValue: unknown, scenarios: readonly StateTransitionScenario[]): { fitError: number; predictedIds: readonly string[] } {
  let failures = 0;
  const predictedIds: string[] = [];
  for (const scenario of scenarios) {
    const predicted = evaluateStateTransitionScenario({ transitionIr: instructions, absentValue } as StateTransitionCandidate, scenario);
    if (deepEqual(predicted, scenario.expectedResult)) predictedIds.push(scenario.id);
    else failures += 1;
  }
  return { fitError: failures / scenarios.length, predictedIds };
}

function instructionFor(operationId: string, operator: StateTransitionOperator): StateTransitionInstruction {
  if (operator === "associate") return { kind: "associate", operationId, keyArgumentIndex: 0, valueArgumentIndex: 1 };
  if (operator === "lookup") return { kind: "lookup", operationId, keyArgumentIndex: 0 };
  if (operator === "dissociate") return { kind: "dissociate", operationId, keyArgumentIndex: 0 };
  return { kind: "noop", operationId };
}

function preconditionsFor(instructions: readonly StateTransitionInstruction[]): readonly StateTransitionPrecondition[] {
  const preconditions: StateTransitionPrecondition[] = [{ kind: "ordered_invocations" }, { kind: "keyed_state" }];
  const associate = instructions.find(instruction => instruction.kind === "associate");
  if (associate?.kind === "associate") {
    preconditions.push({ kind: "associate_argument_count", minimum: 2 }, { kind: "key_argument", index: associate.keyArgumentIndex });
  }
  return preconditions;
}

function operationArity(scenarios: readonly StateTransitionScenario[]): Map<string, number> {
  const arities = new Map<string, number>();
  for (const scenario of scenarios) for (const invocation of scenario.invocations) arities.set(invocation.operationId, Math.max(arities.get(invocation.operationId) ?? 0, invocation.arguments.length));
  return arities;
}

function compareCandidates(left: StateTransitionCandidate, right: StateTransitionCandidate): number {
  return left.fitError - right.fitError || left.complexity - right.complexity || compareStrings(left.id, right.id);
}

function compareScenarios(left: StateTransitionScenario, right: StateTransitionScenario): number { return compareStrings(left.id, right.id); }
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function boundedInteger(value: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : minimum; }

function candidateId(assignments: Readonly<Record<string, StateTransitionOperator>>, absentValue: unknown): string {
  const source = `${Object.keys(assignments).sort(compareStrings).map(id => `${id}:${assignments[id]}`).join("\u0000")}\u0000absent:${stableStringify(absentValue)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `state.transition.${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function argumentAt(args: readonly unknown[], index: number): unknown { return args[index]; }
function keyIdentity(value: unknown): string { return stableStringify(value); }

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort(compareStrings).map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function deepEqual(left: unknown, right: unknown): boolean { return stableStringify(left) === stableStringify(right); }
function distinctValues(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const identity = stableStringify(value);
    if (!seen.has(identity)) { seen.add(identity); out.push(value); }
  }
  return out.slice(0, 32);
}
