// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";
import { COGNITIVE_OPERATOR_IDS } from "../turn-requirements.js";

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
  it.each(["succeeded", "failed"] as const)("resumes a three-stage local dependency chain after the second %s receipt survives a restart", async expected => {
    const directory = await mkdtemp(join(tmpdir(), "scce-executive-chain-"));
    const journalPath = join(directory, "journal.json");
    const inputPath = join(directory, "input.txt");
    const verifiedPath = join(directory, "verified.txt");
    const finalPath = join(directory, "final.txt");
    const invocations = [0, 0, 0];
    let interruptOutcome = false;
    const journal = (): ExecutiveEventJournal => ({
      read: async episodeId => {
        const events = await readFile(journalPath, "utf8").then(text => JSON.parse(text) as ExecutiveEvent[]).catch(error => { if (error.code === "ENOENT") return []; throw error; });
        return { episodeId, events, revision: events.length };
      },
      append: async command => {
        const snapshot = await journal().read(command.episodeId);
        if (snapshot.events.some(event => event.commandId === command.commandId)) return { status: "duplicate", revision: snapshot.revision };
        if (snapshot.revision !== command.expectedRevision) return { status: "conflict", revision: snapshot.revision };
        if (interruptOutcome && command.events.some(event => event.type === "outcome_recorded")) { interruptOutcome = false; throw new Error("stage-two outcome storage interrupted"); }
        const events = [...snapshot.events, ...command.events];
        await writeFile(journalPath, JSON.stringify(events));
        return { status: "appended", revision: events.length };
      }
    });
    const executors = [0, 1, 2].map(index => fakeExecutor(`local.stage.${index}`, async () => {
      invocations[index]!++;
      if (index === 0) await writeFile(inputPath, expected === "succeeded" ? "owned" : "invalid");
      const valid = index === 0 || await readFile(index === 1 ? inputPath : verifiedPath, "utf8") === "owned";
      if (index === 1 && valid) await writeFile(verifiedPath, "owned");
      if (index === 2 && valid) await writeFile(finalPath, "owned");
      const artifact = index === 0 ? inputPath : index === 1 ? inputPath : finalPath;
      return { status: valid ? "succeeded" : "failed", outputRefs: valid ? [artifact] : [], evidenceRefs: [artifact], attestationRef: createHasher().digestHex(await readFile(artifact)) };
    }));
    const restart = () => ({ executive: createDurableExecutiveEpisode({ machine: createExecutiveEpisodeMachine(createHasher()), journal: journal(), maxConflictRetries: 1 }), executors: createCapabilityExecutorRegistry(executors), hasher: createHasher(), now: () => 1000 });
    const stage = (index: number) => {
      const input = baseInput({ controls: index === 2 ? governedControls() : ungovernedControls() });
      return { ...input, task: { ...input.task, id: `task.stage.${index}`, capabilityId: `local.stage.${index}`, dependencyTaskIds: index ? [`task.stage.${index - 1}`] : [] }, payload: { directory } };
    };
    try {
      expect((await dispatchCapabilityTask(restart(), stage(0))).disposition).toBe("succeeded");
      interruptOutcome = true;
      await expect(dispatchCapabilityTask(restart(), stage(1))).rejects.toThrow("stage-two outcome storage interrupted");
      expect((await dispatchCapabilityTask(restart(), stage(2))).blockedStatus).toBe("blocked");
      const recovered = await dispatchCapabilityTask(restart(), stage(1));
      expect(recovered.disposition).toBe(expected);
      expect(invocations).toEqual([1, 1, 0]);
      const waiting = await dispatchCapabilityTask(restart(), stage(2));
      expect(waiting.blockedStatus).toBe(expected === "succeeded" ? "awaiting_approval" : "blocked");
      if (expected === "succeeded") {
        const approved = { ...stage(2), approvalDecision: { decisionId: "approval.local.final", decision: "approved" as const, policyId: "approval.policy.build", decidedBy: "owner", evidenceRefs: [verifiedPath] } };
        expect((await dispatchCapabilityTask(restart(), approved)).disposition).toBe("succeeded");
        expect((await dispatchCapabilityTask(restart(), approved)).disposition).toBe("succeeded");
        expect(await readFile(finalPath, "utf8")).toBe("owned");
        expect(invocations).toEqual([1, 1, 1]);
      }
      const replayed = await restart().executive.load("episode.dispatch");
      expect(Object.values(replayed.outcomes)).toHaveLength(expected === "succeeded" ? 3 : 2);
      expect(Object.values(replayed.receipts)).toHaveLength(expected === "succeeded" ? 3 : 2);
      const conclusion = { type: "conclude_goal" as const, episodeId: "episode.dispatch", commandId: "goal.conclusion", occurredAt: 1000, goalId: "goal.build", disposition: "satisfied" as const, outcomeIds: Object.keys(replayed.outcomes), evidenceRefs: [finalPath] };
      if (expected === "succeeded") expect((await restart().executive.dispatch(conclusion)).goals["goal.build"]!.status).toBe("satisfied");
      else await expect(restart().executive.dispatch(conclusion)).rejects.toThrow("goal has non-terminal tasks");
    } finally {
      for (const path of [journalPath, inputPath, verifiedPath, finalPath]) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
      await rmdir(directory);
    }
  });

  it("resumes an undispatched prepared invocation once and refuses a changed payload or expired approval", async () => {
    for (const variation of ["same", "changed", "expired"] as const) {
      const journal = new MemoryExecutiveJournal();
      const append = journal.append.bind(journal);
      let interruptDispatch = true;
      journal.append = async command => {
        if (interruptDispatch && command.events.some(event => event.type === "attempt_dispatched")) { interruptDispatch = false; throw new Error("interrupted before dispatch"); }
        return append(command);
      };
      let calls = 0;
      const executor = fakeExecutor("process.build_test", () => { calls++; return { status: "succeeded", outputRefs: [], evidenceRefs: ["local.receipt"], attestationRef: "attestation.local" }; });
      let now = 1000;
      const restart = () => ({ executive: createDurableExecutiveEpisode({ machine: createExecutiveEpisodeMachine(createHasher()), journal, maxConflictRetries: 1 }), executors: createCapabilityExecutorRegistry([executor]), hasher: createHasher(), now: () => now });
      const input = { ...baseInput({ controls: governedControls() }), approvalDecision: { decisionId: "approval.original", decision: "approved" as const, policyId: "approval.policy.build", decidedBy: "approver.class.build", evidenceRefs: ["approval.evidence"], expiresAt: 2000 } };
      await expect(dispatchCapabilityTask(restart(), input)).rejects.toThrow("interrupted before dispatch");
      expect(calls).toBe(0);
      if (variation === "expired") now = 3000;
      const resumed = await dispatchCapabilityTask(restart(), variation === "changed" ? { ...input, payload: { program: "other.program" } } : input);
      expect(resumed.disposition).toBe(variation === "same" ? "succeeded" : "not_ready");
      expect(calls).toBe(variation === "same" ? 1 : 0);
      if (variation === "expired") {
        expect(resumed.blockedStatus).toBe("awaiting_approval");
        await expect(restart().executive.dispatch({ type: "record_dispatch", episodeId: input.episodeId, commandId: "bypass.expired", occurredAt: now, attemptId: resumed.state.tasks[input.task.id]!.activeAttemptId!, executorId: "process.build_test", dispatchEvidenceRef: "dispatch.expired" })).rejects.toThrow(/awaiting_approval/);
      }
    }
  });

  it.each(["succeeded", "failed"] as const)("finishes a durable %s receipt after a crash before its outcome without executing twice", async status => {
    const journal = new MemoryExecutiveJournal();
    const append = journal.append.bind(journal);
    let interruptOutcome = true;
    journal.append = async command => {
      if (interruptOutcome && command.events.some(event => event.type === "outcome_recorded")) {
        interruptOutcome = false;
        throw new Error("interrupted before durable outcome");
      }
      return append(command);
    };
    let calls = 0;
    const executor = fakeExecutor("process.build_test", () => { calls++; return { status, outputRefs: ["artifact.local"], evidenceRefs: ["local.receipt"], attestationRef: "attestation.local", actualDelta: { completed: status === "succeeded" } }; });
    const restart = () => ({ executive: createDurableExecutiveEpisode({ machine: createExecutiveEpisodeMachine(createHasher()), journal, maxConflictRetries: 1 }), executors: createCapabilityExecutorRegistry([executor]), hasher: createHasher(), now: () => 1000 });
    const input = { ...baseInput({ controls: ungovernedControls() }), operatorOutcome: { conversationId: "conversation.crash", operatorIds: [COGNITIVE_OPERATOR_IDS.actionPlanning], typedInputState: { completed: false }, predictedDelta: { completed: true } } };
    await expect(dispatchCapabilityTask(restart(), input)).rejects.toThrow("interrupted before durable outcome");
    const resumed = await dispatchCapabilityTask(restart(), input);
    expect(resumed.disposition).toBe(status);
    expect(resumed.outcome?.operatorObservation?.actualDelta).toEqual({ completed: status === "succeeded" });
    expect(calls).toBe(1);
    const repeated = await dispatchCapabilityTask(restart(), input);
    expect(repeated.outcome?.id).toBe(resumed.outcome?.id);
    expect(Object.values(repeated.state.outcomes)).toHaveLength(1);
    expect(calls).toBe(1);
  });

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

  it("carries typed action deltas into the durable calibration outcome record", async () => {
    const dialogueMemory = createInMemoryDialogueMemoryStore();
    const executor = fakeExecutor("process.build_test", () => ({
      status: "succeeded",
      outputRefs: ["artifact.build.alpha"],
      evidenceRefs: ["execution.log.build"],
      attestationRef: "executor.signature.build",
      actualDelta: { state: "applied", revision: 2 }
    }));
    const deps = { ...dispatcherFixture([executor]), dialogueMemory };
    const result = await dispatchCapabilityTask(deps, {
      ...baseInput({ controls: ungovernedControls() }),
      operatorOutcome: {
        conversationId: "conversation.action",
        operatorIds: [COGNITIVE_OPERATOR_IDS.actionPlanning],
        typedInputState: { state: "ready", revision: 1 },
        predictedDelta: { state: "applied", revision: 2 }
      }
    });

    expect(result.outcome?.operatorObservation).toEqual({
      schema: "scce.operator.outcome_observation.v1",
      conversationId: "conversation.action",
      operatorIds: [COGNITIVE_OPERATOR_IDS.actionPlanning],
      typedInputState: { state: "ready", revision: 1 },
      predictedDelta: { state: "applied", revision: 2 },
      actualDelta: { state: "applied", revision: 2 }
    });
    const observations = await dialogueMemory.listCalibrationObservations({ sourceRecordId: result.outcome!.id });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.metadata).toMatchObject({
      typedInputState: { state: "ready", revision: 1 },
      predictedDelta: { state: "applied", revision: 2 },
      actualDelta: { state: "applied", revision: 2 }
    });
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

  describe("plan-simulation gate (plan items 177-179)", () => {
    it("dispatches normally when no caller supplies planSimulation, unchanged from before this gate existed", async () => {
      const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" }));
      const deps = dispatcherFixture([executor]);
      const result = await dispatchCapabilityTask(deps, baseInput({ controls: ungovernedControls() }));
      expect(result.disposition).toBe("succeeded");
    });

    it("refuses to execute an irreversible task when the supplied expected risk clears the threshold and no simulation was ever stored", async () => {
      // fakeExecutor's descriptor.rollback defaults to "unavailable" --
      // genuinely irreversible, the same real signal the gate uses.
      const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" }));
      const deps = dispatcherFixture([executor]);
      const input = {
        ...baseInput({ controls: ungovernedControls() }),
        planSimulation: { expectedUtility: 0.9, expectedRisk: 0.8, simulations: [] }
      };
      const result = await dispatchCapabilityTask(deps, input);
      expect(result.disposition).toBe("simulation_required");
      expect(result.simulationReason).toContain("no stored simulation");
      expect(result.state.tasks["task.build"]?.status).toBe("ready");
    });

    it("refuses to execute when a stored simulation exists for this plan but did not approve it", async () => {
      const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" }));
      const deps = dispatcherFixture([executor]);
      const input = {
        ...baseInput({ controls: ungovernedControls() }),
        planSimulation: {
          expectedUtility: 0.3,
          expectedRisk: 0.8,
          simulations: [{
            schema: "scce.plan_simulation.v1" as const,
            id: "plan_simulation.rejected",
            capabilityPlanId: "task.build",
            simulatedAt: 1_000,
            expectedUtility: 0.3,
            expectedRisk: 0.8,
            reversible: false,
            approved: false,
            reasons: ["expected utility (0.3) does not exceed expected risk (0.8)"]
          }]
        }
      };
      const result = await dispatchCapabilityTask(deps, input);
      expect(result.disposition).toBe("simulation_required");
      expect(result.simulationReason).toContain("did not approve");
    });

    it("executes once a real, matching, approved simulation record is supplied", async () => {
      const executor = fakeExecutor("process.build_test", () => ({ status: "succeeded", outputRefs: ["artifact.alpha"], evidenceRefs: [], attestationRef: "executor.signature.build" }));
      const deps = dispatcherFixture([executor]);
      const input = {
        ...baseInput({ controls: ungovernedControls() }),
        planSimulation: {
          expectedUtility: 0.9,
          expectedRisk: 0.8,
          simulations: [{
            schema: "scce.plan_simulation.v1" as const,
            id: "plan_simulation.approved",
            capabilityPlanId: "task.build",
            simulatedAt: 1_000,
            expectedUtility: 0.9,
            expectedRisk: 0.8,
            reversible: false,
            approved: true,
            reasons: ["expected utility exceeds expected risk"]
          }]
        }
      };
      const result = await dispatchCapabilityTask(deps, input);
      expect(result.disposition).toBe("succeeded");
      expect(result.receipt?.outputRefs).toEqual(["artifact.alpha"]);
    });

    it("does not require a stored simulation for a reversible, low-risk task even when planSimulation is supplied", async () => {
      const executor: CapabilityExecutor = {
        descriptor: { capabilityId: "process.build_test", idempotency: "non-repeatable", rollback: "supported" },
        execute: async () => ({ status: "succeeded", outputRefs: [], evidenceRefs: [], attestationRef: "executor.signature.build" })
      };
      const deps = dispatcherFixture([executor]);
      const input = {
        ...baseInput({ controls: ungovernedControls() }),
        planSimulation: { expectedUtility: 0.9, expectedRisk: 0.1, simulations: [] }
      };
      const result = await dispatchCapabilityTask(deps, input);
      expect(result.disposition).toBe("succeeded");
    });
  });
});
