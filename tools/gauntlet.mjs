#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The qwen-beater gauntlet: one pass over every workload the frozen baseline scores, against the live server.
// Reports what it answered, what it withheld, and what it got wrong, per workload, with CPU and wall cost.
//
//   node tools/gauntlet.mjs                 # all workloads
//   node tools/gauntlet.mjs --only=factual
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const url = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const only = (process.argv.find(a => a.startsWith("--only=")) ?? "").slice(7);

// Each row: the question, and what a correct answer must contain. `expect: null` means the correct
// behaviour is to withhold (false premise, or nothing in corpus), so answering confidently is the failure.
const GAUNTLET = [
  // --- factual recall: the workload the answerhood fix targets
  { workload: "factual", q: "What is the capital of Albania?", expect: ["tirana"] },
  { workload: "factual", q: "When was Ada Lovelace born?", expect: ["10 december 1815", "1815"] },
  { workload: "factual", q: "Who was Ada Lovelace?", expect: ["mathematician", "lovelace"] },
  { workload: "factual", q: "What did Ada Lovelace invent?", expect: ["analytical engine", "program"] },
  { workload: "factual", q: "When did Apollo 11 land on the Moon?", expect: ["july 20, 1969", "1969"] },
  { workload: "factual", q: "What is the capital of Greece?", expect: ["athens"] },
  { workload: "factual", q: "Who is Albert Einstein?", expect: ["physicist", "relativity"] },
  { workload: "factual", q: "What is alchemy?", expect: ["alchemy"] },

  // --- abstention: answering these is the failure, not withholding
  { workload: "abstention", q: "Did Apollo 11 land on Mars?", expect: null },
  { workload: "abstention", q: "What is Albert Einstein's shoe size?", expect: null },
  { workload: "abstention", q: "Who was Ada Lovelace's dentist?", expect: null },

  // --- conversational: chat that must not be a fragment or an echo
  { workload: "conversational", q: "Hello, how are you today?", expect: null, chat: true },
  { workload: "conversational", q: "What can you help me with?", expect: null, chat: true },

  // --- creative
  { workload: "creative", q: "Write a short story about a lighthouse keeper.", expect: null, creative: true },

  // --- code
  { workload: "code", q: "Write a function that adds two numbers.", expect: null, code: true },
  { workload: "code", q: "Which file defines bestEvidenceSentences?", expect: ["local-evidence-runtime"] }
];

function cpuSnapshot() {
  const script = [
    "$s = (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server/dist/index.js*' } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).TotalProcessorTime.TotalSeconds",
    "$p = (Get-Process postgres -ErrorAction SilentlyContinue | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum",
    "Write-Output \"$s $p\""
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const [server, postgres] = String(result.stdout ?? "").trim().split(/\s+/u).map(Number);
  return (Number.isFinite(server) ? server : 0) + (Number.isFinite(postgres) ? postgres : 0);
}

async function ask(text) {
  const id = `g${Math.random().toString(36).slice(2, 9)}`;
  const started = Date.now();
  let status = 0;
  let body = {};
  try {
    const response = await fetch(`${url}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId: id, conversationId: id })
    });
    status = response.status;
    body = await response.json().catch(() => ({}));
  } catch (error) {
    body = { error: String(error?.message ?? error) };
  }
  const result = body.turn ?? body.result ?? body;
  return {
    status,
    ms: Date.now() - started,
    answer: String(result.answer ?? "").replace(/\s+/gu, " ").trim(),
    withheldReason: body.detail?.reasonId ?? null,
    evidence: (result.evidence ?? []).length
  };
}

/** A fragment is an answer too short or too incomplete to be an answer; the fragment defect, made checkable. */
function isFragment(answer) {
  const words = answer.split(/\s+/u).filter(Boolean);
  return words.length > 0 && words.length < 4;
}
function echoesRequest(answer, question) {
  const a = answer.toLocaleLowerCase();
  const q = question.toLocaleLowerCase().replace(/[?.]/gu, "").trim();
  return a === q || a.startsWith(q.slice(0, Math.max(12, Math.floor(q.length * 0.7))));
}

const rows = [];
await ask("warm");
await ask("warm");
const cpuBefore = cpuSnapshot();
const wallStart = Date.now();

for (const item of GAUNTLET) {
  if (only && item.workload !== only) continue;
  const outcome = await ask(item.q);
  const answered = outcome.answer.length > 0;
  let verdict;
  if (item.expect) {
    const hit = item.expect.some(want => outcome.answer.toLocaleLowerCase().includes(want));
    verdict = !answered ? "withheld_when_answerable" : hit ? "correct" : "wrong";
  } else if (item.chat || item.creative || item.code) {
    // No key: judged structurally. A fragment or an echo is a failure; silence on chat is a failure.
    verdict = !answered ? "withheld"
      : isFragment(outcome.answer) ? "fragment"
      : echoesRequest(outcome.answer, item.q) ? "echo"
      : "answered";
  } else {
    // abstention: withholding is correct, asserting is fabrication
    verdict = answered ? "fabricated" : "correctly_withheld";
  }
  rows.push({ ...item, ...outcome, verdict });
  process.stdout.write(`${verdict.padEnd(24)} ${String(outcome.ms).padStart(6)}ms ev=${outcome.evidence} ${item.q}\n    ${outcome.answer.slice(0, 110) || `(${outcome.withheldReason ?? "no answer"})`}\n`);
}

const wall = Date.now() - wallStart;
const cpu = cpuSnapshot() - cpuBefore;
const byWorkload = new Map();
for (const row of rows) {
  const bucket = byWorkload.get(row.workload) ?? { n: 0, good: 0 };
  bucket.n++;
  if (["correct", "correctly_withheld", "answered"].includes(row.verdict)) bucket.good++;
  byWorkload.set(row.workload, bucket);
}
process.stdout.write("\n=== by workload ===\n");
for (const [workload, bucket] of byWorkload) process.stdout.write(`${workload.padEnd(16)} ${bucket.good}/${bucket.n}\n`);
const good = rows.filter(r => ["correct", "correctly_withheld", "answered"].includes(r.verdict)).length;
process.stdout.write(`\nTOTAL ${good}/${rows.length} | mean wall ${Math.round(wall / rows.length)}ms | mean cpu ${(cpu / rows.length).toFixed(2)}s\n`);
writeFileSync("gauntlet-result.json", JSON.stringify({ rows, wall, cpu, good, total: rows.length }, null, 1));
