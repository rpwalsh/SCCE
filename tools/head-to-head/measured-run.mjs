#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The measured head-to-head: one question set, both systems, with energy, temperature, wall time and process CPU
// recorded per row, and the identity of everything that could change the result bound into the artifact.
//
//   node tools/head-to-head/measured-run.mjs --suite artifacts/head-to-head/suite.json --limit 40
//   node tools/head-to-head/measured-run.mjs --replay artifacts/head-to-head/measured.record.json --out /tmp/dry.json
//
// Fairness:
//   - identical prompts, from one suite file whose sha256 is recorded
//   - warmup turns run against both systems and are excluded from every summary
//   - an idle baseline brackets the run at both ends, so thermal and power drift across the run is visible
//   - the ask-order alternates per item, so neither system always answers into a machine the other just heated
//   - a settle gap separates the two windows, so one system's tail is not charged to the other
//
// Honesty:
//   - energy is Intel RAPL over the processor package plus DRAM. It is NOT whole-system and NOT per-process.
//     Per-row joules are gross; the marginal column subtracts the measured idle floor and is labelled derived.
//   - anything the host did not expose is written as null with a reason. No quantity here is ever estimated.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { integratePowerSamples, startConditionMeasurement } from "../sealed-eval/harness/lib/power-measurement.mjs";
import { score, summarizeVerdicts, formatPerCorpus } from "./grade.mjs";
import { interpretTurnResponse } from "./absence.mjs";
import { processCpuSeconds, ollamaTokenCost } from "./cost-meter.mjs";
import { assembleArtifact, counterbalancedOrder } from "./measure.mjs";

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
const SYSTEMS = ["scce", "reference"];
const here = dirname(fileURLToPath(import.meta.url));

