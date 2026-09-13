#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Row-by-row comparison of one workload against the frozen baseline. A net total hides a compensating pair, so
// every transition is counted and every row that moved is named.
//
//   node tools/l3-compare.mjs artifacts/head-to-head/L3-cloze.json cloze
import { readFileSync } from "node:fs";

const [, , runPath, workload, basePath = "artifacts/head-to-head/results-baseline-20260913.json"] = process.argv;
const base = JSON.parse(readFileSync(basePath, "utf8"));
const run = JSON.parse(readFileSync(runPath, "utf8"));
const baseRows = new Map(base.rows.filter(row => !workload || row.workload === workload).map(row => [row.id, row]));
const runRows = run.rows.filter(row => !workload || row.workload === workload);

const tally = {};
const moved = [];
for (const row of runRows) {
  const before = baseRows.get(row.id);
  if (!before) continue;
  const from = before.scce?.verdict ?? "absent";
  const to = row.scce?.verdict ?? "absent";
  tally[`${from} -> ${to}`] = (tally[`${from} -> ${to}`] ?? 0) + 1;
  if (from !== to) moved.push({ id: row.id, from, to, answer: String(row.scce?.answer ?? "").slice(0, 150) });
}

const count = (rows, verdict, side) => rows.filter(row => (side === "base" ? baseRows.get(row.id)?.scce : row.scce)?.verdict === verdict).length;
const compared = runRows.filter(row => baseRows.has(row.id));
console.log(`${workload ?? "all"}: ${compared.length} rows compared against the frozen baseline\n`);
for (const verdict of ["correct", "wrong", "declined_when_answerable", "declined", "fabricated"]) {
  console.log(`  ${verdict.padEnd(26)} baseline ${String(count(compared, verdict, "base")).padStart(4)}  ->  now ${String(count(compared, verdict, "run")).padStart(4)}`);
}
console.log("\ntransitions:");
for (const [transition, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${transition}`);
const lost = moved.filter(m => m.from === "correct");
const won = moved.filter(m => m.to === "correct");
console.log(`\nLOST (was correct): ${lost.length}`);
for (const m of lost) console.log(`  ${m.id} -> ${m.to} :: ${m.answer}`);
console.log(`\nWON (now correct): ${won.length}`);
for (const m of won) console.log(`  ${m.id} (was ${m.from}) :: ${m.answer}`);
const other = moved.filter(m => m.from !== "correct" && m.to !== "correct");
console.log(`\nother moves: ${other.length}`);
for (const m of other) console.log(`  ${m.id} ${m.from} -> ${m.to}`);
