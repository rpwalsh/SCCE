import { describe, expect, it } from "vitest";
import {
  createExecutiveEpisodeMachine,
  executiveResumePlan,
  resumableCapabilityInvocations,
  type ExecutiveApprovalRequirement,
  type ExecutiveAuthorityRequirement,
  type ExecutiveCommand,
  type ExecutiveControlState,
  type ExecutiveEpisodeId,
  type ExecutiveEvent
} from "../executive-episode.js";
import {
  createDurableExecutiveEpisode,
  type ExecutiveEventJournal,
  type ExecutiveJournalAppend,
  type ExecutiveJournalAppendResult,
  type ExecutiveJournalSnapshot
} from "../executive-journal.js";
import { createHasher } from "../primitives.js";

describe("durable executive episode", () => {
  it("persists a goal, task, attested receipt, outcome, and learning record", async () => {
    const journal = new StrictExecutiveJournal();
    const machine = createExecutiveEpisodeMachine(createHasher());
    const runtime = createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 1 });
    const episodeId = "episode.alpha";

    await runtime.dispatch(openEpisode(episodeId));
    await runtime.dispatch(declareGoal(episodeId));
    await runtime.dispatch(declareTask(episodeId, { controls: ungovernedControls() }));
    let state = await runtime.dispatch({
      type: "prepare_attempt",
      episodeId,
      commandId: "command.prepare",
      occurredAt: 1_003,
      taskId: "task.alpha",
      kind: "execution"
    });
    const invocation = resumableCapabilityInvocations(state)[0]!;
    expect(invocation).toMatchObject({
      capabilityId: "capability.alpha",
      inputRef: "content.input.alpha",
      attemptOrdinal: 1
    });

    state = await runtime.dispatch({
      type: "record_dispatch",
      episodeId,
      commandId: "command.dispatch",
      occurredAt: 1_004,
      attemptId: invocation.attemptId,
      executorId: "executor.alpha",
      dispatchEvidenceRef: "dispatch.attestation.alpha"
    });
    expect(state.tasks["task.alpha"]?.status).toBe("in_flight");

    // A new coordinator represents recovery after the process that dispatched the
    // invocation exited. Reissuing uses the exact persisted idempotency key.
    const recoveredRuntime = createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 1 });
    const recovered = await recoveredRuntime.load(episodeId);
    expect(resumableCapabilityInvocations(recovered)).toEqual([invocation]);

    state = await recoveredRuntime.dispatch({
      type: "observe_receipt",
      episodeId,
      commandId: "command.receipt",
      occurredAt: 1_006,
      receipt: {
        id: "receipt.alpha",
        attemptId: invocation.attemptId,
        invocationKey: invocation.idempotencyKey,
        capabilityId: invocation.capabilityId,
        executorId: "executor.alpha",
        status: "succeeded",
        startedAt: 1_004,
        completedAt: 1_005,
        outputRefs: ["content.output.alpha"],
        evidenceRefs: ["execution.log.alpha"],
        attestationRef: "executor.signature.alpha"
      }
    });
    expect(executiveResumePlan(await recoveredRuntime.load(episodeId))).toMatchObject({
      invocations: [],
      outcomePendingAttemptIds: [invocation.attemptId]
    });
    state = await recoveredRuntime.dispatch({
      type: "record_outcome",
      episodeId,
      commandId: "command.outcome",
      occurredAt: 1_007,
      outcome: {
        id: "outcome.alpha",
        attemptId: invocation.attemptId,
        disposition: "accepted",
        evidenceRefs: ["observer.acceptance.alpha"],
        testEvidenceRefs: ["test.report.alpha"],
        correctionRefs: [],
        scoreTraceRefs: ["score.trace.alpha"],
        reward: { value: 1, basisRef: "observer.reward.alpha" }
      }
    });

    expect(state.tasks["task.alpha"]?.status).toBe("succeeded");
    expect(Object.values(state.learningRecords)).toEqual([
      expect.objectContaining({
        taskClassId: "task.class.opaque.alpha",
        capabilityId: "capability.alpha",
        disposition: "accepted",
        receiptStatus: "succeeded",
        testEvidenceRefs: ["test.report.alpha"]
      })
    ]);

    const outcomeRevision = state.revision;
    state = await recoveredRuntime.dispatch({
      type: "record_outcome",
      episodeId,
      commandId: "command.outcome",
      occurredAt: 9_999,
      outcome: {
        id: "outcome.alpha",
        attemptId: invocation.attemptId,
        disposition: "accepted",
        evidenceRefs: ["observer.acceptance.alpha"],
        testEvidenceRefs: ["test.report.alpha"],
        correctionRefs: [],
        scoreTraceRefs: ["score.trace.alpha"]
      }
    });
    expect(state.revision).toBe(outcomeRevision);

    state = await recoveredRuntime.dispatch({
      type: "conclude_goal",
      episodeId,
      commandId: "command.conclude",
      occurredAt: 1_008,
      goalId: "goal.alpha",
      disposition: "satisfied",
      outcomeIds: ["outcome.alpha"],
      evidenceRefs: ["goal.acceptance.alpha"]
    });
    expect(state.status).toBe("closed");
    expect(state.goals["goal.alpha"]?.status).toBe("satisfied");
  });

  it("fails closed on missing authority and approval and preserves explicit denial", async () => {
    const journal = new StrictExecutiveJournal();
    const machine = createExecutiveEpisodeMachine(createHasher());
    const runtime = createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 0 });
    const episodeId = "episode.governed";
    await runtime.dispatch(openEpisode(episodeId));
    await runtime.dispatch(declareGoal(episodeId));
    await runtime.dispatch(declareTask(episodeId, { controls: governedControls() }));

    await expect(runtime.dispatch({
      type: "prepare_attempt",
      episodeId,
      commandId: "command.prepare.early",
      occurredAt: 2_003,
      taskId: "task.alpha",
      kind: "execution"
    })).rejects.toThrow("awaiting_authority");

    await expect(runtime.dispatch({
      type: "record_authority",
      episodeId,
      commandId: "command.authority.invalid",
      occurredAt: 2_004,
      taskId: "task.alpha",
      target: "execution",
      decision: {
        decisionId: "authority.grant.invalid",
        decision: "granted",
        authorityClassId: "authority.class.alpha",
        subjectId: "principal.alpha",
        grantedScopeIds: [],
        decidedBy: "authority.service.alpha",
        evidenceRefs: ["authority.attestation.invalid"]
      }
    })).rejects.toThrow("does not cover every required scope");

    await runtime.dispatch({
      type: "record_authority",
      episodeId,
      commandId: "command.authority",
      occurredAt: 2_005,
      taskId: "task.alpha",
      target: "execution",
      decision: {
        decisionId: "authority.grant.alpha",
        decision: "granted",
        authorityClassId: "authority.class.alpha",
        subjectId: "principal.alpha",
        grantedScopeIds: ["scope.alpha"],
        decidedBy: "authority.service.alpha",
        evidenceRefs: ["authority.attestation.alpha"],
        expiresAt: 3_000
      }
    });
    const state = await runtime.dispatch({
      type: "record_approval",
      episodeId,
      commandId: "command.approval",
      occurredAt: 2_006,
      taskId: "task.alpha",
      target: "execution",
      decision: {
        decisionId: "approval.denial.alpha",
        decision: "denied",
        policyId: "approval.policy.alpha",
        decidedBy: "approver.alpha",
        evidenceRefs: ["approval.attestation.alpha"]
      }
    });
    expect(state.tasks["task.alpha"]?.status).toBe("approval_denied");
    await expect(runtime.dispatch({
      type: "prepare_attempt",
      episodeId,
      commandId: "command.prepare.denied",
      occurredAt: 2_007,
      taskId: "task.alpha",
      kind: "execution"
    })).rejects.toThrow("approval_denied");
  });

  it("runs required rollback as a separately governed idempotent capability", async () => {
    const journal = new StrictExecutiveJournal();
    const machine = createExecutiveEpisodeMachine(createHasher());
    const runtime = createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 0 });
    const episodeId = "episode.rollback";
    await runtime.dispatch(openEpisode(episodeId));
    await runtime.dispatch(declareGoal(episodeId));
    await runtime.dispatch(declareTask(episodeId, {
      controls: ungovernedControls(),
      rollback: {
        mode: "capability",
        planId: "rollback.plan.alpha",
        capabilityId: "capability.rollback.alpha",
        inputRef: "content.rollback.input.alpha",
        justificationRef: "risk.rollback.justification.alpha",
        controls: ungovernedControls()
      }
    }));

    let state = await runtime.dispatch(prepare(episodeId, "execution", "command.execution.prepare", 3_003));
    const execution = resumableCapabilityInvocations(state)[0]!;
    await runtime.dispatch(observeFailedReceipt(episodeId, execution, 3_004));
    state = await runtime.dispatch(recordRejectedOutcome(episodeId, execution.attemptId, "command.execution.outcome", "outcome.execution", 3_005));
    expect(state.tasks["task.alpha"]?.status).toBe("rollback_ready");

    state = await runtime.dispatch(prepare(episodeId, "rollback", "command.rollback.prepare", 3_006));
    const rollback = resumableCapabilityInvocations(state)[0]!;
    expect(rollback).toMatchObject({
      capabilityId: "capability.rollback.alpha",
      inputRef: "content.rollback.input.alpha",
      rollbackPlanId: "rollback.plan.alpha"
    });
    expect(rollback.idempotencyKey).not.toBe(execution.idempotencyKey);

    // A receipt may be observed from the prepared state when dispatch happened
    // but the dispatcher crashed before persisting its handoff observation.
    await runtime.dispatch({
      type: "observe_receipt",
      episodeId,
      commandId: "command.rollback.receipt",
      occurredAt: 3_008,
      receipt: {
        id: "receipt.rollback",
        attemptId: rollback.attemptId,
        invocationKey: rollback.idempotencyKey,
        capabilityId: rollback.capabilityId,
        executorId: "executor.rollback",
        status: "succeeded",
        startedAt: 3_006,
        completedAt: 3_007,
        outputRefs: ["content.rollback.output"],
        evidenceRefs: ["execution.log.rollback"],
        attestationRef: "executor.signature.rollback"
      }
    });
    state = await runtime.dispatch({
      type: "record_outcome",
      episodeId,
      commandId: "command.rollback.outcome",
      occurredAt: 3_009,
      outcome: {
        id: "outcome.rollback",
        attemptId: rollback.attemptId,
        disposition: "accepted",
        evidenceRefs: ["observer.rollback.accepted"],
        testEvidenceRefs: [],
        correctionRefs: [],
        scoreTraceRefs: []
      }
    });

    expect(state.tasks["task.alpha"]?.status).toBe("rolled_back");
    expect(Object.values(state.learningRecords).map(record => record.attemptKind).sort()).toEqual(["execution", "rollback"]);
  });

  it("rejects receipts that are not bound to the prepared invocation", async () => {
    const journal = new StrictExecutiveJournal();
    const machine = createExecutiveEpisodeMachine(createHasher());
    const runtime = createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 0 });
    const episodeId = "episode.receipt-binding";
    await runtime.dispatch(openEpisode(episodeId));
    await runtime.dispatch(declareGoal(episodeId));
    await runtime.dispatch(declareTask(episodeId, { controls: ungovernedControls() }));
    const state = await runtime.dispatch(prepare(episodeId, "execution", "command.prepare", 4_003));
    const invocation = resumableCapabilityInvocations(state)[0]!;

    await expect(runtime.dispatch({
      type: "observe_receipt",
      episodeId,
      commandId: "command.receipt.invalid",
      occurredAt: 4_004,
      receipt: {
        id: "receipt.invalid",
        attemptId: invocation.attemptId,
        invocationKey: "invocation.unrelated",
        capabilityId: invocation.capabilityId,
        executorId: "executor.alpha",
        status: "succeeded",
        startedAt: 4_003,
        completedAt: 4_004,
        outputRefs: [],
        evidenceRefs: ["execution.log.invalid"],
        attestationRef: "executor.signature.invalid"
      }
    })).rejects.toThrow("invocation key mismatch");
  });
});

