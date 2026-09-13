#!/usr/bin/env node
// L2: row-by-row verdict diff of a lane run against the frozen baseline. Uses the runner's own verdicts only.
import { readFileSync } from "node:fs";
const baseline = JSON.parse(readFileSync("artifacts/head-to-head/results-baseline-20260913.json", "utf8"));
const before = new Map(baseline.rows.map(row => [row.id, row]));
for (const path of process.argv.slice(2)) {
  const after = JSON.parse(readFileSync(path, "utf8"));
  const counts = { gained: 0, lost: 0, same: 0 };
  const lines = [];
  for (const row of after.rows) {
    const was = before.get(row.id);
    if (!was) continue;
    const a = was.scce.verdict, b = row.scce.verdict;
    if (a === b) { counts.same++; continue; }
    if (b === "correct") counts.gained++; else if (a === "correct") counts.lost++;
    lines.push(`  ${b === "correct" ? "GAIN" : a === "correct" ? "LOST" : "move"} ${row.id}  ${a} -> ${b}`);
  }
  const verdicts = {};
  for (const row of after.rows) verdicts[row.scce.verdict] = (verdicts[row.scce.verdict] ?? 0) + 1;
  const baseVerdicts = {};
  for (const row of after.rows) { const was = before.get(row.id); if (was) baseVerdicts[was.scce.verdict] = (baseVerdicts[was.scce.verdict] ?? 0) + 1; }
  process.stdout.write(`\n${path}  n=${after.rows.length}\n  baseline ${JSON.stringify(baseVerdicts)}\n  now      ${JSON.stringify(verdicts)}\n  gained ${counts.gained} lost ${counts.lost} unchanged ${counts.same}\n${lines.join("\n")}\n`);
}
