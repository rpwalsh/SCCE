#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The relation-question probe the evaluation site reports verbatim: seven capitals against the running server,
// answers recorded as spoken. Verdicts are NOT decided here -- a substring test scores "capital of the Viceroyalty
// of Peru" as correct -- they are read from the answer text by a person and held in the site generator.
//
//   node tools/capitals-probe.mjs [--out=artifacts/parity-dataset/capitals.json]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const outPath = flag("out", "artifacts/parity-dataset/capitals.json");
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const QUESTIONS = [
  "What is the capital of Japan?",
  "What is the capital of Kenya?",
  "What is the capital of Peru?",
  "What is the capital of Albania?",
  "What is the capital of Alabama?",
  "What is the capital of Azerbaijan?",
  "What is the capital of Armenia?"
];

const rows = [];
for (const text of QUESTIONS) {
  const started = Date.now();
  let answer = "";
  let evidence = 0;
  try {
    const response = await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId: `capitals-${Date.now()}` })
    });
    const body = await response.json();
    const result = body.turn ?? body.result ?? body;
    answer = String(result.answer ?? "");
    evidence = (result.evidence ?? []).length;
  } catch (error) {
    answer = "";
    console.error(`  ${text}: ${String(error?.message ?? error)}`);
  }
  const elapsedMs = Date.now() - started;
  rows.push({ text, answer, elapsedMs, evidence });
  console.log(`${(elapsedMs / 1000).toFixed(1)}s  ${text}\n      ${answer.replace(/\s+/gu, " ").slice(0, 200)}`);
}

const times = rows.map(row => row.elapsedMs);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  schema: "scce.capitals_probe.v1",
  generatedAt: new Date().toISOString(),
  questions: rows.length,
  meanMs: Math.round(times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length)),
  maxMs: Math.max(...times),
  rows
}, null, 2) + "\n", "utf8");
console.log(`\nwrote ${outPath}`);