class StrictExecutiveJournal implements ExecutiveEventJournal {
  private readonly events = new Map<ExecutiveEpisodeId, ExecutiveEvent[]>();
  private readonly commands = new Map<ExecutiveEpisodeId, Set<string>>();

  async read(episodeId: ExecutiveEpisodeId): Promise<ExecutiveJournalSnapshot> {
    const events = this.events.get(episodeId) ?? [];
    return { episodeId, revision: events.length, events: structuredClone(events) };
  }

  async append(input: ExecutiveJournalAppend): Promise<ExecutiveJournalAppendResult> {
    const events = this.events.get(input.episodeId) ?? [];
    const commands = this.commands.get(input.episodeId) ?? new Set<string>();
    if (commands.has(input.commandId)) return { status: "duplicate", revision: events.length };
    if (events.length !== input.expectedRevision) return { status: "conflict", revision: events.length };
    if (input.events.some((event, index) => event.revision !== input.expectedRevision + index + 1)) {
      throw new Error("test journal received non-contiguous events");
    }
    this.events.set(input.episodeId, [...events, ...structuredClone(input.events)]);
    commands.add(input.commandId);
    this.commands.set(input.episodeId, commands);
    return { status: "appended", revision: events.length + input.events.length };
  }
}

function openEpisode(episodeId: string): ExecutiveCommand {
  return {
    type: "open_episode",
    episodeId,
    commandId: "command.open",
    occurredAt: 1_000,
    ownerId: "principal.alpha",
    policyVersionId: "policy.version.alpha"
  };
}

