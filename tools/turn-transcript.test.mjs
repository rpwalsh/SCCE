// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FAILURE_IDS,
  OUTCOME_IDS,
  STAGE_IDS,
  STAGE_STATUS,
  attachProbe,
  readTraceEvents,
  renderTurn,
  segmentTurns,
  turnRecord
} from "./turn-transcript.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "turn-transcript.fixture.jsonl");
const load = async () => (await readTraceEvents(fixture)).map(event => event);
const records = async () => segmentTurns(await load()).map(turnRecord);

test("every turn.input in the trace becomes exactly one record", async () => {
  const events = await load();
  const inputs = events.filter(event => event.stage === "turn.input").length;
  const rows = segmentTurns(events).map(turnRecord);
  assert.equal(inputs, 7);
  assert.equal(rows.length, inputs);
  assert.deepEqual(rows.map(row => row.index), [1, 2, 3, 4, 5, 6, 7]);
});

test("the five failure classes are read off typed fields, one fixture turn each", async () => {
  const rows = await records();
  assert.deepEqual(rows.slice(0, 6).map(row => row.failureClass), [
    FAILURE_IDS.none,
    FAILURE_IDS.population,
    FAILURE_IDS.candidates,
    FAILURE_IDS.authority,
    FAILURE_IDS.planning,
    FAILURE_IDS.realization
  ]);
  assert.deepEqual(rows.slice(0, 6).map(row => row.outcome), [
    OUTCOME_IDS.answered,
    OUTCOME_IDS.withheld,
    OUTCOME_IDS.withheld,
    OUTCOME_IDS.withheld,
    OUTCOME_IDS.withheld,
    OUTCOME_IDS.withheld
  ]);
});

test("each failure class is the first stage whose typed quantity is not populated", async () => {
  const rows = await records();
  assert.equal(rows[1].stages.population.models, 0);
  assert.equal(rows[1].stageStatus.population, STAGE_STATUS.empty);
  assert.equal(rows[2].stages.population.models, 2);
  assert.equal(rows[2].stages.candidates.scored, 0);
  assert.equal(rows[2].stageStatus.candidates, STAGE_STATUS.empty);
  assert.equal(rows[3].stages.candidates.scored, 2);
  assert.deepEqual(rows[3].stages.authority.admittedCandidateIds, []);
  assert.deepEqual(
    rows[3].stages.authority.rejected.flatMap(row => row.failureIds),
    ["missed-required-output", "no-factual-support"]
  );
  assert.equal(rows[4].stages.authority.admittedCandidateIds.length, 1);
  assert.equal(rows[4].stages.planning.selectedCandidateId, null);
  assert.equal(rows[5].stages.planning.selectedCandidateId, "c1");
  assert.equal(rows[5].stages.realization.answerChars, 0);
  assert.equal(rows[5].stages.realization.deterministicSurfaces, 7);
  assert.deepEqual(rows[5].stages.realization.fallbackStageIds, ["mouth.source_summary_fallback.withheld"]);
});

test("classification ignores the realized surface text entirely", async () => {
  const events = await load();
  const mutated = events.map(event => (typeof event.output === "string"
    ? { ...event, output: `${event.output}-ZZZZ-different-surface` }
    : event));
  const before = segmentTurns(events).map(turnRecord);
  const after = segmentTurns(mutated).map(turnRecord);
  assert.deepEqual(after.map(row => row.failureClass), before.map(row => row.failureClass));
  assert.deepEqual(after.map(row => row.outcome), before.map(row => row.outcome));
  assert.deepEqual(after.map(row => row.stageStatus), before.map(row => row.stageStatus));
});

test("a turn missing a stage reports it as missing and is still emitted", async () => {
  const rows = await records();
  const bare = rows[6];
  assert.equal(bare.index, 7);
  assert.deepEqual(bare.missingStageIds, STAGE_IDS);
  for (const id of STAGE_IDS) assert.equal(bare.stageStatus[id], STAGE_STATUS.missing);
  assert.equal(bare.failureClass, FAILURE_IDS.population);
  // The answered turn has no withholding record, and that absence is reported, not skipped.
  assert.deepEqual(rows[0].missingStageIds, ["withheld"]);
  assert.equal(rows[0].stageStatus.withheld, STAGE_STATUS.missing);
});

test("the six per-turn items are carried as ids and numbers on the answered turn", async () => {
  const [answered] = await records();
  assert.equal(answered.episodeId, "episode_fixture_1");
  assert.equal(answered.stages.population.languageId, "language_identity_fixture");
  assert.equal(answered.stages.population.cacheReason, "role-resolved");
  assert.deepEqual(answered.stages.candidates.producerIds, ["kernel.turn.source_exact"]);
  assert.equal(answered.stages.candidates.constructionId, "construction.fixture");
  assert.equal(answered.stages.candidates.constructionBundleId, "bundle.fixture");
  assert.equal(answered.stages.authority.basisClassId, "basis.fixture");
  assert.equal(answered.stages.authority.certificationId, "cert.fixture");
  assert.equal(answered.stages.authority.verifierVerdictId, "scce.verdict.001");
  assert.equal(answered.stages.planning.selectedCandidateId, "c1");
  assert.equal(answered.stages.planning.surfaceMass, 0.9);
  assert.equal(answered.stages.planning.boltzmannProbability, 0.7);
  assert.equal(answered.stages.planning.boltzmannMarginToRunnerUp, null);
  assert.equal(answered.stages.realization.surfaceRealizationId, "c1");
  assert.equal(answered.stages.surface.answerChars, 5);
});

test("the typed withholding record is surfaced when the decline traced one", async () => {
  const rows = await records();
  assert.equal(rows[2].stages.withheld.reasonId, "withheld.no_admitted_evidence");
  assert.deepEqual(rows[2].stages.withheld.learningNeedIds, ["need.fixture"]);
  assert.deepEqual(rows[2].stages.withheld.componentStatuses, ["request_communicative_act=active"]);
  assert.equal(rows[3].stages.withheld.reasonId, "withheld.surface_refused");
  assert.deepEqual(rows[3].stages.withheld.unresolvedRequirementIds, ["req.fixture"]);
  // Turn 2 has no typed record and only the prose warning; it is still reported as present.
  assert.equal(rows[1].stages.withheld.reasonId, null);
  assert.deepEqual(rows[1].stages.withheld.errorWarnings, ["E"]);
  assert.equal(rows[1].stageStatus.withheld, STAGE_STATUS.ok);
});

test("a probe row joins by request text or ordinal and reports disagreement", async () => {
  const rows = await records();
  const probe = {
    schema: "scce.capitals_probe.v1",
    rows: [{ text: "FIXTURE", answer: "AAAAA", elapsedMs: 1500, evidence: 2 }]
  };
  const joined = attachProbe(rows, probe);
  assert.equal(joined[0].probe.matchId, "probe.by_request_text");
  assert.equal(joined[0].probe.elapsedMs, 1500);
  assert.equal(joined[0].probe.answerCharsAgree, true);
  assert.equal(joined[1].probe.matchId, "probe.by_request_text");
  assert.equal(joined[1].probe.answerCharsAgree, false);
});

test("each turn renders one line per stage", async () => {
  const rows = await records();
  for (const row of rows) {
    const lines = renderTurn(row).split("\n");
    assert.equal(lines.length, STAGE_IDS.length + 3);
    for (const [i, id] of STAGE_IDS.entries()) assert.ok(lines[i + 2].startsWith(`  ${id}`), `${id} on line ${i + 2}`);
  }
});
