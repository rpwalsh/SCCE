import { canonicalStringify } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import type { DurableExecutiveEpisode } from "./executive-journal.js";
import type {
  CapabilityInvocationEnvelope,
  ExecutiveApprovalDecision,
  ExecutiveAuthorityDecision,
  ExecutiveCapabilityReceipt,
  ExecutiveEpisodeId,
  ExecutiveEpisodeState,
  ExecutiveGoal,
  ExecutiveGoalId,
  ExecutiveOutcome,
  ExecutiveTask,
  ExecutiveTaskId
} from "./executive-episode.js";

/**
 * How an executor's invocation behaves under retry/crash: whether the
 * provider itself de-duplicates by idempotency key, whether a stateful
 * lookup can reconcile an unknown outcome, or whether a retry can double
 * the real-world effect.
 */
export type CapabilityIdempotencyContract = "provider-enforced" | "reconcilable" | "non-repeatable";

/** Whether a dispatched capability can be undone, and how. */
export type CapabilityRollbackContract = "supported" | "compensating-action" | "unavailable";

export interface CapabilityExecutorDescriptor {
  capabilityId: string;
  idempotency: CapabilityIdempotencyContract;
  rollback: CapabilityRollbackContract;
}

export interface CapabilityExecutionRequest {
  invocation: CapabilityInvocationEnvelope;
  payload: JsonValue;
}

export interface CapabilityExecutionResult {
  status: "succeeded" | "failed" | "indeterminate";
  outputRefs: string[];
  evidenceRefs: string[];
  attestationRef: string;
}

/**
 * A bounded executor for exactly one capability id. Never called until the
 * executive machine has durably persisted a prepared+dispatched attempt, so
 * a crash between invocation and receipt observation always resumes as
 * "indeterminate" rather than silently forgotten or blindly retried.
 */
export interface CapabilityReconciliationRequest {
  invocation: CapabilityInvocationEnvelope;
  /** The original indeterminate receipt this reconciliation is resolving. */
  indeterminateReceipt: ExecutiveCapabilityReceipt;
}

export interface CapabilityExecutor {
  descriptor: CapabilityExecutorDescriptor;
  execute(request: CapabilityExecutionRequest): Promise<CapabilityExecutionResult>;
  /**
   * Provider-lookup reconciliation for an indeterminate outcome (Part A
   * finding 3 / plan item 42) -- never a blind retry of `execute`. Looks
   * up the real, already-happened-or-not status of a specific
   * invocation (by idempotency key) from the provider itself. Absent
   * means this capability has no reconciliation path yet; the attempt
   * stays indeterminate until one is added or a human resolves it.
   * Must itself resolve to "succeeded" or "failed" -- returning
   * "indeterminate" again is rejected by the state machine.
   */
  reconcile?(request: CapabilityReconciliationRequest): Promise<CapabilityExecutionResult>;
}

export interface CapabilityExecutorRegistry {
  get(capabilityId: string): CapabilityExecutor | undefined;
  list(): readonly CapabilityExecutorDescriptor[];
}

export function createCapabilityExecutorRegistry(executors: readonly CapabilityExecutor[]): CapabilityExecutorRegistry {
  const byId = new Map<string, CapabilityExecutor>();
  for (const executor of executors) {
    if (byId.has(executor.descriptor.capabilityId)) {
      throw new Error(`duplicate capability executor registration: ${executor.descriptor.capabilityId}`);
    }
    byId.set(executor.descriptor.capabilityId, executor);
  }
  return {
    get: capabilityId => byId.get(capabilityId),
    list: () => executors.map(executor => executor.descriptor)
  };
}

export interface CapabilityDispatchInput {
  episodeId: ExecutiveEpisodeId;
  ownerId: string;
  policyVersionId: string;
  goal: Omit<ExecutiveGoal, "status" | "createdAt" | "conclusion">;
  task: Omit<ExecutiveTask, "status" | "createdAt" | "activeAttemptId">;
  /** Supplied only when the task's own controls mark authority as pending. */
  authorityDecision?: ExecutiveAuthorityDecision;
  /** Supplied only when the task's own controls mark approval as pending. */
  approvalDecision?: ExecutiveApprovalDecision;
  payload: JsonValue;
  /** Evidence refs backing the eventual outcome record (e.g. build/test artifact refs). */
  outcomeEvidenceRefs: string[];
}

export type CapabilityDispatchDisposition =
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "unsupported_capability"
  | "not_ready";

