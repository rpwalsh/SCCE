import { canonicalStringify } from "./primitives.js";
import type { Hasher } from "./types.js";

export type ExecutiveEpisodeId = string;
export type ExecutiveGoalId = string;
export type ExecutiveTaskId = string;
export type ExecutiveAttemptId = string;
export type ExecutiveReceiptId = string;
export type ExecutiveOutcomeId = string;
export type ExecutiveLearningRecordId = string;
export type CapabilityInvocationKey = string;

export type ExecutiveGoalStatus = "active" | "satisfied" | "failed" | "cancelled";
export type ExecutiveTaskStatus =
  | "blocked"
  | "awaiting_authority"
  | "awaiting_approval"
  | "authority_denied"
  | "approval_denied"
  | "ready"
  | "prepared"
  | "in_flight"
  | "awaiting_outcome"
  | "succeeded"
  | "failed"
  | "rollback_blocked"
  | "rollback_ready"
  | "rolling_back"
  | "rolled_back"
  | "rollback_failed"
  | "cancelled";
export type ExecutiveAttemptKind = "execution" | "rollback";
export type ExecutiveAttemptStatus = "prepared" | "in_flight" | "receipt_observed" | "concluded";

export interface ExecutiveAuthorityRequirement {
  authorityClassId: string;
  subjectId: string;
  requiredScopeIds: string[];
  state: "not_required" | "pending";
  justificationRef: string;
}

export interface ExecutiveAuthorityDecision {
  decisionId: string;
  decision: "granted" | "denied";
  authorityClassId: string;
  subjectId: string;
  grantedScopeIds: string[];
  decidedBy: string;
  evidenceRefs: string[];
  expiresAt?: number;
}

export interface ExecutiveApprovalRequirement {
  policyId: string;
  state: "not_required" | "pending";
  approverClassIds: string[];
  justificationRef: string;
}

export interface ExecutiveApprovalDecision {
  decisionId: string;
  decision: "approved" | "denied";
  policyId: string;
  decidedBy: string;
  evidenceRefs: string[];
  expiresAt?: number;
}

export interface ExecutiveControlState {
  authority: ExecutiveAuthorityRequirement;
  authorityDecision?: ExecutiveAuthorityDecision;
  approval: ExecutiveApprovalRequirement;
  approvalDecision?: ExecutiveApprovalDecision;
}

export type ExecutiveRollbackPlan =
  | {
      mode: "not_required";
      justificationRef: string;
    }
  | {
      mode: "unavailable";
      justificationRef: string;
      riskAcceptanceId: string;
      riskAcceptanceEvidenceRefs: string[];
    }
  | {
      mode: "capability";
      planId: string;
      capabilityId: string;
      inputRef: string;
      justificationRef: string;
      controls: ExecutiveControlState;
    };

export interface ExecutiveGoal {
  id: ExecutiveGoalId;
  goalClassId: string;
  objectiveRef: string;
  requirementIds: string[];
  ownerId: string;
  status: ExecutiveGoalStatus;
  createdAt: number;
  conclusion?: {
    disposition: "satisfied" | "failed" | "cancelled";
    outcomeIds: ExecutiveOutcomeId[];
    evidenceRefs: string[];
    concludedAt: number;
  };
}

export interface ExecutiveTask {
  id: ExecutiveTaskId;
  goalId: ExecutiveGoalId;
  taskClassId: string;
  requirementIds: string[];
  dependencyTaskIds: ExecutiveTaskId[];
  capabilityId: string;
  inputRef: string;
  policyVersionId: string;
  controls: ExecutiveControlState;
  rollback: ExecutiveRollbackPlan;
  status: ExecutiveTaskStatus;
  createdAt: number;
  activeAttemptId?: ExecutiveAttemptId;
}

export interface CapabilityInvocationEnvelope {
  episodeId: ExecutiveEpisodeId;
  goalId: ExecutiveGoalId;
  taskId: ExecutiveTaskId;
  attemptId: ExecutiveAttemptId;
  attemptKind: ExecutiveAttemptKind;
  attemptOrdinal: number;
  capabilityId: string;
  inputRef: string;
  idempotencyKey: CapabilityInvocationKey;
  policyVersionId: string;
  authorityDecisionId?: string;
  approvalDecisionId?: string;
  rollbackPlanId?: string;
}

export interface ExecutiveAttempt {
  id: ExecutiveAttemptId;
  taskId: ExecutiveTaskId;
  kind: ExecutiveAttemptKind;
  ordinal: number;
  status: ExecutiveAttemptStatus;
  invocation: CapabilityInvocationEnvelope;
  preparedAt: number;
  dispatchedAt?: number;
  executorId?: string;
  dispatchEvidenceRef?: string;
  receiptId?: ExecutiveReceiptId;
  outcomeId?: ExecutiveOutcomeId;
}

export interface ExecutiveCapabilityReceipt {
  id: ExecutiveReceiptId;
  attemptId: ExecutiveAttemptId;
  invocationKey: CapabilityInvocationKey;
  capabilityId: string;
  executorId: string;
  status: "succeeded" | "failed" | "indeterminate";
  startedAt: number;
  completedAt: number;
  outputRefs: string[];
  evidenceRefs: string[];
  attestationRef: string;
}

