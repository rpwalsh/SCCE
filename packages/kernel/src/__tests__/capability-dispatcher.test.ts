import { describe, expect, it } from "vitest";
import {
  createCapabilityExecutorRegistry,
  dispatchCapabilityTask,
  dispatchRollbackAttempt,
  reconcileIndeterminateCapability,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type CapabilityExecutor,
  type CapabilityReconciliationRequest
} from "../capability-dispatcher.js";
import {
  createExecutiveEpisodeMachine,
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

class MemoryExecutiveJournal implements ExecutiveEventJournal {
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
    this.events.set(input.episodeId, [...events, ...structuredClone(input.events)]);
    commands.add(input.commandId);
    this.commands.set(input.episodeId, commands);
    return { status: "appended", revision: events.length + input.events.length };
  }
}

function ungovernedControls(): ExecutiveControlState {
  return {
    authority: {
      authorityClassId: "authority.class.build",
      subjectId: "principal.build",
      requiredScopeIds: [],
      state: "not_required",
      justificationRef: "authority.none.build"
    },
    approval: {
      policyId: "approval.policy.build",
      state: "not_required",
      approverClassIds: [],
      justificationRef: "approval.none.build"
    }
  };
}

function governedControls(): ExecutiveControlState {
  return {
    authority: {
      authorityClassId: "authority.class.build",
      subjectId: "principal.build",
      requiredScopeIds: [],
      state: "not_required",
      justificationRef: "authority.none.build"
    },
    approval: {
      policyId: "approval.policy.build",
      state: "pending",
      approverClassIds: ["approver.class.build"],
      justificationRef: "approval.required.build"
    }
  };
}

function authorityGovernedControls(): ExecutiveControlState {
  return {
    authority: {
      authorityClassId: "authority.class.build",
      subjectId: "principal.build",
      requiredScopeIds: ["scope.build"],
      state: "pending",
      justificationRef: "authority.required.build"
    },
    approval: {
      policyId: "approval.policy.build",
      state: "not_required",
      approverClassIds: [],
      justificationRef: "approval.none.build"
    }
  };
}

function fakeExecutor(capabilityId: string, respond: (request: CapabilityExecutionRequest) => Promise<CapabilityExecutionResult> | CapabilityExecutionResult): CapabilityExecutor {
  return {
    descriptor: { capabilityId, idempotency: "non-repeatable", rollback: "unavailable" },
    execute: async request => respond(request)
  };
}

function dispatcherFixture(executors: CapabilityExecutor[]) {
  const journal = new MemoryExecutiveJournal();
  const machine = createExecutiveEpisodeMachine(createHasher());
  const executive = createDurableExecutiveEpisode({ machine, journal, maxConflictRetries: 1 });
  return {
    executive,
    executors: createCapabilityExecutorRegistry(executors),
    hasher: createHasher(),
    now: () => 1_000
  };
}

function baseInput(overrides: { controls: ExecutiveControlState }) {
  return {
    episodeId: "episode.dispatch",
    ownerId: "principal.build",
    policyVersionId: "policy.version.build",
    goal: {
      id: "goal.build",
      goalClassId: "goal.class.build",
      objectiveRef: "construct.objective.build",
      requirementIds: [],
      ownerId: "principal.build"
    },
    task: {
      id: "task.build",
      goalId: "goal.build",
      taskClassId: "task.class.build",
      requirementIds: [],
      dependencyTaskIds: [],
      capabilityId: "process.build_test",
      inputRef: "content.input.build",
      policyVersionId: "policy.version.build",
      controls: overrides.controls,
      rollback: { mode: "not_required" as const, justificationRef: "risk.none.build" }
    },
    payload: { program: "program.alpha" },
    outcomeEvidenceRefs: ["build.log.alpha"]
  };
}

