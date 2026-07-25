import { describe, expect, it } from "vitest";
import { counterfactualTracesFromCapabilityPreview } from "../functional-cognition-adapters.js";
import type { CapabilityPlanPreview, CapabilityScore, ToolObjective } from "../tool-cognition.js";

describe("counterfactualTracesFromCapabilityPreview", () => {
  it("produces no traces for an empty preview, keeping CMPS honestly unavailable", () => {
    const traces = counterfactualTracesFromCapabilityPreview({ objectives: [], scored: [] });
    expect(traces).toEqual([]);
  });

  it("maps each objective's real top candidate into a trace, using real evi/fit/risk", () => {
    const preview: CapabilityPlanPreview = {
      objectives: [objective("objective.search")],
      scored: [
        score({ objectiveId: "objective.search", capabilityId: "network.search", phase: "read", fit: 0.8, evi: 0.7, risk: 0.2, utility: 0.75 })
      ]
    };

    const [trace] = counterfactualTracesFromCapabilityPreview(preview);

    expect(trace).toBeDefined();
    expect(trace!.sourceTraceId).toBe("objective.search");
    expect(trace!.planSteps).toEqual(["network.search:read"]);
    expect(trace!.substitutedSteps).toEqual([]);
    expect(trace!.evidenceSurvival).toEqual([0.7]);
    expect(trace!.predictedSkillConfidence).toEqual([0.8]);
    expect(trace!.safetyMargins).toEqual([0.8]);
  });

  it("uses the real next-best scored candidate as substitutedSteps, not an invented alternative", () => {
    const preview: CapabilityPlanPreview = {
      objectives: [objective("objective.retrieve")],
      scored: [
        score({ objectiveId: "objective.retrieve", capabilityId: "network.fetch", phase: "read", fit: 0.6, evi: 0.5, risk: 0.3, utility: 0.55 }),
        score({ objectiveId: "objective.retrieve", capabilityId: "filesystem.read", phase: "read", fit: 0.9, evi: 0.8, risk: 0.1, utility: 0.85 })
      ]
    };

    const [trace] = counterfactualTracesFromCapabilityPreview(preview);

    expect(trace!.planSteps).toEqual(["filesystem.read:read"]);
    expect(trace!.substitutedSteps).toEqual(["network.fetch:read"]);
  });

  it("emits one trace per distinct objective", () => {
    const preview: CapabilityPlanPreview = {
      objectives: [objective("objective.a"), objective("objective.b")],
      scored: [
        score({ objectiveId: "objective.a", capabilityId: "filesystem.read", phase: "read", fit: 0.7, evi: 0.6, risk: 0.2, utility: 0.6 }),
        score({ objectiveId: "objective.b", capabilityId: "process.build_test", phase: "prepare", fit: 0.5, evi: 0.4, risk: 0.4, utility: 0.4 })
      ]
    };

    const traces = counterfactualTracesFromCapabilityPreview(preview);

    expect(traces.map(t => t.sourceTraceId).sort()).toEqual(["objective.a", "objective.b"]);
  });

  it("derives a real, non-invented safety margin from the scorer's own risk value", () => {
    const preview: CapabilityPlanPreview = {
      objectives: [objective("objective.risky")],
      scored: [
        score({ objectiveId: "objective.risky", capabilityId: "process.build_test", phase: "prepare", fit: 0.5, evi: 0.5, risk: 0.7, utility: 0.3 })
      ]
    };

    const [trace] = counterfactualTracesFromCapabilityPreview(preview);

    expect(trace!.safetyMargins).toHaveLength(1);
    expect(trace!.safetyMargins[0]).toBeCloseTo(0.3, 10); // 1 - risk(0.7), not a fabricated constant
  });
});

function objective(id: string): ToolObjective {
  return {
    id,
    kind: "observe",
    label: id,
    features: [],
    requiredEvidence: 0.5,
    mutationPressure: 0,
    networkPressure: 0,
    privacyPressure: 0,
    communicationPressure: 0,
    codePressure: 0,
    urgency: 0.3,
    expectedValue: 0.5
  };
}

function score(input: { objectiveId: string; capabilityId: string; phase: CapabilityScore["phase"]; fit: number; evi: number; risk: number; utility: number }): CapabilityScore {
  return {
    capabilityId: input.capabilityId,
    objectiveId: input.objectiveId,
    phase: input.phase,
    fit: input.fit,
    evi: input.evi,
    risk: input.risk,
    utility: input.utility,
    reversible: true,
    configured: true,
    approvalMode: "not_required",
    reasons: []
  };
}