export interface ExecutiveOutcome {
  id: ExecutiveOutcomeId;
  attemptId: ExecutiveAttemptId;
  disposition: "accepted" | "rejected" | "partial" | "unknown";
  evidenceRefs: string[];
  testEvidenceRefs: string[];
  correctionRefs: string[];
  scoreTraceRefs: string[];
  reward?: {
    value: number;
    basisRef: string;
  };
  recordedAt: number;
}

export interface ExecutiveOutcomeLearningRecord {
  id: ExecutiveLearningRecordId;
  episodeId: ExecutiveEpisodeId;
  goalId: ExecutiveGoalId;
  taskId: ExecutiveTaskId;
  taskClassId: string;
  capabilityId: string;
  policyVersionId: string;
  attemptId: ExecutiveAttemptId;
  attemptKind: ExecutiveAttemptKind;
  outcomeId: ExecutiveOutcomeId;
  disposition: ExecutiveOutcome["disposition"];
  receiptStatus: ExecutiveCapabilityReceipt["status"];
  evidenceRefs: string[];
  testEvidenceRefs: string[];
  correctionRefs: string[];
  scoreTraceRefs: string[];
  reward?: ExecutiveOutcome["reward"];
  recordedAt: number;
}

export interface ExecutiveEpisodeState {
  id: ExecutiveEpisodeId;
  revision: number;
  status: "unopened" | "open" | "closed";
  ownerId?: string;
  policyVersionId?: string;
  openedAt?: number;
  closedAt?: number;
  goals: Record<ExecutiveGoalId, ExecutiveGoal>;
  tasks: Record<ExecutiveTaskId, ExecutiveTask>;
  attempts: Record<ExecutiveAttemptId, ExecutiveAttempt>;
  receipts: Record<ExecutiveReceiptId, ExecutiveCapabilityReceipt>;
  outcomes: Record<ExecutiveOutcomeId, ExecutiveOutcome>;
  learningRecords: Record<ExecutiveLearningRecordId, ExecutiveOutcomeLearningRecord>;
  appliedCommandIds: Record<string, true>;
}

interface ExecutiveCommandBase {
  episodeId: ExecutiveEpisodeId;
  commandId: string;
  occurredAt: number;
}

export type ExecutiveCommand =
  | (ExecutiveCommandBase & {
      type: "open_episode";
      ownerId: string;
      policyVersionId: string;
    })
  | (ExecutiveCommandBase & {
      type: "declare_goal";
      goal: Omit<ExecutiveGoal, "status" | "createdAt" | "conclusion">;
    })
  | (ExecutiveCommandBase & {
      type: "declare_task";
      task: Omit<ExecutiveTask, "status" | "createdAt" | "activeAttemptId">;
    })
  | (ExecutiveCommandBase & {
      type: "record_authority";
      taskId: ExecutiveTaskId;
      target: ExecutiveAttemptKind;
      decision: ExecutiveAuthorityDecision;
    })
  | (ExecutiveCommandBase & {
      type: "record_approval";
      taskId: ExecutiveTaskId;
      target: ExecutiveAttemptKind;
      decision: ExecutiveApprovalDecision;
    })
  | (ExecutiveCommandBase & {
      type: "prepare_attempt";
      taskId: ExecutiveTaskId;
      kind: ExecutiveAttemptKind;
    })
  | (ExecutiveCommandBase & {
      type: "record_dispatch";
      attemptId: ExecutiveAttemptId;
      executorId: string;
      dispatchEvidenceRef: string;
    })
  | (ExecutiveCommandBase & {
      type: "observe_receipt";
      receipt: ExecutiveCapabilityReceipt;
    })
  | (ExecutiveCommandBase & {
      type: "record_outcome";
      outcome: Omit<ExecutiveOutcome, "recordedAt">;
    })
  | (ExecutiveCommandBase & {
      type: "conclude_goal";
      goalId: ExecutiveGoalId;
      disposition: "satisfied" | "failed" | "cancelled";
      outcomeIds: ExecutiveOutcomeId[];
      evidenceRefs: string[];
    });

interface ExecutiveEventBase {
  id: string;
  episodeId: ExecutiveEpisodeId;
  commandId: string;
  revision: number;
  occurredAt: number;
}

export type ExecutiveEvent =
  | (ExecutiveEventBase & {
      type: "episode_opened";
      ownerId: string;
      policyVersionId: string;
    })
  | (ExecutiveEventBase & {
      type: "goal_declared";
      goal: ExecutiveGoal;
    })
  | (ExecutiveEventBase & {
      type: "task_declared";
      task: ExecutiveTask;
    })
  | (ExecutiveEventBase & {
      type: "authority_recorded";
      taskId: ExecutiveTaskId;
      target: ExecutiveAttemptKind;
      decision: ExecutiveAuthorityDecision;
    })
  | (ExecutiveEventBase & {
      type: "approval_recorded";
      taskId: ExecutiveTaskId;
      target: ExecutiveAttemptKind;
      decision: ExecutiveApprovalDecision;
    })
  | (ExecutiveEventBase & {
      type: "attempt_prepared";
      attempt: ExecutiveAttempt;
    })
  | (ExecutiveEventBase & {
      type: "attempt_dispatched";
      attemptId: ExecutiveAttemptId;
      executorId: string;
      dispatchEvidenceRef: string;
    })
  | (ExecutiveEventBase & {
      type: "capability_receipt_observed";
      receipt: ExecutiveCapabilityReceipt;
    })
  | (ExecutiveEventBase & {
      type: "outcome_recorded";
      outcome: ExecutiveOutcome;
    })
  | (ExecutiveEventBase & {
      type: "outcome_learning_recorded";
      learningRecord: ExecutiveOutcomeLearningRecord;
    })
  | (ExecutiveEventBase & {
      type: "goal_concluded";
      goalId: ExecutiveGoalId;
      disposition: "satisfied" | "failed" | "cancelled";
      outcomeIds: ExecutiveOutcomeId[];
      evidenceRefs: string[];
    })
  | (ExecutiveEventBase & {
      type: "episode_closed";
    });