describe("capability dispatcher", () => {
  it("fails closed on an unsupported capability without touching the executive journal", async () => {
    const deps = dispatcherFixture([]);
    const result = await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
    expect(result.disposition).toBe("unsupported_capability");
    expect(result.state.status).toBe("unopened");
  });

  it("drives an ungoverned task through prepare, dispatch, receipt, and an accepted outcome on success", async () => {
    const executor = fakeExecutor("process.build_test", () => ({
      status: "succeeded",
      outputRefs: ["artifact.build.alpha"],
      evidenceRefs: ["execution.log.build"],
      attestationRef: "executor.signature.build"
    }));
    const deps = dispatcherFixture([executor]);
    const result = await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));

    expect(result.disposition).toBe("succeeded");
    expect(result.receipt).toMatchObject({ status: "succeeded", outputRefs: ["artifact.build.alpha"] });
    expect(result.outcome).toMatchObject({ disposition: "accepted", evidenceRefs: ["build.log.alpha"] });
    expect(result.state.tasks["task.build"]?.status).toBe("succeeded");
  });

  it("records a failed receipt as a rejected outcome, not a thrown error", async () => {
    const executor = fakeExecutor("process.build_test", () => ({
      status: "failed",
      outputRefs: [],
      evidenceRefs: ["execution.log.build.failed"],
      attestationRef: "executor.signature.build.failed"
    }));
    const deps = dispatcherFixture([executor]);
    const result = await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toMatchObject({ disposition: "rejected" });
    expect(result.state.tasks["task.build"]?.status).toBe("failed");
  });

  it("stops at an observed receipt for an indeterminate result and leaves the outcome pending for reconciliation", async () => {
    const executor = fakeExecutor("process.build_test", () => ({
      status: "indeterminate",
      outputRefs: [],
      evidenceRefs: ["execution.log.build.unknown"],
      attestationRef: "executor.signature.build.unknown"
    }));
    const deps = dispatcherFixture([executor]);
    const result = await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));

    expect(result.disposition).toBe("indeterminate");
    expect(result.outcome).toBeUndefined();
    expect(result.receipt?.status).toBe("indeterminate");
    expect(result.state.tasks["task.build"]?.status).toBe("awaiting_outcome");
  });

  it("treats an executor throw as indeterminate rather than crashing the dispatch", async () => {
    const executor: CapabilityExecutor = {
      descriptor: { capabilityId: "process.build_test", idempotency: "non-repeatable", rollback: "unavailable" },
      execute: async () => {
        throw new Error("provider connection reset");
      }
    };
    const deps = dispatcherFixture([executor]);
    const result = await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));

    expect(result.disposition).toBe("indeterminate");
    expect(result.receipt?.status).toBe("indeterminate");
  });

  it("blocks on pending approval until a decision is supplied, without inventing one", async () => {
    const executor = fakeExecutor("process.build_test", () => ({
      status: "succeeded",
      outputRefs: [],
      evidenceRefs: ["execution.log.build"],
      attestationRef: "executor.signature.build"
    }));
    const deps = dispatcherFixture([executor]);
    const input = baseInput({ controls: governedControls() });

    const blocked = await dispatchCapabilityTask(deps, input);
    expect(blocked.disposition).toBe("not_ready");
    expect(blocked.blockedStatus).toBe("awaiting_approval");

    const approved = await dispatchCapabilityTask(deps, {
      ...input,
      approvalDecision: {
        decisionId: "approval.grant.build",
        decision: "approved",
        policyId: "approval.policy.build",
        decidedBy: "approver.build",
        evidenceRefs: ["approval.attestation.build"]
      }
    });
    expect(approved.disposition).toBe("succeeded");
  });

  it("replays as duplicate on a retried call after the outcome already landed, without re-invoking the executor", async () => {
    let invocations = 0;
    const executor = fakeExecutor("process.build_test", () => {
      invocations += 1;
      return { status: "succeeded", outputRefs: [], evidenceRefs: ["execution.log.build"], attestationRef: "executor.signature.build" };
    });
    const deps = dispatcherFixture([executor]);
    const input = baseInput({ controls: ungovernedControls() });

    const first = await dispatchCapabilityTask(deps, input);
    expect(first.disposition).toBe("succeeded");
    expect(invocations).toBe(1);

    const retried = await dispatchCapabilityTask(deps, input);
    expect(retried.disposition).toBe("succeeded");
    expect(retried.outcome?.id).toBe(first.outcome?.id);
    expect(invocations).toBe(1);
  });

  it("resolves an indeterminate outcome to succeeded via a real provider-lookup reconciliation, not a blind retry of execute", async () => {
    let executeInvocations = 0;
    let reconcileInvocations = 0;
    const executor: CapabilityExecutor = {
      descriptor: { capabilityId: "process.build_test", idempotency: "reconcilable", rollback: "unavailable" },
      execute: async () => {
        executeInvocations += 1;
        return { status: "indeterminate", outputRefs: [], evidenceRefs: ["execution.log.build.unknown"], attestationRef: "executor.signature.build.unknown" };
      },
      reconcile: async (request: CapabilityReconciliationRequest) => {
        reconcileInvocations += 1;
        expect(request.indeterminateReceipt.status).toBe("indeterminate");
        return { status: "succeeded", outputRefs: ["artifact.build.reconciled"], evidenceRefs: ["provider.lookup.build"], attestationRef: "executor.signature.build.reconciled" };
      }
    };
    const deps = dispatcherFixture([executor]);
    const dispatched = await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
    expect(dispatched.disposition).toBe("indeterminate");
    expect(executeInvocations).toBe(1);

    const reconciled = await reconcileIndeterminateCapability(deps, {
      episodeId: "episode.dispatch",
      taskId: "task.build",
      outcomeEvidenceRefs: ["build.log.alpha"]
    });
    expect(reconciled.disposition).toBe("succeeded");
    expect(reconcileInvocations).toBe(1);
    expect(executeInvocations).toBe(1);
    expect(reconciled.outcome).toMatchObject({ disposition: "accepted" });
    expect(reconciled.receipt?.status).toBe("succeeded");
    expect(reconciled.state.tasks["task.build"]?.status).toBe("succeeded");
    // The original indeterminate receipt is preserved, not overwritten.
    const originalReceiptId = dispatched.receipt!.id;
    expect(reconciled.state.receipts[originalReceiptId]?.status).toBe("indeterminate");
  });

  it("resolves an indeterminate outcome to failed (rejected) when the provider lookup confirms it never happened", async () => {
    const executor: CapabilityExecutor = {
      descriptor: { capabilityId: "process.build_test", idempotency: "reconcilable", rollback: "unavailable" },
      execute: async () => ({ status: "indeterminate", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build.unknown" }),
      reconcile: async () => ({ status: "failed", outputRefs: [], evidenceRefs: ["provider.lookup.build.absent"], attestationRef: "executor.signature.build.absent" })
    };
    const deps = dispatcherFixture([executor]);
    await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
    const reconciled = await reconcileIndeterminateCapability(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(reconciled.disposition).toBe("failed");
    expect(reconciled.outcome).toMatchObject({ disposition: "rejected" });
    expect(reconciled.state.tasks["task.build"]?.status).toBe("failed");
  });

  it("reports not_reconcilable rather than throwing when the executor has no reconcile method", async () => {
    const executor = fakeExecutor("process.build_test", () => ({ status: "indeterminate", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build.unknown" }));
    const deps = dispatcherFixture([executor]);
    await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
    const reconciled = await reconcileIndeterminateCapability(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(reconciled.disposition).toBe("not_reconcilable");
  });

  it("reports still_indeterminate rather than throwing when the provider lookup itself can't resolve it yet", async () => {
    const executor: CapabilityExecutor = {
      descriptor: { capabilityId: "process.build_test", idempotency: "reconcilable", rollback: "unavailable" },
      execute: async () => ({ status: "indeterminate", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build.unknown" }),
      reconcile: async () => ({ status: "indeterminate", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build.still_unknown" })
    };
    const deps = dispatcherFixture([executor]);
    await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
    const reconciled = await reconcileIndeterminateCapability(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(reconciled.disposition).toBe("still_indeterminate");
    expect(reconciled.state.tasks["task.build"]?.status).toBe("awaiting_outcome");
  });

  it("reports not_pending for a task that never reached an indeterminate outcome", async () => {
    const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" }));
    const deps = dispatcherFixture([executor]);
    await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
    const reconciled = await reconcileIndeterminateCapability(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(reconciled.disposition).toBe("not_pending");
  });

  it("blocks on pending authority and never invokes the executor, distinct from pending approval (plan item 47)", async () => {
    let invocations = 0;
    const executor = fakeExecutor("process.build_test", () => {
      invocations += 1;
      return { status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" };
    });
    const deps = dispatcherFixture([executor]);
    const input = baseInput({ controls: authorityGovernedControls() });

    const blocked = await dispatchCapabilityTask(deps, input);
    expect(blocked.disposition).toBe("not_ready");
    expect(blocked.blockedStatus).toBe("awaiting_authority");
    expect(invocations).toBe(0);
  });

  it("fails closed permanently on an explicit authority denial -- never proceeds even on retry", async () => {
    let invocations = 0;
    const executor = fakeExecutor("process.build_test", () => {
      invocations += 1;
      return { status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" };
    });
    const deps = dispatcherFixture([executor]);
    const input = baseInput({ controls: authorityGovernedControls() });

    const denied = await dispatchCapabilityTask(deps, {
      ...input,
      authorityDecision: {
        decisionId: "authority.denial.build",
        decision: "denied",
        authorityClassId: "authority.class.build",
        subjectId: "principal.build",
        grantedScopeIds: [],
        decidedBy: "authority.service.build",
        evidenceRefs: ["authority.denial.evidence.build"]
      }
    });
    expect(denied.disposition).toBe("not_ready");
    expect(denied.blockedStatus).toBe("authority_denied");
    expect(invocations).toBe(0);

    // A bare retry (no new decision) must stay denied, not silently proceed.
    const retried = await dispatchCapabilityTask(deps, input);
    expect(retried.disposition).toBe("not_ready");
    expect(retried.blockedStatus).toBe("authority_denied");
    expect(invocations).toBe(0);
  });

  it("refuses to even declare an irreversible task without a genuine risk acceptance (plan item 47)", async () => {
    const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" }));
    const deps = dispatcherFixture([executor]);
    const input = baseInput({ controls: ungovernedControls() });
    const unconfirmedIrreversible = {
      ...input,
      task: {
        ...input.task,
        rollback: { mode: "unavailable" as const, justificationRef: "risk.build", riskAcceptanceId: "", riskAcceptanceEvidenceRefs: [] }
      }
    };
    // executive-episode.ts's declare_task validation (not a dispatcher-
    // level check) is what fails this closed: an empty riskAcceptanceId
    // is structurally rejected, so an irreversible action can never be
    // declared without real, non-empty confirmation evidence.
    await expect(dispatchCapabilityTask(deps, unconfirmedIrreversible)).rejects.toThrow();
  });

  it("proceeds for an irreversible task once a genuine risk acceptance is supplied", async () => {
    const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" }));
    const deps = dispatcherFixture([executor]);
    const input = baseInput({ controls: ungovernedControls() });
    const confirmedIrreversible = {
      ...input,
      task: {
        ...input.task,
        rollback: { mode: "unavailable" as const, justificationRef: "risk.build", riskAcceptanceId: "risk.acceptance.build.001", riskAcceptanceEvidenceRefs: ["risk.acceptance.evidence.build"] }
      }
    };
    const result = await dispatchCapabilityTask(deps, confirmedIrreversible);
    expect(result.disposition).toBe("succeeded");
  });

  it("executes a real compensating action when the primary attempt fails and a rollback executor is registered (plan item 48)", async () => {
    let rollbackInvocations = 0;
    const primaryExecutor = fakeExecutor("outlook.mail.draft.create", () => ({
      status: "failed",
      outputRefs: [],
      evidenceRefs: ["execution.log.draft.failed"],
      attestationRef: "executor.signature.draft.failed"
    }));
    const rollbackExecutor: CapabilityExecutor = {
      descriptor: { capabilityId: "outlook.mail.draft.delete", idempotency: "non-repeatable", rollback: "unavailable" },
      execute: async () => { throw new Error("this capability is only ever invoked via rollback()"); },
      rollback: async () => {
        rollbackInvocations += 1;
        return { status: "succeeded", outputRefs: [], evidenceRefs: ["compensating.action.log"], attestationRef: "executor.signature.draft.deleted" };
      }
    };
    const deps = dispatcherFixture([primaryExecutor, rollbackExecutor]);
    const input = {
      ...baseInput({ controls: ungovernedControls() }),
      task: {
        ...baseInput({ controls: ungovernedControls() }).task,
        capabilityId: "outlook.mail.draft.create",
        rollback: {
          mode: "capability" as const,
          planId: "plan.rollback.draft",
          capabilityId: "outlook.mail.draft.delete",
          inputRef: "content.input.build",
          justificationRef: "risk.draft.create",
          controls: ungovernedControls()
        }
      }
    };

    const primary = await dispatchCapabilityTask(deps, { ...input, task: { ...input.task, capabilityId: "outlook.mail.draft.create" } });
    expect(primary.disposition).toBe("failed");
    expect(primary.state.tasks["task.build"]?.status).toBe("rollback_ready");
    expect(rollbackInvocations).toBe(0);

    const rolledBack = await dispatchRollbackAttempt(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(rolledBack.disposition).toBe("rolled_back");
    expect(rollbackInvocations).toBe(1);
    expect(rolledBack.state.tasks["task.build"]?.status).toBe("rolled_back");

    // Retrying is safe -- it must not re-invoke the compensating action.
    const retried = await dispatchRollbackAttempt(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(retried.disposition).toBe("rolled_back");
    expect(rollbackInvocations).toBe(1);
  });

  it("fails closed (no_rollback_executor) instead of silently succeeding when no compensating action is registered", async () => {
    const primaryExecutor = fakeExecutor("outlook.mail.draft.create", () => ({
      status: "failed",
      outputRefs: [],
      evidenceRefs: [],
      attestationRef: "executor.signature.draft.failed"
    }));
    const deps = dispatcherFixture([primaryExecutor]); // no rollback executor registered at all
    const input = {
      ...baseInput({ controls: ungovernedControls() }),
      task: {
        ...baseInput({ controls: ungovernedControls() }).task,
        capabilityId: "outlook.mail.draft.create",
        rollback: {
          mode: "capability" as const,
          planId: "plan.rollback.draft",
          capabilityId: "outlook.mail.draft.delete",
          inputRef: "content.input.build",
          justificationRef: "risk.draft.create",
          controls: ungovernedControls()
        }
      }
    };
    await dispatchCapabilityTask(deps, input);

    const result = await dispatchRollbackAttempt(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(result.disposition).toBe("no_rollback_executor");
    // The task must NOT be reported as rolled back -- a rollback that
    // cannot run is a distinct, visible failure state, not a silent
    // success.
    expect(result.state.tasks["task.build"]?.status).not.toBe("rolled_back");
  });

  it("reports no_rollback_needed for a task that never declared a rollback capability", async () => {
    const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" }));
    const deps = dispatcherFixture([executor]);
    await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
    const result = await dispatchRollbackAttempt(deps, { episodeId: "episode.dispatch", taskId: "task.build", outcomeEvidenceRefs: [] });
    expect(result.disposition).toBe("no_rollback_needed");
  });
});
