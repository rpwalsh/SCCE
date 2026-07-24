import { describe, expect, it } from "vitest";
import { createConnectorGovernance, defaultConnectorConfigs } from "../connector-governance.js";
import { DEFAULT_POLICY } from "../safety.js";
import { createAutonomousToolCognition } from "../tool-cognition.js";
import type { Capability, EpisodeId } from "../types.js";

describe("tool cognition action commitment", () => {
  it("keeps low-commitment requests on the bounded observation route", () => {
    const plan = cognitionPlan(0.05);

    expect(plan.objectives.some(objective => objective.kind === "observe")).toBe(true);
    expect(plan.objectives.some(objective => objective.kind === "execute")).toBe(false);
    expect(plan.capabilityPlans[0]?.capabilityId).toBe("filesystem.fixture");
    expect(plan.capabilityPlans[0]?.phase).toBe("read");
    expect(objectiveKind(plan.capabilityPlans[0]?.input)).toBe("observe");
  });

  it("turns high structured action commitment into one process prepare plan without executing", () => {
    const plan = cognitionPlan(0.95);
    const capabilityPlan = plan.capabilityPlans[0];
    const permission = record(capabilityPlan?.permission);
    const executeObjective = plan.objectives.find(objective => objective.kind === "execute");

    expect(executeObjective?.mutationPressure).toBe(0.95);
    expect(plan.capabilityPlans).toHaveLength(1);
    expect(capabilityPlan?.capabilityId).toBe("process.fixture");
    expect(capabilityPlan?.phase).toBe("prepare");
    expect(capabilityPlan?.status).toBe("planned");
    expect(objectiveKind(capabilityPlan?.input)).toBe("execute");
    expect(permission.dryRun).toBe(true);
    expect(capabilityPlan?.result).toBeUndefined();
  });

  it("selects the configured local process capability for the authority-matrix action", () => {
    const cognition = createAutonomousToolCognition({ now: () => 1_000 });
    const capabilities = createConnectorGovernance({ now: () => 1_000 }).capabilities(defaultConnectorConfigs());
    const plan = cognition.plan({
      episodeId: "episode.authority-matrix" as EpisodeId,
      request: "Create a command action plan to restart pump alpha without executing it.",
      capabilities,
      policy: DEFAULT_POLICY,
      actionCommitment: 0.95,
      functionalGate: FUNCTIONAL_GATE
    });

    expect(plan.capabilityPlans.map(capabilityPlan => ({
      capabilityId: capabilityPlan.capabilityId,
      phase: capabilityPlan.phase,
      status: capabilityPlan.status,
      dryRun: record(capabilityPlan.permission).dryRun
    }))).toEqual([{
      capabilityId: "process.local",
      phase: "prepare",
      status: "planned",
      dryRun: true
    }]);
  });

  it("does not override a specialized structured connector signal", () => {
    const plan = createAutonomousToolCognition({ now: () => 1_000 }).plan({
      episodeId: "episode.connector" as EpisodeId,
      request: "owner@example.test",
      capabilities: capabilities(),
      policy: DEFAULT_POLICY,
      actionCommitment: 0.95,
      functionalGate: FUNCTIONAL_GATE
    });

    expect(plan.objectives.some(objective => objective.kind === "execute")).toBe(false);
    expect(plan.capabilityPlans[0]?.capabilityId).toBe("outlook.fixture");
    expect(plan.capabilityPlans[0]?.phase).toBe("prepare");
    expect(objectiveKind(plan.capabilityPlans[0]?.input)).toBe("communicate");
  });
});

function cognitionPlan(actionCommitment: number) {
  return createAutonomousToolCognition({ now: () => 1_000 }).plan({
    episodeId: "episode.fixture" as EpisodeId,
    request: "\u03b1\u03b2\u03b3",
    capabilities: capabilities(),
    policy: DEFAULT_POLICY,
    actionCommitment,
    functionalGate: FUNCTIONAL_GATE
  });
}

const FUNCTIONAL_GATE = {
  fc: true,
  efc: true,
  gov: true,
  selectedGoalId: "goal.observed"
} as const;

function capabilities(): Capability[] {
  return [
    {
      id: "filesystem.fixture",
      label: "capability.fixture.1",
      kind: "filesystem",
      mutates: true,
      risk: 0.28,
      requiresApproval: true,
      configured: true,
      metadata: {}
    },
    {
      id: "process.fixture",
      label: "capability.fixture.2",
      kind: "process",
      mutates: false,
      risk: 0.46,
      requiresApproval: true,
      configured: true,
      metadata: {}
    },
    {
      id: "outlook.fixture",
      label: "capability.fixture.3",
      kind: "outlook",
      mutates: true,
      risk: 0.2,
      requiresApproval: true,
      configured: true,
      metadata: {}
    }
  ];
}

function objectiveKind(input: unknown): unknown {
  return record(record(input).objective).kind;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
