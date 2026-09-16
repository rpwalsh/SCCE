// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The measurement arithmetic of the head-to-head rig, separated from the clock, the server and the model so
// `measure-selfcheck.mjs` can assert every branch offline against recorded samples.
//
// Nothing here invents a reading. Every quantity that was not measured is null and carries a reason; no absent
// value is ever defaulted to zero, because zero joules and zero degrees are claims a run did not make.

/** Which system answers first for an item. Alternating by index removes any fixed first-position advantage. */
export function counterbalancedOrder(index, systems) {
  if (!Array.isArray(systems) || systems.length !== 2) throw new Error("counterbalance-requires-two-systems");
  return index % 2 === 0 ? [systems[0], systems[1]] : [systems[1], systems[0]];
}

/** Temperature over one window. Samples without a reading are excluded, never read as 0 C. */
export function windowTemperature(samples, startMs, endMs) {
  if (!Array.isArray(samples)) return { meanCelsius: null, peakCelsius: null, samples: 0, reason: "no-sample-array" };
  const inside = samples.filter(s => s && Number.isFinite(s.timestampMs) && s.timestampMs >= startMs && s.timestampMs <= endMs);
  const readings = inside.map(s => s.celsius).filter(Number.isFinite);
  if (!readings.length) {
    const reason = inside.length ? (inside.find(s => s.celsiusReason)?.celsiusReason ?? "no-temperature-in-window") : "no-sample-in-window";
    return { meanCelsius: null, peakCelsius: null, samples: inside.length, reason };
  }
  return {
    meanCelsius: Number((readings.reduce((a, b) => a + b, 0) / readings.length).toFixed(2)),
    peakCelsius: Math.max(...readings),
    minCelsius: Math.min(...readings),
    samples: readings.length,
    reason: null
  };
}

/**
 * Energy above the machine's measured idle draw. Derived, not measured: the sensor's scope is the whole
 * processor package, so the gross figure also contains whatever else the host was doing. Reported beside the
 * gross value and labelled, never in place of it. A negative result means the idle baseline over-estimated the
 * floor and is returned as measured -- clamping it to zero would hide exactly that.
 */
export function marginalJoules(grossJoules, idleWatts, durationMs) {
  if (!Number.isFinite(grossJoules) || !Number.isFinite(idleWatts) || !Number.isFinite(durationMs) || durationMs <= 0)
    return { joules: null, method: "derived-marginal-over-idle-baseline", reason: "missing-gross-idle-or-duration" };
  return {
    joules: Number((grossJoules - idleWatts * (durationMs / 1000)).toFixed(4)),
    method: "derived-marginal-over-idle-baseline",
    idleWatts: Number(idleWatts.toFixed(4)),
    reason: null
  };
}

const finite = values => values.filter(Number.isFinite);
const sum = values => values.reduce((a, b) => a + b, 0);

/** Sum over the rows that carry the measurement, with the count that carried it. Null when none did. */
export function totalOfMeasured(values) {
  const measured = finite(values);
  return measured.length ? { total: Number(sum(measured).toFixed(4)), measuredRows: measured.length } : { total: null, measuredRows: 0 };
}

/** Per-side energy and thermal roll-up. `measuredRows` states how much of the run each total actually covers. */
export function summarizeMeasurement(rows, side, totalRows) {
  const cell = row => row[side] ?? {};
  const gross = totalOfMeasured(rows.map(r => cell(r).energyJoules));
  const marginal = totalOfMeasured(rows.map(r => cell(r).marginalJoules));
  const cpu = totalOfMeasured(rows.map(r => cell(r).cpuSeconds));
  const peaks = finite(rows.map(r => cell(r).peakCelsius));
  const means = finite(rows.map(r => cell(r).meanCelsius));
  const unavailable = {};
  for (const row of rows) {
    const reason = cell(row).energyReason;
    if (reason) unavailable[reason] = (unavailable[reason] ?? 0) + 1;
  }
  return {
    rows: totalRows,
    grossJoules: gross.total,
    grossJoulesMeasuredRows: gross.measuredRows,
    marginalJoules: marginal.total,
    marginalJoulesMeasuredRows: marginal.measuredRows,
    joulesPerRow: gross.measuredRows ? Number((gross.total / gross.measuredRows).toFixed(3)) : null,
    cpuSeconds: cpu.total,
    cpuSecondsMeasuredRows: cpu.measuredRows,
    peakCelsius: peaks.length ? Math.max(...peaks) : null,
    meanCelsius: means.length ? Number((sum(means) / means.length).toFixed(2)) : null,
    temperatureMeasuredRows: means.length,
    energyUnavailableByReason: Object.keys(unavailable).length ? unavailable : null
  };
}

/**
 * Proof that ordering cannot explain the result: how often each system answered first, and the mean temperature
 * it saw in each position. A rig that claims counterbalancing must show the balance it actually achieved.
 */
export function orderBalance(rows, systems) {
  const report = {};
  for (const system of systems) {
    const first = rows.filter(r => r.order?.[0] === system);
    const second = rows.filter(r => r.order?.[1] === system);
    const meanTemp = subset => {
      const values = finite(subset.map(r => r[system]?.meanCelsius));
      return values.length ? Number((sum(values) / values.length).toFixed(2)) : null;
    };
    report[system] = {
      answeredFirst: first.length,
      answeredSecond: second.length,
      balanced: Math.abs(first.length - second.length) <= 1,
      meanCelsiusWhenFirst: meanTemp(first),
      meanCelsiusWhenSecond: meanTemp(second)
    };
  }
  report.allBalanced = systems.every(s => report[s].balanced);
  return report;
}

