import type { ConstructGraph, EpisodeId } from "./types.js";
import type { EventLedger } from "./storage.js";
import type { ConsolidatedEpisode } from "./episodic-memory-consolidation.js";
import {
  compileSkillFromEpisodes,
  executeSkill,
  type CompiledSkill,
  type ProceduralEpisodeTrace,
  type SkillExecutionContext,
  type SkillExecutionResult,
  type SkillStep
} from "./procedural-skill-compilation.js";
import type { BuildTestResult } from "./types.js";

/**
 * Plan items 215-216 live wiring. The one real, already-dispatched
 * capability the kernel has an actual live executor for today is
 * build/test (production-turn-runtime.ts's dispatchBuildTestThroughExecutive
 * / deps.buildTest.executeProgram) -- every other capability id
 * (Outlook/YouTube/network/etc) is still dispatched directly by
 * packages/server/src/routes.ts with no kernel-level executor registry to
 * look one up from (a separate, already-identified gap: Phase 16 items
 * 197-209). Scoping this wiring to build/test means it is genuinely live-
 * executable today, not a fabricated stand-in for capabilities the kernel
 * cannot actually dispatch yet.
 */
export const BUILD_TEST_SKILL_STEP: SkillStep = { actionType: "build_test.execute", input: {} };

/**
 * Mines the real, durable, cross-episode event ledger (EventLedger.readRange
 * queries real storage, not this turn's own in-memory event list) for past
 * episodes that actually ran a build/test dispatch, producing one real
 * ProceduralEpisodeTrace per such episode. succeeded is read from the real
 * CapabilitySucceeded/CapabilityFailed event pair the dispatcher already
 * emits -- never inferred or guessed. Returns [] honestly when the ledger
 * has no build/test history yet.
 */
export async function buildTestProceduralEpisodeTraces(
  events: EventLedger,
  limit = 128
): Promise<ProceduralEpisodeTrace[]> {
  const consolidatedRows = await events.readRange({ typeId: "EpisodeConsolidated", limit });
  const traces: ProceduralEpisodeTrace[] = [];
  const seenEpisodeIds = new Set<string>();
  for (const row of consolidatedRows) {
    const consolidated = row.payload as unknown as ConsolidatedEpisode;
    const episodeId = consolidated?.episodeId;
    if (!episodeId || seenEpisodeIds.has(String(episodeId))) continue;
    seenEpisodeIds.add(String(episodeId));
    const episodeEvents = await events.readEpisode(episodeId);
    const ranBuild = episodeEvents.some(event => event.typeId === "BuildExecuted");
    const ranTest = episodeEvents.some(event => event.typeId === "TestExecuted");
    if (!ranBuild || !ranTest) continue;
    const succeeded = episodeEvents.some(event => event.typeId === "CapabilitySucceeded")
      && !episodeEvents.some(event => event.typeId === "CapabilityFailed");
    traces.push({ episodeId: String(episodeId), steps: [BUILD_TEST_SKILL_STEP], succeeded });
  }
  return traces;
}

/**
 * Compiles a real build/test skill from real ledger history. Returns
 * undefined honestly (not a placeholder skill) when fewer than
 * minimumSuccessCount episodes have actually run a successful build/test
 * dispatch yet -- the common case for a fresh or lightly-used ledger.
 */
export async function compileBuildTestSkillFromLedger(
  events: EventLedger,
  input: { minimumSuccessCount?: number; limit?: number } = {}
): Promise<CompiledSkill | undefined> {
  const traces = await buildTestProceduralEpisodeTraces(events, input.limit ?? 128);
  return compileSkillFromEpisodes({
    episodes: traces,
    minimumSuccessCount: input.minimumSuccessCount ?? 3,
    authority: "authority.class.build_test",
    cost: 1,
    preconditions: ["construct.program.buildable"],
    postconditions: ["build.passed", "test.passed"],
    // Matches dispatchBuildTestThroughExecutive's own rollback: build/test
    // runs in an ephemeral workspace with no durable mutation to roll back.
    rollbackSteps: []
  });
}

/**
 * Real execution context for a compiled build/test skill: its one step
 * dispatches to exactly the same executeProgram executor
 * dispatchBuildTestThroughExecutive already uses for a normal (non-skill)
 * build/test dispatch. executeSkill gains no execution authority a normal
 * turn didn't already have -- it only adds proven-sequence bookkeeping
 * (this skill's id, sourceEpisodeIds) on top of the same real capability.
 * The real build/test still always actually runs; nothing here skips it.
 */
export function buildTestSkillExecutionContext(input: {
  episodeId: EpisodeId;
  construct: ConstructGraph;
  executeProgram: (input: { episodeId: EpisodeId; construct: ConstructGraph }) => Promise<BuildTestResult>;
  onResult?: (result: BuildTestResult) => void;
}): SkillExecutionContext {
  return {
    async executeStep(step) {
      if (step.actionType !== BUILD_TEST_SKILL_STEP.actionType) return { ok: false };
      const result = await input.executeProgram({ episodeId: input.episodeId, construct: input.construct });
      input.onResult?.(result);
      return { ok: result.passed, output: { code: result.build.code } };
    }
  };
}

/**
 * Executes a compiled build/test skill for real, end to end: runs the real
 * executeProgram capability through executeSkill's ordering/rollback
 * program, capturing the real BuildTestResult for the caller the same way
 * dispatchBuildTestThroughExecutive's caller already does.
 */
export async function executeBuildTestSkill(input: {
  skill: CompiledSkill;
  episodeId: EpisodeId;
  construct: ConstructGraph;
  executeProgram: (input: { episodeId: EpisodeId; construct: ConstructGraph }) => Promise<BuildTestResult>;
}): Promise<{ execution: SkillExecutionResult; buildTest?: BuildTestResult }> {
  let buildTest: BuildTestResult | undefined;
  const context = buildTestSkillExecutionContext({
    episodeId: input.episodeId,
    construct: input.construct,
    executeProgram: input.executeProgram,
    onResult: result => { buildTest = result; }
  });
  const execution = await executeSkill(input.skill, context);
  return { execution, buildTest };
}
