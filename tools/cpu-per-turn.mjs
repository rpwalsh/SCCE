#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// CPU seconds a warm turn actually costs, split by the processes that spend it. Uses the head-to-head cost meter so
// the number is comparable to the frozen baseline's `mean cpu`. The meter runs outside the timed window.
//
//   node tools/cpu-per-turn.mjs                       # default probe set
//   node tools/cpu-per-turn.mjs "question one" "two"  # your own
//   node tools/cpu-per-turn.mjs --warm=2 --repeat=2
import { processCpuSeconds } from "./head-to-head/cost-meter.mjs";

const flag = (name, fallback) => {
  const found = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return found ? Number(found.slice(`--${name}=`.length)) : fallback;
};
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const warmTurns = flag("warm", 2);
const repeat = flag("repeat", 1);
const spoken = process.argv.slice(2).filter(arg => !arg.startsWith("--"));

const DEFAULT = [
  "What is the capital of Albania?",
  "Who was Ada Lovelace?",
  "When was Ada Lovelace born?",
  "What did Einstein discover?",
  "When did Apollo 11 land on the Moon?"
];
const questions = spoken.length ? spoken : DEFAULT;

// The server and Postgres both spend CPU on a turn; charging only one of them understates the cost.
const SERVER = { commandLineIncludes: ["server/dist/index.js"] };
const POSTGRES = { names: ["postgres.exe"] };

async function turn(text) {
  const sessionId = `cpu-${Math.random().toString(36).slice(2, 10)}`;
  const started = Date.now();
  const response = await fetch(`${serverUrl}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId, conversationId: sessionId })
  }).catch(error => ({ status: 0, json: async () => ({ error: String(error?.message ?? error) }) }));
  const body = await response.json().catch(() => ({}));
  const result = body.turn ?? body.result ?? body;
  return {
    status: response.status,
    ms: Date.now() - started,
    answered: typeof result.answer === "string" && result.answer.trim().length > 0,
    chars: String(result.answer ?? "").trim().length
  };
}

for (let index = 0; index < warmTurns; index++) await turn("warm");

const rows = [];
for (let pass = 0; pass < repeat; pass++) {
  for (const question of questions) {
    const serverBefore = processCpuSeconds(SERVER).seconds;
    const pgBefore = processCpuSeconds(POSTGRES).seconds;
    const outcome = await turn(question);
    const serverAfter = processCpuSeconds(SERVER).seconds;
    const pgAfter = processCpuSeconds(POSTGRES).seconds;
    rows.push({
      question,
      status: outcome.status,
      answered: outcome.answered,
      chars: outcome.chars,
      ms: outcome.ms,
      serverCpu: Number((serverAfter - serverBefore).toFixed(3)),
      postgresCpu: Number((pgAfter - pgBefore).toFixed(3))
    });
  }
}

const finite = value => Number.isFinite(value) ? value : 0;
const mean = list => list.length ? list.reduce((sum, value) => sum + finite(value), 0) / list.length : 0;
const totalCpu = rows.map(row => finite(row.serverCpu) + finite(row.postgresCpu));

for (const row of rows) {
  const total = finite(row.serverCpu) + finite(row.postgresCpu);
  console.log(
    `${String(row.status).padEnd(4)} ${String(row.ms).padStart(6)}ms  cpu ${total.toFixed(2)}s`
    + ` (server ${finite(row.serverCpu).toFixed(2)} + pg ${finite(row.postgresCpu).toFixed(2)})`
    + `  ${row.answered ? `${row.chars}ch` : "withheld"}  ${row.question}`
  );
}

console.log("");
console.log(`turns ${rows.length} | mean wall ${Math.round(mean(rows.map(row => row.ms)))}ms`
  + ` | mean cpu ${mean(totalCpu).toFixed(2)}s`
  + ` (server ${mean(rows.map(row => row.serverCpu)).toFixed(2)} + pg ${mean(rows.map(row => row.postgresCpu)).toFixed(2)})`);
console.log(`frozen baseline for comparison: mean cpu 23.22s | qwen2.5:3b mean cpu 0.40s`);
