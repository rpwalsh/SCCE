#!/usr/bin/env node
// Re-score a saved results file against the current suite gold, offline. The runner's verdicts are frozen at the
// moment it ran; when gold changes, the rows must be re-judged without paying for another live run.
import { readFileSync, writeFileSync } from "node:fs";
import { score, summarizeVerdicts } from "./head-to-head/grade.mjs";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const results = JSON.parse(readFileSync(arg("in", "artifacts/head-to-head/results-full.json"), "utf8"));
const suiteDoc = JSON.parse(readFileSync(arg("suite", "artifacts/head-to-head/suite.json"), "utf8"));
const items = new Map((Array.isArray(suiteDoc) ? suiteDoc : suiteDoc.items).map(i => [i.id, i]));

const TRUNCATION_CAP = 300;
let changed = 0;
let unreliable = 0;
for (const row of results.rows) {
  const item = items.get(row.id);
  if (!item) continue;
  for (const side of ["scce", "model"]) {
    if (!row[side]) continue;
    const answer = row[side].answer ?? "";
    // Runs before 2026-09-13 stored only the first 300 characters while grading the whole answer. Re-judging a
    // clipped string invents failures, so those rows keep the verdict the runner reached with the full text.
    if (answer.length >= TRUNCATION_CAP) { unreliable++; continue; }
    const next = score(item, answer);
    if (next.verdict !== row[side].verdict) changed++;
    row[side].verdict = next.verdict;
    row[side].declined = next.declined;
  }
}

const out = arg("out", "");
if (out) writeFileSync(out, JSON.stringify(results, null, 2) + "\n", "utf8");

const tally = side => {
  const t = {};
  for (const r of results.rows) if (r[side]) t[r[side].verdict] = (t[r[side].verdict] || 0) + 1;
  return t;
};
const right = side => results.rows.reduce((n, r) => {
  if (!r[side]) return n;
  const want = r.workload === "abstention" ? "declined" : "correct";
  return n + (r[side].verdict === want ? 1 : 0);
}, 0);

console.log(`re-scored ${results.rows.length} rows, ${changed} verdict changes` + (unreliable ? `, ${unreliable} left alone as stored-truncated` : ""));
console.log("SCCE:", JSON.stringify(tally("scce")));
console.log("qwen:", JSON.stringify(tally("model")));
console.log(`\nRIGHT BEHAVIOUR  SCCE ${right("scce")}  vs  reference ${right("model")}  of ${results.rows.length}`);

const by = {};
for (const r of results.rows) {
  const w = r.workload || "?";
  (by[w] ??= { n: 0, s: 0, m: 0 });
  by[w].n++;
  const want = w === "abstention" ? "declined" : "correct";
  if (r.scce?.verdict === want) by[w].s++;
  if (r.model?.verdict === want) by[w].m++;
}
console.log("\nworkload".padEnd(17), "n".padStart(4), "SCCE".padStart(6), "ref".padStart(6));
for (const [w, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) {
  console.log(w.padEnd(16), String(v.n).padStart(5), String(v.s).padStart(6), String(v.m).padStart(6),
    v.s > v.m ? "  SCCE" : v.s < v.m ? "  ref" : "  tie");
}
