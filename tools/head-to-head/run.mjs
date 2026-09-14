#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Runs the head-to-head suite against SCCE and against the local reference model, scoring both with one
// contract and charging both for what they actually consume.
//
//   node tools/head-to-head/run.mjs --suite artifacts/head-to-head/suite.json --limit 50
//   node tools/head-to-head/run.mjs --only scce --workload relation
//
// Energy
//   This machine exposes no usable wattage counter: \Power Meter\Power reads 0 and the ACPI thermal zone is
//   empty without elevation. What it does expose is per-process CPU time, which is attributable -- the SCCE
//   server and the model runner are separate processes, so each side is charged for its own work rather than
//   for wall clock, and a system that idles while waiting is not billed for waiting.
//
//   For a whole-suite figure in real energy, run on battery: RemainingCapacity is reported in mWh and is
//   sampled at the start and end of the run. On AC that delta is meaningless and is reported as null rather
//   than as a number that looks like a measurement.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { score, summarizeVerdicts, formatPerCorpus } from "./grade.mjs";
import { interpretTurnResponse, meanOfMeasured, maxOfMeasured } from "./absence.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const eq = token.indexOf("=");
  if (eq > 0) { args.set(token.slice(2, eq), token.slice(eq + 1)); continue; }
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(token.slice(2), next); i++; continue; }
  args.set(token.slice(2), "1");
}
const flag = (name, fallback) => args.get(name) ?? fallback;

const suitePath = flag("suite", "artifacts/head-to-head/suite.json");
const outPath = flag("out", "artifacts/head-to-head/results.json");
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const ollamaUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const model = flag("model", "qwen2.5:3b");
const limit = Number(flag("limit", "0"));
const requestTimeoutMs = Number(flag("request-timeout-ms", "60000"));
const checkpointEvery = Math.max(1, Number(flag("checkpoint-every", "1")));
const modelSeed = Number(flag("model-seed", "20260914"));
const modelTemperature = Number(flag("model-temperature", "0"));
const modelDigest = flag("model-digest", "unrecorded");
const scceRevision = flag("scce-revision", gitRevision());
const workloadFilter = flag("workload", "");
const only = flag("only", "both");

// ---- telemetry ----------------------------------------------------------------------------------------------
const ps = script => {
  try {
    return JSON.parse(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true
    }).trim() || "null");
  } catch {
    return null;
  }
};

/** CPU seconds consumed so far by the SCCE server and by the model runner, plus their resident sets. */
function sampleProcesses() {
  return ps(`
    $scce = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/dist/index.js*' } | Select-Object -First 1
    $scceProc = if ($scce) { Get-Process -Id $scce.ProcessId -ErrorAction SilentlyContinue } else { $null }
    $modelProcs = Get-Process ollama* -ErrorAction SilentlyContinue
    [pscustomobject]@{
      scceCpu = if ($scceProc) { [math]::Round($scceProc.CPU, 3) } else { $null }
      scceRssMb = if ($scceProc) { [math]::Round($scceProc.WorkingSet64/1MB) } else { $null }
      modelCpu = if ($modelProcs) { [math]::Round((($modelProcs | Measure-Object CPU -Sum).Sum), 3) } else { $null }
      modelRssMb = if ($modelProcs) { [math]::Round((($modelProcs | Measure-Object WorkingSet64 -Sum).Sum)/1MB) } else { $null }
    } | ConvertTo-Json -Compress
  `);
}

/** Battery state. Only meaningful while discharging; on AC the capacity delta is not energy consumed. */
function sampleBattery() {
  return ps(`
    $b = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($b) {
      [pscustomobject]@{ onBattery = -not $b.PowerOnline; remainingMwh = $b.RemainingCapacity; dischargeRateMw = $b.DischargeRate } | ConvertTo-Json -Compress
    } else { 'null' }
  `);
}

const cpuDelta = (before, after, key) =>
  before && after && typeof before[key] === "number" && typeof after[key] === "number"
    ? Number((after[key] - before[key]).toFixed(3))
    : null;

// ---- systems ------------------------------------------------------------------------------------------------
async function askScce(prompt) {
  const started = Date.now();
  try {
    const response = await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
      body: JSON.stringify({ text: prompt })
    });
    // A non-OK status that is not 422 returns {ok:false,error} with no answer and no evidence key, so reading a
    // count of 0 out of it recorded a server fault as a decline over an empty pool. It is neither.
    const payload = await response.json().catch(() => null);
    return interpretTurnResponse({ status: response.status, payload, ms: Date.now() - started });
  } catch (error) {
    return { answer: "", ms: Date.now() - started, evidence: null, error: String(error?.message ?? error) };
  }
}

async function askModel(prompt) {
  const started = Date.now();
  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
      body: JSON.stringify({ model, prompt, stream: false, options: { seed: modelSeed, temperature: modelTemperature } })
    });
    const payload = await response.json();
    return { answer: String(payload.response ?? ""), ms: Date.now() - started };
  } catch (error) {
    return { answer: "", ms: Date.now() - started, error: String(error?.message ?? error) };
  }
}

// ---- run ----------------------------------------------------------------------------------------------------
if (!existsSync(suitePath)) {
  console.error(`no suite at ${suitePath}; run tools/head-to-head/build-suite.mjs first`);
  process.exit(2);
}
const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const suiteSha256 = `sha256:${createHash("sha256").update(readFileSync(suitePath)).digest("hex")}`;
let items = suite.items;
if (workloadFilter) items = items.filter(item => item.workload === workloadFilter);
if (limit > 0) items = items.slice(0, limit);

