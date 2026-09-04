// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { compileBuildTestSkillFromLedger, executeBuildTestSkill, BUILD_TEST_SKILL_STEP } from "../procedural-skill-runtime.js";
import type { ConsolidatedEpisode } from "../episodic-memory-consolidation.js";
import type { EventLedger, EventRangeQuery } from "../storage.js";
import type { ConstructGraph, EpisodeId, EventId, ScceEvent } from "../index.js";

// Items 215-216 are real code with a real call site
// (production-turn-runtime.ts:1998-2027, inside the build/test dispatch
// path) but had zero test coverage of that wiring: the underlying pure
// compileSkillFromEpisodes/executeSkill functions were tested against
// hand-built ProceduralEpisodeTrace objects, never against a real
// EventLedger the way production-turn-runtime.ts actually calls
// compileBuildTestSkillFromLedger. This file closes that gap: a minimal
// but real EventLedger (append/readRange/readEpisode all genuinely
// filter/store, nothing stubbed to always-pass), seeded with the exact
// event shape dispatchBuildTestThroughExecutive's real dispatch produces
// (EpisodeConsolidated + BuildExecuted + TestExecuted +
// CapabilitySucceeded/CapabilityFailed), exercising the real
// mine-the-ledger -> compile -> execute pipeline end to end.

class MemoryEventLedger implements EventLedger {
  private readonly events: ScceEvent[] = [];
  private nextId = 0;

  async append(event: ScceEvent): Promise<void> {
    this.events.push(event);
  }