const settings = {
  // suite-current.json, not suite.json: only the former carries corpus labels, and without them every row falls
  // into one bucket and the multi-corpus claim cannot be made at all.
  suitePath: flag("suite", "artifacts/head-to-head/suite-current.json"),
  outPath: flag("out", "artifacts/head-to-head/measured.json"),
  serverUrl: process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  model: flag("model", "qwen2.5:3b"),
  limit: Number(flag("limit", "0")),
  warmupItems: Number(flag("warmup", "3")),
  idleSeconds: Number(flag("idle-seconds", "60")),
  settleMs: Number(flag("settle-ms", "3000")),
  sensorIntervalMs: Number(flag("sensor-interval-ms", "250")),
  maxSampleGapMs: Number(flag("max-sample-gap-ms", "2500")),
  requestTimeoutMs: Number(flag("request-timeout-ms", "120000")),
  modelSeed: Number(flag("model-seed", "20260914")),
  modelTemperature: Number(flag("model-temperature", "0")),
  workloadFilter: flag("workload", "")
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shell = (command, commandArgs) => {
  try { return execFileSync(command, commandArgs, { encoding: "utf8", windowsHide: true, timeout: 20000 }).trim(); }
  catch { return null; }
};

// ---- systems ---------------------------------------------------------------------------------------------------
async function askScce(prompt) {
  try {
    const response = await fetch(`${settings.serverUrl}/api/turn`, {
      method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
      body: JSON.stringify({ text: prompt })
    });
    const payload = await response.json().catch(() => null);
    const read = interpretTurnResponse({ status: response.status, payload, ms: 0 });
    return { answer: read.answer, evidence: read.evidence, runtimeDeclined: read.declinedByRuntime, httpStatus: read.httpStatus, transportError: read.error };
  } catch (error) {
    return { answer: "", evidence: null, runtimeDeclined: false, httpStatus: null, transportError: String(error?.message ?? error) };
  }
}

async function askReference(prompt) {
  try {
    const response = await fetch(`${settings.ollamaUrl}/api/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
      body: JSON.stringify({ model: settings.model, prompt, stream: false, options: { seed: settings.modelSeed, temperature: settings.modelTemperature } })
    });
    const payload = await response.json();
    return { answer: String(payload.response ?? ""), modelTiming: ollamaTokenCost(payload), httpStatus: response.status, transportError: null };
  } catch (error) {
    return { answer: "", modelTiming: null, httpStatus: null, transportError: String(error?.message ?? error) };
  }
}

const CPU_TARGET = {
  scce: { commandLineIncludes: ["server/dist/index.js"] },
  reference: { names: ["ollama*"] }
};

/** One turn, with the CPU meter's own process kept outside the measured window. */
async function runTurn(system, item, position) {
  const before = processCpuSeconds(CPU_TARGET[system]);
  const windowStartMs = Date.now();
  const result = system === "scce" ? await askScce(item.prompt) : await askReference(item.prompt);
  const windowEndMs = Date.now();
  const after = processCpuSeconds(CPU_TARGET[system]);
  return {
    id: item.id, workload: item.workload, corpus: item.corpus ?? "unlabelled", prompt: item.prompt, gold: item.gold,
    system, position, windowStartMs, windowEndMs,
    cpuSeconds: after.processes && before.processes ? Math.max(0, after.seconds - before.seconds) : null,
    ...result
  };
}

// ---- bindings ----------------------------------------------------------------------------------------------------
async function corpusSnapshot() {
  try {
    const response = await fetch(`${settings.serverUrl}/api/ready`, { signal: AbortSignal.timeout(60000) });
    const body = await response.json();
    const pg = body?.postgres ?? {};
    return {
      schemaVersion: pg.schemaVersion ?? null, schema: pg.database?.schema ?? null,
      countSemantics: pg.countSemantics ?? null, tableCounts: pg.tableCounts ?? null,
      tableCountsSha256: pg.tableCounts ? `sha256:${createHash("sha256").update(JSON.stringify(pg.tableCounts)).digest("hex")}` : null,
      warmupComplete: body?.warmup?.complete ?? null
    };
  } catch (error) { return { status: "unavailable", reason: String(error?.message ?? error) }; }
}

/** The model's content digest. Read from the serving instance when it answers, otherwise from its manifest on disk. */
async function modelIdentity() {
  try {
    const response = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    const row = (body.models ?? []).find(entry => entry.name === settings.model || entry.model === settings.model);
    if (row) return { name: settings.model, digest: row.digest, size: row.size, details: row.details, digestSource: "ollama-api-tags" };
  } catch { /* fall through to the manifest */ }
  const [name, tag = "latest"] = settings.model.split(":");
  const root = join(process.env.OLLAMA_MODELS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".ollama", "models"), "manifests");
  const found = [];
  const walk = dir => {
    let entries; try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === tag && path.replace(/\\/gu, "/").includes(`/${name}/`)) found.push(path);
    }
  };
  walk(root);
  if (!found.length) return { name: settings.model, digest: null, digestSource: "unavailable", reason: "no-serving-instance-and-no-manifest" };
  const manifest = JSON.parse(readFileSync(found[0], "utf8"));
  const weights = (manifest.layers ?? []).find(layer => layer.mediaType?.endsWith(".model"));
  return {
    name: settings.model, digest: weights?.digest ?? null, size: weights?.size ?? null,
    configDigest: manifest.config?.digest ?? null,
    manifestSha256: `sha256:${createHash("sha256").update(readFileSync(found[0])).digest("hex")}`,
    digestSource: "ollama-manifest-on-disk", manifestPath: found[0]
  };
}

/**
 * The server process behind the endpoint, and how long it had been up when the run started. SCCE's own state
 * warms over a session, so a run against a freshly restarted server measures cold start, not steady state, and
 * the artifact has to say which it was.
 */
function serverProcess() {
  const raw = shell("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server/dist/index.js*' } | Select-Object -First 1; " +
    "if ($p) { [pscustomobject]@{ pid = $p.ProcessId; startedAt = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress } else { 'null' }"]);
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed) return { status: "unavailable", reason: "no-matching-server-process" };
    const uptimeSeconds = Math.round((Date.now() - Date.parse(parsed.startedAt)) / 1000);
    return { pid: parsed.pid, startedAt: parsed.startedAt, uptimeSecondsAtRunStart: uptimeSeconds };
  } catch { return { status: "unavailable", reason: "server-process-probe-failed" }; }
}

// ---- replay ------------------------------------------------------------------------------------------------------
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function build(record) {
  return assembleArtifact({
    ...record, systems: SYSTEMS, integrate: (samples, startMs, endMs) => integratePowerSamples(samples, startMs, endMs, { maxSampleGapMs: record.settings?.maxSampleGapMs ?? settings.maxSampleGapMs }),
    scoreItem: score
  });
}

function report(artifact) {
  for (const system of SYSTEMS) {
    const verdicts = summarizeVerdicts(artifact.rows, system);
    const m = artifact.measurement[system];
    console.log(`\n${system}`);
    console.log(`  verdicts correct=${verdicts.correct} wrong=${verdicts.wrong} declined_when_answerable=${verdicts.declinedWhenAnswerable} declined=${verdicts.declined} fabricated=${verdicts.fabricated}`);
    console.log(`  joules_gross=${m.grossJoules} rows=${m.grossJoulesMeasuredRows}/${m.rows} joules_marginal=${m.marginalJoules} cpu_s=${m.cpuSeconds}`);
    console.log(`  celsius_mean=${m.meanCelsius} celsius_peak=${m.peakCelsius}`);
    for (const line of formatPerCorpus(verdicts.byCorpus)) console.log(line);
  }
  console.log(`\nidle_watts=${artifact.idle.watts} basis=${artifact.idle.basis} drift_w=${artifact.idle.driftWatts}`);
  console.log(`order_balanced=${artifact.orderBalance.allBalanced} ${SYSTEMS.map(s => `${s}_first=${artifact.orderBalance[s].answeredFirst}`).join(" ")}`);
  console.log(`sensor=${artifact.sensor.sensorId} scope=${artifact.sensor.scope} samples=${artifact.sensor.sampleCount}`);
}

const replayPath = flag("replay", "");
if (replayPath) {
  const record = JSON.parse(readFileSync(replayPath, "utf8"));
  const artifact = build(record);
  artifact.mode = "replay";
  artifact.replaySource = { path: replayPath, sha256: `sha256:${createHash("sha256").update(readFileSync(replayPath)).digest("hex")}` };
  write(settings.outPath, artifact);
  report(artifact);
  console.log(`\nwrote ${settings.outPath}`);
  process.exit(0);
}

// ---- live run ------------------------------------------------------------------------------------------------------
if (!existsSync(settings.suitePath)) { console.error(`no-suite ${settings.suitePath}`); process.exit(2); }
const suiteBytes = readFileSync(settings.suitePath);
const suite = JSON.parse(suiteBytes.toString("utf8"));
let items = suite.items;
if (settings.workloadFilter) items = items.filter(item => item.workload === settings.workloadFilter);
const warmupSet = items.slice(0, settings.warmupItems);
const measuredSet = settings.limit > 0 ? items.slice(settings.warmupItems, settings.warmupItems + settings.limit) : items.slice(settings.warmupItems);
if (!measuredSet.length) { console.error("no-items-after-warmup"); process.exit(2); }

for (const [label, url] of [["scce", `${settings.serverUrl}/api/ready`], ["reference", `${settings.ollamaUrl}/api/version`]]) {
  const probe = await fetch(url, { signal: AbortSignal.timeout(60000) }).then(r => r.ok, () => false);
  if (!probe) { console.error(`unreachable ${label} ${url}`); process.exit(3); }
}

const bindings = {
  codeCommit: shell("git", ["rev-parse", "HEAD"]),
  codeDirty: (shell("git", ["status", "--porcelain"]) ?? "").length > 0,
  suite: {
    path: settings.suitePath, sha256: `sha256:${createHash("sha256").update(suiteBytes).digest("hex")}`,
    itemsTotal: suite.items.length, warmupItems: warmupSet.length, measuredItems: measuredSet.length,
    // Unlabelled items collapse the per-corpus breakdown into one bucket, so the count travels with the artifact.
    measuredItemsWithCorpusLabel: measuredSet.filter(item => item.corpus).length,
    workloads: [...new Set(measuredSet.map(item => item.workload))].sort()
  },
  model: await modelIdentity(),
  serverProcess: serverProcess(),
  corpusBefore: await corpusSnapshot(),
  host: { node: process.version, platform: process.platform, arch: process.arch, cpu: shell("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Processor).Name"]), startedAt: new Date().toISOString() }
};
console.log(`items=${measuredSet.length} warmup=${warmupSet.length} commit=${bindings.codeCommit} model_digest=${bindings.model.digest} digest_source=${bindings.model.digestSource}`);
console.log(`corpus_labelled=${bindings.suite.measuredItemsWithCorpusLabel}/${measuredSet.length} workloads=${bindings.suite.workloads.join(",")} corpus_tables_sha=${bindings.corpusBefore.tableCountsSha256}`);
console.log(`server_pid=${bindings.serverProcess.pid} server_uptime_s=${bindings.serverProcess.uptimeSecondsAtRunStart}`);

const sensor = await startConditionMeasurement({
  command: ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "power", "rapl-thermal-jsonl.ps1"), "-IntervalMilliseconds", String(settings.sensorIntervalMs)],
  startupTimeoutMs: 20000, maxSampleGapMs: settings.maxSampleGapMs
});

const idleBefore = { startMs: Date.now() };
await sleep(settings.idleSeconds * 1000);
idleBefore.endMs = Date.now();

// Warmup answers are thrown away: they pay the model's load and the server's first-turn cost, which are not
// per-question costs and would otherwise be charged to whichever item happened to be first.
const warmupTurns = [];
for (const [index, item] of warmupSet.entries())
  for (const [position, system] of counterbalancedOrder(index, SYSTEMS).entries()) {
    warmupTurns.push(await runTurn(system, item, position));
    await sleep(settings.settleMs);
  }
console.log(`warmup_done turns=${warmupTurns.length}`);

const turns = [];
for (const [index, item] of measuredSet.entries()) {
  for (const [position, system] of counterbalancedOrder(index, SYSTEMS).entries()) {
    turns.push(await runTurn(system, item, position));
    await sleep(settings.settleMs);
  }
  if ((index + 1) % 10 === 0 || index === measuredSet.length - 1) console.log(`  ${index + 1}/${measuredSet.length}`);
}

const idleAfter = { startMs: Date.now() };
await sleep(settings.idleSeconds * 1000);
idleAfter.endMs = Date.now();

const stopped = await sensor.stop();
bindings.corpusAfter = await corpusSnapshot();
bindings.corpusUnchanged = bindings.corpusBefore.tableCountsSha256 !== null && bindings.corpusBefore.tableCountsSha256 === bindings.corpusAfter.tableCountsSha256;
bindings.host.endedAt = new Date().toISOString();

const record = { turns, warmupTurns, samples: stopped.samples, idleBefore, idleAfter, bindings, settings, sensorStderr: stopped.sensorStderr };
const recordPath = settings.outPath.replace(/\.json$/u, "") + ".record.json";
write(recordPath, record);

const artifact = build(record);
artifact.mode = "live";
artifact.warmupExcluded = { turns: warmupTurns.length, items: warmupSet.map(item => item.id) };
artifact.sensorStderr = stopped.sensorStderr;
write(settings.outPath, artifact);
report(artifact);
console.log(`\nwrote ${settings.outPath}\nwrote ${recordPath}`);
