#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Measures the collective itself, so its design is evidence rather than assumption.
//
// The lean process is BELIEVED cheaper than the ten-worker one. Believed is not measured. Two ratios decide it:
// verified findings per million tokens, and accepted production changes per million tokens. A process that
// produces more commits per token but whose commits get reverted is worse, not better, so reverts are charged.
//
//   node tools/collective-metrics.mjs record --run=lean-01 --process=lean --task=T10 \
//        --tokens=142000 --wall-ms=1913895 --findings=3 --false-premises=1 --commits=2 --reverted=0 --verified=1
//   node tools/collective-metrics.mjs report
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LEDGER = ".agent/metrics/collective.json";
const args = new Map();
for (const token of process.argv.slice(3)) {
  if (!token.startsWith("--")) continue;
  const eq = token.indexOf("=");
  args.set(eq > 0 ? token.slice(2, eq) : token.slice(2), eq > 0 ? token.slice(eq + 1) : "1");
}
const arg = (name, fallback = null) => args.get(name) ?? fallback;
const num = (name) => { const raw = arg(name); return raw === null ? null : Number(raw); };

const load = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { schema: "scce.collective_metrics.v1", runs: [] });
const save = (ledger) => { mkdirSync(dirname(LEDGER), { recursive: true }); writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n"); };

const command = process.argv[2];

if (command === "record") {
  const ledger = load();
  const run = {
    run: arg("run"),
    process: arg("process"),          // "wide" (ten independent workers) or "lean" (3 investigate, 1 each after)
    task: arg("task"),
    workers: num("workers"),
    tokens: num("tokens"),
    wallMs: num("wall-ms"),
    // A finding is novel, evidenced and not already in .agent/context. A restatement of cached knowledge is not.
    findings: num("findings"),
    // A premise held by the coordinator or another worker, disproven with evidence. The highest-value output.
    falsePremises: num("false-premises"),
    commits: num("commits"),
    reverted: num("reverted"),
    // Survived the integration gate and is still in main.
    verified: num("verified"),
    at: new Date().toISOString()
  };
  if (!run.run || !run.process) { console.error("need --run and --process"); process.exit(1); }
  ledger.runs.push(run);
  save(ledger);
  console.log(`recorded ${run.run} (${run.process})`);
  process.exit(0);
}

if (command === "report") {
  const ledger = load();
  if (!ledger.runs.length) { console.log("no runs recorded yet"); process.exit(0); }
  const groups = new Map();
  for (const run of ledger.runs) {
    const key = run.process ?? "unknown";
    const group = groups.get(key) ?? { process: key, runs: 0, workers: 0, tokens: 0, wallMs: 0, findings: 0, falsePremises: 0, commits: 0, reverted: 0, verified: 0 };
    group.runs += 1;
    for (const field of ["workers", "tokens", "wallMs", "findings", "falsePremises", "commits", "reverted", "verified"]) {
      group[field] += Number(run[field] ?? 0);
    }
    groups.set(key, group);
  }
  const perMillion = (value, tokens) => (tokens > 0 ? (value / (tokens / 1e6)).toFixed(1) : "—");
  const rows = [...groups.values()];
  const lines = [
    "# Collective process comparison",
    "",
    "| | " + rows.map(row => row.process).join(" | ") + " |",
    "| --- | " + rows.map(() => "---:").join(" | ") + " |",
    "| runs | " + rows.map(r => r.runs).join(" | ") + " |",
    "| workers | " + rows.map(r => r.workers).join(" | ") + " |",
    "| tokens | " + rows.map(r => (r.tokens / 1e6).toFixed(2) + "M").join(" | ") + " |",
    "| wall hours | " + rows.map(r => (r.wallMs / 3.6e6).toFixed(1)).join(" | ") + " |",
    "| novel findings | " + rows.map(r => r.findings).join(" | ") + " |",
    "| false premises caught | " + rows.map(r => r.falsePremises).join(" | ") + " |",
    "| production commits | " + rows.map(r => r.commits).join(" | ") + " |",
    "| reverted | " + rows.map(r => r.reverted).join(" | ") + " |",
    "| verified fixes | " + rows.map(r => r.verified).join(" | ") + " |",
    "",
    "| ratio | " + rows.map(row => row.process).join(" | ") + " |",
    "| --- | " + rows.map(() => "---:").join(" | ") + " |",
    "| findings / Mtok | " + rows.map(r => perMillion(r.findings, r.tokens)).join(" | ") + " |",
    "| false premises / Mtok | " + rows.map(r => perMillion(r.falsePremises, r.tokens)).join(" | ") + " |",
    "| verified fixes / Mtok | " + rows.map(r => perMillion(r.verified, r.tokens)).join(" | ") + " |",
    "| net accepted / Mtok | " + rows.map(r => perMillion(r.commits - r.reverted, r.tokens)).join(" | ") + " |",
    ""
  ];
  const total = rows.reduce((sum, row) => sum + row.runs, 0);
  if (total < 5) lines.push(`Only ${total} run${total === 1 ? "" : "s"} recorded. Five to ten are needed before these ratios mean anything.`, "");
  const report = lines.join("\n");
  writeFileSync(".agent/metrics/collective.md", report);
  console.log(report);
  process.exit(0);
}

console.log("usage: collective-metrics.mjs record --run=<id> --process=wide|lean [...]  |  report");
process.exit(1);
