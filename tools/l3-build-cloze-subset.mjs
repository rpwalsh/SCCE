#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
//   node tools/l3-build-cloze-subset.mjs artifacts/head-to-head/L3-cloze-subset-suite.json 2
// A cloze subset for a fast early-warning run: every row that declined or went wrong, plus an evenly spaced
// sample of the ones that were correct, so a regression on the winning rows cannot hide.
import { readFileSync, writeFileSync } from "node:fs";
const suite = JSON.parse(readFileSync("artifacts/head-to-head/suite.json", "utf8"));
const base = JSON.parse(readFileSync("artifacts/head-to-head/results-baseline-20260913.json", "utf8"));
const verdict = new Map(base.rows.filter(r => r.workload === "cloze").map(r => [r.id, r.scce.verdict]));
const cloze = suite.items.filter(item => item.workload === "cloze");
const failing = cloze.filter(item => verdict.get(item.id) !== "correct");
const correct = cloze.filter(item => verdict.get(item.id) === "correct");
const every = Number(process.argv[3] ?? 4);
const sampled = correct.filter((_, index) => index % every === 0);
const items = [...failing, ...sampled];
writeFileSync(process.argv[2], JSON.stringify({ ...suite, items }, null, 1));
console.log(`subset: ${items.length} rows -- ${failing.length} that failed, ${sampled.length} of ${correct.length} that were correct`);