type ExecutiveEventPayload = ExecutiveEvent extends infer Event
  ? Event extends ExecutiveEvent
    ? Omit<Event, keyof ExecutiveEventBase>
    : never
  : never;

export interface ExecutiveEpisodeMachine {
  initial(episodeId: ExecutiveEpisodeId): ExecutiveEpisodeState;
  decide(state: ExecutiveEpisodeState, command: ExecutiveCommand): ExecutiveEvent[];
  apply(state: ExecutiveEpisodeState, event: ExecutiveEvent): ExecutiveEpisodeState;
  replay(episodeId: ExecutiveEpisodeId, events: readonly ExecutiveEvent[]): ExecutiveEpisodeState;
}

export interface ExecutiveResumePlan {
  invocations: CapabilityInvocationEnvelope[];
  outcomePendingAttemptIds: ExecutiveAttemptId[];
  readyTaskIds: ExecutiveTaskId[];
  rollbackReadyTaskIds: ExecutiveTaskId[];
}

export function createExecutiveEpisodeMachine(hasher: Hasher): ExecutiveEpisodeMachine {
  const initial = (episodeId: ExecutiveEpisodeId): ExecutiveEpisodeState => ({
    id: episodeId,
    revision: 0,
    status: "unopened",
    goals: {},
    tasks: {},
    attempts: {},
    receipts: {},
    outcomes: {},
    learningRecords: {},
    appliedCommandIds: {}
  });

  const decide = (state: ExecutiveEpisodeState, command: ExecutiveCommand): ExecutiveEvent[] => {
    assertIdentifier(command.episodeId, "episodeId");
    assertIdentifier(command.commandId, "commandId");
    assertTime(command.occurredAt, "occurredAt");
    if (command.episodeId !== state.id) throw new Error("executive command episode mismatch");
    if (state.appliedCommandIds[command.commandId]) return [];

    const pending: ExecutiveEventPayload[] = [];
    const emit = (event: ExecutiveEventPayload) => pending.push(event);

    if (command.type !== "open_episode") {
      if (state.status === "unopened") throw new Error("executive episode is not open");
      if (state.status === "closed") throw new Error("executive episode is closed");
    }

    switch (command.type) {
      case "open_episode": {
        if (state.status !== "unopened") throw new Error("executive episode already opened");
        assertIdentifier(command.ownerId, "ownerId");
        assertIdentifier(command.policyVersionId, "policyVersionId");
        emit({ type: "episode_opened", ownerId: command.ownerId, policyVersionId: command.policyVersionId });
        break;
      }
      case "declare_goal": {
        validateGoal(command.goal);
        if (state.goals[command.goal.id]) throw new Error(`executive goal already exists: ${command.goal.id}`);
        emit({
          type: "goal_declared",
          goal: { ...command.goal, requirementIds: unique(command.goal.requirementIds), status: "active", createdAt: command.occurredAt }
        });
        break;
      }
      case "declare_task": {
        validateTask(command.task);
        const goal = requireGoal(state, command.task.goalId);
        if (goal.status !== "active") throw new Error("cannot add a task to a concluded goal");
        if (state.tasks[command.task.id]) throw new Error(`executive task already exists: ${command.task.id}`);
        for (const dependencyId of command.task.dependencyTaskIds) {
          const dependency = requireTask(state, dependencyId);
          if (dependency.goalId !== command.task.goalId) throw new Error("task dependencies must belong to the same goal");
        }
        const task: ExecutiveTask = {
          ...command.task,
          requirementIds: unique(command.task.requirementIds),
          dependencyTaskIds: unique(command.task.dependencyTaskIds),
          controls: cloneControls(command.task.controls),
          rollback: cloneRollback(command.task.rollback),
          status: initialTaskStatus(state, command.task),
          createdAt: command.occurredAt
        };
        emit({ type: "task_declared", task });
        break;
      }
      case "record_authority": {
        const task = requireTask(state, command.taskId);
        const controls = controlsFor(task, command.target);
        validateAuthorityDecision(controls.authority, command.decision, command.occurredAt);
        if (controls.authority.state !== "pending") throw new Error("authority is explicitly not required");
        if (controls.authorityDecision) throw new Error("authority decision already recorded");
        emit({ type: "authority_recorded", taskId: task.id, target: command.target, decision: clone(command.decision) });
        break;
      }
      case "record_approval": {
        const task = requireTask(state, command.taskId);
        const controls = controlsFor(task, command.target);
        validateApprovalDecision(controls.approval, command.decision, command.occurredAt);
        if (controls.approval.state !== "pending") throw new Error("approval is explicitly not required");
        if (controls.approvalDecision) throw new Error("approval decision already recorded");
        emit({ type: "approval_recorded", taskId: task.id, target: command.target, decision: clone(command.decision) });
        break;
      }
      case "prepare_attempt": {
        const task = requireTask(state, command.taskId);
        const readiness = taskReadiness(state, task, command.kind, command.occurredAt);
        if (readiness !== "ready") throw new Error(`executive ${command.kind} attempt is not ready: ${readiness}`);
        if (task.activeAttemptId) throw new Error("task already has an active attempt");
        const ordinal = Object.values(state.attempts).filter(attempt => attempt.taskId === task.id && attempt.kind === command.kind).length + 1;
        const capability = capabilityFor(task, command.kind);
        const attemptId = executiveId(hasher, "attempt", { episodeId: state.id, taskId: task.id, kind: command.kind, ordinal });
        const idempotencyKey = executiveId(hasher, "invocation", {
          episodeId: state.id,
          taskId: task.id,
          kind: command.kind,
          ordinal,
          capabilityId: capability.capabilityId,
          inputRef: capability.inputRef,
          policyVersionId: task.policyVersionId
        });
        const controls = controlsFor(task, command.kind);
        const attempt: ExecutiveAttempt = {
          id: attemptId,
          taskId: task.id,
          kind: command.kind,
          ordinal,
          status: "prepared",
          invocation: {
            episodeId: state.id,
            goalId: task.goalId,
            taskId: task.id,
            attemptId,
            attemptKind: command.kind,
            attemptOrdinal: ordinal,
            capabilityId: capability.capabilityId,
            inputRef: capability.inputRef,
            idempotencyKey,
            policyVersionId: task.policyVersionId,
            authorityDecisionId: controls.authorityDecision?.decisionId,
            approvalDecisionId: controls.approvalDecision?.decisionId,
            rollbackPlanId: command.kind === "rollback" && task.rollback.mode === "capability" ? task.rollback.planId : undefined
          },
          preparedAt: command.occurredAt
        };
        emit({ type: "attempt_prepared", attempt });
        break;
      }
      case "record_dispatch": {
        const attempt = requireAttempt(state, command.attemptId);
        if (attempt.status !== "prepared") throw new Error("only a prepared attempt can be dispatched");
        assertIdentifier(command.executorId, "executorId");
        assertIdentifier(command.dispatchEvidenceRef, "dispatchEvidenceRef");
        emit({
          type: "attempt_dispatched",
          attemptId: attempt.id,
          executorId: command.executorId,
          dispatchEvidenceRef: command.dispatchEvidenceRef
        });
        break;
      }
      case "observe_receipt": {
        validateReceipt(command.receipt);
        const attempt = requireAttempt(state, command.receipt.attemptId);
        if (attempt.status !== "prepared" && attempt.status !== "in_flight") {
          throw new Error("receipt can only conclude a prepared or in-flight attempt");
        }
        if (attempt.invocation.idempotencyKey !== command.receipt.invocationKey) throw new Error("receipt invocation key mismatch");
        if (attempt.invocation.capabilityId !== command.receipt.capabilityId) throw new Error("receipt capability mismatch");
        if (attempt.executorId && attempt.executorId !== command.receipt.executorId) throw new Error("receipt executor mismatch");
        if (state.receipts[command.receipt.id]) throw new Error(`executive receipt already exists: ${command.receipt.id}`);
        emit({ type: "capability_receipt_observed", receipt: clone(command.receipt) });
        break;
      }
      case "record_outcome": {
        validateOutcome(command.outcome);
        const attempt = requireAttempt(state, command.outcome.attemptId);
        if (attempt.status !== "receipt_observed" || !attempt.receiptId) throw new Error("outcome requires an observed capability receipt");
        if (state.outcomes[command.outcome.id]) throw new Error(`executive outcome already exists: ${command.outcome.id}`);
        const receipt = state.receipts[attempt.receiptId];
        if (!receipt) throw new Error("attempt receipt is unavailable");
        validateOutcomeAgainstReceipt(command.outcome, receipt);
        const task = requireTask(state, attempt.taskId);
        const outcome: ExecutiveOutcome = { ...clone(command.outcome), recordedAt: command.occurredAt };
        const learningRecord: ExecutiveOutcomeLearningRecord = {
          id: executiveId(hasher, "outcome_learning", { episodeId: state.id, taskId: task.id, attemptId: attempt.id, outcomeId: outcome.id }),
          episodeId: state.id,
          goalId: task.goalId,
          taskId: task.id,
          taskClassId: task.taskClassId,
          capabilityId: attempt.invocation.capabilityId,
          policyVersionId: task.policyVersionId,
          attemptId: attempt.id,
          attemptKind: attempt.kind,
          outcomeId: outcome.id,
          disposition: outcome.disposition,
          receiptStatus: receipt.status,
          evidenceRefs: [...outcome.evidenceRefs],
          testEvidenceRefs: [...outcome.testEvidenceRefs],
          correctionRefs: [...outcome.correctionRefs],
          scoreTraceRefs: [...outcome.scoreTraceRefs],
          reward: outcome.reward ? { ...outcome.reward } : undefined,
          recordedAt: command.occurredAt
        };
        emit({ type: "outcome_recorded", outcome });
        emit({ type: "outcome_learning_recorded", learningRecord });
        break;
      }
      case "conclude_goal": {
        const goal = requireGoal(state, command.goalId);
        if (goal.status !== "active") throw new Error("goal already concluded");
        const goalTasks = Object.values(state.tasks).filter(task => task.goalId === goal.id);
        if (goalTasks.some(task => !isTerminalTask(task.status))) throw new Error("goal has non-terminal tasks");
        for (const outcomeId of command.outcomeIds) {
          const outcome = state.outcomes[outcomeId];
          if (!outcome) throw new Error(`executive outcome not found: ${outcomeId}`);
          const attempt = requireAttempt(state, outcome.attemptId);
          if (requireTask(state, attempt.taskId).goalId !== goal.id) throw new Error("goal conclusion references an unrelated outcome");
        }
        if (command.disposition === "satisfied" && goalTasks.some(task => task.status !== "succeeded")) {
          throw new Error("a satisfied goal requires every task to succeed");
        }
        if (command.disposition !== "cancelled" && command.outcomeIds.length === 0) {
          throw new Error("a concluded goal requires outcome evidence");
        }
        if (command.evidenceRefs.length === 0) throw new Error("goal conclusion requires evidence references");
        emit({
          type: "goal_concluded",
          goalId: goal.id,
          disposition: command.disposition,
          outcomeIds: unique(command.outcomeIds),
          evidenceRefs: unique(command.evidenceRefs)
        });
        if (Object.values(state.goals).every(candidate => candidate.id === goal.id || candidate.status !== "active")) {
          emit({ type: "episode_closed" });
        }
        break;
      }
    }

    return pending.map((event, index) => ({
      ...event,
      id: executiveId(hasher, "event", { episodeId: state.id, commandId: command.commandId, index, type: event.type }),
      episodeId: state.id,
      commandId: command.commandId,
      revision: state.revision + index + 1,
      occurredAt: command.occurredAt
    })) as ExecutiveEvent[];
  };

  const apply = (previous: ExecutiveEpisodeState, event: ExecutiveEvent): ExecutiveEpisodeState => {
    if (event.episodeId !== previous.id) throw new Error("executive event episode mismatch");
    if (event.revision !== previous.revision + 1) throw new Error("executive event revision gap");
    const state = clone(previous);
    state.revision = event.revision;
    state.appliedCommandIds[event.commandId] = true;

    switch (event.type) {
      case "episode_opened":
        state.status = "open";
        state.ownerId = event.ownerId;
        state.policyVersionId = event.policyVersionId;
        state.openedAt = event.occurredAt;
        break;
      case "goal_declared":
        state.goals[event.goal.id] = clone(event.goal);
        break;
      case "task_declared":
        state.tasks[event.task.id] = clone(event.task);
        refreshTaskStatuses(state, event.occurredAt);
        break;
      case "authority_recorded": {
        const task = requireTask(state, event.taskId);
        const controls = controlsFor(task, event.target);
        controls.authorityDecision = clone(event.decision);
        refreshControlStatus(state, task, event.target, event.occurredAt);
        break;
      }
      case "approval_recorded": {
        const task = requireTask(state, event.taskId);
        const controls = controlsFor(task, event.target);
        controls.approvalDecision = clone(event.decision);
        refreshControlStatus(state, task, event.target, event.occurredAt);
        break;
      }
      case "attempt_prepared": {
        state.attempts[event.attempt.id] = clone(event.attempt);
        const task = requireTask(state, event.attempt.taskId);
        task.activeAttemptId = event.attempt.id;
        task.status = event.attempt.kind === "execution" ? "prepared" : "rollback_ready";
        break;
      }
      case "attempt_dispatched": {
        const attempt = requireAttempt(state, event.attemptId);
        attempt.status = "in_flight";
        attempt.dispatchedAt = event.occurredAt;
        attempt.executorId = event.executorId;
        attempt.dispatchEvidenceRef = event.dispatchEvidenceRef;
        requireTask(state, attempt.taskId).status = attempt.kind === "execution" ? "in_flight" : "rolling_back";
        break;
      }
      case "capability_receipt_observed": {
        state.receipts[event.receipt.id] = clone(event.receipt);
        const attempt = requireAttempt(state, event.receipt.attemptId);
        attempt.status = "receipt_observed";
        attempt.receiptId = event.receipt.id;
        requireTask(state, attempt.taskId).status = "awaiting_outcome";
        break;
      }
      case "outcome_recorded": {
        state.outcomes[event.outcome.id] = clone(event.outcome);
        const attempt = requireAttempt(state, event.outcome.attemptId);
        const task = requireTask(state, attempt.taskId);
        const receipt = attempt.receiptId ? state.receipts[attempt.receiptId] : undefined;
        if (!receipt) throw new Error("outcome event has no receipt");
        attempt.status = "concluded";
        attempt.outcomeId = event.outcome.id;
        task.activeAttemptId = undefined;
        const accepted = receipt.status === "succeeded" && event.outcome.disposition === "accepted";
        if (attempt.kind === "rollback") {
          task.status = accepted ? "rolled_back" : "rollback_failed";
        } else if (accepted) {
          task.status = "succeeded";
        } else if (task.rollback.mode === "capability") {
          const readiness = controlReadiness(task.rollback.controls, event.occurredAt);
          task.status = readiness === "ready"
            ? "rollback_ready"
            : readiness === "authority_denied" || readiness === "approval_denied"
              ? "rollback_failed"
              : "rollback_blocked";
        } else {
          task.status = "failed";
        }
        refreshTaskStatuses(state, event.occurredAt);
        break;
      }
      case "outcome_learning_recorded":
        state.learningRecords[event.learningRecord.id] = clone(event.learningRecord);
        break;
      case "goal_concluded": {
        const goal = requireGoal(state, event.goalId);
        goal.status = event.disposition;
        goal.conclusion = {
          disposition: event.disposition,
          outcomeIds: [...event.outcomeIds],
          evidenceRefs: [...event.evidenceRefs],
          concludedAt: event.occurredAt
        };
        break;
      }
      case "episode_closed":
        state.status = "closed";
        state.closedAt = event.occurredAt;
        break;
    }
    return state;
  };

  const replay = (episodeId: ExecutiveEpisodeId, events: readonly ExecutiveEvent[]): ExecutiveEpisodeState =>
    events.reduce((state, event) => apply(state, event), initial(episodeId));

  return { initial, decide, apply, replay };
}

