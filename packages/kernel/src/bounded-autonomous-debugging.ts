import type { ProgramDiagnostic, RepairOperation } from "./program-repair-kernel.js";
import type { Hasher } from "./types.js";
import { canonicalStringify, clamp01, createHasher } from "./primitives.js";
import { evaluateMetacognitiveControl, type MetacognitiveSnapshot } from "./metacognitive-control.js";

/**
 * Plan items 191-193. Bounded autonomous debugging: a real, pure
 * inspect -> hypothesize -> patch -> build -> test -> diagnose -> revise
 * control loop under explicit attempt/wall-clock/mutation budgets. This
 * module owns only the loop's decision state -- it never runs a compiler,
 * a test command, or `program-repair-kernel.ts`'s own hypothesis search
 * itself (those are real I/O, driven from outside by a caller, e.g.
 * `tools/bounded-debugging-live-rehearsal.mjs` for item 194). What this
 * module guarantees, independent of whatever real build/test/repair tools
 * a caller wires in: an identical patch is never proposed twice against
 * the same diagnostic state without new evidence (193), and a genuinely
 * repeated failure -- the same diagnostics recurring after a real patch
 * attempt -- terminates the loop rather than spinning forever (192).
 * Repeated-state and budget-exhaustion termination reuse
 * `metacognitive-control.ts`'s real, already-tested control policy rather
 * than reimplementing it.
 */

export interface BoundedDebugBudget {
  maxAttempts: number;
  maxWallClockMs: number;
  /** Distinct file paths mutated across the whole session, unioned across every attempt. */
  maxMutatedFiles: number;
}

export interface DebugAttemptRecord {
  attemptIndex: number;
  timestamp: number;
  diagnosticsBeforeSignature: string;
  diagnosticsBeforeCount: number;
  operationSetHash: string;
  operationIds: string[];
  mutatedPaths: string[];
  buildSucceeded: boolean;
  testsSucceeded: boolean;
  diagnosticsAfterSignature: string;
  diagnosticsAfterCount: number;
}

export interface BoundedDebugSession {
  budget: BoundedDebugBudget;
  startedAt: number;
  attempts: DebugAttemptRecord[];
  totalMutatedFiles: number;
}

export function createBoundedDebugSession(budget: BoundedDebugBudget, startedAt: number): BoundedDebugSession {
  if (budget.maxAttempts <= 0) throw new Error("maxAttempts must be positive");
  if (budget.maxWallClockMs <= 0) throw new Error("maxWallClockMs must be positive");
  if (budget.maxMutatedFiles <= 0) throw new Error("maxMutatedFiles must be positive");
  return { budget, startedAt, attempts: [], totalMutatedFiles: 0 };
}

function diagnosticsSignature(diagnostics: readonly ProgramDiagnostic[], hasher: Hasher): string {
  const ids = diagnostics
    .map(d => `${d.class}:${d.path ?? ""}:${d.line ?? ""}:${d.column ?? ""}:${d.symbol ?? ""}:${d.message}`)
    .sort();
  return hasher.digestHex(canonicalStringify(ids)).slice(0, 24);
}

function operationSetHash(operations: readonly RepairOperation[], hasher: Hasher): string {
  const ids = operations.map(op => op.id).sort();
  return hasher.digestHex(canonicalStringify(ids)).slice(0, 24);
}

export interface DebugAttemptPlanCheck {
  permitted: boolean;
  reason: string;
  diagnosticsBeforeSignature: string;
  operationSetHash: string;
}

/**
 * Real inspect+hypothesize gate (item 193): before a caller spends effort
 * actually applying a candidate patch, checks whether the attempt budget
 * still allows another attempt, and whether this exact (diagnostic-state,
 * patch) pair has already been tried. A genuinely different patch against
 * the same diagnostics is still permitted -- only an identical patch
 * against an identical prior diagnostic state is refused, since retrying
 * it would produce no new evidence.
 */
export function planDebugAttempt(
  session: BoundedDebugSession,
  diagnosticsBefore: readonly ProgramDiagnostic[],
  candidateOperations: readonly RepairOperation[],
  hasher: Hasher = createHasher()
): DebugAttemptPlanCheck {
  const diagnosticsBeforeSignature = diagnosticsSignature(diagnosticsBefore, hasher);
  const candidateOperationSetHash = operationSetHash(candidateOperations, hasher);
  if (session.attempts.length >= session.budget.maxAttempts) {
    return {
      permitted: false,
      reason: `attempt budget exhausted (${session.budget.maxAttempts} attempts already used)`,
      diagnosticsBeforeSignature,
      operationSetHash: candidateOperationSetHash
    };
  }
  const duplicate = session.attempts.find(
    attempt => attempt.diagnosticsBeforeSignature === diagnosticsBeforeSignature && attempt.operationSetHash === candidateOperationSetHash
  );
  if (duplicate) {
    return {
      permitted: false,
      reason: `identical patch already attempted against this exact diagnostic state at attempt ${duplicate.attemptIndex} -- refusing to repeat without new evidence`,
      diagnosticsBeforeSignature,
      operationSetHash: candidateOperationSetHash
    };
  }
  return { permitted: true, reason: "novel diagnostic state or novel patch hypothesis", diagnosticsBeforeSignature, operationSetHash: candidateOperationSetHash };
}

