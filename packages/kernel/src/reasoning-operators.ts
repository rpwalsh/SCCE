import type { JsonValue } from "./types.js";

/**
 * Plan item 160. Three reusable reasoning operators (deduction,
 * decomposition, comparison) as typed executable graph transformations,
 * each with a real precondition check, a graph-level invariant check, a
 * declared cost, and a receipt naming exactly which proof obligation was
 * discharged and from which input facts -- distinct from
 * `working-memory.ts` (provisional scratch state) and
 * `hierarchical-task-decomposition.ts` (a plan-graph of tasks): a
 * `ReasoningFact` is a typed logical/decision artifact an operator
 * consumes and produces, not a task or a hypothesis.
 */

export interface ReasoningFact {
  id: string;
  kindId: string;
  data: JsonValue;
}

export interface ReasoningGraph {
  facts: Record<string, ReasoningFact>;
}

export const EMPTY_REASONING_GRAPH: ReasoningGraph = { facts: {} };

export function addReasoningFact(graph: ReasoningGraph, fact: ReasoningFact): ReasoningGraph {
  if (graph.facts[fact.id]) throw new Error(`reasoning fact already exists: ${fact.id}`);
  return { facts: { ...graph.facts, [fact.id]: fact } };
}

export interface ReasoningOperatorReceipt {
  operatorId: string;
  inputFactIds: string[];
  outputFactIds: string[];
  cost: number;
  proofObligationId: string;
}

export interface ReasoningOperatorResult {
  graph: ReasoningGraph;
  receipt: ReasoningOperatorReceipt;
}

export interface ReasoningOperator {
  id: string;
  cost: number;
  /** Real, checkable precondition over the specific input facts this application would consume. */
  preconditionsSatisfied(graph: ReasoningGraph, inputFactIds: readonly string[]): boolean;
  /** Graph-level invariant that must hold both before and after applying this operator (e.g. no duplicate fact ids). */
  invariantHolds(graph: ReasoningGraph): boolean;
  apply(graph: ReasoningGraph, inputFactIds: readonly string[]): ReasoningOperatorResult;
}

/**
 * Enforces preconditions/invariants around any operator's `apply` rather
 * than trusting each operator to remember to check them itself -- an
 * operator that skipped its own precondition check would otherwise be
 * silently accepted.
 */
export function applyReasoningOperator(
  operator: ReasoningOperator,
  graph: ReasoningGraph,
  inputFactIds: readonly string[]
): ReasoningOperatorResult {
  if (!operator.invariantHolds(graph)) throw new Error(`${operator.id}: graph invariant does not hold before application`);
  for (const factId of inputFactIds) {
    if (!graph.facts[factId]) throw new Error(`${operator.id}: unknown input fact: ${factId}`);
  }
  if (!operator.preconditionsSatisfied(graph, inputFactIds)) {
    throw new Error(`${operator.id}: preconditions not satisfied for input facts: ${inputFactIds.join(", ")}`);
  }
  const result = operator.apply(graph, inputFactIds);
  if (!operator.invariantHolds(result.graph)) throw new Error(`${operator.id}: graph invariant violated by application`);
  return result;
}

function noDuplicateFactIds(graph: ReasoningGraph): boolean {
  return Object.entries(graph.facts).every(([key, fact]) => key === fact.id);
}

// ---------------------------------------------------------------------------
// Deduction: modus ponens over an explicit implication fact and its antecedent.
// ---------------------------------------------------------------------------

export interface ImplicationFactData {
  antecedentFactId: string;
  consequentClaim: JsonValue;
}

