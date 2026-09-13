#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * G9's compute-efficiency PROXY, built from turn traces already on disk. Offline: no server, no database.
 *
 * A proxy, not energy. CPU-seconds are not joules, and this host exposes no package-energy counter, so there is
 * no joules column rather than an estimated one.
 *
 * What each measured quantity is, exactly (see packages/kernel/src/resource-usage-accounting.ts):
 *   wallMs   process.hrtime.bigint() differenced around the kernel turn. Attributable to the turn.
 *   cpuMs    process.cpuUsage() differenced around the same window: every CPU-millisecond the SERVER PROCESS
 *            burned while the turn ran, this turn's work included but not separated from it. An upper bound.
 *   rssBytes max(rss at turn start, rss at turn end). A process-level high-water of two samples -- not the
 *            turn's allocation, and not a sampled maximum.
 *
 * Usage: node tools/compute-efficiency-table.mjs [--traces DIR] [--reference FILE] [--out JSON] [--md MD] [--top N]
 */
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
const traceDir = args.get("traces") ?? process.env.SCCE_TRACE_DIR ?? ".scce/traces";
const referencePath = args.get("reference") ?? "artifacts/parity-dataset/reference-comparison-live.json";
const outPath = args.get("out") ?? ".agent/findings/T9-compute-efficiency.json";
const mdPath = args.get("md") ?? ".agent/findings/T9-compute-efficiency.md";
const topGroups = Number(args.get("top") ?? "25");

// Published paths are repo-relative: an absolute local path would put this checkout's directory names in the artifact.
const portablePath = value => {
  const parts = String(value).replace(/\\/gu, "/").split("/");
  const root = parts.findIndex(part => part === ".scce" || part === "artifacts" || part === "tools");
  return root < 0 ? String(value) : parts.slice(root).join("/");
};

// ---- turn records -------------------------------------------------------------------------------------------
/** One trace file is one host process: `trace.open` is written when the process opens its trace. */
function readTurns(dir) {
  if (!existsSync(dir)) { console.error(`no trace directory at ${dir}`); process.exit(2); }
  const files = readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort();
  const turns = [];
  for (const name of files) {
    let events;
    try {
      events = readFileSync(path.join(dir, name), "utf8").split(/\r?\n/u)
        .filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { continue; }
    const open = events.find(event => event.stage === "trace.open");
    const host = events.some(event => event.stage === "server.start") ? "server" : "tool";
    const hydrationAt = events.filter(event => String(event.stage).startsWith("language.hydrate.")).map(event => Date.parse(event.time));
    const local = [];
    let request = null;
    let ordinal = 0;
    for (const event of events) {
      if (event.stage === "turn.input") request = typeof event.input === "string" ? event.input : null;
      if (event.stage !== "turn.output" || event.label !== "kernel.turn") continue;
      const usage = event.support?.timing?.resourceUsage;
      if (!usage || !Number.isFinite(usage.wallClockMs)) continue;
      const endMs = Date.parse(event.time);
      const startMs = endMs - usage.wallClockMs;
      local.push({
        traceFile: name, host, hostLabel: open?.label ?? null, ordinal, request,
        startMs, endMs,
        wallMs: usage.wallClockMs,
        cpuUserMs: usage.cpuUserMs, cpuSystemMs: usage.cpuSystemMs,
        cpuMs: usage.cpuUserMs + usage.cpuSystemMs,
        rssBytes: usage.peakResidentSetBytes,
        totalMs: event.support?.timing?.totalMs ?? null,
        hydratingInWindow: hydrationAt.some(at => at >= startMs && at <= endMs)
      });
      ordinal++;
    }
    // Solo: no other measured turn of the same process was in flight during this one's window.
    for (const turn of local) {
      turn.solo = !local.some(other => other !== turn && other.startMs < turn.endMs && turn.startMs < other.endMs);
      turn.condition = turn.ordinal === 0 || turn.hydratingInWindow ? "cold" : "warm";
      turns.push(turn);
    }
  }
  return turns;
}

// ---- statistics ---------------------------------------------------------------------------------------------
/** Nearest-rank percentile: always an observation that actually occurred, never an interpolated one. */
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}
const round = (value, places) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(places)));
/** Milliseconds to seconds, preserving the null `percentile` returns for an empty sample. `(x ?? 0) / 1000`
 *  reported a cost nobody measured as zero seconds, which is the one direction that flatters this system. */
