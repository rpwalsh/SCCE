#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Finds ARBITRARY MODELING CONSTANTS that are written inline instead of declared in the calibration registry.
//
// Not every number is a calibration candidate. A slice bound, a batch limit, a convergence tolerance and an array
// index are structure or cost, and abstracting them would be noise. What matters is the number somebody CHOSE:
// a weight in a linear combination, or a threshold compared against a normalized score. Those decide behaviour,
// nobody derived them, and while they sit inline they cannot be audited, searched or fitted.
//
// The first version of this tool reported 1,929 "candidates" by counting every literal, which is exactly the kind
// of number that gets a report ignored.
//
//   node tools/undeclared-constants.mjs [--min=2] [--path=packages/kernel/src] [--list]
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const root = flag("path", "packages/kernel/src");
const minHits = Number(flag("min", 2));
const listAll = process.argv.includes("--list");

const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "calibrations") continue;
      walk(full);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full);
  }
};
walk(root);

/**
 * A calibration candidate is a decimal strictly inside (0,1) that is either:
 *   WEIGHT     multiplied into an expression   `contradiction * 0.58`
 *   THRESHOLD  compared against a score        `preservation >= 0.6`
 *   BLEND      an additive term in a sum       `+ 0.28`
 * Integers are excluded: in this codebase they are slice bounds, limits, counts and indices.
 * Exponentials are excluded: 1e-10 is a convergence tolerance, not a judgement.
 */
const WEIGHT = /\*\s*(0\.\d+)\b/g;
const THRESHOLD = /(?:[<>]=?|===)\s*(0\.\d+)\b/g;
const BLEND = /[+-]\s*(0\.\d+)\s*[*)+,\]]/g;

/** Names that mark a number as a bound on work rather than a modeling choice. */
const COST_CONTEXT = /\b(limit|max|min|cap|budget|bytes|timeout|ms|slice|batch|size|count|tolerance|epsilon)\b/i;

const hits = new Map();
let costBounded = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const readsRegistry = source.includes("calibrated(");
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    if (line.includes("calibrated(")) continue;
    const found = new Set();
    for (const [kind, pattern] of [["weight", WEIGHT], ["threshold", THRESHOLD], ["blend", BLEND]]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line))) found.add(`${kind}:${match[1]}`);
    }
    if (!found.size) continue;
    if (COST_CONTEXT.test(line)) { costBounded += found.size; continue; }
    const key = path.relative(".", file).replace(/\\/g, "/");
    const row = hits.get(key) ?? { file: key, readsRegistry, count: 0, samples: [] };
    row.count += found.size;
    if (row.samples.length < (listAll ? 40 : 3)) row.samples.push({ line: index + 1, text: line.slice(0, 100) });
    hits.set(key, row);
  }
}

const ranked = [...hits.values()].filter(row => row.count >= minHits).sort((left, right) => right.count - left.count);
const total = ranked.reduce((sum, row) => sum + row.count, 0);
const registry = readFileSync("packages/kernel/src/calibrations/public-calibrations.ts", "utf8");
const declared = registry.match(/^\s*"[a-z_]+\.[a-z_0-9]+":/gim)?.length ?? 0;
const coverage = declared + total > 0 ? (declared / (declared + total)) * 100 : 100;

console.log(`# Arbitrary modeling constants written inline\n`);
console.log(`Weights and thresholds in the unit interval that decide behaviour and were chosen by hand.`);
console.log(`Slice bounds, limits, counts, indices and tolerances are excluded: ${costBounded} were skipped as cost bounds.\n`);
console.log("| file | count | reads registry | example |");
console.log("| --- | ---: | :---: | --- |");
for (const row of ranked.slice(0, listAll ? ranked.length : 25)) {
  console.log(`| ${row.file} | ${row.count} | ${row.readsRegistry ? "yes" : "NO"} | \`${String(row.samples[0]?.text ?? "").replace(/\|/g, "/")}\` |`);
}
if (listAll) {
  console.log(`\n## Every site\n`);
  for (const row of ranked) {
    console.log(`### ${row.file}`);
    for (const sample of row.samples) console.log(`- ${row.file}:${sample.line}  \`${sample.text.replace(/\|/g, "/")}\``);
  }
}
console.log(`\n**${ranked.filter(row => !row.readsRegistry).length} files never read the registry.**`);
console.log(`Arbitrary constants inline: ${total}. Declared calibrations: ${declared}.`);
console.log(`\nDECLARED_COVERAGE ${coverage.toFixed(1)}%`);