export interface DebugAttemptInput {
  now: number;
  diagnosticsBefore: readonly ProgramDiagnostic[];
  operations: readonly RepairOperation[];
  mutatedPaths: readonly string[];
  buildSucceeded: boolean;
  testsSucceeded: boolean;
  diagnosticsAfter: readonly ProgramDiagnostic[];
  hasher?: Hasher;
}

export type DebugLoopOutcome =
  | "resolved"
  | "continue"
  | "stopped_repeated_failure"
  | "stopped_budget_exhausted"
  | "stopped_wall_clock_exhausted";

export interface DebugLoopDecision {
  outcome: DebugLoopOutcome;
  reason: string;
}

const DEBUG_LOOP_CONTROL_POLICY = {
  minimumProgressDeltaPerWindow: 0.01,
  stallWindow: 2,
  repeatedStateThreshold: 2,
  minimumBudgetForContinue: 1
};

/**
 * Real record+diagnose step (build -> test -> diagnose -> revise). Appends
 * one completed attempt to the session and decides whether the loop may
 * continue. Throws if called after the budget was already exhausted --
 * callers must consult `planDebugAttempt` first, same as the rest of this
 * codebase's real, checkable preconditions rather than a silent clamp.
 */
export function recordDebugAttempt(
  session: BoundedDebugSession,
  input: DebugAttemptInput
): { session: BoundedDebugSession; decision: DebugLoopDecision } {
  const hasher = input.hasher ?? createHasher();
  if (session.attempts.length >= session.budget.maxAttempts) {
    throw new Error("recordDebugAttempt called after the attempt budget was already exhausted");
  }
  const elapsed = input.now - session.startedAt;
  if (elapsed > session.budget.maxWallClockMs) {
    throw new Error("recordDebugAttempt called after the wall-clock budget was already exceeded");
  }
  const priorMutatedPaths = session.attempts.flatMap(attempt => attempt.mutatedPaths);
  const mutatedUnion = new Set([...priorMutatedPaths, ...input.mutatedPaths]);
  if (mutatedUnion.size > session.budget.maxMutatedFiles) {
    throw new Error(`recording this attempt would mutate ${mutatedUnion.size} distinct files, exceeding the mutation budget of ${session.budget.maxMutatedFiles}`);
  }

  const record: DebugAttemptRecord = {
    attemptIndex: session.attempts.length,
    timestamp: input.now,
    diagnosticsBeforeSignature: diagnosticsSignature(input.diagnosticsBefore, hasher),
    diagnosticsBeforeCount: input.diagnosticsBefore.length,
    operationSetHash: operationSetHash(input.operations, hasher),
    operationIds: input.operations.map(op => op.id),
    mutatedPaths: [...input.mutatedPaths],
    buildSucceeded: input.buildSucceeded,
    testsSucceeded: input.testsSucceeded,
    diagnosticsAfterSignature: diagnosticsSignature(input.diagnosticsAfter, hasher),
    diagnosticsAfterCount: input.diagnosticsAfter.length
  };
  const nextSession: BoundedDebugSession = {
    ...session,
    attempts: [...session.attempts, record],
    totalMutatedFiles: mutatedUnion.size
  };
  return { session: nextSession, decision: decideDebugLoopContinuation(nextSession) };
}

function decideDebugLoopContinuation(session: BoundedDebugSession): DebugLoopDecision {
  const latest = session.attempts[session.attempts.length - 1]!;
  if (latest.buildSucceeded && latest.testsSucceeded && latest.diagnosticsAfterCount === 0) {
    return { outcome: "resolved", reason: "build and tests succeeded with zero remaining diagnostics" };
  }
  if (latest.timestamp - session.startedAt >= session.budget.maxWallClockMs) {
    return { outcome: "stopped_wall_clock_exhausted", reason: `wall-clock budget of ${session.budget.maxWallClockMs}ms reached without resolving all diagnostics` };
  }
  if (session.attempts.length >= session.budget.maxAttempts) {
    return { outcome: "stopped_budget_exhausted", reason: `attempt budget of ${session.budget.maxAttempts} reached without resolving all diagnostics` };
  }

  const initialDiagnosticCount = session.attempts[0]!.diagnosticsBeforeCount || 1;
  const snapshots: MetacognitiveSnapshot[] = session.attempts.map(attempt => ({
    timestamp: attempt.timestamp,
    progressScore: clamp01(1 - attempt.diagnosticsAfterCount / initialDiagnosticCount),
    uncertainty: clamp01(attempt.diagnosticsAfterCount / initialDiagnosticCount),
    contradictionDetected: attempt.buildSucceeded && !attempt.testsSucceeded && attempt.diagnosticsAfterCount === 0,
    stateSignature: attempt.diagnosticsAfterSignature,
    budgetRemaining: session.budget.maxAttempts - (attempt.attemptIndex + 1)
  }));
  const control = evaluateMetacognitiveControl(snapshots, DEBUG_LOOP_CONTROL_POLICY);

  if (control.decision === "stop" || control.decision === "partial_result") {
    return { outcome: "stopped_budget_exhausted", reason: control.reason };
  }
  if (control.decision === "switch_strategy" || control.decision === "clarify") {
    // A fully automated bounded loop has no independent strategy to switch
    // to on its own -- the same diagnostic state recurring after a real
    // patch attempt (or an unresolved contradiction) means this loop must
    // stop rather than spin, matching item 192's literal requirement.
    return { outcome: "stopped_repeated_failure", reason: control.reason };
  }
  return { outcome: "continue", reason: control.reason };
}