export interface CapabilityDispatchResult {
  disposition: CapabilityDispatchDisposition;
  state: ExecutiveEpisodeState;
  attemptId?: string;
  receipt?: ExecutiveCapabilityReceipt;
  outcome?: ExecutiveOutcome;
  /** Present only for "not_ready" -- the task status blocking dispatch. */
  blockedStatus?: ExecutiveTask["status"];
}

export interface CapabilityDispatcherDeps {
  executive: DurableExecutiveEpisode;
  executors: CapabilityExecutorRegistry;
  hasher: Hasher;
  now(): number;
}

/**
 * Drives one capability task through the durable executive state machine:
 * open episode -> declare goal/task -> record authority/approval (if
 * supplied) -> prepare+dispatch the attempt -> invoke the bounded executor
 * -> observe the receipt -> record the outcome (skipped for "indeterminate",
 * which leaves the attempt in the machine's own outcome-pending resume set
 * for later reconciliation rather than guessing).
 *
 * Every command id is deterministic (hash of episode+goal/task+stage), so a
 * retried call after a crash replays as "duplicate" against the journal
 * instead of re-declaring state or re-invoking the executor.
 */
export async function dispatchCapabilityTask(
  deps: CapabilityDispatcherDeps,
  input: CapabilityDispatchInput
): Promise<CapabilityDispatchResult> {
  const executor = deps.executors.get(input.task.capabilityId);
  if (!executor) {
    const state = await deps.executive.load(input.episodeId);
    return { disposition: "unsupported_capability", state };
  }

  const commandId = (stage: string): string =>
    `cmd_${deps.hasher.digestHex(canonicalStringify({ episodeId: input.episodeId, goalId: input.goal.id, taskId: input.task.id, stage })).slice(0, 40)}`;

  let state = await deps.executive.load(input.episodeId);

  if (state.status === "unopened") {
    state = await deps.executive.dispatch({
      type: "open_episode",
      episodeId: input.episodeId,
      commandId: commandId("open_episode"),
      occurredAt: deps.now(),
      ownerId: input.ownerId,
      policyVersionId: input.policyVersionId
    });
  }

  if (!state.goals[input.goal.id]) {
    state = await deps.executive.dispatch({
      type: "declare_goal",
      episodeId: input.episodeId,
      commandId: commandId("declare_goal"),
      occurredAt: deps.now(),
      goal: input.goal
    });
  }

  if (!state.tasks[input.task.id]) {
    state = await deps.executive.dispatch({
      type: "declare_task",
      episodeId: input.episodeId,
      commandId: commandId("declare_task"),
      occurredAt: deps.now(),
      task: input.task
    });
  }

  let task = requireTask(state, input.task.id);

  if (task.controls.authority.state === "pending" && !task.controls.authorityDecision && input.authorityDecision) {
    state = await deps.executive.dispatch({
      type: "record_authority",
      episodeId: input.episodeId,
      commandId: commandId("record_authority"),
      occurredAt: deps.now(),
      taskId: task.id,
      target: "execution",
      decision: input.authorityDecision
    });
    task = requireTask(state, input.task.id);
  }

  if (task.controls.approval.state === "pending" && !task.controls.approvalDecision && input.approvalDecision) {
    state = await deps.executive.dispatch({
      type: "record_approval",
      episodeId: input.episodeId,
      commandId: commandId("record_approval"),
      occurredAt: deps.now(),
      taskId: task.id,
      target: "execution",
      decision: input.approvalDecision
    });
    task = requireTask(state, input.task.id);
  }

  if (task.status === "succeeded" || task.status === "failed") {
    const attempt = latestExecutionAttempt(state, task.id);
    const receipt = attempt?.receiptId ? state.receipts[attempt.receiptId] : undefined;
    const outcome = attempt?.outcomeId ? state.outcomes[attempt.outcomeId] : undefined;
    return { disposition: task.status, state, attemptId: attempt?.id, receipt, outcome };
  }

  if (task.status === "awaiting_outcome") {
    const attempt = latestExecutionAttempt(state, task.id);
    const receipt = attempt?.receiptId ? state.receipts[attempt.receiptId] : undefined;
    return { disposition: "indeterminate", state, attemptId: attempt?.id, receipt };
  }

  if (task.status !== "ready") {
    return { disposition: "not_ready", state, blockedStatus: task.status };
  }

  state = await deps.executive.dispatch({
    type: "prepare_attempt",
    episodeId: input.episodeId,
    commandId: commandId("prepare_attempt"),
    occurredAt: deps.now(),
    taskId: task.id,
    kind: "execution"
  });
  task = requireTask(state, input.task.id);
  const attemptId = task.activeAttemptId;
  if (!attemptId) throw new Error("executive attempt preparation did not activate an attempt");
  const attempt = state.attempts[attemptId];
  if (!attempt) throw new Error("executive attempt preparation lost its own attempt record");

  const dispatchEvidenceRef = `dispatch_${deps.hasher.digestHex(attempt.invocation.idempotencyKey).slice(0, 32)}`;
  state = await deps.executive.dispatch({
    type: "record_dispatch",
    episodeId: input.episodeId,
    commandId: commandId("record_dispatch"),
    occurredAt: deps.now(),
    attemptId,
    executorId: executor.descriptor.capabilityId,
    dispatchEvidenceRef
  });

  let result: CapabilityExecutionResult;
  const startedAt = deps.now();
  try {
    result = await executor.execute({ invocation: attempt.invocation, payload: input.payload });
  } catch (error) {
    result = {
      status: "indeterminate",
      outputRefs: [],
      evidenceRefs: [dispatchEvidenceRef],
      attestationRef: `error_${deps.hasher.digestHex(String(error instanceof Error ? error.message : error)).slice(0, 32)}`
    };
  }

  const receiptId = `receipt_${deps.hasher.digestHex(canonicalStringify({ attemptId, idempotencyKey: attempt.invocation.idempotencyKey })).slice(0, 40)}`;
  const receipt: ExecutiveCapabilityReceipt = {
    id: receiptId,
    attemptId,
    invocationKey: attempt.invocation.idempotencyKey,
    capabilityId: attempt.invocation.capabilityId,
    executorId: executor.descriptor.capabilityId,
    status: result.status,
    startedAt,
    completedAt: deps.now(),
    outputRefs: result.outputRefs,
    evidenceRefs: result.evidenceRefs.length > 0 ? result.evidenceRefs : [dispatchEvidenceRef],
    attestationRef: result.attestationRef
  };
  state = await deps.executive.dispatch({
    type: "observe_receipt",
    episodeId: input.episodeId,
    commandId: commandId("observe_receipt"),
    occurredAt: deps.now(),
    receipt
  });

  if (result.status === "indeterminate") {
    return { disposition: "indeterminate", state, attemptId, receipt };
  }

  const outcomeId = `outcome_${deps.hasher.digestHex(canonicalStringify({ attemptId, receiptId })).slice(0, 40)}`;
  const outcome: Omit<ExecutiveOutcome, "recordedAt"> = {
    id: outcomeId,
    attemptId,
    disposition: result.status === "succeeded" ? "accepted" : "rejected",
    evidenceRefs: input.outcomeEvidenceRefs.length > 0 ? input.outcomeEvidenceRefs : receipt.evidenceRefs,
    testEvidenceRefs: [],
    correctionRefs: [],
    scoreTraceRefs: []
  };
  state = await deps.executive.dispatch({
    type: "record_outcome",
    episodeId: input.episodeId,
    commandId: commandId("record_outcome"),
    occurredAt: deps.now(),
    outcome
  });

  return {
    disposition: result.status === "succeeded" ? "succeeded" : "failed",
    state,
    attemptId,
    receipt,
    outcome: state.outcomes[outcomeId]
  };
}

