#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Cold and warm turn latency on the running server, reported as distributions rather than a single mean: the runtime
// hydrates language and graph state durably, so the first pass over a probe set (cold) and the second (warm) are
// different measurements and are kept apart. Requirement (PROMISE_GAP_PLAN G2): warm p95 under 10 s; every cold
// regression reported, never averaged away.
//
//   node tools/head-to-head/latency-profile.mjs [--suite=artifacts/head-to-head/suite.json] [--workloads=relation,book,code,conversational]
//
// Runs alone; the server must have just been restarted for the cold pass to mean anything.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const suitePath = flag("suite", "artifacts/head-to-head/suite.json");
const outPath = flag("out", "artifacts/head-to-head/latency.json");
const workloads = new Set(flag("workloads", "relation,book,code,conversational,direct").split(",").filter(Boolean));
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";

const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const items = suite.items.filter(item => workloads.has(item.workload));
if (!items.length) throw new Error(`no suite items in workloads ${[...workloads].join(",")}`);

async function turn(text, pass) {
  const started = Date.now();
  try {
    const response = await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId: `latency-${pass}-${Date.now()}` })
    });
    await response.text();
    return { ms: Date.now() - started, status: response.status };
  } catch (error) {
    return { ms: Date.now() - started, status: 0, error: String(error?.message ?? error) };
  }
}

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
};
const summarize = rows => {
  const ms = rows.map(row => row.ms);
  return { items: rows.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: Math.max(...ms), mean: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), failed: rows.filter(row => row.status !== 200).length };
};

const passes = {};
for (const pass of ["cold", "warm"]) {
  const rows = [];
  for (const item of items) {
    const result = await turn(item.prompt, pass);
    rows.push({ id: item.id, workload: item.workload, ...result });
  }
  passes[pass] = { ...summarize(rows), byWorkload: Object.fromEntries([...workloads].filter(w => rows.some(r => r.workload === w)).map(w => [w, summarize(rows.filter(r => r.workload === w))])), rows };
  console.log(`${pass}: p50 ${passes[pass].p50} ms, p95 ${passes[pass].p95} ms, max ${passes[pass].max} ms over ${rows.length} turns (${passes[pass].failed} failed)`);
}
// The same item slower cold than warm by more than the warm p95 is a cold regression worth naming.
const regressions = passes.cold.rows
  .map(row => ({ id: row.id, coldMs: row.ms, warmMs: passes.warm.rows.find(r => r.id === row.id)?.ms ?? null }))
  .filter(row => row.warmMs !== null && row.coldMs - row.warmMs > passes.warm.p95)
  .sort((a, b) => (b.coldMs - b.warmMs) - (a.coldMs - a.warmMs));
const requirement = { warmP95UnderMs: 10_000, met: passes.warm.p95 !== null && passes.warm.p95 < 10_000 };
console.log(`requirement warm p95 < 10 s: ${requirement.met ? "MET" : "NOT MET"}; cold regressions: ${regressions.length}`);
for (const row of regressions.slice(0, 8)) console.log(`  ${row.id}: cold ${row.coldMs} ms, warm ${row.warmMs} ms`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ schema: "scce.latency_profile.v1", generatedAt: new Date().toISOString(), workloads: [...workloads], requirement, cold: passes.cold, warm: passes.warm, regressions }, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