function declareGoal(episodeId: string): ExecutiveCommand {
  return {
    type: "declare_goal",
    episodeId,
    commandId: "command.goal",
    occurredAt: 1_001,
    goal: {
      id: "goal.alpha",
      goalClassId: "goal.class.opaque.alpha",
      objectiveRef: "construct.objective.alpha",
      requirementIds: ["requirement.alpha"],
      ownerId: "principal.alpha"
    }
  };
}

function declareTask(
  episodeId: string,
  override: {
    controls: ExecutiveControlState;
    rollback?: Extract<ExecutiveCommand, { type: "declare_task" }>["task"]["rollback"];
  }
): ExecutiveCommand {
  return {
    type: "declare_task",
    episodeId,
    commandId: "command.task",
    occurredAt: 1_002,
    task: {
      id: "task.alpha",
      goalId: "goal.alpha",
      taskClassId: "task.class.opaque.alpha",
      requirementIds: ["requirement.alpha"],
      dependencyTaskIds: [],
      capabilityId: "capability.alpha",
      inputRef: "content.input.alpha",
      policyVersionId: "policy.version.alpha",
      controls: override.controls,
      rollback: override.rollback ?? { mode: "not_required", justificationRef: "risk.none.alpha" }
    }
  };
}

function prepare(
  episodeId: string,
  kind: "execution" | "rollback",
  commandId: string,
  occurredAt: number
): ExecutiveCommand {
  return { type: "prepare_attempt", episodeId, commandId, occurredAt, taskId: "task.alpha", kind };
}