export function resumableCapabilityInvocations(state: ExecutiveEpisodeState): CapabilityInvocationEnvelope[] {
  return Object.values(state.attempts)
    .filter(attempt => attempt.status === "prepared" || attempt.status === "in_flight")
    .sort((left, right) => left.preparedAt - right.preparedAt || left.id.localeCompare(right.id))
    .map(attempt => clone(attempt.invocation));
}

export function executiveResumePlan(state: ExecutiveEpisodeState): ExecutiveResumePlan {
  return {
    invocations: resumableCapabilityInvocations(state),
    outcomePendingAttemptIds: Object.values(state.attempts)
      .filter(attempt => attempt.status === "receipt_observed")
      .map(attempt => attempt.id)
      .sort(),
    readyTaskIds: Object.values(state.tasks)
      .filter(task => task.status === "ready")
      .map(task => task.id)
      .sort(),
    rollbackReadyTaskIds: Object.values(state.tasks)
      .filter(task => task.status === "rollback_ready")
      .map(task => task.id)
      .sort()
  };
}

function controlsFor(task: ExecutiveTask, kind: ExecutiveAttemptKind): ExecutiveControlState {
  if (kind === "execution") return task.controls;
  if (task.rollback.mode !== "capability") throw new Error("task has no rollback capability");
  return task.rollback.controls;
}