/**
 * Builds the artifact from recorded turns and recorded sensor samples. Pure: no clock, no server, no model, no
 * process state. Live mode and replay mode call this same function, so a dry run exercises the real assembly
 * rather than a stand-in for it.
 */
export function assembleArtifact({ turns, samples, idleBefore, idleAfter, bindings, settings, systems, integrate, scoreItem }) {
  const byItem = new Map();
  for (const turn of turns) {
    if (!byItem.has(turn.id)) byItem.set(turn.id, { id: turn.id, workload: turn.workload, corpus: turn.corpus ?? "unlabelled", prompt: turn.prompt, gold: turn.gold, order: [], turns: [] });
    const entry = byItem.get(turn.id);
    entry.turns.push(turn);
  }
  for (const entry of byItem.values())
    entry.order = entry.turns.slice().sort((a, b) => a.position - b.position).map(t => t.system);

  const window = (startMs, endMs) => {
    const energy = integrate(samples, startMs, endMs);
    const temperature = windowTemperature(samples, startMs, endMs);
    return { energy, temperature };
  };

  const baseline = idleBaseline(
    idleBefore ? { energy: integrate(samples, idleBefore.startMs, idleBefore.endMs) } : null,
    idleAfter ? { energy: integrate(samples, idleAfter.startMs, idleAfter.endMs) } : null
  );

  const rows = [];
  for (const entry of byItem.values()) {
    const row = { id: entry.id, workload: entry.workload, corpus: entry.corpus, prompt: entry.prompt, order: entry.order };
    for (const turn of entry.turns) {
      const durationMs = turn.windowEndMs - turn.windowStartMs;
      const { energy, temperature } = window(turn.windowStartMs, turn.windowEndMs);
      const measured = energy.status === "measured";
      const marginal = measured ? marginalJoules(energy.joules, baseline.watts, durationMs) : { joules: null, method: "derived-marginal-over-idle-baseline", reason: energy.reason };
      row[turn.system] = {
        ...scoreItem(entry, turn.answer),
        position: turn.position,
        ms: durationMs,
        cpuSeconds: Number.isFinite(turn.cpuSeconds) ? Number(turn.cpuSeconds.toFixed(3)) : null,
        // Gross: the sensor's scope is the whole package, so this window also contains the host's other work.
        energyJoules: measured ? Number(energy.joules.toFixed(4)) : null,
        energyWatts: measured ? Number(energy.averageWatts.toFixed(4)) : null,
        energyScope: measured ? energy.scope : null,
        energyMethod: measured ? energy.method : null,
        energyAccounting: measured ? energy.accounting : null,
        energySampleCount: measured ? energy.sampleCount : null,
        energyReason: measured ? null : energy.reason,
        marginalJoules: marginal.joules,
        marginalMethod: marginal.method,
        meanCelsius: temperature.meanCelsius,
        peakCelsius: temperature.peakCelsius,
        temperatureReason: temperature.reason,
        windowStartMs: turn.windowStartMs,
        windowEndMs: turn.windowEndMs,
        evidence: turn.evidence ?? null,
        runtimeDeclined: turn.runtimeDeclined === true,
        httpStatus: turn.httpStatus ?? null,
        transportError: turn.transportError ?? null,
        modelTiming: turn.modelTiming ?? null,
        answer: String(turn.answer ?? "").replace(/\s+/gu, " ")
      };
    }
    rows.push(row);
  }

  const measurement = Object.fromEntries(systems.map(s => [s, summarizeMeasurement(rows, s, rows.length)]));
  return {
    schema: "scce.head_to_head.measured.v1",
    bindings,
    settings,
    sensor: {
      scope: samples.find(s => s?.scope)?.scope ?? null,
      sensorId: samples.find(s => s?.sensorId)?.sensorId ?? null,
      source: samples.find(s => s?.source)?.source ?? null,
      sampleCount: samples.length,
      units: { energy: "joules", temperature: "celsius", providerEnergyUnit: "picowatt-hour", picowattHourToJoule: 3.6e-9 },
      scopeCaveat: "processor package plus DRAM. Not whole system: display, storage and NIC draw are outside it.",
      attribution: "RAPL is per-package, not per-process. Per-row joules are gross; the marginal column subtracts the measured idle baseline and is labelled derived."
    },
    idle: baseline,
    orderBalance: orderBalance(rows, systems),
    measurement,
    rows,
    rawSensorSamples: samples
  };
}

/** Idle draw from a bracketing measurement. Only a measured energy window yields watts. */
export function idleWatts(measurement) {
  const energy = measurement?.energy;
  if (energy?.status !== "measured" || !Number.isFinite(energy.averageWatts))
    return { watts: null, reason: energy?.reason ?? "idle-baseline-not-measured" };
  return { watts: Number(energy.averageWatts.toFixed(4)), joules: Number(energy.joules.toFixed(4)), reason: null };
}

/** The two idle brackets combined. Drift between them is reported, not averaged away silently. */
export function idleBaseline(before, after) {
  const a = idleWatts(before);
  const b = idleWatts(after);
  const both = [a.watts, b.watts].filter(Number.isFinite);
  return {
    before: a,
    after: b,
    watts: both.length ? Number((sum(both) / both.length).toFixed(4)) : null,
    basis: both.length === 2 ? "mean-of-both-brackets" : both.length === 1 ? "single-bracket" : "unmeasured",
    driftWatts: both.length === 2 ? Number((b.watts - a.watts).toFixed(4)) : null
  };
}
