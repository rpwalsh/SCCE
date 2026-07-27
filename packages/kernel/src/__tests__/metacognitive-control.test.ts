import { describe, expect, it } from "vitest";
import { evaluateMetacognitiveControl, type MetacognitiveSnapshot } from "../metacognitive-control.js";

const POLICY = {
  minimumProgressDeltaPerWindow: 0.05,
  stallWindow: 3,
  repeatedStateThreshold: 3,
  minimumBudgetForContinue: 2
};

function snapshot(overrides: Partial<MetacognitiveSnapshot> & { timestamp: number }): MetacognitiveSnapshot {
  return {
    progressScore: 0,
    uncertainty: 0.5,
    contradictionDetected: false,
    stateSignature: `state.${overrides.timestamp}`,
    budgetRemaining: 10,
    ...overrides
  };
}

describe("metacognitive control (plan items 175-176)", () => {
  it("continues when there is budget, no contradiction, no repeated state, and healthy progress", () => {
    const history = [
      snapshot({ timestamp: 1, progressScore: 0.1 }),
      snapshot({ timestamp: 2, progressScore: 0.3 }),
      snapshot({ timestamp: 3, progressScore: 0.5 })
    ];
    const result = evaluateMetacognitiveControl(history, POLICY);
    expect(result.decision).toBe("continue");
  });

  it("stops once budget is exhausted, before checking anything else", () => {
    const history = [
      snapshot({ timestamp: 1, progressScore: 0.9, contradictionDetected: true, budgetRemaining: 0 })
    ];
    const result = evaluateMetacognitiveControl(history, POLICY);
    expect(result.decision).toBe("stop");
    expect(result.reason).toMatch(/budget exhausted/);
  });

  it("asks to clarify when the latest snapshot detects a contradiction", () => {
    const history = [
      snapshot({ timestamp: 1, progressScore: 0.4 }),
      snapshot({ timestamp: 2, progressScore: 0.5, contradictionDetected: true, budgetRemaining: 8 })
    ];
    const result = evaluateMetacognitiveControl(history, POLICY);
    expect(result.decision).toBe("clarify");
  });

  it("switches strategy once the reasoning state has genuinely repeated without change", () => {
    const history = [
      snapshot({ timestamp: 1, progressScore: 0.2, stateSignature: "loop-state" }),
      snapshot({ timestamp: 2, progressScore: 0.2, stateSignature: "loop-state" }),
      snapshot({ timestamp: 3, progressScore: 0.2, stateSignature: "loop-state" }),
      snapshot({ timestamp: 4, progressScore: 0.2, stateSignature: "loop-state", budgetRemaining: 9 })
    ];
    const result = evaluateMetacognitiveControl(history, POLICY);
    expect(result.decision).toBe("switch_strategy");
    expect(result.reason).toMatch(/repeated/);
  });

  it("a genuinely stalled strategy (no repeated state, just flat progress) triggers switch_strategy while budget remains healthy", () => {
    const history = [
      snapshot({ timestamp: 1, progressScore: 0.40, budgetRemaining: 10 }),
      snapshot({ timestamp: 2, progressScore: 0.41, budgetRemaining: 8 }),
      snapshot({ timestamp: 3, progressScore: 0.42, budgetRemaining: 6 })
    ];
    const result = evaluateMetacognitiveControl(history, POLICY);
    expect(result.decision).toBe("switch_strategy");
    expect(result.reason).toMatch(/stalled/);
  });

  it("a stalled strategy with too little budget left to justify switching yields partial_result instead", () => {
    const history = [
      snapshot({ timestamp: 1, progressScore: 0.40, budgetRemaining: 3 }),
      snapshot({ timestamp: 2, progressScore: 0.41, budgetRemaining: 2 }),
      snapshot({ timestamp: 3, progressScore: 0.42, budgetRemaining: 1 })
    ];
    const result = evaluateMetacognitiveControl(history, POLICY);
    expect(result.decision).toBe("partial_result");
    expect(result.reason).toMatch(/stalled/);
  });

  it("does not flag a stall before enough snapshots exist to judge the window", () => {
    const history = [snapshot({ timestamp: 1, progressScore: 0.01, budgetRemaining: 10 })];
    const result = evaluateMetacognitiveControl(history, POLICY);
    expect(result.decision).toBe("continue");
  });

  it("rejects an empty snapshot history", () => {
    expect(() => evaluateMetacognitiveControl([], POLICY)).toThrow(/non-empty/);
  });
});
