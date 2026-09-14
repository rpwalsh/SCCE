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

    expect(await restarted.loadPlan(hash("a"))).toEqual(binding());
    const supports = await restarted.recordExecution({
      planHash: hash("a"),
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
      planHash: hash("a"),
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
});

function binding() {
  return {
    schema: PROGRAM_BEHAVIOR_VALIDATION_PLAN_BINDING_SCHEMA,
    planHash: hash("a"),
    graph: {
      schema: "scce.workspace.task_constraint_graph.v1" as const,
      id: "graph.1",
      workspaceRevision: { workspaceId: "workspace.1", revisionId: "revision.1", revisionHash: hash("e") },
      analyzerRevision: { analyzerId: "analyzer.1", analyzerVersion: "1", semanticRevisionHash: hash("f") },
      validationCommandBindings: [],
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
    async append(event) { rows.push(event); },
    async appendBatch(events) { rows.push(...events); },
    async readEpisode(episodeId) { return rows.filter(event => event.episodeId === episodeId); },
    async readRange(query) { return rows.filter(event => !query.episodeId || event.episodeId === query.episodeId).slice(0, query.limit); },
    async latestLedgerHash() { return rows.at(-1)?.hash ?? ""; }
  };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
