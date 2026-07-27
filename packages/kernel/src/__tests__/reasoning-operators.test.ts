import { describe, expect, it } from "vitest";
import {
  EMPTY_REASONING_GRAPH,
  addReasoningFact,
  applyReasoningOperator,
  comparisonOperator,
  decompositionOperator,
  deductionOperator,
  type ComparisonResultFactData,
  type CompoundTaskFactData,
  type ImplicationFactData,
  type OptionFactData,
  type ReasoningGraph
} from "../reasoning-operators.js";

describe("deduction operator (modus ponens)", () => {
  function graphWithImplication(): ReasoningGraph {
    let graph = addReasoningFact(EMPTY_REASONING_GRAPH, {
      id: "claim.raining",
      kindId: "claim",
      data: { statement: "it is raining" }
    });
    graph = addReasoningFact(graph, {
      id: "implication.raining-implies-wet",
      kindId: "implication",
      data: { antecedentFactId: "claim.raining", consequentClaim: { statement: "the ground is wet" } } satisfies ImplicationFactData
    });
    return graph;
  }

  it("derives the consequent as a real new claim fact, with a receipt naming both inputs", () => {
    const graph = graphWithImplication();
    const result = applyReasoningOperator(deductionOperator, graph, ["implication.raining-implies-wet"]);
    const consequent = result.graph.facts["implication.raining-implies-wet.consequent"];
    expect(consequent?.data).toEqual({ statement: "the ground is wet" });
    expect(result.receipt.inputFactIds).toEqual(["implication.raining-implies-wet", "claim.raining"]);
    expect(result.receipt.proofObligationId).toBe("modus_ponens");
    expect(result.receipt.cost).toBe(1);
  });

  it("refuses to fire when the antecedent claim is not established", () => {
    let graph = addReasoningFact(EMPTY_REASONING_GRAPH, {
      id: "implication.orphan",
      kindId: "implication",
      data: { antecedentFactId: "claim.missing", consequentClaim: { statement: "unsupported" } } satisfies ImplicationFactData
    });
    expect(() => applyReasoningOperator(deductionOperator, graph, ["implication.orphan"]))
      .toThrow(/preconditions not satisfied/);
  });

  it("rejects an unknown input fact id before even checking preconditions", () => {
    expect(() => applyReasoningOperator(deductionOperator, EMPTY_REASONING_GRAPH, ["missing"]))
      .toThrow(/unknown input fact/);
  });
});

describe("decomposition operator (subgoal split)", () => {
  it("splits a compound task into one real claim fact per declared subgoal", () => {
    const graph = addReasoningFact(EMPTY_REASONING_GRAPH, {
      id: "task.ship-release",
      kindId: "compound_task",
      data: {
        subgoals: [
          { id: "build", description: "build the release artifact" },
          { id: "test", description: "run the release test suite" }
        ]
      } satisfies CompoundTaskFactData
    });
    const result = applyReasoningOperator(decompositionOperator, graph, ["task.ship-release"]);
    expect(result.receipt.outputFactIds).toEqual(["task.ship-release.subgoal.build", "task.ship-release.subgoal.test"]);
    expect(result.graph.facts["task.ship-release.subgoal.build"]?.data).toEqual({
      parentTaskFactId: "task.ship-release",
      description: "build the release artifact"
    });
    expect(result.receipt.proofObligationId).toBe("subgoal_decomposition_covers_declared_subgoals");
  });

  it("refuses to decompose a task with no declared subgoals", () => {
    const graph = addReasoningFact(EMPTY_REASONING_GRAPH, {
      id: "task.empty",
      kindId: "compound_task",
      data: { subgoals: [] } satisfies CompoundTaskFactData
    });
    expect(() => applyReasoningOperator(decompositionOperator, graph, ["task.empty"]))
      .toThrow(/preconditions not satisfied/);
  });

  it("refuses to decompose a fact that is not a compound_task", () => {
    const graph = addReasoningFact(EMPTY_REASONING_GRAPH, { id: "claim.x", kindId: "claim", data: {} });
    expect(() => applyReasoningOperator(decompositionOperator, graph, ["claim.x"]))
      .toThrow(/preconditions not satisfied/);
  });
});