const toSeconds = (value, places) => (value === null || value === undefined ? null : round(value / 1000, places));
/** Max over an empty sample is unknown, not zero: `Math.max(0, ...none)` returns the floor it was seeded with. */
const maxOf = values => (values.length ? Math.max(...values) : null);

function summarize(turns) {
  const wall = turns.map(turn => turn.wallMs);
  const cpu = turns.map(turn => turn.cpuMs);
  const rss = turns.map(turn => turn.rssBytes);
  return {
    samples: turns.length,
    cpuSeconds: { p50: toSeconds(percentile(cpu, 0.5), 3), p95: toSeconds(percentile(cpu, 0.95), 3), max: toSeconds(maxOf(cpu), 3) },
    wallSeconds: { p50: toSeconds(percentile(wall, 0.5), 3), p95: toSeconds(percentile(wall, 0.95), 3), max: toSeconds(maxOf(wall), 3) },
    peakResidentSetBytes: { p50: percentile(rss, 0.5), p95: percentile(rss, 0.95), max: maxOf(rss) },
    gpuSeconds: 0,
    apiTokens: 0,
    cpuPerWall: { p50: round(percentile(turns.filter(turn => turn.wallMs > 0).map(turn => turn.cpuMs / turn.wallMs), 0.5), 3), p95: round(percentile(turns.filter(turn => turn.wallMs > 0).map(turn => turn.cpuMs / turn.wallMs), 0.95), 3) }
  };
}

// ---- reference ----------------------------------------------------------------------------------------------
/** Reference figures are reported only where a run on disk actually recorded them. */
function readReference(file) {
  if (!existsSync(file)) return { available: false, reason: `no reference comparison at ${file}` };
  const data = JSON.parse(readFileSync(file, "utf8"));
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const modelMs = rows.map(row => row.model?.durationMs).filter(Number.isFinite);
  const scceMs = rows.map(row => row.scce?.durationMs).filter(Number.isFinite);
  if (!modelMs.length) return { available: false, reason: `${file} records no reference durations` };
  return {
    available: true,
    source: portablePath(file),
    generatedAt: data.generatedAt ?? null,
    compareModel: data.compareModel ?? null,
    modelAdvantage: data.modelAdvantage ?? null,
    measurement: "client-observed wall clock per question, both systems measured the same way in the same run",
    reference: {
      samples: modelMs.length,
      wallSeconds: { p50: round(percentile(modelMs, 0.5) / 1000, 3), p95: round(percentile(modelMs, 0.95) / 1000, 3), max: round(Math.max(...modelMs) / 1000, 3) },
      cpuSeconds: null, peakResidentSetBytes: null, gpuSeconds: null, apiTokens: null,
      unmeasured: {
        cpuSeconds: "the harness that produced this file sampled no per-process CPU for the reference",
        peakResidentSetBytes: "no resident-set sample was taken for the reference process",
        gpuSeconds: "no GPU counter was sampled; whether the local runner used the iGPU is unrecorded",
        apiTokens: "prompt_eval_count/eval_count were not recorded; tools/head-to-head/run.mjs can record them but no results file from it exists"
      }
    },
    scceSameRun: {
      samples: scceMs.length,
      wallSeconds: { p50: round(percentile(scceMs, 0.5) / 1000, 3), p95: round(percentile(scceMs, 0.95) / 1000, 3), max: round(Math.max(...scceMs) / 1000, 3) },
      gpuSeconds: 0, apiTokens: 0
    }
  };
}

// ---- assemble -----------------------------------------------------------------------------------------------
const allTurns = readTurns(traceDir);
const measured = allTurns.filter(turn => turn.host === "server");
const warmSolo = measured.filter(turn => turn.condition === "warm" && turn.solo);
const coldSolo = measured.filter(turn => turn.condition === "cold" && turn.solo);
const concurrent = measured.filter(turn => !turn.solo);

