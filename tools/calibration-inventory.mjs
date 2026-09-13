#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The calibration debt, counted as decisions rather than digits, with enough context to declare each one.
//
// Three inflations were removed after audit, in order of size: a band (`x > a && x < b`) is ONE decision written as
// two comparisons; code unreachable from a real turn decides nothing in production; and a value repeated inside one
// file is one convention applied N times, not N independent judgements. Slice bounds, batch limits, indices and
// convergence tolerances were never calibration candidates at all.
//
// What is left is what somebody chose: a weight vector, or a tuned threshold.
//
//   node tools/calibration-inventory.mjs                  # summary
//   node tools/calibration-inventory.mjs --sites          # every site, for declaring them
//   node tools/calibration-inventory.mjs --file=<path>    # one file
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = "packages/kernel/src";
const flag = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const wantSites = process.argv.includes("--sites");
const onlyFile = flag("file");

/** Round tenths and quarters are defaults, not tuning. Declaring them adds ceremony without adding a fit. */
const CONVENTIONAL = new Set(["0.5", "0.25", "0.75", "0.1", "0.2", "0.3", "0.4", "0.6", "0.7", "0.8", "0.9"]);
/** Names that mark a number as a bound on work rather than a modeling choice. */
const COST = /\b(limit|max|min|cap|budget|bytes|timeout|ms|slice|batch|size|count|tolerance|epsilon|index)\b/i;

const files = [];
const walk = d => {
  for (const e of readdirSync(d)) {
    const f = path.join(d, e);
    if (statSync(f).isDirectory()) {
      if (e === "__tests__" || e === "calibrations") continue;
      walk(f);
      continue;
    }
    if (f.endsWith(".ts") && !f.endsWith(".d.ts")) files.push(f);
  }
};
walk(ROOT);
const rel = f => path.relative(".", f).split(path.sep).join("/");

// Only code a real turn can reach decides production behaviour.
const importsOf = new Map();
for (const f of files) {
  importsOf.set(rel(f), [...readFileSync(f, "utf8").matchAll(/from\s+"\.\/([^"]+)\.js"/g)].map(m => m[1]));
}
const reachable = new Set();
const queue = [`${ROOT}/production-turn-runtime.ts`];
while (queue.length) {
  const cur = queue.pop();
  if (reachable.has(cur)) continue;
  reachable.add(cur);
  for (const dep of importsOf.get(cur) ?? []) {
    const next = `${ROOT}/${dep}.ts`;
    if (importsOf.has(next)) queue.push(next);
  }
}

const vectors = [];
const thresholds = [];
for (const f of files) {
  const key = rel(f);
  if (onlyFile && key !== onlyFile) continue;
  if (!reachable.has(key)) continue;
  const seen = new Set();
  for (const [index, raw] of readFileSync(f, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.includes("calibrated(")) continue;
    const weights = [...line.matchAll(/(?:^|[^.\w])(0\.\d+)\s*\*/g)].map(m => m[1]);
    if (weights.length >= 2) {
      const sum = weights.reduce((a, b) => a + Number(b), 0);
      vectors.push({ file: key, line: index + 1, weights, normalized: Math.abs(sum - 1) < 0.02, text: line.slice(0, 150) });
      continue;
    }
    if (COST.test(line)) continue;
    const comparisons = [...line.matchAll(/(?:[<>]=?|===)\s*(0\.\d+)/g)].map(m => m[1]);
    // A band is one decision; take the pair once.
    const distinct = comparisons.length === 2 && /&&|\|\|/.test(line) ? [comparisons.join("..")] : comparisons;
    for (const value of distinct) {
      if (CONVENTIONAL.has(value)) continue;
      // One convention applied N times in a file is one object to declare, not N.
      const sig = `${key}:${value}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      thresholds.push({ file: key, line: index + 1, value, text: line.slice(0, 150) });
    }
  }
}

const byFile = new Map();
for (const row of [...vectors, ...thresholds]) {
  const entry = byFile.get(row.file) ?? { vectors: 0, thresholds: 0 };
  if (row.weights) entry.vectors += 1; else entry.thresholds += 1;
  byFile.set(row.file, entry);
}

if (wantSites || onlyFile) {
  console.log(`# Calibration sites to declare\n`);
  for (const [file, counts] of [...byFile.entries()].sort((a, b) => (b[1].vectors + b[1].thresholds) - (a[1].vectors + a[1].thresholds))) {
    console.log(`\n## ${file}  (${counts.vectors} vectors, ${counts.thresholds} thresholds)`);
    for (const row of vectors.filter(v => v.file === file)) {
      console.log(`- VECTOR ${file}:${row.line}${row.normalized ? " [sums to 1]" : ""}  [${row.weights.join(", ")}]`);
      console.log(`    ${row.text}`);
    }
    for (const row of thresholds.filter(t => t.file === file)) {
      console.log(`- THRESHOLD ${file}:${row.line}  ${row.value}`);
      console.log(`    ${row.text}`);
    }
  }
}

console.log(`\n# Summary\n`);
console.log(`weight vectors:        ${vectors.length}  (${vectors.filter(v => v.normalized).length} sum to 1)`);
console.log(`tuned thresholds:      ${thresholds.length}  (deduplicated per file, bands counted once, conventional excluded)`);
console.log(`files carrying them:   ${byFile.size}`);
console.log(`TOTAL OBJECTS:         ${vectors.length + thresholds.length}`);
console.log(`\nTop files:`);
for (const [file, counts] of [...byFile.entries()].sort((a, b) => (b[1].vectors + b[1].thresholds) - (a[1].vectors + a[1].thresholds)).slice(0, 12)) {
  console.log(`  ${String(counts.vectors + counts.thresholds).padStart(3)}  ${file}  (${counts.vectors}v ${counts.thresholds}t)`);
}