  async appendBatch(events: ScceEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async readEpisode(episodeId: EpisodeId): Promise<ScceEvent[]> {
    return this.events.filter(event => event.episodeId === episodeId);
  }

  async readRange(input: EventRangeQuery): Promise<ScceEvent[]> {
    let rows = this.events.slice();
    if (input.episodeId !== undefined) rows = rows.filter(event => event.episodeId === input.episodeId);
    if (input.typeId !== undefined) rows = rows.filter(event => event.typeId === input.typeId);
    if (input.afterT !== undefined) rows = rows.filter(event => event.t > input.afterT!);
    if (input.beforeT !== undefined) rows = rows.filter(event => event.t < input.beforeT!);
    if (input.limit !== undefined) rows = rows.slice(0, input.limit);
    return rows;
  }

  async latestLedgerHash(): Promise<string> {
    return this.events.at(-1)?.hash ?? "genesis";
  }

  seedBuildTestEpisode(input: { episodeId: string; t: number; succeeded: boolean }): void {
    const episodeId = input.episodeId as EpisodeId;
    const mk = (typeId: string, payload: unknown): ScceEvent => ({
      id: `evt.${this.nextId++}` as EventId,
      episodeId,
      typeId: typeId as ScceEvent["typeId"],
      t: input.t,
      payload: payload as ScceEvent["payload"],
      parents: [],
      hash: `hash.${this.nextId}`
    });
    const consolidated: ConsolidatedEpisode = {
      episodeId,
      requestFeatures: [],
      contextEventIds: [],
      actionEventIds: [],
      outcomeEventIds: [],
      correctionEventIds: [],
      lessons: [],
      sourceEventIds: [],
      eventCount: 3,
      firstT: input.t,
      lastT: input.t
    } as unknown as ConsolidatedEpisode;
    this.events.push(mk("EpisodeConsolidated", consolidated));
    this.events.push(mk("BuildExecuted", { code: 0 }));
    this.events.push(mk("TestExecuted", { code: 0 }));
    this.events.push(mk(input.succeeded ? "CapabilitySucceeded" : "CapabilityFailed", {}));
  }
}

describe("procedural build/test skill wiring against a real event ledger (plan items 215-216)", () => {
  it("does not compile a skill when the real ledger has fewer than minimumSuccessCount successful build/test episodes", async () => {
    const ledger = new MemoryEventLedger();
    ledger.seedBuildTestEpisode({ episodeId: "episode.1", t: 1, succeeded: true });
    ledger.seedBuildTestEpisode({ episodeId: "episode.2", t: 2, succeeded: true });
    // Only 2 successes exist; the default minimum is 3.
    const skill = await compileBuildTestSkillFromLedger(ledger);
    expect(skill).toBeUndefined();
  });

  it("compiles a real skill from real ledger history once enough episodes actually succeeded, ignoring failed ones", async () => {
    const ledger = new MemoryEventLedger();
    ledger.seedBuildTestEpisode({ episodeId: "episode.1", t: 1, succeeded: true });
    ledger.seedBuildTestEpisode({ episodeId: "episode.2", t: 2, succeeded: true });
    ledger.seedBuildTestEpisode({ episodeId: "episode.3", t: 3, succeeded: false });
    ledger.seedBuildTestEpisode({ episodeId: "episode.4", t: 4, succeeded: true });

    const skill = await compileBuildTestSkillFromLedger(ledger);
    expect(skill).toBeDefined();
    expect(skill!.steps).toEqual([BUILD_TEST_SKILL_STEP]);
    // Exactly the three real successful episodes, the failed one excluded.
    expect(skill!.sourceEpisodeIds.sort()).toEqual(["episode.1", "episode.2", "episode.4"]);
    expect(skill!.preconditions).toEqual(["construct.program.buildable"]);
    expect(skill!.postconditions).toEqual(["build.passed", "test.passed"]);
  });

  it("runs the compiled skill through executeBuildTestSkill, dispatching the real build/test capability -- never the source episodes' text", async () => {
    const ledger = new MemoryEventLedger();
    ledger.seedBuildTestEpisode({ episodeId: "episode.1", t: 1, succeeded: true });
    ledger.seedBuildTestEpisode({ episodeId: "episode.2", t: 2, succeeded: true });
    ledger.seedBuildTestEpisode({ episodeId: "episode.3", t: 3, succeeded: true });
    const skill = await compileBuildTestSkillFromLedger(ledger);
    expect(skill).toBeDefined();

    let executeProgramCalls = 0;
    let sawEpisodeIdOrConstructText = false;
    const result = await executeBuildTestSkill({
      skill: skill!,
      episodeId: "episode.new" as EpisodeId,
      construct: { id: "construct.new" } as unknown as ConstructGraph,
      executeProgram: async input => {
        executeProgramCalls += 1;
        // The real capability only ever receives this turn's own
        // episodeId/construct -- never anything derived from the compiled
        // skill's sourceEpisodeIds (which are never passed to
        // executeProgram at all by executeSkill's contract).
        if (String(input.episodeId) !== "episode.new") sawEpisodeIdOrConstructText = true;
        return { build: { code: 0, stdout: "", stderr: "", durationMs: 1 }, test: { code: 0, stdout: "", stderr: "", durationMs: 1 }, repairAttempted: false, repairApplied: false, passed: true, artifacts: [] };
      }
    });

    expect(executeProgramCalls).toBe(1);
    expect(sawEpisodeIdOrConstructText).toBe(false);
    expect(result.execution.ok).toBe(true);
    expect(result.execution.skillId).toBe(skill!.id);
    expect(result.buildTest?.passed).toBe(true);
  });

  it("a failed build/test step surfaces as a genuinely failed skill execution, not a silently swallowed one", async () => {
    const ledger = new MemoryEventLedger();
    ledger.seedBuildTestEpisode({ episodeId: "episode.1", t: 1, succeeded: true });
    ledger.seedBuildTestEpisode({ episodeId: "episode.2", t: 2, succeeded: true });
    ledger.seedBuildTestEpisode({ episodeId: "episode.3", t: 3, succeeded: true });
    const skill = await compileBuildTestSkillFromLedger(ledger);
    expect(skill).toBeDefined();

    const result = await executeBuildTestSkill({
      skill: skill!,
      episodeId: "episode.new" as EpisodeId,
      construct: { id: "construct.new" } as unknown as ConstructGraph,
      executeProgram: async () => ({ build: { code: 1, stdout: "", stderr: "compile error", durationMs: 1 }, test: { code: null, stdout: "", stderr: "", durationMs: 0 }, repairAttempted: false, repairApplied: false, passed: false, artifacts: [] })
    });

    expect(result.execution.ok).toBe(false);
    expect(result.buildTest?.passed).toBe(false);
  });
});