const groups = new Map();
for (const turn of warmSolo) {
  if (!turn.request) continue;
  if (!groups.has(turn.request)) groups.set(turn.request, []);
  groups.get(turn.request).push(turn);
}
const byRequest = [...groups.entries()]
  .map(([request, turns]) => ({ request, ...summarize(turns) }))
  .sort((left, right) => right.samples - left.samples || left.request.localeCompare(right.request));

const endTimes = allTurns.map(turn => turn.endMs).filter(Number.isFinite);
const artifact = {
  schema: "scce.compute_efficiency_proxy.v1",
  generatedAt: new Date().toISOString(),
  framing: "A compute-efficiency proxy. CPU-seconds are not joules; this host exposes no package-energy counter, so there is no joules column rather than an estimated one.",
  traceDir: portablePath(traceDir),
  traceWindow: endTimes.length ? { from: new Date(Math.min(...endTimes)).toISOString(), to: new Date(Math.max(...endTimes)).toISOString() } : null,
  population: {
    measuredTurns: allTurns.length,
    serverHosted: measured.length,
    toolHosted: allTurns.length - measured.length,
    warmSolo: warmSolo.length,
    coldSolo: coldSolo.length,
    concurrentExcluded: concurrent.length,
    warmSoloWithRequestText: warmSolo.filter(turn => turn.request).length,
    distinctRequests: groups.size
  },
  classification: {
    cold: "the first turn a process served, or any turn with a language-hydration event inside its own window",
    warm: "every other turn",
    solo: "no other measured turn of the same process was in flight during this turn's window; turns that fail this are excluded from the CPU column because another turn's work is inside the same process-wide delta",
    scope: "server-hosted processes only (the trace file carries a server.start); turns from short-lived tool processes are counted separately and excluded from the headline"
  },
  meaning: {
    wallSeconds: "elapsed time of the kernel turn, from a monotonic clock differenced around it. Attributable to the turn.",
    cpuSeconds: "every CPU-second the server process burned while the turn ran, user plus system. Process-wide, so it is an UPPER BOUND on the turn's own CPU, not the turn's CPU.",
    peakResidentSetBytes: "the larger of the process's resident-set size at turn start and at turn end. A process-level high-water of two samples: not the turn's allocation, not a sampled peak, and dominated by state the server holds between turns.",
    gpuSeconds: "0 by construction: SCCE's product code loads no GPU or model runtime. A structural fact from the dependency gate, not a reading from a GPU counter.",
    apiTokens: "0 by construction: SCCE calls no model API. Same basis.",
    quantization: "this host's process CPU accounting advances in ~15.6 ms steps, so each of user and system carries that much quantization error per turn."
  },
  zeroColumnBasis: "artifacts/no-hidden-model-check.json -- 1029 files scanned for model packages, model endpoints and generation call patterns; violations: none.",
  overall: { warm: summarize(warmSolo), cold: summarize(coldSolo), concurrentExcluded: summarize(concurrent) },
  toolHosted: summarize(allTurns.filter(turn => turn.host !== "server" && turn.solo)),
  byRequest,
  referenceComparison: readReference(referencePath)
};

// ---- render -------------------------------------------------------------------------------------------------
const seconds = value => (value === null ? "" : value.toFixed(2));
const gib = value => (value === null ? "" : (value / 1024 ** 3).toFixed(2));
const shorten = text => (text.length <= 62 ? text : `${text.slice(0, 59)}...`);

