#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Warm CPU seconds per turn, comparable to the frozen baseline's `mean cpu`. One process-CPU snapshot before the batch
// and one after: the per-question meter spawned PowerShell four times per turn and stalled the whole run.
//
//   node tools/cpu-now.mjs                          # default four questions
//   node tools/cpu-now.mjs "q1" "q2" --warm=2
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const url = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const flag = (name, fallback) => {
  const found = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const warm = flag("warm", 2);
const spoken = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const questions = spoken.length ? spoken : [
  "Who was Ada Lovelace?",
  "When did Apollo 11 land on the Moon?",
  "What is the capital of Albania?",
  "When was Ada Lovelace born?"
];

/** CPU seconds of the server process and of every postgres process, read once from the OS. */
function cpuSnapshot() {
  const script = [
    "$s = (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server/dist/index.js*' } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).TotalProcessorTime.TotalSeconds",
    "$p = (Get-Process postgres -ErrorAction SilentlyContinue | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum",
    "Write-Output \"$s $p\""
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const [server, postgres] = String(result.stdout ?? "").trim().split(/\s+/u).map(Number);
  return { server: Number.isFinite(server) ? server : 0, postgres: Number.isFinite(postgres) ? postgres : 0 };
}

async function ask(text) {
  const id = `m${Math.random().toString(36).slice(2, 9)}`;
  const started = Date.now();
  const response = await fetch(`${url}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId: id, conversationId: id })
  });
  const body = await response.json().catch(() => ({}));
  const result = body.turn ?? body.result ?? body;
  return { ms: Date.now() - started, status: response.status, answer: String(result.answer ?? body.error ?? "").replace(/\s+/gu, " ").slice(0, 64) };
}

for (let index = 0; index < warm; index++) await ask("warm");

const before = cpuSnapshot();
const wallStart = Date.now();
const rows = [];
for (const question of questions) rows.push({ question, ...(await ask(question)) });
const wall = Date.now() - wallStart;
const after = cpuSnapshot();

const server = after.server - before.server;
const postgres = after.postgres - before.postgres;
const n = rows.length;
for (const row of rows) process.stdout.write(`${row.status} ${String(row.ms).padStart(6)}ms  ${row.answer}\n`);
process.stdout.write(`\n${n} turns: server cpu ${server.toFixed(2)}s  postgres cpu ${postgres.toFixed(2)}s`
  + `  => MEAN ${((server + postgres) / n).toFixed(2)}s/turn   wall ${Math.round(wall / n)}ms/turn\n`);
process.stdout.write("frozen baseline mean cpu 23.22s | qwen2.5:3b 0.40s\n");
writeFileSync("cpu-now.json", JSON.stringify({ rows, server, postgres, meanCpu: (server + postgres) / n, meanWallMs: wall / n }, null, 1));