const batteryStart = sampleBattery();
const rows = [];
console.log(`${items.length} items, systems: ${only}`);
console.log(`battery: ${batteryStart ? (batteryStart.onBattery ? `on battery, ${batteryStart.remainingMwh} mWh` : "on AC -- energy delta will be reported as null") : "unavailable"}\n`);

for (const [index, item] of items.entries()) {
  const row = { id: item.id, workload: item.workload, corpus: item.corpus ?? "unlabelled", prompt: item.prompt };
  if (only === "both" || only === "scce") {
    const before = sampleProcesses();
    const result = await askScce(item.prompt);
    const after = sampleProcesses();
    row.scce = {
      ...score(item, result.answer),
      ms: result.ms,
      cpuSeconds: cpuDelta(before, after, "scceCpu"),
      rssMb: after?.scceRssMb ?? null,
      // null, never 0: an HTTP 422 decline returns no evidence key, and reporting that as zero admitted spans
      // made a runtime refusal indistinguishable from a retrieval miss. Three lanes chased that difference.
      evidence: result.evidence ?? null,
      runtimeDeclined: result.declinedByRuntime === true,
      // A fault is recorded beside the verdict, never instead of it: an empty answer from a 500 grades the same
      // as an honest decline, and only this field says which of the two the row actually is.
      httpStatus: result.httpStatus ?? null,
      transportError: result.error ?? null,
      answer: result.answer.replace(/\s+/gu, " ")
    };
  }
  if (only === "both" || only === "model") {
    const before = sampleProcesses();
    const result = await askModel(item.prompt);
    const after = sampleProcesses();
    row.model = {
      ...score(item, result.answer),
      ms: result.ms,
      cpuSeconds: cpuDelta(before, after, "modelCpu"),
      rssMb: after?.modelRssMb ?? null,
      answer: result.answer.replace(/\s+/gu, " ")
    };
  }
  rows.push(row);
  if ((index + 1) % checkpointEvery === 0 || index === items.length - 1) {
    console.log(`  ${index + 1}/${items.length}`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ schema: "scce.head_to_head.v1", model, rows }, null, 2) + "\n", "utf8");
  }
}
const batteryEnd = sampleBattery();

function summarize(side) {
  const cpu = rows.map(row => row[side]?.cpuSeconds).filter(v => typeof v === "number");
  const meanMs = meanOfMeasured(rows.map(row => row[side]?.ms));
  return {
    ...summarizeVerdicts(rows, side),
    // Means over the rows that carry the measurement, null when none do. `sum(x ?? 0) / rows.length` reports a
    // side nobody timed as 0 ms, which reads as instantaneous rather than as unmeasured.
    meanMs: meanMs === null ? null : Math.round(meanMs),
    wallSecondsPerItem: meanMs === null ? null : Number((meanMs / 1000).toFixed(2)),
    cpuSecondsTotal: cpu.length ? Number(cpu.reduce((sum, v) => sum + v, 0).toFixed(2)) : null,
    cpuSecondsPerItem: cpu.length ? Number((cpu.reduce((sum, v) => sum + v, 0) / cpu.length).toFixed(2)) : null,
    peakRssMb: maxOfMeasured(rows.map(r => r[side]?.rssMb)),
    faults: rows.filter(r => typeof r[side]?.httpStatus === "number" && r[side].httpStatus !== 200 && r[side].httpStatus !== 422).length,
    // Stated, not inferred: SCCE runs no accelerator and calls no API, and this harness would record it if it did.
    gpuSecondsPerItem: 0,
    apiTokensPerItem: 0
  };
}

const summary = {
  schema: "scce.head_to_head.v1",
  generatedAt: new Date().toISOString(),
  model,
  modelDigest,
  modelSeed,
  modelTemperature,
  scceRevision,
  suite: { path: suitePath, sha256: suiteSha256 },
  requestTimeoutMs,
  checkpointEvery,
  items: rows.length,
  scce: only === "model" ? null : summarize("scce"),
  reference: only === "scce" ? null : summarize("model"),
  energy: {
    // Only a discharging battery makes this a measurement; on AC it is reported as null on purpose.
    onBattery: Boolean(batteryStart?.onBattery && batteryEnd?.onBattery),
    consumedMwh: batteryStart?.onBattery && batteryEnd?.onBattery
      ? batteryStart.remainingMwh - batteryEnd.remainingMwh
      : null,
    note: "CPU seconds are the attributable measure; mWh is whole-machine and only valid on battery."
  },
  rows
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

for (const [label, side] of [["SCCE", summary.scce], [model, summary.reference]]) {
  if (!side) continue;
  console.log(`\n${label}: ${side.correct} correct, ${side.wrong} wrong, ${side.declinedWhenAnswerable} declined when answerable, ${side.fabricated} fabricated`);
  console.log(`  ${side.meanMs}ms mean, ${side.cpuSecondsPerItem}s CPU per item, ${side.cpuSecondsTotal}s CPU total`);
  console.log(`  workload: ${Object.entries(side.byWorkload).map(([workload, b]) => `${workload} ${b.correct}/${b.items}`).join(", ")}`);
  // The number that matters for a multi-corpus claim: books and code are reported apart from Wikipedia.
  console.log("  per corpus:");
  for (const line of formatPerCorpus(side.byCorpus)) console.log(line);
}
console.log(`\nwrote ${outPath}`);

function gitRevision() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(); }
  catch { return "unrecorded"; }
}
