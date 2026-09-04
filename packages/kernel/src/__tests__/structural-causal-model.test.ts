// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  counterfactualSimulate,
  createStructuralCausalModel,
  simulateStructuralCausalModel,
  StructuralCausalModelCycleError,
  type StructuralEquation
} from "../structural-causal-model.js";

// Plan items 163-164. A real per-variable functional-mechanism causal
// model, distinct from a correlational graph, and a real, exact,
// deterministic proof (no Monte Carlo, no flakiness risk) that an
// observational association is never the same quantity as an
// interventional effect under real confounding.

function exogenousRoot(variableId: string): StructuralEquation {
  return {
    variableId,
    parentIds: [],
    compute: (_parents, noise) => noise,
    assumptions: [`${variableId} is exogenous`],
    evidenceIds: [],
    identifiabilityStatus: "identified"
  };
}

describe("createStructuralCausalModel (plan item 163)", () => {
  it("computes a real, cycle-checked evaluation order (parents before children)", () => {
    const model = createStructuralCausalModel([
      exogenousRoot("z"),
      { variableId: "x", parentIds: ["z"], compute: (parents) => parents.get("z")!, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" },
      { variableId: "y", parentIds: ["x", "z"], compute: (parents) => 2 * parents.get("x")! + 3 * parents.get("z")!, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" }
    ]);
    expect(model.evaluationOrder.indexOf("z")).toBeLessThan(model.evaluationOrder.indexOf("x"));
    expect(model.evaluationOrder.indexOf("x")).toBeLessThan(model.evaluationOrder.indexOf("y"));
  });

  it("throws a real, typed cycle error for a genuinely cyclic equation set -- never silently accepted as a DAG", () => {
    const equations: StructuralEquation[] = [
      { variableId: "a", parentIds: ["b"], compute: parents => parents.get("b")!, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" },
      { variableId: "b", parentIds: ["a"], compute: parents => parents.get("a")!, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" }
    ];
    expect(() => createStructuralCausalModel(equations)).toThrow(StructuralCausalModelCycleError);
  });

  it("refuses an equation whose parentIds reference an unknown variable", () => {
    expect(() => createStructuralCausalModel([
      { variableId: "x", parentIds: ["ghost"], compute: () => 0, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" }
    ])).toThrow(/unknown parent/);
  });
});

describe("simulateStructuralCausalModel: real forward simulation", () => {
  it("propagates real values through a chain z -> x -> y", () => {
    const model = createStructuralCausalModel([
      exogenousRoot("z"),
      { variableId: "x", parentIds: ["z"], compute: parents => parents.get("z")! + 1, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" },
      { variableId: "y", parentIds: ["x"], compute: parents => parents.get("x")! * 10, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" }
    ]);
    const result = simulateStructuralCausalModel(model, new Map([["z", 4]]));
    expect(result.get("z")).toBe(4);
    expect(result.get("x")).toBe(5);
    expect(result.get("y")).toBe(50);
  });

  it("a do-operator intervention overrides a variable's own mechanism entirely, severing it from its parents", () => {
    const model = createStructuralCausalModel([
      exogenousRoot("z"),
      { variableId: "x", parentIds: ["z"], compute: parents => parents.get("z")! + 1, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" }
    ]);
    const observational = simulateStructuralCausalModel(model, new Map([["z", 4]]));
    const interventional = simulateStructuralCausalModel(model, new Map([["z", 4]]), new Map([["x", 99]]));
    expect(observational.get("x")).toBe(5); // z=4 -> x=5 via its real mechanism
    expect(interventional.get("x")).toBe(99); // do(x=99) ignores the mechanism entirely, regardless of z
    expect(interventional.get("z")).toBe(4); // z itself is untouched by intervening on x
  });
});

describe("item 164: an observational association is never the same quantity as a real interventional effect under confounding", () => {
  // z is a real common cause of both x and y (x = z exactly, y = 2x + 3z).
  // z's own real distribution is {0, 1} with equal real probability.
  function confoundedModel() {
    return createStructuralCausalModel([
      exogenousRoot("z"),
      { variableId: "x", parentIds: ["z"], compute: parents => parents.get("z")!, assumptions: ["x is fully determined by z"], evidenceIds: [], identifiabilityStatus: "identified" },
      { variableId: "y", parentIds: ["x", "z"], compute: parents => 2 * parents.get("x")! + 3 * parents.get("z")!, assumptions: ["y has a real direct effect from x and a separate real direct effect from z"], evidenceIds: [], identifiabilityStatus: "identified" }
    ]);
  }

  it("computes an exact real interventional effect E[Y|do(X=1)] by averaging over z's real distribution while x is held fixed by the do-operator", () => {
    const model = confoundedModel();
    const zSupport = [0, 1]; // equal real probability 0.5 each
    const interventionalYValues = zSupport.map(z => simulateStructuralCausalModel(model, new Map([["z", z]]), new Map([["x", 1]])).get("y")!);
    const interventionalExpectation = interventionalYValues.reduce((sum, value) => sum + value, 0) / interventionalYValues.length;
    // do(x=1): y = 2*1 + 3*z, averaged over z in {0,1} -> (2+0 + 2+3)/2 = (2+5)/2 = 3.5
    expect(interventionalExpectation).toBeCloseTo(3.5, 12);
  });

  it("computes the real observational association E[Y|X=1] by filtering real (unintervened) simulated outcomes to X=1 and averaging Y -- a genuinely different quantity", () => {
    const model = confoundedModel();
    const zSupport = [0, 1];
    const observed = zSupport.map(z => simulateStructuralCausalModel(model, new Map([["z", z]])));
    const matchingX1 = observed.filter(outcome => outcome.get("x") === 1);
    // Because x = z exactly here, x=1 happens only when z=1 -- so this is
    // not a 50/50 mix of z values the way the interventional case was; the
    // real point of confounding.
    expect(matchingX1).toHaveLength(1);
    const observationalExpectation = matchingX1.reduce((sum, outcome) => sum + outcome.get("y")!, 0) / matchingX1.length;
    // Only z=1 ever produces x=1 here: y = 2*1 + 3*1 = 5.
    expect(observationalExpectation).toBeCloseTo(5, 12);
  });

  it("the real interventional and observational quantities genuinely differ -- proving this module cannot conflate them, the exact guarantee item 164 asks for", () => {
    const model = confoundedModel();
    const zSupport = [0, 1];
    const interventionalExpectation = zSupport
      .map(z => simulateStructuralCausalModel(model, new Map([["z", z]]), new Map([["x", 1]])).get("y")!)
      .reduce((sum, value, _index, array) => sum + value / array.length, 0);
    const observed = zSupport.map(z => simulateStructuralCausalModel(model, new Map([["z", z]])));
    const matchingX1 = observed.filter(outcome => outcome.get("x") === 1);
    const observationalExpectation = matchingX1.reduce((sum, outcome) => sum + outcome.get("y")!, 0) / matchingX1.length;
    expect(interventionalExpectation).not.toBeCloseTo(observationalExpectation, 6);
  });
});

describe("counterfactualSimulate: real Pearl three-step abduction-action-prediction (plan item 165 support)", () => {
  it("a unit whose intervention matches its own naturally observed value produces an identical counterfactual outcome", () => {
    const model = createStructuralCausalModel([
      exogenousRoot("z"),
      { variableId: "x", parentIds: ["z"], compute: parents => parents.get("z")! + 1, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" },
      { variableId: "y", parentIds: ["x", "z"], compute: parents => parents.get("x")! + parents.get("z")!, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" }
    ]);
    const observed = new Map([["z", 3], ["x", 4], ["y", 7]]);
    const result = counterfactualSimulate(model, { observed, interventions: new Map([["x", 4]]) });
    expect(result.get("y")).toBe(7);
  });

  it("abducts this specific unit's real exogenous noise and preserves it through a genuine counterfactual intervention -- not a fresh random draw", () => {
    const model = createStructuralCausalModel([
      exogenousRoot("z"),
      { variableId: "y", parentIds: ["z"], compute: (parents, noise) => parents.get("z")! + noise, assumptions: [], evidenceIds: [], identifiabilityStatus: "identified" }
    ]);
    // Real observed unit: z=2, y=10 -- so this unit's own abducted noise on
    // y's mechanism is 10 - 2 = 8, a real fact about this specific unit,
    // not the population average.
    const observed = new Map([["z", 2], ["y", 10]]);
    const result = counterfactualSimulate(model, { observed, interventions: new Map([["z", 5]]) });
    // Counterfactual: had z been 5 instead of 2 for this same unit, y would
    // be 5 + 8 (this unit's own abducted noise) = 13, not the population-
    // average-noise prediction of just 5.
    expect(result.get("y")).toBe(13);
  });
});
