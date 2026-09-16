// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Regression check for the measured head-to-head rig. Every assertion here fails against the rig as it was
// before `measure.mjs` existed, and each names the wrong conclusion the old harness produced: energy reported as
// null on AC power, no temperature at all, a fixed ask-order that let thermal drift load one system, and absent
// readings defaulted to zero.
// Offline: no server, no model, no sensor, no clock.
//   node tools/head-to-head/measure-selfcheck.mjs

import { integratePowerSamples } from "../sealed-eval/harness/lib/power-measurement.mjs";
import { score } from "./grade.mjs";
import {
  counterbalancedOrder, windowTemperature, marginalJoules, totalOfMeasured,
  summarizeMeasurement, orderBalance, idleBaseline, idleWatts, assembleArtifact
} from "./measure.mjs";

const failures = [];
const check = (name, condition, detail) => {
  if (!condition) failures.push(`${name}: ${detail}`);
  process.stdout.write(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : `  -- ${detail}`}\n`);
};

// A recorded sensor stream: cumulative joules at a constant 10 W, temperature climbing 50 -> 59 C.
const SENSOR = { source: "windows-perflib-rapl-thermal", scope: "processor-package-plus-dram", sensorId: "rapl:PKG+DRAM" };
const stream = (count, { watts = 10, baseCelsius = 50, stepMs = 250, startMs = 1000, joules0 = 500000 } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    timestampMs: startMs + i * stepMs,
    joules: joules0 + watts * (i * stepMs) / 1000,
    valid: true, reason: null,
    celsius: baseCelsius + i * 0.1,
    celsiusReason: null,
    ...SENSOR
  }));

// ---- counterbalancing: the old rig asked SCCE first on every item -------------------------------------------
const systems = ["scce", "reference"];
check("counterbalance.alternates", JSON.stringify(counterbalancedOrder(0, systems)) === JSON.stringify(["scce", "reference"]) &&
  JSON.stringify(counterbalancedOrder(1, systems)) === JSON.stringify(["reference", "scce"]),
  "a fixed first position lets a warm or cold machine favour whichever system always went first");
let threw = false;
try { counterbalancedOrder(0, ["only"]); } catch { threw = true; }
check("counterbalance.rejects_non_pair", threw, "a counterbalance over anything but two systems is not a counterbalance");

// ---- energy: real joules on AC power, where the old rig reported null ---------------------------------------
const samples = stream(40);
const measured = integratePowerSamples(samples, 2000, 4000);
check("energy.measured_from_cumulative_counter", measured.status === "measured" && Math.abs(measured.joules - 20) < 1e-6,
  `10 W across 2 s is 20 J; got ${measured.status}/${measured.joules}. The old rig reported null unless discharging a battery.`);
check("energy.records_scope", measured.scope === "processor-package-plus-dram", `scope must travel with the number; got ${measured.scope}`);
check("energy.records_accounting", measured.accounting === "gross-including-idle-and-background-work",
  "a package-scope reading is gross and must say so");

// ---- absence stays absent ------------------------------------------------------------------------------------
const gapped = integratePowerSamples([samples[0], { ...samples[39], timestampMs: 60000, joules: 500600 }], 1000, 59000);
check("energy.gap_is_unavailable_not_zero", gapped.status === "unavailable" && gapped.joules === null,
  `an unsampled interval must not be filled in; got ${JSON.stringify(gapped)}`);
const swapped = integratePowerSamples([samples[0], { ...samples[10], sensorId: "other" }], 1000, 3000);
check("energy.sensor_change_is_unavailable", swapped.status === "unavailable", "two different sensors cannot be integrated as one");
check("total.absent_is_null_not_zero", totalOfMeasured([null, undefined, NaN]).total === null,
  "summing absent readings as 0 reports an unmeasured side as having consumed nothing");
check("total.counts_measured_rows", totalOfMeasured([1, null, 2]).measuredRows === 2, "a total must say how many rows it covers");

// ---- temperature, which the old rig never recorded at all ----------------------------------------------------
const temp = windowTemperature(samples, 1000, 2000);
// The window is inclusive at both ends: 1000..2000 at 250 ms spacing is five samples, 50.0 through 50.4.
check("temperature.mean_and_peak", temp.samples === 5 && temp.meanCelsius === 50.2 && Math.abs(temp.peakCelsius - 50.4) < 1e-9,
  `expected 5 samples, mean 50.2 / peak 50.4; got ${temp.samples}, ${temp.meanCelsius}/${temp.peakCelsius}`);
const noTemp = windowTemperature(samples.map(s => ({ ...s, celsius: null, celsiusReason: "thermal-category-unavailable" })), 1000, 2000);
check("temperature.absent_is_null_with_reason", noTemp.meanCelsius === null && noTemp.reason === "thermal-category-unavailable",
  `a missing sensor must not read as 0 C; got ${JSON.stringify(noTemp)}`);
check("temperature.empty_window_is_null", windowTemperature(samples, 999000, 999500).reason === "no-sample-in-window",
  "a window the sensor never covered has no temperature");

// ---- idle baseline and the derived marginal -------------------------------------------------------------------
const base = idleBaseline({ energy: integratePowerSamples(samples, 1000, 3000) }, { energy: integratePowerSamples(samples, 5000, 7000) });
check("idle.mean_of_both_brackets", base.basis === "mean-of-both-brackets" && Math.abs(base.watts - 10) < 1e-6,
  `expected 10 W from both brackets; got ${JSON.stringify(base)}`);
check("idle.reports_drift", base.driftWatts !== null, "drift between the opening and closing baseline is evidence, not noise");
check("idle.unmeasured_is_null", idleBaseline(null, null).watts === null && idleWatts(null).reason === "idle-baseline-not-measured",
  "an unmeasured idle floor must not become 0 W, which would make every gross reading look entirely attributable");
const marg = marginalJoules(20, 10, 2000);
check("marginal.subtracts_idle", marg.joules === 0 && marg.method === "derived-marginal-over-idle-baseline",
  `20 J gross at a 10 W floor over 2 s is 0 J marginal; got ${JSON.stringify(marg)}`);
check("marginal.negative_is_reported", marginalJoules(5, 10, 2000).joules === -15,
  "clamping a negative marginal to 0 hides that the idle baseline over-estimated the floor");
check("marginal.missing_idle_is_null", marginalJoules(20, null, 2000).joules === null, "no baseline means no marginal");

// ---- end-to-end assembly over recorded turns and recorded samples ---------------------------------------------
const gold = { requiredStrings: [], acceptedAnswers: ["athens"], forbiddenStrings: [], unanswerable: false };
const turn = (id, system, position, startMs, endMs, answer, cpuSeconds) =>
  ({ id, workload: "relation", corpus: "wikipedia", prompt: `p:${id}`, gold, system, position, windowStartMs: startMs, windowEndMs: endMs, answer, cpuSeconds });
const artifact = assembleArtifact({
  turns: [
    turn("i1", "scce", 0, 1500, 2500, "Athens.", 0.8), turn("i1", "reference", 1, 3000, 5000, "Sparta.", 4.0),
    turn("i2", "reference", 0, 5500, 7500, "Athens.", 4.2), turn("i2", "scce", 1, 8000, 9000, "Athens.", 0.9)
  ],
  samples, idleBefore: { startMs: 1000, endMs: 1400 }, idleAfter: { startMs: 9200, endMs: 9800 },
  bindings: { codeCommit: "abc" }, settings: { settleMs: 500 }, systems,
  integrate: integratePowerSamples, scoreItem: score
});
check("assemble.one_row_per_item", artifact.rows.length === 2, `expected 2 rows, got ${artifact.rows.length}`);
check("assemble.grader_verdict_present", artifact.rows[0].scce.verdict === "correct" && artifact.rows[0].reference.verdict === "wrong",
  `the existing grader's verdict must ride with the measurement; got ${artifact.rows[0].scce.verdict}/${artifact.rows[0].reference.verdict}`);
check("assemble.per_row_energy", Math.abs(artifact.rows[0].scce.energyJoules - 10) < 1e-6,
  `1 s of 10 W is 10 J; got ${artifact.rows[0].scce.energyJoules}`);
check("assemble.per_row_temperature", artifact.rows[0].scce.peakCelsius !== null, "every row must carry the temperature it ran at");
check("assemble.order_recorded", JSON.stringify(artifact.rows[0].order) === JSON.stringify(["scce", "reference"]) &&
  JSON.stringify(artifact.rows[1].order) === JSON.stringify(["reference", "scce"]), "each row must record who answered first");
check("assemble.order_balanced", artifact.orderBalance.allBalanced === true &&
  artifact.orderBalance.scce.answeredFirst === 1 && artifact.orderBalance.scce.answeredSecond === 1,
  `the rig must show the balance it achieved; got ${JSON.stringify(artifact.orderBalance.scce)}`);
check("assemble.raw_samples_retained", artifact.rawSensorSamples.length === samples.length,
  "every raw sample is written, not just the summary derived from it");
check("assemble.scope_caveat_present", typeof artifact.sensor.scopeCaveat === "string" && artifact.sensor.scope === "processor-package-plus-dram",
  "the artifact must state what the sensor does and does not cover");
check("assemble.cpu_per_side", artifact.measurement.scce.cpuSeconds === 1.7 && artifact.measurement.reference.cpuSeconds === 8.2,
  `process CPU must stay per-system; got ${artifact.measurement.scce.cpuSeconds}/${artifact.measurement.reference.cpuSeconds}`);

// A sensor that dies mid-run must leave the surviving rows measured and the rest null-with-reason.
const truncated = assembleArtifact({
  turns: [turn("i1", "scce", 0, 1500, 2500, "Athens.", 0.8), turn("i1", "reference", 1, 50000, 52000, "Athens.", 4.0)],
  samples, idleBefore: null, idleAfter: null, bindings: {}, settings: {}, systems,
  integrate: integratePowerSamples, scoreItem: score
});
check("assemble.partial_sensor_loss_is_named", truncated.rows[0].scce.energyJoules !== null &&
  truncated.rows[0].reference.energyJoules === null && typeof truncated.rows[0].reference.energyReason === "string",
  `a row the sensor did not cover must be null with a reason, never 0 J; got ${JSON.stringify(truncated.rows[0].reference.energyReason)}`);
check("assemble.unavailable_reasons_tallied", truncated.measurement.reference.energyUnavailableByReason !== null,
  "the artifact must say how much of the run energy actually covers");

process.stdout.write(`\n${failures.length ? `${failures.length} FAILED` : "all checks passed"}\n`);
process.exit(failures.length ? 1 : 0);
