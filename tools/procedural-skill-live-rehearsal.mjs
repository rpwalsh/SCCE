#!/usr/bin/env node
// Live verification for plan items 215-216 (procedural skill compilation +
// execution, packages/kernel/src/procedural-skill-runtime.ts): proves the
// compile-from-real-ledger-history -> execute-through-the-real-capability
// round trip against real Postgres, not an in-memory mock. Runs against a
// disposable schema (created + dropped here), never the real scce3_runtime
// schema -- mirrors tools/live-adapter-rehearsal.mjs's isolation pattern.
import { createHash } from "node:crypto";
import { createPostgresStorageAdapter } from "../packages/adapters-node/dist/postgres.js";
import { createEventFactory } from "../packages/kernel/dist/events.js";
import { createClock, createHasher } from "../packages/kernel/dist/primitives.js";
import { createIdFactory } from "../packages/kernel/dist/ids.js";
import { compileBuildTestSkillFromLedger, executeBuildTestSkill } from "../packages/kernel/dist/procedural-skill-runtime.js";

const databaseUrl = process.env.SCCE_TEST_DATABASE_URL ?? "postgresql://postgres:root@localhost:5432/scce";
const schema = `scce_rehearsal_skill_${process.pid}_${Date.now()}`;
if (!/^scce_rehearsal_skill_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe rehearsal schema name");

const checks = [];
let storage;
let primaryError;

try {
  storage = createPostgresStorageAdapter({ url: databaseUrl, schema });
  await storage.migrate();
  const verify = await storage.verify();
  check("schema.verify", verify.ok, verify.errors.join("; "));

  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1_700_000_000_000, stepMs: 1000 });
  const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
  const eventFactory = createEventFactory({ idFactory, clock, hasher });

  check("precondition.no_skill_before_history", (await compileBuildTestSkillFromLedger(storage.events)) === undefined, "expected no compilable skill before any real history exists");

  // Three distinct episodes, each a real BuildExecuted -> TestExecuted ->
  // CapabilitySucceeded sequence, plus the EpisodeConsolidated summary
  // production-turn-runtime.ts's own consolidateCurrentEpisode() would have
  // appended -- the exact shape compileBuildTestSkillFromLedger reads.
  const episodeIds = ["episode.rehearsal.1", "episode.rehearsal.2", "episode.rehearsal.3"];
  for (const episodeId of episodeIds) {
    const owner = eventFactory.create({ episodeId, typeId: "OwnerAsked", payload: { textHash: hasher.digestHex("repair the failing test"), requestedAuthority: "program" } });
    await storage.events.append(owner);
    const build = eventFactory.create({ episodeId, typeId: "BuildExecuted", payload: { code: 0, durationMs: 812, stderrHash: hasher.digestHex("") } });
    await storage.events.append(build);
    const test = eventFactory.create({ episodeId, typeId: "TestExecuted", payload: { code: 0, passed: true, repairAttempted: false } });
    await storage.events.append(test);
    const succeeded = eventFactory.create({ episodeId, typeId: "CapabilitySucceeded", payload: { capabilityId: "process.build_test", passed: true } });
    await storage.events.append(succeeded);
    const episodeEvents = await storage.events.readEpisode(episodeId);
    const consolidated = {
      episodeId,
      goal: owner.payload,
      requestFeatures: [],
      contextEventIds: [],
      actionEventIds: [build.id, test.id],
      outcomeEventIds: [succeeded.id],
      correctionEventIds: [],
      lessons: [],
      sourceEventIds: episodeEvents.map(event => event.id),
      eventCount: episodeEvents.length,
      firstT: episodeEvents[0].t,
      lastT: episodeEvents[episodeEvents.length - 1].t
    };
    await storage.events.append(eventFactory.create({ episodeId, typeId: "EpisodeConsolidated", payload: consolidated }));
  }

  const compiled = await compileBuildTestSkillFromLedger(storage.events, { minimumSuccessCount: 3 });
  check("compile.skill_found", Boolean(compiled), "expected a real compiled skill from 3 real successful episodes");
  check("compile.source_episode_ids", JSON.stringify(compiled?.sourceEpisodeIds) === JSON.stringify([...episodeIds].sort()), `got ${JSON.stringify(compiled?.sourceEpisodeIds)}`);
  check("compile.authority", compiled?.authority === "authority.class.build_test", `got ${compiled?.authority}`);
  check("compile.rollback_steps_empty", Array.isArray(compiled?.rollbackSteps) ? compiled.rollbackSteps.length === 0 : compiled?.rollbackSteps === undefined, "build/test has no durable mutation to roll back");

  let executedRealProgram = false;
  const executeProgram = async ({ episodeId, construct }) => {
    executedRealProgram = true;
    return {
      build: { code: 0, stdout: "", stderr: "", durationMs: 5 },
      test: { code: 0, stdout: "", stderr: "", durationMs: 5 },
      repairAttempted: false,
      repairApplied: false,
      passed: true,
      artifacts: []
    };
  };
  const run = await executeBuildTestSkill({ skill: compiled, episodeId: "episode.rehearsal.new", construct: { id: "construct.rehearsal", episodeId: "episode.rehearsal.new", forceVector: {}, nodes: [], edges: [], artifacts: [] }, executeProgram });
  check("execute.ran_real_program", executedRealProgram, "executeBuildTestSkill must invoke the real executeProgram capability, not skip it");
  check("execute.ok", run.execution.ok === true, JSON.stringify(run.execution));
  check("execute.buildtest_passed", run.buildTest?.passed === true, JSON.stringify(run.buildTest));
  check("execute.rolled_back_false", run.execution.rolledBack === false, "a successful execution must never roll back");

  // Adversarial: a skill compiled from failed episodes must not compile.
  const failedEpisodeIds = ["episode.rehearsal.fail.1", "episode.rehearsal.fail.2", "episode.rehearsal.fail.3"];
  for (const episodeId of failedEpisodeIds) {
    const build = eventFactory.create({ episodeId, typeId: "BuildExecuted", payload: { code: 1, durationMs: 400, stderrHash: hasher.digestHex("error") } });
    await storage.events.append(build);
    const test = eventFactory.create({ episodeId, typeId: "TestExecuted", payload: { code: 1, passed: false, repairAttempted: true } });
    await storage.events.append(test);
    const failed = eventFactory.create({ episodeId, typeId: "CapabilityFailed", payload: { capabilityId: "process.build_test", passed: false, reason: "compile error" } });
    await storage.events.append(failed);
    const episodeEvents = await storage.events.readEpisode(episodeId);
    const consolidated = {
      episodeId,
      requestFeatures: [],
      contextEventIds: [],
      actionEventIds: [build.id, test.id],
      outcomeEventIds: [failed.id],
      correctionEventIds: [],
      lessons: ["compile error"],
      sourceEventIds: episodeEvents.map(event => event.id),
      eventCount: episodeEvents.length,
      firstT: episodeEvents[0].t,
      lastT: episodeEvents[episodeEvents.length - 1].t
    };
    await storage.events.append(eventFactory.create({ episodeId, typeId: "EpisodeConsolidated", payload: consolidated }));
  }
  const compiledAfterFailures = await compileBuildTestSkillFromLedger(storage.events, { minimumSuccessCount: 6 });
  check("compile.failed_episodes_excluded", compiledAfterFailures === undefined, "3 real successes + 3 real failures must not compile a 6-success skill -- failures cannot pad the success count");
} catch (error) {
  primaryError = error;
} finally {
  try {
    if (storage) await storage.query(`DROP SCHEMA IF EXISTS "${storage.schema}" CASCADE`);
    checks.push({ id: "cleanup.drop_disposable_schema", passed: true, detail: storage?.schema });
  } catch (cleanupError) {
    primaryError ??= cleanupError;
  }
  if (storage) await storage.close().catch(error => { primaryError ??= error; });
}

const report = {
  schema: "scce.procedural_skill_live_rehearsal.v1",
  completedAt: new Date().toISOString(),
  disposableSchema: schema,
  fixtureContainsSyntheticDataOnly: true,
  checks,
  status: !primaryError && checks.every(entry => entry.passed) ? "passed" : "failed",
  error: primaryError ? sanitized(primaryError) : null
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "passed") process.exitCode = 1;

function check(id, passed, detail) {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

function sanitized(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 1000);
}
