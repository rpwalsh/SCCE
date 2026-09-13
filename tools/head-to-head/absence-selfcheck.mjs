// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Regression check for the harness's absent-measurement defaults. Every assertion here fails against the code as it
// was before `absence.mjs` existed, and each names the wrong conclusion the old default produced.
// Offline: no server, no database, no clock.
//   node tools/head-to-head/absence-selfcheck.mjs

import { interpretTurnResponse, comparableWorkloadWins, meanOfMeasured, maxOfMeasured } from "./absence.mjs";

const failures = [];
const check = (name, condition, detail) => {
  if (!condition) failures.push(`${name}: ${detail}`);
  process.stdout.write(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : `  -- ${detail}`}\n`);
};

// ---- a turn that ran, and admitted nothing. Zero here IS the measurement. ------------------------------------
const answered = interpretTurnResponse({ status: 200, payload: { answer: "Athens.", evidence: [{}, {}] }, ms: 1200 });
check("answered.evidence_is_the_count", answered.evidence === 2, `expected 2, got ${answered.evidence}`);
const missed = interpretTurnResponse({ status: 200, payload: { answer: "", evidence: [] }, ms: 900 });
check("retrieval_miss.evidence_is_zero", missed.evidence === 0, `a turn that admitted no spans measured zero; got ${missed.evidence}`);

// ---- a turn that ran and reported no count at all. Absent is not zero. ---------------------------------------
const uncounted = interpretTurnResponse({ status: 200, payload: { answer: "Athens." }, ms: 900 });
check("no_evidence_key.is_null", uncounted.evidence === null,
  `a 200 body with no evidence array never reported a count; got ${uncounted.evidence}, which reads as a retrieval miss`);

// ---- HTTP 422: the turn declined and the harness never asked for its evidence. -------------------------------
const declined = interpretTurnResponse({ status: 422, payload: { ok: false, error: "runtime declined" }, ms: 700 });
check("runtime_decline.evidence_is_null", declined.evidence === null, `expected null, got ${declined.evidence}`);
check("runtime_decline.is_flagged", declined.declinedByRuntime === true, "a 422 must be separable from a retrieval miss");

// ---- any other non-OK status: {ok:false,error}, no answer key, no evidence key. -------------------------------
// This is the branch the 422 fix did not cover. `Array.isArray(payload.evidence) ? ... : 0` scored a server fault
// as declined_when_answerable over an empty pool, with runtimeDeclined false and nothing recording the fault.
const fault = interpretTurnResponse({ status: 500, payload: { ok: false, error: "connection terminated", status: 500 }, ms: 30000 });
check("server_fault.evidence_is_null", fault.evidence === null,
  `a 500 measured nothing about retrieval; got ${fault.evidence}, indistinguishable from a real miss`);
check("server_fault.is_not_a_runtime_decline", fault.declinedByRuntime === false, "a fault is not the runtime refusing to speak");
check("server_fault.records_its_status", fault.httpStatus === 500, `expected 500, got ${fault.httpStatus}`);
check("server_fault.records_its_error", /connection terminated/u.test(String(fault.error)), `expected the server's message, got ${fault.error}`);
const faultNoBody = interpretTurnResponse({ status: 503, payload: null, ms: 10 });
check("unparseable_fault.still_null", faultNoBody.evidence === null && faultNoBody.httpStatus === 503,
  `expected null evidence and status 503, got ${faultNoBody.evidence} / ${faultNoBody.httpStatus}`);

// ---- workload comparison: an absent side is not a zero-scoring side. -----------------------------------------
const scce = { cloze: { correct: 112, items: 160 }, book: { correct: 2, items: 12 }, code: { correct: 4, items: 8 } };
const bothRan = comparableWorkloadWins(scce, { cloze: { correct: 26, items: 160 }, book: { correct: 10, items: 12 }, code: { correct: 4, items: 8 } });
check("workloads.counts_real_wins", bothRan.won === 2 && bothRan.comparable === 3, `expected 2/3, got ${bothRan.won}/${bothRan.comparable}`);
const referenceMissingOne = comparableWorkloadWins(scce, { cloze: { correct: 26, items: 160 }, book: { correct: 10, items: 12 } });
check("workloads.absent_reference_is_not_a_win", referenceMissingOne.won === 1 && referenceMissingOne.comparable === 2,
  `a workload the reference was never graded on counted as won; got ${referenceMissingOne.won}/${referenceMissingOne.comparable}`);
check("workloads.absent_reference_is_named", referenceMissingOne.incomparable.join() === "code",
  `expected the uncompared workload to be named, got [${referenceMissingOne.incomparable.join()}]`);
const referenceAbsent = comparableWorkloadWins(scce, {});
check("workloads.unrun_reference_wins_nothing", referenceAbsent.won === 0 && referenceAbsent.comparable === 0,
  `a reference that never ran scored ${referenceAbsent.won}/${referenceAbsent.comparable} against SCCE`);

// ---- latency and peak memory over a side nobody measured. -----------------------------------------------------
check("mean.of_measured_only", meanOfMeasured([100, undefined, 300]) === 200, `absent rows must not dilute the mean; got ${meanOfMeasured([100, undefined, 300])}`);
check("mean.of_nothing_is_null", meanOfMeasured([undefined, undefined]) === null,
  `an unmeasured side reported ${meanOfMeasured([undefined, undefined])} ms, which reads as instantaneous`);
check("max.of_nothing_is_null", maxOfMeasured([undefined, null]) === null, `expected null, got ${maxOfMeasured([undefined, null])}`);
check("max.of_measured", maxOfMeasured([undefined, 512, 300]) === 512, `expected 512, got ${maxOfMeasured([undefined, 512, 300])}`);

process.stdout.write(`\n${failures.length ? `${failures.length} FAILED` : "all checks passed"}\n`);
process.exit(failures.length ? 1 : 0);