function observeFailedReceipt(
  episodeId: string,
  invocation: ReturnType<typeof resumableCapabilityInvocations>[number],
  occurredAt: number
): ExecutiveCommand {
  return {
    type: "observe_receipt",
    episodeId,
    commandId: "command.execution.receipt",
    occurredAt,
    receipt: {
      id: "receipt.execution",
      attemptId: invocation.attemptId,
      invocationKey: invocation.idempotencyKey,
      capabilityId: invocation.capabilityId,
      executorId: "executor.execution",
      status: "failed",
      startedAt: occurredAt - 1,
      completedAt: occurredAt,
      outputRefs: [],
      evidenceRefs: ["execution.log.failed"],
      attestationRef: "executor.signature.failed"
    }
  };
}

function recordRejectedOutcome(
  episodeId: string,
  attemptId: string,
  commandId: string,
  outcomeId: string,
  occurredAt: number
): ExecutiveCommand {
  return {
    type: "record_outcome",
    episodeId,
    commandId,
    occurredAt,
    outcome: {
      id: outcomeId,
      attemptId,
      disposition: "rejected",
      evidenceRefs: ["observer.rejection"],
      testEvidenceRefs: ["test.failure"],
      correctionRefs: [],
      scoreTraceRefs: []
    }
  };
}

function ungovernedControls(): ExecutiveControlState {
  return {
    authority: {
      authorityClassId: "authority.class.alpha",
      subjectId: "principal.alpha",
      requiredScopeIds: [],
      state: "not_required",
      justificationRef: "authority.none.alpha"
    },
    approval: {
      policyId: "approval.policy.alpha",
      state: "not_required",
      approverClassIds: [],
      justificationRef: "approval.none.alpha"
    }
  };
}

function governedControls(): ExecutiveControlState {
  const authority: ExecutiveAuthorityRequirement = {
    authorityClassId: "authority.class.alpha",
    subjectId: "principal.alpha",
    requiredScopeIds: ["scope.alpha"],
    state: "pending",
    justificationRef: "authority.required.alpha"
  };
  const approval: ExecutiveApprovalRequirement = {
    policyId: "approval.policy.alpha",
    state: "pending",
    approverClassIds: ["approver.class.alpha"],
    justificationRef: "approval.required.alpha"
  };
  return { authority, approval };
}
