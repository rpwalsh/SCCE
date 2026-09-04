// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { requiresStoredSimulation, simulatePlan, verifyExecutionAuthorized } from "../plan-simulation.js";

// Plan items 177-179. A real, distinct, stored simulation artifact and a
// real gate enforcing it before irreversible/high-risk execution.

describe("requiresStoredSimulation (plan item 178)", () => {
  it("requires simulation for any irreversible plan, regardless of risk", () => {
    expect(requiresStoredSimulation({ reversible: false, expectedRisk: 0 })).toBe(true);
  });

  it("requires simulation for a reversible plan once expected risk clears the real threshold", () => {
    expect(requiresStoredSimulation({ reversible: true, expectedRisk: 0.5 })).toBe(true);
    expect(requiresStoredSimulation({ reversible: true, expectedRisk: 0.49 })).toBe(false);
  });
});

describe("simulatePlan (plan item 178)", () => {
  it("approves an irreversible plan whose expected utility genuinely exceeds its expected risk", () => {
    const record = simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.9, expectedRisk: 0.3, now: 1000 });
    expect(record.approved).toBe(true);
    expect(record.capabilityPlanId).toBe("plan.1");
  });

  it("refuses an irreversible plan whose expected risk meets or exceeds its expected utility -- a real comparison, not a rubber stamp", () => {
    const record = simulatePlan({ capabilityPlanId: "plan.2", reversible: false, expectedUtility: 0.3, expectedRisk: 0.6, now: 1000 });
    expect(record.approved).toBe(false);
    expect(record.reasons[0]).toContain("does not exceed");
  });

  it("a reversible, low-risk plan is approved by default without needing the utility/risk comparison at all", () => {
    const record = simulatePlan({ capabilityPlanId: "plan.3", reversible: true, expectedUtility: 0.1, expectedRisk: 0.1, now: 1000 });
    expect(record.approved).toBe(true);
    expect(record.reasons[0]).toContain("not required");
  });

  it("produces a stable, deterministic id for the same real inputs", () => {
    const a = simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.9, expectedRisk: 0.3, now: 1000 });
    const b = simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.9, expectedRisk: 0.3, now: 1000 });
    expect(a.id).toBe(b.id);
  });
});

describe("verifyExecutionAuthorized (plan item 179)", () => {
  it("refuses execution of an irreversible plan with no stored simulation record at all", () => {
    const result = verifyExecutionAuthorized({ capabilityPlanId: "plan.1", reversible: false, expectedRisk: 0.3, simulations: [] });
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("no stored simulation");
  });

  it("refuses execution when a stored simulation exists but did not approve", () => {
    const simulation = simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.1, expectedRisk: 0.8, now: 1000 });
    const result = verifyExecutionAuthorized({ capabilityPlanId: "plan.1", reversible: false, expectedRisk: 0.8, simulations: [simulation] });
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("did not approve");
  });

  it("authorizes execution once a real, approved, matching stored simulation exists", () => {
    const simulation = simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.9, expectedRisk: 0.2, now: 1000 });
    const result = verifyExecutionAuthorized({ capabilityPlanId: "plan.1", reversible: false, expectedRisk: 0.2, simulations: [simulation] });
    expect(result.authorized).toBe(true);
    expect(result.simulation).toBe(simulation);
  });

  it("a reversible, low-risk plan is authorized without needing any stored simulation at all", () => {
    const result = verifyExecutionAuthorized({ capabilityPlanId: "plan.4", reversible: true, expectedRisk: 0.05, simulations: [] });
    expect(result.authorized).toBe(true);
  });

  it("a stored simulation for a DIFFERENT plan id does not authorize this one -- no cross-plan credit", () => {
    const simulation = simulatePlan({ capabilityPlanId: "plan.other", reversible: false, expectedUtility: 0.9, expectedRisk: 0.1, now: 1000 });
    const result = verifyExecutionAuthorized({ capabilityPlanId: "plan.1", reversible: false, expectedRisk: 0.1, simulations: [simulation] });
    expect(result.authorized).toBe(false);
  });

  it("CRITICAL fix: a stored simulation whose expectedRisk no longer matches the current plan is treated as stale, not authorized", () => {
    const simulation = simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.9, expectedRisk: 0.2, now: 1000 });
    // The plan has since been revised to a materially higher risk under
    // the same id -- the old approval must not carry over.
    const result = verifyExecutionAuthorized({ capabilityPlanId: "plan.1", reversible: false, expectedRisk: 0.9, simulations: [simulation] });
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("stale");
  });

  it("CRITICAL fix: a stored simulation whose reversible flag no longer matches the current plan is treated as stale, not authorized", () => {
    const simulation = simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.9, expectedRisk: 0.2, now: 1000 });
    const result = verifyExecutionAuthorized({ capabilityPlanId: "plan.1", reversible: true, expectedRisk: 0.6, simulations: [simulation] });
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("stale");
  });
});

describe("input validation (CRITICAL fix): NaN/out-of-range risk and utility must never reach authorization logic", () => {
  it("requiresStoredSimulation rejects a NaN expectedRisk rather than silently deciding no simulation is needed", () => {
    expect(() => requiresStoredSimulation({ reversible: true, expectedRisk: Number.NaN })).toThrow(/\[0, 1\]/);
  });

  it("requiresStoredSimulation rejects an out-of-range expectedRisk", () => {
    expect(() => requiresStoredSimulation({ reversible: true, expectedRisk: 1.5 })).toThrow(/\[0, 1\]/);
    expect(() => requiresStoredSimulation({ reversible: true, expectedRisk: -0.1 })).toThrow(/\[0, 1\]/);
  });

  it("simulatePlan rejects NaN/Infinity expectedUtility or expectedRisk instead of leaving a plan wrongly approved", () => {
    expect(() => simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: Number.NaN, expectedRisk: 0.3, now: 1000 })).toThrow(/\[0, 1\]/);
    expect(() => simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: 0.9, expectedRisk: Number.POSITIVE_INFINITY, now: 1000 })).toThrow(/\[0, 1\]/);
    expect(() => simulatePlan({ capabilityPlanId: "plan.1", reversible: false, expectedUtility: -0.5, expectedRisk: 0.3, now: 1000 })).toThrow(/\[0, 1\]/);
  });

  it("verifyExecutionAuthorized rejects a NaN expectedRisk", () => {
    expect(() => verifyExecutionAuthorized({ capabilityPlanId: "plan.1", reversible: false, expectedRisk: Number.NaN, simulations: [] })).toThrow(/\[0, 1\]/);
  });
});
