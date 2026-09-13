#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// How much of a turn's visible-response budget is spent before the kernel starts, read off traces already on disk.
// Needs no server and no database. For every POST /api/turn in every trace file it reports:
//
//   window       the deadline the kernel actually counted down from (support.budgetMs, or remainingMs + durationMs
//                for traces written before that field existed)
//   preKernel    elapsed from the deadline's own start stamp to the kernel.turn.start checkpoint
//   readiness    the turn.runtime.readiness block, which is nearly all of preKernel
//
// A turn whose kernel-side window disagrees with the budgetMs the server reports in turn.deadline.observed is the
// failure this tool exists to catch: the kernel then counts down from a budget nobody wrote down, and every
// remainingMs downstream reads as unexplained missing time.
//
//   node tools/pre-kernel-latency.mjs [--dir=.scce/traces] [--top=10]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const dir = flag("dir", ".scce/traces");
const top = Number(flag("top", 10));

const turns = [];
for (const file of readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort()) {
  let current = null;
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.stage === "api.request" && String(event.label ?? "").includes("POST /api/turn")) current = { file };
    if (!current) continue;
    if (event.stage === "turn.runtime.readiness") current.readinessMs = event.durationMs;
    if (event.stage === "runtime.deadline.check" && event.support?.phase === "kernel.turn.start") {
      current.preKernelMs = event.durationMs;
      // remainingMs is floored at zero, so it only recovers the window while the deadline has not already elapsed.
      current.kernelWindowMs = event.support.budgetMs
        ?? (event.support.remainingMs > 0 ? Math.round(event.durationMs + event.support.remainingMs) : undefined);
    }
    if (event.stage === "turn.deadline.observed") {
      current.serverBudgetMs = event.support?.budgetMs;
      if (current.preKernelMs !== undefined) turns.push(current);
      current = null;
    }
  }
}
if (!turns.length) throw new Error(`no /api/turn turns with a kernel.turn.start checkpoint under ${dir}`);

const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] : null;
const round = value => value === null || value === undefined ? "n/a" : String(Math.round(value));
const preKernel = turns.map(turn => turn.preKernelMs);
const readiness = turns.map(turn => turn.readinessMs).filter(value => value !== undefined);

console.log(`${turns.length} turns across ${new Set(turns.map(turn => turn.file)).size} trace files in ${dir}`);
console.log(`preKernel ms  p50 ${round(quantile(preKernel, 0.5))}  p90 ${round(quantile(preKernel, 0.9))}  p99 ${round(quantile(preKernel, 0.99))}  max ${round(Math.max(...preKernel))}`);
console.log(`readiness ms  p50 ${round(quantile(readiness, 0.5))}  p90 ${round(quantile(readiness, 0.9))}  p99 ${round(quantile(readiness, 0.99))}  max ${round(Math.max(...readiness))}`);

const windows = new Map();
for (const turn of turns) {
  const key = turn.kernelWindowMs ?? "unrecoverable (deadline already elapsed)";
  windows.set(key, (windows.get(key) ?? 0) + 1);
}
console.log(`kernel windows observed: ${[...windows].sort((a, b) => b[1] - a[1]).map(([ms, count]) => `${ms}${typeof ms === "number" ? "ms" : ""} x${count}`).join(", ")}`);

const disagreeing = turns.filter(turn => turn.kernelWindowMs !== undefined && turn.serverBudgetMs !== undefined && Math.abs(turn.kernelWindowMs - turn.serverBudgetMs) > 1);
console.log(`\nturns whose kernel window disagrees with the server's reported budget: ${disagreeing.length}`);
for (const [file, rows] of groupBy(disagreeing, turn => turn.file)) {
  console.log(`  ${file}: ${rows.length} turns, kernel window ${rows[0].kernelWindowMs}ms, server budget ${rows[0].serverBudgetMs}ms`);
}

console.log(`\nslowest ${top} pre-kernel turns:`);
for (const turn of [...turns].sort((a, b) => b.preKernelMs - a.preKernelMs).slice(0, top)) {
  console.log(`  ${round(turn.preKernelMs)}ms  readiness ${round(turn.readinessMs)}ms  window ${turn.kernelWindowMs === undefined ? "n/a" : `${turn.kernelWindowMs}ms`}  ${turn.file}`);
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const id = key(row);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return grouped;
}
