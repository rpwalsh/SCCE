/**
 * Plan items 175-176. Real metacognitive control: tracks progress,
 * uncertainty, contradiction, repeated state, and remaining budget across
 * a real snapshot history, and turns a stalled strategy into one
 * traceable control decision (switch/clarify/partial-result/stop) under
 * an explicit budget -- never a silent, undecided continuation.
 */

export interface MetacognitiveSnapshot {
  timestamp: number;
  /** 0..1, how much closer to the goal this snapshot is than the start. */
  progressScore: number;
  uncertainty: number;
  contradictionDetected: boolean;
  /** A canonical key for the current reasoning/search state -- identical keys mean genuinely the same state, not just a similar one. */
  stateSignature: string;
  budgetRemaining: number;
}

export type MetacognitiveControlDecision = "continue" | "switch_strategy" | "clarify" | "partial_result" | "stop";

export interface MetacognitiveControlResult {
  decision: MetacognitiveControlDecision;
  reason: string;
}

export interface MetacognitiveControlPolicy {
  /** Over the last `stallWindow` snapshots, progress must improve by at least this much or the strategy is considered stalled. */
  minimumProgressDeltaPerWindow: number;
  stallWindow: number;
  /** How many of the most recent snapshots (including the latest) sharing the latest's exact stateSignature counts as "repeated state". */
  repeatedStateThreshold: number;
  /** Below this, a stalled strategy is not worth switching -- return what progress exists instead. */
  minimumBudgetForContinue: number;
}

/**
 * Decision priority (checked in this order, each a real, checkable
 * condition over the snapshot history -- not a black-box heuristic):
 * 1. Budget exhausted -> stop.
 * 2. Latest snapshot flags a contradiction -> clarify.
 * 3. State has genuinely repeated `repeatedStateThreshold` times in a row
 *    -> switch_strategy (still has budget to try something different).
 * 4. Progress has stalled over the stall window -> partial_result if
 *    budget is too low to justify switching, otherwise switch_strategy.
 * 5. Otherwise -> continue.
 */
export function evaluateMetacognitiveControl(
  history: readonly MetacognitiveSnapshot[],
  policy: MetacognitiveControlPolicy
): MetacognitiveControlResult {
  if (!history.length) throw new Error("evaluateMetacognitiveControl requires a non-empty snapshot history");
  const ordered = [...history].sort((left, right) => left.timestamp - right.timestamp);
  const latest = ordered[ordered.length - 1]!;

  if (latest.budgetRemaining <= 0) {
    return { decision: "stop", reason: "budget exhausted" };
  }
  if (latest.contradictionDetected) {
    return { decision: "clarify", reason: "latest snapshot detected a contradiction that needs resolution before continuing" };
  }

  const repeatedRun = countTrailingRepeatedState(ordered, latest.stateSignature);
  if (repeatedRun >= policy.repeatedStateThreshold) {
    return {
      decision: "switch_strategy",
      reason: `reasoning state repeated ${repeatedRun} times in a row without changing (threshold ${policy.repeatedStateThreshold})`
    };
  }

  const windowStart = ordered[Math.max(0, ordered.length - policy.stallWindow)]!;
  const progressDelta = latest.progressScore - windowStart.progressScore;
  if (ordered.length >= policy.stallWindow && progressDelta < policy.minimumProgressDeltaPerWindow) {
    if (latest.budgetRemaining < policy.minimumBudgetForContinue) {
      return {
        decision: "partial_result",
        reason: `progress stalled (delta ${progressDelta.toFixed(3)} over ${policy.stallWindow} snapshots) and remaining budget (${latest.budgetRemaining}) is too low to justify switching strategy`
      };
    }
    return {
      decision: "switch_strategy",
      reason: `progress stalled (delta ${progressDelta.toFixed(3)} over ${policy.stallWindow} snapshots, below required ${policy.minimumProgressDeltaPerWindow})`
    };
  }

  return { decision: "continue", reason: "budget available, no contradiction, no repeated state, progress within tolerance" };
}

function countTrailingRepeatedState(ordered: readonly MetacognitiveSnapshot[], signature: string): number {
  let count = 0;
  for (let index = ordered.length - 1; index >= 0; index--) {
    if (ordered[index]!.stateSignature !== signature) break;
    count += 1;
  }
  return count;
}
