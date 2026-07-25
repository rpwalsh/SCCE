import { describe, expect, it } from "vitest";
import {
  createCapabilityExecutorRegistry,
  dispatchCapabilityTask,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type CapabilityExecutor
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
});
