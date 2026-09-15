import test from "node:test";
import assert from "node:assert/strict";
import { integratePowerSamples } from "../lib/power-measurement.mjs";

const sample = (timestampMs, watts = 10) => ({ timestampMs, watts, valid: true, source: "test-meter", scope: "whole-system", sensorId: "meter-1" });
const integrate = rows => integratePowerSamples(rows, 500, 1500);

test("integrates only the bracketed workload interval, in joules", () => {
  const result = integrate([sample(0, 0), sample(1000, 10), sample(2000, 20)]);
  assert.equal(result.status, "measured");
  assert.equal(result.joules, 10);
  assert.equal(result.averageWatts, 10);
});

test("cumulative energy counters use deltas and never add absolute readings", () => {
  const rows = [0, 1000, 2000].map(timestampMs => ({ ...sample(timestampMs), watts: undefined, joules: 100 + timestampMs / 100 }));
  assert.equal(integrate(rows).joules, 10);
  rows[1].joules = 0;
  assert.equal(integrate(rows).reason, "energy-counter-reset-or-wrap");
});

test("missing, invalid, reset, zero and mixed-domain samples cannot prove efficiency", () => {
  const cases = [
    [], [null], [sample(1000)], [sample(0), sample(1000)],
    [sample(0), { ...sample(1000), valid: false, reason: "battery-on-ac" }, sample(2000)],
    [sample(0, 0), sample(2000, 0)],
    [sample(0), { ...sample(2000), scope: "gpu" }],
    [sample(0), { ...sample(2000), sensorId: "other" }],
    [sample(2000), sample(0)], [sample(0), sample(0), sample(2000)],
    [sample(0), { ...sample(2000), watts: null }],
    [sample(0), sample(5000)]
  ];
  for (const rows of cases) assert.equal(integrate(rows).status, "unavailable", JSON.stringify(rows));
});

test("a missing interval is not filled by assuming the last known power", () => {
  const result = integratePowerSamples([sample(0), sample(10000)], 10, 9990, { maxSampleGapMs: 1000 });
  assert.equal(result.reason, "sensor-sampling-gap");
  assert.equal(result.joules, null);
});