describe("comparison operator (weighted criteria)", () => {
  function optionsGraph(): ReasoningGraph {
    let graph = addReasoningFact(EMPTY_REASONING_GRAPH, {
      id: "option.a",
      kindId: "option",
      data: { criteria: { cost: 3, quality: 8 } } satisfies OptionFactData
    });
    graph = addReasoningFact(graph, {
      id: "option.b",
      kindId: "option",
      data: { criteria: { cost: 9, quality: 5 } } satisfies OptionFactData
    });
    return graph;
  }

  it("ranks options by a real weighted sum of their own declared criteria, never an invented preference", () => {
    const graph = optionsGraph();
    const operator = comparisonOperator({ cost: -1, quality: 1 });
    const result = applyReasoningOperator(operator, graph, ["option.a", "option.b"]);
    const resultFact = result.graph.facts[result.receipt.outputFactIds[0]!]!;
    const data = resultFact.data as unknown as ComparisonResultFactData;
    // a: -1*3 + 1*8 = 5 ; b: -1*9 + 1*5 = -4 -- a should rank first.
    expect(data.rankedOptionFactIds).toEqual(["option.a", "option.b"]);
    expect(data.scores["option.a"]).toBe(5);
    expect(data.scores["option.b"]).toBe(-4);
  });

  it("a different weighting can flip the ranking -- proving the score is really derived from the weights, not hardcoded", () => {
    // A genuine tradeoff (unlike optionsGraph() above, where option.a
    // dominates option.b on both criteria and so no economically sensible
    // weighting could ever flip it): cheap-and-low-quality vs
    // expensive-and-high-quality.
    let graph = addReasoningFact(EMPTY_REASONING_GRAPH, {
      id: "option.cheap",
      kindId: "option",
      data: { criteria: { cost: 2, quality: 3 } } satisfies OptionFactData
    });
    graph = addReasoningFact(graph, {
      id: "option.premium",
      kindId: "option",
      data: { criteria: { cost: 8, quality: 11 } } satisfies OptionFactData
    });

    const costOnly = comparisonOperator({ cost: -1, quality: 0 });
    const costOnlyResult = applyReasoningOperator(costOnly, graph, ["option.cheap", "option.premium"]);
    const costOnlyData = costOnlyResult.graph.facts[costOnlyResult.receipt.outputFactIds[0]!]!.data as unknown as ComparisonResultFactData;
    expect(costOnlyData.rankedOptionFactIds).toEqual(["option.cheap", "option.premium"]);

    const qualityOnly = comparisonOperator({ cost: 0, quality: 1 });
    const qualityOnlyResult = applyReasoningOperator(qualityOnly, graph, ["option.cheap", "option.premium"]);
    const qualityOnlyData = qualityOnlyResult.graph.facts[qualityOnlyResult.receipt.outputFactIds[0]!]!.data as unknown as ComparisonResultFactData;
    expect(qualityOnlyData.rankedOptionFactIds).toEqual(["option.premium", "option.cheap"]);
  });

  it("refuses to compare fewer than two options", () => {
    const graph = optionsGraph();
    const operator = comparisonOperator({ cost: -1 });
    expect(() => applyReasoningOperator(operator, graph, ["option.a"])).toThrow(/preconditions not satisfied/);
  });

  it("refuses to compare a fact that is not an option", () => {
    let graph = optionsGraph();
    graph = addReasoningFact(graph, { id: "claim.not-an-option", kindId: "claim", data: {} });
    const operator = comparisonOperator({ cost: -1 });
    expect(() => applyReasoningOperator(operator, graph, ["option.a", "claim.not-an-option"]))
      .toThrow(/preconditions not satisfied/);
  });
});

describe("applyReasoningOperator's shared invariant/precondition enforcement", () => {
  it("every operator shares the same wrapper -- an operator cannot skip its own precondition check", () => {
    const graph = addReasoningFact(EMPTY_REASONING_GRAPH, {
      id: "implication.bad",
      kindId: "implication",
      data: { antecedentFactId: "claim.absent", consequentClaim: {} } satisfies ImplicationFactData
    });
    for (const operator of [deductionOperator, decompositionOperator, comparisonOperator({})]) {
      expect(() => applyReasoningOperator(operator, graph, ["implication.bad"])).toThrow(/preconditions not satisfied/);
    }
  });
});
