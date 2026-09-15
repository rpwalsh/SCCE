import { describe, expect, it } from "vitest";
import { activateCognitiveOperators, deriveTurnRequirementField, COGNITIVE_OPERATOR_IDS, type ActivatedOperator } from "../turn-requirements.js";
import { cognitiveMpcEnergy, planCognitiveOperatorSteps, runCognitiveOperatorMpc, type CognitiveMpcState } from "../operator-mpc-scheduler.js";
import { createRuntimeOrchestrator } from "../runtime-orchestrator.js";

function state(): CognitiveMpcState {
  return { signature: "initial", progress: 0, unresolved: 1, uncertainty: 0.8, contradiction: 0, budget: 1 };
}

function operators(): ActivatedOperator[] {
  const field = deriveTurnRequirementField({ requestText: "", explicitRequirements: [{ dimension: "inferentialDepth", value: 1, confidence: 1, semanticRoleId: "goal", learnedFrameOrPatternId: "frame.goal" }] });
  const active = activateCognitiveOperators({ requirementField: field });
  const make = (operatorId: ActivatedOperator["operatorId"], activation: number): ActivatedOperator => ({
    id: `test:${operatorId}`, operatorId, activation, active: true, contributingRequirementDimensions: ["inferentialDepth"], support: { requirement: activation, graph: 0, dialogue: 0, construct: 0, outcome: 0 }, trace: {}
  });
  return [make(COGNITIVE_OPERATOR_IDS.semanticProof, 0.92), make(COGNITIVE_OPERATOR_IDS.relationComposition, 0.84)];
}

describe("bounded cognitive operator MPC", () => {
  it("plans only a bounded 2-5 step horizon and exposes the first action graph node", () => {
    const plan = planCognitiveOperatorSteps({ requirements: deriveTurnRequirementField({ requestText: "" }), operators: operators(), state: state(), horizon: 5, beamWidth: 3 });
    expect(plan.sequence.length).toBe(5);
    expect(plan.selectedFirst?.operator.operatorId).toBeDefined();
    expect(plan.actionGraph.nodes.length).toBe(5);
    expect(plan.predictedEnergyAfter).toBeLessThan(plan.energyBefore);
  });

  it("is exposed by the one runtime orchestrator lane", () => {
    const orchestrator = createRuntimeOrchestrator();
    const plan = orchestrator.planOperatorSteps({ requirements: deriveTurnRequirementField({ requestText: "" }), operators: operators(), state: state(), horizon: 2 });
    expect(plan.horizon).toBe(2);
    expect(plan.actionGraph.nodes[0]?.operatorId).toBeDefined();
  });

  it("uses an observed failure to change the next first operator and bounds worsening energy", async () => {
    const seen: string[] = [];
    const result = await runCognitiveOperatorMpc({
      requirements: deriveTurnRequirementField({ requestText: "" }),
      operators: operators(),
      state: state(),
      horizon: 2,
      maxSteps: 4,
      maxEnergyWorseningSteps: 2,
      execute: step => {
        seen.push(step.operator.operatorId);
        if (seen.length === 1) return { outcome: false, delta: { progressDelta: -0.02, unresolvedReduction: 0, uncertaintyDelta: 0.18, contradictionDelta: 0.1, cost: 0.1 }, actualDelta: { observed: "rejected" } };
        return { outcome: true, delta: { progressDelta: 1, unresolvedReduction: 1, uncertaintyDelta: -0.6, contradictionDelta: -0.1, cost: 0.1 }, actualDelta: { observed: "accepted" } };
      }
    });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(result.observations[0]?.outcome).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.energyHistory.length).toBeLessThanOrEqual(5);
    expect(result.energyHistory.filter((energy, index) => index > 0 && energy > result.energyHistory[index - 1]! + 1e-9).length).toBeLessThanOrEqual(2);
    expect(cognitiveMpcEnergy(result.finalState)).toBeLessThan(cognitiveMpcEnergy(state()));
  });

  it("executes each static proposal family at most once when reentry is disabled", async () => {
    const seen: string[] = [];
    const result = await runCognitiveOperatorMpc({
      requirements: deriveTurnRequirementField({ requestText: "" }),
      operators: operators(),
      state: state(),
      horizon: 2,
      maxSteps: 4,
      allowOperatorReentry: false,
      goalReached: () => false,
      execute: step => {
        seen.push(step.operator.operatorId);
        return { outcome: true, delta: { progressDelta: 0.02, unresolvedReduction: 0.02, uncertaintyDelta: -0.01, contradictionDelta: 0, cost: 0.05 } };
      }
    });
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(result.status).toBe("stopped_no_action");
  });
});