function capabilityFor(task: ExecutiveTask, kind: ExecutiveAttemptKind): { capabilityId: string; inputRef: string } {
  if (kind === "execution") return { capabilityId: task.capabilityId, inputRef: task.inputRef };
  if (task.rollback.mode !== "capability") throw new Error("task has no rollback capability");
  return { capabilityId: task.rollback.capabilityId, inputRef: task.rollback.inputRef };
}

function initialTaskStatus(state: ExecutiveEpisodeState, task: Omit<ExecutiveTask, "status" | "createdAt" | "activeAttemptId">): ExecutiveTaskStatus {
  if (task.dependencyTaskIds.some(id => state.tasks[id]?.status !== "succeeded")) return "blocked";
  return controlReadiness(task.controls, Number.NEGATIVE_INFINITY);
}

function taskReadiness(
  state: ExecutiveEpisodeState,
  task: ExecutiveTask,
  kind: ExecutiveAttemptKind,
  at: number
): "ready" | "blocked" | "awaiting_authority" | "awaiting_approval" | "authority_denied" | "approval_denied" {
  if (kind === "execution") {
    if (task.dependencyTaskIds.some(id => state.tasks[id]?.status !== "succeeded")) return "blocked";
    if (!["blocked", "awaiting_authority", "awaiting_approval", "authority_denied", "approval_denied", "ready"].includes(task.status)) {
      return "blocked";
    }
  } else if (task.status !== "rollback_ready" && task.status !== "rollback_blocked") {
    return "blocked";
  }
  return controlReadiness(controlsFor(task, kind), at);
}

