#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Re-derives `ingest.apparatus_run_residue_cut` from the source material in hand, so the declared value is
// reproducible rather than chosen: it is the Otsu split of the excess symbol density of the line runs of real files.
// Wiki pages are read through `wikiSurfaceLines` (markup resolved, lines intact) and every other file as it stands.
//
//   node tools/derive-apparatus-line-cuts.mjs <dir> [dir...]
//
// Directories are read one level deep; `.wikitext` files take the wiki path, everything else the plain path.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kernel = await import(pathToFileURL(path.resolve("packages/kernel/dist/index.js")).href);
const adapters = await import(pathToFileURL(path.resolve("packages/adapters-node/dist/wikipedia.js")).href);

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/derive-apparatus-line-cuts.mjs <dir> [dir...]");
  process.exit(2);
}

const scores = [];
let documents = 0;
let repeatedRuns = 0;
let linesInThem = 0;
for (const root of roots) {
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    if (!statSync(file).isFile() || name.startsWith("_")) continue;
    const raw = readFileSync(file, "utf8");
    const text = name.endsWith(".wikitext") ? adapters.wikiSurfaceLines(raw) : raw;
    // A cut of +Infinity measures the population without any run being called apparatus first.
    documents++;
    for (const run of kernel.measureApparatusRuns(text, Infinity)) {
      // The cut is derived over the population it is applied to: the runs that repeat at all.
      if (run.lineIndices.length < 2) continue;
      repeatedRuns++;
      linesInThem += run.lineIndices.length;
      scores.push(run.excessSymbolDensity);
    }
  }
}

console.log(`documents=${documents} repeated_runs=${repeatedRuns} lines_in_them=${linesInThem}`);
report("ingest.apparatus_run_residue_cut", scores, 256);
console.log(`declared ingest.apparatus_run_residue_cut = ${kernel.PUBLIC_CALIBRATIONS["ingest.apparatus_run_residue_cut"]}`);

/** Otsu's split of a population over `bins` equal buckets. */
function report(key, values, bins) {
  if (values.length === 0) return;
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const histogram = new Array(bins).fill(0);
  const span = (max - min) || 1;
  for (const value of values) histogram[Math.min(bins - 1, Math.floor(((value - min) / span) * (bins - 1)))]++;
  const total = values.length;
  let sum = 0;
  for (let index = 0; index < bins; index++) sum += index * histogram[index];
  let weightBelow = 0;
  let sumBelow = 0;
  let best = { variance: -1, index: 0 };
  for (let index = 0; index < bins; index++) {
    weightBelow += histogram[index];
    if (weightBelow === 0) continue;
    const weightAbove = total - weightBelow;
    if (weightAbove === 0) break;
    sumBelow += index * histogram[index];
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sum - sumBelow) / weightAbove;
    const variance = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (variance > best.variance) best = { variance, index };
  }
  const cut = min + ((best.index + 1) / (bins - 1)) * span;
  const above = values.filter(value => value >= cut).length;
  console.log(`${key}: min=${round(min)} max=${round(max)} otsu_cut=${round(cut)} runs_at_or_above=${above} (${round((above / total) * 100)}%)`);
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