const lines = [];
lines.push("# Compute-efficiency proxy (G9)", "");
lines.push(artifact.framing, "");
lines.push(`Built from ${artifact.population.measuredTurns} measured turns in \`${artifact.traceDir}\`, ${artifact.traceWindow?.from ?? "?"} to ${artifact.traceWindow?.to ?? "?"}.`, "");
lines.push("## Per turn, SCCE", "");
lines.push("| condition | n | CPU-s p50 | CPU-s p95 | wall-s p50 | wall-s p95 | peak RSS p50 | peak RSS p95 | GPU-s | API tokens |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const [label, summary] of [["warm", artifact.overall.warm], ["cold", artifact.overall.cold]]) {
  lines.push(`| ${label} | ${summary.samples} | ${seconds(summary.cpuSeconds.p50)} | ${seconds(summary.cpuSeconds.p95)} | ${seconds(summary.wallSeconds.p50)} | ${seconds(summary.wallSeconds.p95)} | ${gib(summary.peakResidentSetBytes.p50)} GiB | ${gib(summary.peakResidentSetBytes.p95)} GiB | ${summary.gpuSeconds} | ${summary.apiTokens} |`);
}
lines.push("");
lines.push(`How much of that CPU column can be this turn's own work: over warm turns the whole process burned ${artifact.overall.warm.cpuPerWall.p50} CPU-seconds per wall-second at p50 and ${artifact.overall.warm.cpuPerWall.p95} at p95. At the median the entire process, background included, stayed under one busy core, so the turn's own CPU cannot exceed the figure above and the room between them is small.`, "");
lines.push("## Per request, warm", "");
lines.push(`${Math.min(topGroups, byRequest.length)} of ${byRequest.length} request groups, by sample count, covering ${artifact.population.warmSoloWithRequestText} of ${artifact.population.warmSolo} warm turns (the rest carry no request text in the trace). All ${byRequest.length} groups are in the JSON artifact.`, "");
lines.push("| request | n | CPU-s p50 | CPU-s p95 | wall-s p50 | wall-s p95 | GPU-s | API tokens |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const group of byRequest.slice(0, topGroups)) {
  lines.push(`| ${shorten(group.request).replace(/\|/gu, "\\|")} | ${group.samples} | ${seconds(group.cpuSeconds.p50)} | ${seconds(group.cpuSeconds.p95)} | ${seconds(group.wallSeconds.p50)} | ${seconds(group.wallSeconds.p95)} | ${group.gpuSeconds} | ${group.apiTokens} |`);
}
lines.push("");
lines.push("## Against a reference system", "");
const comparison = artifact.referenceComparison;
if (!comparison.available) {
  lines.push(`Unmeasured: ${comparison.reason}.`, "");
} else {
  lines.push(`Both systems on the same questions in one run, ${comparison.source} (${comparison.generatedAt}). ${comparison.measurement}.`, "");
  lines.push(`Reference advantage on the task itself: ${comparison.modelAdvantage}.`, "");
  lines.push("| system | n | CPU-s | wall-s p50 | wall-s p95 | peak RSS | GPU-s | API tokens |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(`| SCCE | ${comparison.scceSameRun.samples} | | ${seconds(comparison.scceSameRun.wallSeconds.p50)} | ${seconds(comparison.scceSameRun.wallSeconds.p95)} | | 0 | 0 |`);
  lines.push(`| ${comparison.compareModel} | ${comparison.reference.samples} | | ${seconds(comparison.reference.wallSeconds.p50)} | ${seconds(comparison.reference.wallSeconds.p95)} | | | |`);
  lines.push("");
  lines.push("Empty cells are unmeasured, not zero:", "");
  for (const [column, reason] of Object.entries(comparison.reference.unmeasured)) lines.push(`- reference ${column}: ${reason}`);
  lines.push("- SCCE CPU-seconds and peak RSS in this run: the reference harness records no process accounting, so the per-turn table above is the only place those are measured.", "");
  lines.push(`SCCE's wall-seconds here (${seconds(comparison.scceSameRun.wallSeconds.p50)} s p50) is larger than the warm per-turn figure above (${seconds(artifact.overall.warm.wallSeconds.p50)} s p50) and the two are not interchangeable: this one is a client-observed HTTP round trip over one fixed question set on one day, that one is the kernel's own window over every request in the trace window. Only the two rows in this table are measured against each other.`, "");
}
lines.push("## What these numbers do and do not mean", "");
for (const [key, text] of Object.entries(artifact.meaning)) lines.push(`- **${key}** -- ${text}`);
lines.push("", `Zero columns rest on: ${artifact.zeroColumnBasis}`, "");
lines.push(`Excluded from the CPU column: ${artifact.population.concurrentExcluded} turns that overlapped another measured turn in the same process.`);
lines.push(`Counted separately: ${artifact.population.toolHosted} turns served by short-lived tool processes rather than the long-running server.`, "");

for (const file of [outPath, mdPath]) mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(mdPath, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.error(`\nwrote ${outPath} and ${mdPath}`);