function controlReadiness(
  controls: ExecutiveControlState,
  at: number
): "ready" | "awaiting_authority" | "awaiting_approval" | "authority_denied" | "approval_denied" {
  if (controls.authority.state === "pending") {
    const decision = controls.authorityDecision;
    if (decision?.decision === "denied") return "authority_denied";
    if (!decision || isExpired(decision.expiresAt, at)) return "awaiting_authority";
  }
  if (controls.approval.state === "pending") {
    const decision = controls.approvalDecision;
    if (decision?.decision === "denied") return "approval_denied";
    if (!decision || isExpired(decision.expiresAt, at)) return "awaiting_approval";
  }
  return "ready";
}

function refreshControlStatus(
  state: ExecutiveEpisodeState,
  task: ExecutiveTask,
  target: ExecutiveAttemptKind,
  at: number
): void {
  if (target === "execution") {
    refreshTaskStatuses(state, at);
    return;
  }
  if (task.status !== "rollback_blocked" && task.status !== "rollback_ready") return;
  const readiness = controlReadiness(controlsFor(task, "rollback"), at);
  task.status = readiness === "ready"
    ? "rollback_ready"
    : readiness === "authority_denied" || readiness === "approval_denied"
      ? "rollback_failed"
      : "rollback_blocked";
}

