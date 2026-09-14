// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import {
  createProgramBehaviorValidationLedger,
  PROGRAM_BEHAVIOR_VALIDATION_PLAN_BINDING_SCHEMA,
  programBehaviorValidationEpisodeId
} from "../program-behavior-validation-ledger.js";
import type { EventLedger } from "../storage.js";
import type { ScceEvent } from "../types.js";

describe("program behavior validation ledger", () => {
  it("survives recreation and records only receipt-supported structural roles", async () => {
    const events = memoryLedger();
    const first = ledger(events);
    await first.bindPlan(binding());
    const restarted = ledger(events);

    expect(await restarted.loadPlan({ workspaceId: "workspace.1", planHash: hash("a") })).toEqual(binding());
    const supports = await restarted.recordExecution({
      workspaceId: "workspace.1",
      planHash: hash("a"),
      validationPolicyId: "validation.policy.1",
      validationBindingHash: hash("1"),
      receipt: {
        planHash: hash("a"),
        transactionReceiptHash: hash("b"),
        validationEvidenceHash: hash("c"),
        commandOutcomes: [{
          checkId: "tests",
          commandIndex: 1,
          commandEvidenceHash: hash("d"),
          executed: true,
          passed: true
        }]
      }
    });

    expect(supports).toMatchObject([{
      semanticStatus: "execution_supported_unassigned",
      constructionId: "construction.1",
      memberObservationIds: ["observation.1"]
    }]);
    expect(await restarted.recordExecution({
      workspaceId: "workspace.1",
      planHash: hash("a"),
      validationPolicyId: "validation.policy.1",
      validationBindingHash: hash("1"),
      receipt: {
        planHash: hash("a"),
        transactionReceiptHash: hash("b"),
        validationEvidenceHash: hash("c"),
        commandOutcomes: [{ checkId: "tests", commandIndex: 1, commandEvidenceHash: hash("d"), executed: true, passed: true }]
      }
    })).toEqual(supports);
  });

  it("keeps one server-authored graph binding immutable per plan", async () => {
    const events = memoryLedger();
    const subject = ledger(events);
    await subject.bindPlan(binding());
    await expect(subject.bindPlan({ ...binding(), graph: { ...binding().graph, id: "graph.changed" } })).rejects.toThrow(/immutable/u);
  });

  it("isolates identical plan bytes by workspace and validation policy", async () => {
    const events = memoryLedger();
    const subject = ledger(events);
    await subject.bindPlan(binding("workspace.1", "validation.policy.1"));
    await subject.bindPlan(binding("workspace.2", "validation.policy.2"));

    expect(await subject.loadPlan({ workspaceId: "workspace.1", planHash: hash("a") }))
      .toEqual(binding("workspace.1", "validation.policy.1"));
    expect(await subject.loadPlan({ workspaceId: "workspace.2", planHash: hash("a") }))
      .toEqual(binding("workspace.2", "validation.policy.2"));
    await expect(subject.recordExecution({
      workspaceId: "workspace.1",
      planHash: hash("a"),
      validationPolicyId: "validation.policy.2",
      validationBindingHash: hash("2"),
      receipt: {
        planHash: hash("a"),
        transactionReceiptHash: hash("b"),
        validationEvidenceHash: hash("c"),
        commandOutcomes: [{ checkId: "tests", commandIndex: 1, commandEvidenceHash: hash("d"), executed: true, passed: true }]
      }
    })).rejects.toThrow(/validation policy/u);
    await expect(subject.recordExecution({
      workspaceId: "workspace.1",
      planHash: hash("a"),
      validationPolicyId: "validation.policy.1",
      validationBindingHash: hash("2"),
      receipt: {
        planHash: hash("a"),
        transactionReceiptHash: hash("b"),
        validationEvidenceHash: hash("c"),
        commandOutcomes: [{ checkId: "tests", commandIndex: 1, commandEvidenceHash: hash("d"), executed: true, passed: true }]
      }
    })).rejects.toThrow(/validation binding/u);
  });
});

function binding(workspaceId = "workspace.1", validationPolicyId = "validation.policy.1") {
  return {
    schema: PROGRAM_BEHAVIOR_VALIDATION_PLAN_BINDING_SCHEMA,
    planHash: hash("a"),
    validationPolicyId,
    validationBindingHash: validationPolicyId === "validation.policy.1" ? hash("1") : hash("2"),
    graph: {
      schema: "scce.workspace.task_constraint_graph.v1" as const,
      id: "graph.1",
      workspaceRevision: { workspaceId, revisionId: "revision.1", revisionHash: hash("e") },
      analyzerRevision: { analyzerId: "analyzer.1", analyzerVersion: "1", semanticRevisionHash: hash("f") },
      validationCommandBindings: [{ commandId: "command.tests", checkId: "tests" as const, commandIndex: 1 }],
      constructions: [{
        id: "construction.1",
        kindId: "scce.program.behavior_role_construction.v1" as const,
        memberObservationIds: ["observation.1"],
        evidenceSpanIds: ["span.1"]
      }]
    }
  };
}

function ledger(events: EventLedger) {
  const clock = createClock();
  const hasher = createHasher();
  return createProgramBehaviorValidationLedger({
    events,
    clock,
    hasher
  });
}

function memoryLedger(): EventLedger {
  const rows: ScceEvent[] = [];
  return {
    async append(event) {
      if (!rows.some(row => row.id === event.id)) rows.push(event);
    },
    async appendBatch(events) {
      for (const event of events) {
        if (!rows.some(row => row.id === event.id)) rows.push(event);
      }
    },
    async readEpisode(episodeId) { return rows.filter(event => event.episodeId === episodeId); },
    async readRange(query) { return rows.filter(event => !query.episodeId || event.episodeId === query.episodeId).slice(0, query.limit); },
    async latestLedgerHash() { return rows.at(-1)?.hash ?? ""; }
  };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