export const deductionOperator: ReasoningOperator = {
  id: "reasoning.operator.deduction.modus_ponens.v1",
  cost: 1,
  invariantHolds: noDuplicateFactIds,
  preconditionsSatisfied(graph, inputFactIds) {
    const [implicationId] = inputFactIds;
    if (inputFactIds.length !== 1 || !implicationId) return false;
    const implication = graph.facts[implicationId];
    if (!implication || implication.kindId !== "implication") return false;
    const data = implication.data as unknown as ImplicationFactData;
    const antecedent = graph.facts[data.antecedentFactId];
    return Boolean(antecedent && antecedent.kindId === "claim");
  },
  apply(graph, inputFactIds) {
    const implication = graph.facts[inputFactIds[0]!]!;
    const data = implication.data as unknown as ImplicationFactData;
    const outputId = `${implication.id}.consequent`;
    const consequent: ReasoningFact = { id: outputId, kindId: "claim", data: data.consequentClaim };
    return {
      graph: addReasoningFact(graph, consequent),
      receipt: {
        operatorId: deductionOperator.id,
        inputFactIds: [implication.id, data.antecedentFactId],
        outputFactIds: [outputId],
        cost: deductionOperator.cost,
        proofObligationId: "modus_ponens"
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Decomposition: splits a compound-task fact into its declared subgoals.
// ---------------------------------------------------------------------------

export interface CompoundTaskFactData {
  subgoals: Array<{ id: string; description: string }>;
}

export const decompositionOperator: ReasoningOperator = {
  id: "reasoning.operator.decomposition.subgoal_split.v1",
  cost: 1,
  invariantHolds: noDuplicateFactIds,
  preconditionsSatisfied(graph, inputFactIds) {
    const [taskId] = inputFactIds;
    if (inputFactIds.length !== 1 || !taskId) return false;
    const task = graph.facts[taskId];
    if (!task || task.kindId !== "compound_task") return false;
    const data = task.data as unknown as CompoundTaskFactData;
    return Array.isArray(data.subgoals) && data.subgoals.length > 0;
  },
  apply(graph, inputFactIds) {
    const task = graph.facts[inputFactIds[0]!]!;
    const data = task.data as unknown as CompoundTaskFactData;
    let nextGraph = graph;
    const outputFactIds: string[] = [];
    for (const subgoal of data.subgoals) {
      const factId = `${task.id}.subgoal.${subgoal.id}`;
      nextGraph = addReasoningFact(nextGraph, {
        id: factId,
        kindId: "claim",
        data: { parentTaskFactId: task.id, description: subgoal.description }
      });
      outputFactIds.push(factId);
    }
    return {
      graph: nextGraph,
      receipt: {
        operatorId: decompositionOperator.id,
        inputFactIds: [task.id],
        outputFactIds,
        cost: decompositionOperator.cost,
        proofObligationId: "subgoal_decomposition_covers_declared_subgoals"
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Comparison: ranks option facts by a real weighted-sum of their criteria.
// ---------------------------------------------------------------------------

export interface OptionFactData {
  criteria: Record<string, number>;
}

export interface ComparisonResultFactData {
  rankedOptionFactIds: string[];
  scores: Record<string, number>;
  weights: Record<string, number>;
}

export function comparisonOperator(weights: Readonly<Record<string, number>>): ReasoningOperator {
  return {
    id: "reasoning.operator.comparison.weighted_criteria.v1",
    cost: 1,
    invariantHolds: noDuplicateFactIds,
    preconditionsSatisfied(graph, inputFactIds) {
      if (inputFactIds.length < 2) return false;
      return inputFactIds.every(factId => {
        const fact = graph.facts[factId];
        return Boolean(fact && fact.kindId === "option");
      });
    },
    apply(graph, inputFactIds) {
      const scores: Record<string, number> = {};
      for (const factId of inputFactIds) {
        const data = graph.facts[factId]!.data as unknown as OptionFactData;
        let score = 0;
        for (const [criterionId, weight] of Object.entries(weights)) {
          score += weight * (data.criteria[criterionId] ?? 0);
        }
        scores[factId] = score;
      }
      const rankedOptionFactIds = [...inputFactIds].sort((left, right) => scores[right]! - scores[left]! || left.localeCompare(right));
      const resultId = `comparison.${inputFactIds.join(".")}`;
      const resultData: ComparisonResultFactData = { rankedOptionFactIds, scores, weights: { ...weights } };
      return {
        graph: addReasoningFact(graph, { id: resultId, kindId: "comparison_result", data: resultData as unknown as JsonValue }),
        receipt: {
          operatorId: "reasoning.operator.comparison.weighted_criteria.v1",
          inputFactIds: [...inputFactIds],
          outputFactIds: [resultId],
          cost: 1,
          proofObligationId: "weighted_criteria_ranking_uses_declared_weights_only"
        }
      };
    }
  };
}
