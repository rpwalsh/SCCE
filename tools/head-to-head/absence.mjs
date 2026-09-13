// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What a harness records when a measurement was NOT taken. Zero is a measurement; absent is not. `?? 0` on a field
// that can legitimately be unknown converts "we did not ask" into a confident claim, and every consumer downstream
// believes it -- an HTTP 422 decline read as a retrieval miss cost three lanes an evening.
// Pure: no server, no clock, no process state, so `absence-selfcheck.mjs` can assert every branch offline.

/**
 * How the SCCE side of a turn actually ended, keeping three outcomes apart that all used to collapse to
 * `answer: "", evidence: 0`:
 *   answered        the turn ran; `evidence` is its admitted span count, and 0 there is a real retrieval miss
 *   runtime decline HTTP 422, no admissible surface. The turn ran, the harness never asked for its evidence.
 *   transport fault any other non-OK status. The body is `{ok:false,error}` with no answer and no evidence key,
 *                   so nothing about retrieval was measured at all.
 * `evidence` is null in the last two: null propagates as "unknown" through every consumer, 0 does not.
 */
export function interpretTurnResponse({ status, payload, ms }) {
  if (status === 422) return { answer: "", ms, evidence: null, declinedByRuntime: true, httpStatus: status, error: null };
  const ok = status >= 200 && status < 300;
  if (!ok) {
    return {
      answer: "",
      ms,
      evidence: null,
      declinedByRuntime: false,
      httpStatus: status,
      error: String(payload?.error ?? `HTTP ${status}`)
    };
  }
  return {
    answer: String(payload?.answer ?? ""),
    ms,
    evidence: Array.isArray(payload?.evidence) ? payload.evidence.length : null,
    declinedByRuntime: false,
    httpStatus: status,
    error: null
  };
}

/**
 * Workloads where SCCE matches or beats the reference, counted only over workloads BOTH systems were graded on.
 * `(a[w]?.correct ?? 0) >= (b[w]?.correct ?? 0)` scores a workload the reference was never asked as a win,
 * because absent became 0 on the losing side of the comparison. A workload one side never ran is not a tie.
 */
export function comparableWorkloadWins(scceByWorkload, referenceByWorkload) {
  const mine = scceByWorkload ?? {};
  const theirs = referenceByWorkload ?? {};
  const comparable = Object.keys(mine).filter(workload => theirs[workload] && typeof theirs[workload].correct === "number");
  const incomparable = Object.keys(mine).filter(workload => !comparable.includes(workload));
  return {
    won: comparable.filter(workload => mine[workload].correct >= theirs[workload].correct).length,
    comparable: comparable.length,
    incomparable
  };
}

/**
 * Mean of the values that exist, and null when none do. `sum(x ?? 0) / rows.length` reports a latency of 0 ms for
 * a side nobody measured, which reads as instantaneous rather than as unmeasured.
 */
export function meanOfMeasured(values) {
  const measured = values.filter(value => typeof value === "number" && Number.isFinite(value));
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
}

/** Max of the values that exist, and null when none do. `Math.max(0, ...absent)` reports a floor as a maximum. */
export function maxOfMeasured(values) {
  const measured = values.filter(value => typeof value === "number" && Number.isFinite(value));
  return measured.length ? Math.max(...measured) : null;
}