function refreshTaskStatuses(state: ExecutiveEpisodeState, at: number): void {
  for (const task of Object.values(state.tasks)) {
    if (!["blocked", "awaiting_authority", "awaiting_approval", "authority_denied", "approval_denied", "ready"].includes(task.status)) continue;
    task.status = task.dependencyTaskIds.some(id => state.tasks[id]?.status !== "succeeded")
      ? "blocked"
      : controlReadiness(task.controls, at);
  }
}

function isExpired(expiresAt: number | undefined, at: number): boolean {
  return expiresAt !== undefined && Number.isFinite(at) && at >= expiresAt;
}

function isTerminalTask(status: ExecutiveTaskStatus): boolean {
  return ["succeeded", "failed", "authority_denied", "approval_denied", "rolled_back", "rollback_failed", "cancelled"].includes(status);
}

function requireGoal(state: ExecutiveEpisodeState, goalId: ExecutiveGoalId): ExecutiveGoal {
  const goal = state.goals[goalId];
  if (!goal) throw new Error(`executive goal not found: ${goalId}`);
  return goal;
}

function requireTask(state: ExecutiveEpisodeState, taskId: ExecutiveTaskId): ExecutiveTask {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`executive task not found: ${taskId}`);
  return task;
}

function requireAttempt(state: ExecutiveEpisodeState, attemptId: ExecutiveAttemptId): ExecutiveAttempt {
  const attempt = state.attempts[attemptId];
  if (!attempt) throw new Error(`executive attempt not found: ${attemptId}`);
  return attempt;
}

function validateGoal(goal: Omit<ExecutiveGoal, "status" | "createdAt" | "conclusion">): void {
  assertIdentifier(goal.id, "goal.id");
  assertIdentifier(goal.goalClassId, "goal.goalClassId");
  assertIdentifier(goal.objectiveRef, "goal.objectiveRef");
  assertIdentifier(goal.ownerId, "goal.ownerId");
  assertIdentifierList(goal.requirementIds, "goal.requirementIds");
}

function validateTask(task: Omit<ExecutiveTask, "status" | "createdAt" | "activeAttemptId">): void {
  assertIdentifier(task.id, "task.id");
  assertIdentifier(task.goalId, "task.goalId");
  assertIdentifier(task.taskClassId, "task.taskClassId");
  assertIdentifier(task.capabilityId, "task.capabilityId");
  assertIdentifier(task.inputRef, "task.inputRef");
  assertIdentifier(task.policyVersionId, "task.policyVersionId");
  assertIdentifierList(task.requirementIds, "task.requirementIds");
  assertIdentifierList(task.dependencyTaskIds, "task.dependencyTaskIds");
  if (task.dependencyTaskIds.includes(task.id)) throw new Error("task cannot depend on itself");
  validateControls(task.controls, "task.controls");
  validateRollback(task.rollback);
}

function validateControls(controls: ExecutiveControlState, path: string): void {
  assertIdentifier(controls.authority.authorityClassId, `${path}.authority.authorityClassId`);
  assertIdentifier(controls.authority.subjectId, `${path}.authority.subjectId`);
  assertIdentifier(controls.authority.justificationRef, `${path}.authority.justificationRef`);
  assertIdentifierList(controls.authority.requiredScopeIds, `${path}.authority.requiredScopeIds`);
  assertIdentifier(controls.approval.policyId, `${path}.approval.policyId`);
  assertIdentifier(controls.approval.justificationRef, `${path}.approval.justificationRef`);
  assertIdentifierList(controls.approval.approverClassIds, `${path}.approval.approverClassIds`);
  if (controls.authority.state === "not_required" && controls.authorityDecision) {
    throw new Error(`${path} cannot decide authority that is not required`);
  }
  if (controls.approval.state === "not_required" && controls.approvalDecision) {
    throw new Error(`${path} cannot decide approval that is not required`);
  }
  if (controls.authorityDecision || controls.approvalDecision) {
    throw new Error(`${path} decisions must be recorded as executive events`);
  }
}

function validateRollback(rollback: ExecutiveRollbackPlan): void {
  assertIdentifier(rollback.justificationRef, "task.rollback.justificationRef");
  if (rollback.mode === "unavailable") {
    assertIdentifier(rollback.riskAcceptanceId, "task.rollback.riskAcceptanceId");
    if (rollback.riskAcceptanceEvidenceRefs.length === 0) throw new Error("unavailable rollback requires risk acceptance evidence");
    assertIdentifierList(rollback.riskAcceptanceEvidenceRefs, "task.rollback.riskAcceptanceEvidenceRefs");
  }
  if (rollback.mode === "capability") {
    assertIdentifier(rollback.planId, "task.rollback.planId");
    assertIdentifier(rollback.capabilityId, "task.rollback.capabilityId");
    assertIdentifier(rollback.inputRef, "task.rollback.inputRef");
    validateControls(rollback.controls, "task.rollback.controls");
  }
}

