#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Re-scores the SCCE side of a recorded reference-comparison report with the current decline rule, leaving every
// recorded answer, timing, and the model's verdicts untouched. Exists because the decline detector was corrected
// after a run: SCCE's own decline notice ("No grounded source in the ingested corpus for: ...") had been scored as
// a fabrication. SCCE's notice is short and leads the answer, so the recorded (truncated) answer is enough to
// re-score it; the model's answers are truncated in the record and its verdicts are taken from the run log.
//   node tools/rescore-reference-comparison.mjs <report.json> <run-log.txt>
import { readFileSync, writeFileSync } from "node:fs";

const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const [file, logFile] = positional;
// --model-summary=correct,wrong,declinedWhenAnswerable,fabrications,declined,cited,meanMs restores the model's
// totals from the run's own printed summary when the log no longer holds every per-question line.
const modelSummaryArg = process.argv.find(a => a.startsWith("--model-summary="));
if (!file || !logFile) { console.error("usage: rescore-reference-comparison.mjs <report.json> <run-log.txt> [--model-summary=c,w,d,f,dec,cited,ms]"); process.exit(2); }
const report = JSON.parse(readFileSync(file, "utf8"));
const log = readFileSync(logFile, "utf8").split(/\r?\n/u);

const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
const declines = answer => {
  const spoken = normalize(answer);
  if (!spoken) return true;
  return /(do not|does not|doesn't|don't|no (information|mention|reference|record|grounded source)|not (mentioned|found|provided|present|specified|available|contain|include)|cannot|can't|unable|unknown|not enough|isn't (mentioned|specified)|no specific)/u.test(spoken);
};
const statesExpected = (row, answer) => String(row.expect ?? "").split(/[\s,]+/u).filter(Boolean).every(part => normalize(answer).includes(normalize(part)));

// Model verdicts as the run printed them: the line after "<id>: <question>" that starts with the model's name.
const modelVerdicts = new Map();
for (let index = 0; index < log.length; index++) {
  const head = /^([a-z0-9-]+)(?:\s+\(not in the corpus\))?: /u.exec(log[index]);
  if (!head) continue;
  const modelLine = log.slice(index + 1, index + 4).find(line => /^\s{2}(?!scce)\S+\s+\d+ms\s+(CORRECT|declined|wrong|FABRICATED)/u.test(line));
  const verdict = modelLine ? /\d+ms\s+(CORRECT|declined|wrong|FABRICATED)/u.exec(modelLine)?.[1] : undefined;
  if (verdict) modelVerdicts.set(head[1], verdict);
}

let modelFromLog = 0;
for (const row of report.rows) {
  row.scce.declined = declines(row.scce.answer);
  row.scce.correct = row.answerable ? statesExpected(row, row.scce.answer) : null;
  const verdict = modelVerdicts.get(row.question);
  if (verdict) {
    modelFromLog++;
    row.model.declined = verdict === "declined";
    row.model.correct = row.answerable ? verdict === "CORRECT" : null;
    row.model.verdictSource = "run-log";
  } else {
    row.model.verdictSource = "rescored-from-truncated-answer";
  }
}
const answerable = report.rows.filter(row => row.answerable);
const unanswerable = report.rows.filter(row => !row.answerable);
const tally = side => ({
  correct: answerable.filter(row => row[side].correct).length,
  wrong: answerable.filter(row => !row[side].correct && !row[side].declined).length,
  declinedWhenAnswerable: answerable.filter(row => !row[side].correct && row[side].declined).length,
  fabrications: unanswerable.filter(row => !row[side].declined).length,
  declined: unanswerable.filter(row => row[side].declined).length,
  cited: report.rows.filter(row => row[side].cited).length,
  meanMs: Math.round(report.rows.reduce((sum, row) => sum + row[side].durationMs, 0) / Math.max(1, report.rows.length))
});
report.scce = tally("scce");
report.model = tally("model");
if (modelSummaryArg) {
  const [correct, wrong, declinedWhenAnswerable, fabrications, declined, cited, meanMs] = modelSummaryArg.slice("--model-summary=".length).split(",").map(Number);
  report.model = { correct, wrong, declinedWhenAnswerable, fabrications, declined, cited, meanMs, source: "run summary line" };
}
report.rescored = { at: new Date().toISOString(), rule: "decline detector recognizes SCCE's grounded-source notice; answers and timings unchanged; model verdicts restored from the run log", modelVerdictsFromLog: modelFromLog };
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const line = (label, entry) => `  ${label.padEnd(14)}${`${entry.correct}/${answerable.length}`.padStart(8)}   ${String(entry.wrong).padStart(5)}   ${`${entry.declined}/${unanswerable.length}`.padStart(9)}   ${String(entry.fabrications).padStart(12)}   ${String(entry.cited).padStart(6)}   ${String(entry.meanMs).padStart(9)}ms`;
console.log(`model verdicts from log: ${modelFromLog}/${report.rows.length}\n                 correct   wrong   declined   fabrications   cited   mean latency\n${line("scce", report.scce)}\n${line(report.compareModel, report.model)}`);