export type CapabilityReconciliationDisposition =
  | "succeeded"
  | "failed"
  | "still_indeterminate"
  | "not_reconcilable"
  | "not_pending";

export interface CapabilityReconciliationResult {
  disposition: CapabilityReconciliationDisposition;
  state: ExecutiveEpisodeState;
  attemptId?: string;
  receipt?: ExecutiveCapabilityReceipt;
  outcome?: ExecutiveOutcome;
}

/**
 * Resolves one task's indeterminate attempt via the executor's provider
 * lookup (Part A finding 3, plan item 42) -- never a blind retry of
 * `execute`. A lookup is safe to repeat if this call itself gets retried
 * before the reconciliation is durably recorded (checking status is
 * inherently idempotent, unlike `execute`, which is why `execute` gets
 * the full prepare-before-invoke durability treatment and a lookup does
 * not need it). No-ops (returns "not_pending") for a task that isn't
 * actually awaiting an indeterminate outcome, and "not_reconcilable"
 * when the registered executor has no `reconcile` method at all.
 */
export async function reconcileIndeterminateCapability(
  deps: CapabilityDispatcherDeps,
  input: { episodeId: ExecutiveEpisodeId; taskId: ExecutiveTaskId; outcomeEvidenceRefs: string[] }
): Promise<CapabilityReconciliationResult> {
  const initialState = await deps.executive.load(input.episodeId);
  const task = requireTask(initialState, input.taskId);
  if (task.status !== "awaiting_outcome") return { disposition: "not_pending", state: initialState };

  const attempt = latestExecutionAttempt(initialState, task.id);
  if (!attempt?.receiptId) return { disposition: "not_pending", state: initialState };
  const receipt = initialState.receipts[attempt.receiptId];
  if (!receipt || receipt.status !== "indeterminate") return { disposition: "not_pending", state: initialState };

  const executor = deps.executors.get(attempt.invocation.capabilityId);
  if (!executor?.reconcile) return { disposition: "not_reconcilable", state: initialState, attemptId: attempt.id, receipt };

  const commandId = (stage: string): string =>
    `cmd_${deps.hasher.digestHex(canonicalStringify({ episodeId: input.episodeId, taskId: task.id, attemptId: attempt.id, stage })).slice(0, 40)}`;

  let lookup: CapabilityExecutionResult;
  try {
    lookup = await executor.reconcile({ invocation: attempt.invocation, indeterminateReceipt: receipt });
  } catch {
    return { disposition: "still_indeterminate", state: initialState, attemptId: attempt.id, receipt };
  }
  if (lookup.status === "indeterminate") {
    return { disposition: "still_indeterminate", state: initialState, attemptId: attempt.id, receipt };
  }

  const reconciledReceiptId = `receipt_${deps.hasher.digestHex(canonicalStringify({ attemptId: attempt.id, invocationKey: attempt.invocation.idempotencyKey, reconciliation: true })).slice(0, 40)}`;
  const reconciledReceipt: ExecutiveCapabilityReceipt = {
    id: reconciledReceiptId,
    attemptId: attempt.id,
    invocationKey: attempt.invocation.idempotencyKey,
    capabilityId: attempt.invocation.capabilityId,
    executorId: executor.descriptor.capabilityId,
    status: lookup.status,
    startedAt: receipt.startedAt,
    completedAt: deps.now(),
    outputRefs: lookup.outputRefs,
    evidenceRefs: lookup.evidenceRefs.length > 0 ? lookup.evidenceRefs : receipt.evidenceRefs,
    attestationRef: lookup.attestationRef
  };
  let state = await deps.executive.dispatch({
    type: "reconcile_receipt",
    episodeId: input.episodeId,
    commandId: commandId("reconcile_receipt"),
    occurredAt: deps.now(),
    attemptId: attempt.id,
    receipt: reconciledReceipt
  });

  const outcomeId = `outcome_${deps.hasher.digestHex(canonicalStringify({ attemptId: attempt.id, receiptId: reconciledReceiptId })).slice(0, 40)}`;
  const outcome: Omit<ExecutiveOutcome, "recordedAt"> = {
    id: outcomeId,
    attemptId: attempt.id,
    disposition: lookup.status === "succeeded" ? "accepted" : "rejected",
    evidenceRefs: input.outcomeEvidenceRefs.length > 0 ? input.outcomeEvidenceRefs : reconciledReceipt.evidenceRefs,
    testEvidenceRefs: [],
    correctionRefs: [],
    scoreTraceRefs: []
  };
  state = await deps.executive.dispatch({
    type: "record_outcome",
    episodeId: input.episodeId,
    commandId: commandId("record_outcome"),
    occurredAt: deps.now(),
    outcome
  });

  return {
    disposition: lookup.status === "succeeded" ? "succeeded" : "failed",
    state,
    attemptId: attempt.id,
    receipt: reconciledReceipt,
    outcome: state.outcomes[outcomeId]
  };
}

function requireTask(state: ExecutiveEpisodeState, taskId: ExecutiveTaskId): ExecutiveTask {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`executive task not found after declaration: ${taskId}`);
  return task;
}

function latestExecutionAttempt(state: ExecutiveEpisodeState, taskId: ExecutiveTaskId) {
  return Object.values(state.attempts)
    .filter(attempt => attempt.taskId === taskId && attempt.kind === "execution")
    .sort((left, right) => right.ordinal - left.ordinal)[0];
}

// Re-exported for call sites that need to reference a goal id type without importing executive-episode.ts directly.
export type { ExecutiveGoalId };