function validateAuthorityDecision(
  requirement: ExecutiveAuthorityRequirement,
  decision: ExecutiveAuthorityDecision,
  at: number
): void {
  assertIdentifier(decision.decisionId, "authority.decisionId");
  assertIdentifier(decision.authorityClassId, "authority.authorityClassId");
  assertIdentifier(decision.subjectId, "authority.subjectId");
  assertIdentifier(decision.decidedBy, "authority.decidedBy");
  assertIdentifierList(decision.grantedScopeIds, "authority.grantedScopeIds");
  if (decision.evidenceRefs.length === 0) throw new Error("authority decision requires evidence");
  assertIdentifierList(decision.evidenceRefs, "authority.evidenceRefs");
  if (decision.authorityClassId !== requirement.authorityClassId || decision.subjectId !== requirement.subjectId) {
    throw new Error("authority decision does not match the requirement");
  }
  if (decision.decision === "granted" && requirement.requiredScopeIds.some(scope => !decision.grantedScopeIds.includes(scope))) {
    throw new Error("authority grant does not cover every required scope");
  }
  if (decision.expiresAt !== undefined) {
    assertTime(decision.expiresAt, "authority.expiresAt");
    if (decision.expiresAt <= at) throw new Error("authority decision is already expired");
  }
}

function validateApprovalDecision(
  requirement: ExecutiveApprovalRequirement,
  decision: ExecutiveApprovalDecision,
  at: number
): void {
  assertIdentifier(decision.decisionId, "approval.decisionId");
  assertIdentifier(decision.policyId, "approval.policyId");
  assertIdentifier(decision.decidedBy, "approval.decidedBy");
  if (decision.evidenceRefs.length === 0) throw new Error("approval decision requires evidence");
  assertIdentifierList(decision.evidenceRefs, "approval.evidenceRefs");
  if (decision.policyId !== requirement.policyId) throw new Error("approval decision does not match the requirement");
  if (decision.expiresAt !== undefined) {
    assertTime(decision.expiresAt, "approval.expiresAt");
    if (decision.expiresAt <= at) throw new Error("approval decision is already expired");
  }
}

function validateReceipt(receipt: ExecutiveCapabilityReceipt): void {
  assertIdentifier(receipt.id, "receipt.id");
  assertIdentifier(receipt.attemptId, "receipt.attemptId");
  assertIdentifier(receipt.invocationKey, "receipt.invocationKey");
  assertIdentifier(receipt.capabilityId, "receipt.capabilityId");
  assertIdentifier(receipt.executorId, "receipt.executorId");
  assertIdentifier(receipt.attestationRef, "receipt.attestationRef");
  assertTime(receipt.startedAt, "receipt.startedAt");
  assertTime(receipt.completedAt, "receipt.completedAt");
  if (receipt.completedAt < receipt.startedAt) throw new Error("receipt completion precedes its start");
  if (receipt.evidenceRefs.length === 0) throw new Error("capability receipt requires execution evidence");
  assertIdentifierList(receipt.evidenceRefs, "receipt.evidenceRefs");
  assertIdentifierList(receipt.outputRefs, "receipt.outputRefs");
}

function validateOutcome(outcome: Omit<ExecutiveOutcome, "recordedAt">): void {
  assertIdentifier(outcome.id, "outcome.id");
  assertIdentifier(outcome.attemptId, "outcome.attemptId");
  if (outcome.evidenceRefs.length === 0) throw new Error("outcome requires evidence references");
  assertIdentifierList(outcome.evidenceRefs, "outcome.evidenceRefs");
  assertIdentifierList(outcome.testEvidenceRefs, "outcome.testEvidenceRefs");
  assertIdentifierList(outcome.correctionRefs, "outcome.correctionRefs");
  assertIdentifierList(outcome.scoreTraceRefs, "outcome.scoreTraceRefs");
  if (outcome.reward) {
    if (!Number.isFinite(outcome.reward.value)) throw new Error("outcome reward must be finite");
    assertIdentifier(outcome.reward.basisRef, "outcome.reward.basisRef");
  }
}

function validateOutcomeAgainstReceipt(
  outcome: Omit<ExecutiveOutcome, "recordedAt">,
  receipt: ExecutiveCapabilityReceipt
): void {
  if (outcome.disposition === "accepted" && receipt.status !== "succeeded") {
    throw new Error("an unsuccessful or indeterminate receipt cannot have an accepted outcome");
  }
  if (outcome.disposition === "partial" && receipt.status === "failed") {
    throw new Error("a failed receipt cannot have a partial accepted outcome");
  }
}

function executiveId(hasher: Hasher, kind: string, value: unknown): string {
  return `executive_${kind}_${hasher.digestHex(canonicalStringify(value)).slice(0, 40)}`;
}

function assertIdentifier(value: string, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty identifier`);
}

function assertIdentifierList(values: readonly string[], path: string): void {
  if (!Array.isArray(values)) throw new Error(`${path} must be an array`);
  for (const value of values) assertIdentifier(value, path);
  if (unique(values).length !== values.length) throw new Error(`${path} must not contain duplicates`);
}

function assertTime(value: number, path: string): void {
  if (!Number.isFinite(value)) throw new Error(`${path} must be finite`);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function cloneControls(controls: ExecutiveControlState): ExecutiveControlState {
  return clone(controls);
}

function cloneRollback(rollback: ExecutiveRollbackPlan): ExecutiveRollbackPlan {
  return clone(rollback);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
