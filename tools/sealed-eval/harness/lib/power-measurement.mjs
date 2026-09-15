import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

// A sensor is an independent process that emits timestamped JSONL. Energy is
// measured over the entire condition, including adapter startup and failures.
// No CPU utilization, TDP, token count or battery percentage is converted to W.
export function integratePowerSamples(samples, startMs, endMs, { maxSampleGapMs = 2500 } = {}) {
  const unavailable = reason => ({ status: "unavailable", reason, joules: null, averageWatts: null });
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)) return unavailable("invalid-measurement-window");
  if (!(Number.isFinite(maxSampleGapMs) && maxSampleGapMs > 0)) return unavailable("invalid-maximum-sample-gap");
  // Never sort malformed telemetry into apparent validity. Acquisition order
  // and clock continuity are evidence, including duplicate timestamps.
  if (samples.some((sample, i) => !sample || typeof sample !== "object" || !Number.isFinite(sample.timestampMs) || (i && sample.timestampMs <= samples[i - 1].timestampMs)))
    return unavailable("non-monotonic-sensor-clock");
  const first = samples.findLastIndex(sample => sample.timestampMs <= startMs);
  const last = samples.findIndex(sample => sample.timestampMs >= endMs);
  if (first < 0 || last < 0 || last <= first) return unavailable("sensor-does-not-bracket-measurement");
  const selected = samples.slice(first, last + 1);
  const identity = selected[0];
  if (!identity.source || !identity.scope || !identity.sensorId) return unavailable("missing-sensor-identity-or-scope");
  const cumulative = Number.isFinite(identity.joules);
  let joules = 0;
  for (let i = 0; i < selected.length; i++) {
    const current = selected[i];
    if (current.valid !== true) return unavailable(`invalid-sensor-sample:${current.reason ?? "unspecified"}`);
    if (current.source !== identity.source || current.scope !== identity.scope || current.sensorId !== identity.sensorId)
      return unavailable("sensor-identity-or-scope-changed");
    const value = cumulative ? current.joules : current.watts;
    if (!Number.isFinite(value) || value < 0 || Number.isFinite(current.joules) !== cumulative)
      return unavailable("invalid-or-mixed-sensor-units");
    if (!i) continue;
    const previous = selected[i - 1];
    const span = current.timestampMs - previous.timestampMs;
    if (span > maxSampleGapMs) return unavailable("sensor-sampling-gap");
    const left = Math.max(startMs, previous.timestampMs);
    const right = Math.min(endMs, current.timestampMs);
    if (right <= left) continue;
    if (cumulative) {
      const delta = current.joules - previous.joules;
      if (delta < 0) return unavailable("energy-counter-reset-or-wrap");
      joules += delta * (right - left) / span;
    } else {
      const leftW = previous.watts + (current.watts - previous.watts) * (left - previous.timestampMs) / span;
      const rightW = previous.watts + (current.watts - previous.watts) * (right - previous.timestampMs) / span;
      joules += (leftW + rightW) / 2 * (right - left) / 1000;
    }
  }
  if (!(joules > 0)) return unavailable("nonpositive-measured-energy");
  return {
    status: "measured", source: identity.source, scope: identity.scope, sensorId: identity.sensorId,
    method: cumulative ? "cumulative-joules-interpolated-at-boundaries" : "trapezoidal-watts",
    accounting: "gross-including-idle-and-background-work", joules,
    averageWatts: joules / ((endMs - startMs) / 1000), sampleCount: selected.length,
    maxSampleGapMs: Math.max(...selected.slice(1).map((sample, i) => sample.timestampMs - selected[i].timestampMs))
  };
}

export async function startConditionMeasurement(config = {}) {
  const samples = [];
  let child, exited = false, stderr = "", failure, onSample;
  const timeoutMs = config.startupTimeoutMs ?? 10000;
  const maxSampleGapMs = config.maxSampleGapMs ?? 2500;
  const awaitSample = predicate => new Promise(resolve => {
    if (predicate() || exited) return resolve();
    const timer = setTimeout(() => { onSample = undefined; resolve(); }, timeoutMs);
    onSample = () => { if (predicate() || exited) { clearTimeout(timer); onSample = undefined; resolve(); } };
  });
  if (config.command?.length) {
    child = spawn(config.command[0], config.command.slice(1), {
      cwd: config.cwd ?? process.cwd(), env: { ...process.env, ...config.env },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    child.on("error", error => { failure = `sensor-process-error:${error.message}`; exited = true; onSample?.(); });
    child.on("close", () => { exited = true; onSample?.(); });
    child.stderr.on("data", value => { stderr = (stderr + value).slice(-4096); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      if (!line.trim()) return;
      try {
        const sample = JSON.parse(line);
        if (!sample || typeof sample !== "object" || !Number.isFinite(sample.timestampMs)) failure = "invalid-sensor-record";
        samples.push(sample);
      }
      catch { failure = "malformed-sensor-jsonl"; }
      onSample?.();
    });
    await awaitSample(() => samples.length > 0 || Boolean(failure));
    if (!samples.length && !failure) failure = "sensor-startup-timeout";
  }
  const startedAtMs = Date.now();
  const monotonicStart = performance.now();
  return {
    async stop() {
      const wallElapsedMs = performance.now() - monotonicStart;
      const endedAtMs = Date.now();
      if (child && !failure) await awaitSample(() => samples.some(sample => sample?.timestampMs >= endedAtMs));
      child?.kill();
      let energy = config.command?.length
        ? integratePowerSamples(samples, startedAtMs, endedAtMs, { maxSampleGapMs })
        : { status: "unavailable", reason: "sensor-not-configured", joules: null, averageWatts: null };
      if (failure) energy = { status: "unavailable", reason: failure, joules: null, averageWatts: null };
      if (Math.abs((endedAtMs - startedAtMs) - wallElapsedMs) > 100)
        energy = { status: "unavailable", reason: "host-wall-clock-discontinuity", joules: null, averageWatts: null };
      return { startedAtMs, endedAtMs, wallElapsedMs, energy, samples, sensorStderr: stderr || null };
    }
  };
}
