#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Acceptance gate 16: cognition across a sequence of turns in one process, measured rather than asserted.
 *
 * A single turn says nothing about whether state accumulates or degrades, and every one-shot harness in this
 * repository starts a fresh process, so it measures a permanently cold runtime. What that hides: the durable
 * language-memory hydration is budgeted per turn and falls back to a resident cache, so the first turn after
 * start can run with no learned language at all. Whether the second turn recovers is a property only a
 * multi-turn run can observe.
 *
 * Reports per turn: wall clock, what the language memory actually delivered, evidence admitted, whether an
 * answer was produced, and resident memory. Degradation is the output, not a pass mark -- the gate's own
 * criterion is that decline is graceful, and a number per turn is what lets a reader judge that.
 */

const args = new Map(process.argv.slice(2)
  .filter(argument => argument.startsWith("--"))
  .map(argument => {
    const [name, value] = argument.slice(2).split("=");
    return [name, value ?? "1"];
  }));

const configPath = args.get("config") ?? process.env.SCCE_CONFIG ?? "scce.config.json";
const turnCount = Number(args.get("turns") ?? 20);
const outputPath = args.get("out") ?? "artifacts/long-horizon-gate.json";

if (!process.env.SCCE_DATABASE_URL) {
  // The URL lives only in the untracked local config; the gate reads it the same way an operator would.
  try {
    process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
  } catch {
    process.stderr.write("no SCCE_DATABASE_URL and no scce.config.local.json to read one from\n");
    process.exit(2);
  }
}
process.env.SCCE_TRACE = "1";

const { createNodeRuntime, readScceRuntimeConfig } = await import("../packages/adapters-node/dist/index.js");
const { createTrace } = await import("../packages/kernel/dist/debug/trace.js");

const trace = createTrace("long-horizon");
globalThis.__sccTrace = trace;

const config = await readScceRuntimeConfig(configPath);
const runtime = createNodeRuntime(config);
// The server warms the runtime before it serves. A sequence that skips it measures a cold path production never
// takes: the first turn to touch a language cluster otherwise hydrates nothing.
const warmup = await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);
process.stdout.write(
  `warmup ${Math.round(warmup?.totalMs ?? 0)}ms `
  + `language models=${warmup?.language?.models ?? 0} units=${warmup?.language?.units ?? 0}\n`
);

/** Questions that revisit the same subjects, so a later turn can be checked against what an earlier one established. */
const QUESTIONS = [
  "When was Ada Lovelace born?",
  "Who was Charles Babbage?",
  "What did Ada Lovelace write about the Analytical Engine?",
  "When did Ada Lovelace die?",
  "What was the Analytical Engine?"
];

const rows = [];
let consumed = 0;

for (let turn = 1; turn <= turnCount; turn++) {
  const question = QUESTIONS[(turn - 1) % QUESTIONS.length];
  const started = Date.now();
  let failure;
  let result;
  try {
    result = await runtime.kernel.turn({ text: question });
  } catch (error) {
    failure = String(error?.message ?? error).slice(0, 200);
  }
  const durationMs = Date.now() - started;
  const traceRows = readFileSync(trace.file, "utf8").trim().split("\n").slice(consumed).map(line => {
    try { return JSON.parse(line); } catch { return {}; }
  });
  consumed += traceRows.length;
  const language = traceRows.filter(row => row.stage === "runtime.seed.language").pop();
  const budgetExceeded = traceRows.some(row => row.stage === "runtime.seed.language.budget_exceeded");
  const memory = process.memoryUsage();
  rows.push({
    turn,
    question,
    durationMs,
    ...(failure ? { failure } : {}),
    languageModels: language?.counts?.models ?? null,
    languagePatterns: language?.counts?.patterns ?? null,
    languageFrames: language?.counts?.semanticFrames ?? null,
    languageBudgetExceeded: budgetExceeded,
    evidence: result?.evidence?.length ?? 0,
    force: result?.epistemicForce ?? null,
    answered: Boolean(String(result?.answer ?? "").trim()),
    answerChars: String(result?.answer ?? "").length,
    residentMb: Math.round(memory.rss / 1048576),
    heapMb: Math.round(memory.heapUsed / 1048576)
  });
  const row = rows[rows.length - 1];
  process.stdout.write(
    `turn ${String(turn).padStart(3)} ${String(durationMs).padStart(6)}ms  `
    + `lang ${String(row.languagePatterns).padStart(5)}p/${String(row.languageFrames).padStart(5)}f`
    + `${budgetExceeded ? " OVER" : "     "}  `
    + `ev ${String(row.evidence).padStart(2)}  ${row.answered ? "answered" : "SILENT  "}  `
    + `rss ${String(row.residentMb).padStart(4)}mb  ${row.failure ? "FAIL " + row.failure : ""}\n`
  );
}

const answered = rows.filter(row => row.answered).length;
const withLanguage = rows.filter(row => (row.languagePatterns ?? 0) > 0).length;
const firstHalf = rows.slice(0, Math.floor(rows.length / 2));
const secondHalf = rows.slice(Math.floor(rows.length / 2));
const mean = list => list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : 0;

const report = {
  schema: "scce.long_horizon_gate.v1",
  generatedAt: new Date().toISOString(),
  config: configPath,
  turns: rows.length,
  answered,
  silent: rows.length - answered,
  turnsWithLanguageMemory: withLanguage,
  languageBudgetExceeded: rows.filter(row => row.languageBudgetExceeded).length,
  failures: rows.filter(row => row.failure).length,
  latency: {
    firstHalfMeanMs: mean(firstHalf.map(row => row.durationMs)),
    secondHalfMeanMs: mean(secondHalf.map(row => row.durationMs)),
    maxMs: Math.max(...rows.map(row => row.durationMs))
  },
  memory: {
    firstResidentMb: rows[0]?.residentMb ?? 0,
    lastResidentMb: rows[rows.length - 1]?.residentMb ?? 0,
    maxResidentMb: Math.max(...rows.map(row => row.residentMb))
  },
  rows
};

mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(
  `\n${rows.length} turns: ${answered} answered, ${rows.length - answered} silent, `
  + `${withLanguage} with language memory, ${report.languageBudgetExceeded} language-budget overruns, ${report.failures} failures\n`
  + `latency first half ${report.latency.firstHalfMeanMs}ms -> second half ${report.latency.secondHalfMeanMs}ms (max ${report.latency.maxMs}ms)\n`
  + `resident ${report.memory.firstResidentMb}mb -> ${report.memory.lastResidentMb}mb (max ${report.memory.maxResidentMb}mb)\n`
  + `wrote ${outputPath}\n`
);

await runtime.close?.();
process.exit(0);
