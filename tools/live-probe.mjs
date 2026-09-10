#!/usr/bin/env node
// Live turn probe against the running server: answer, latency, evidence count, and the costliest kernel stages.
// Usage: node tools/live-probe.mjs "Who is Albert Einstein?" ["What did Ada Lovelace invent?" ...]
//        node tools/live-probe.mjs --file questions.txt   (one question per line)
//        SCCE_SERVER_URL overrides http://127.0.0.1:3873; --session keeps one conversation across questions.
import { readFileSync } from "node:fs";

const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const args = process.argv.slice(2);
const sessionId = args.includes("--session") ? `probe.${Date.now().toString(36)}` : undefined;
const fileIndex = args.indexOf("--file");
const questions = fileIndex >= 0
  ? readFileSync(args[fileIndex + 1], "utf8").split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"))
  : args.filter(arg => !arg.startsWith("--"));
if (!questions.length) {
  console.error("no questions given");
  process.exit(2);
}

const rows = [];
for (const text of questions) {
  const started = Date.now();
  let payload;
  try {
    const response = await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(sessionId ? { sessionId, conversationId: sessionId } : {}) })
    });
    payload = await response.json();
    payload.__status = response.status;
  } catch (error) {
    payload = { __status: 0, error: String(error?.message ?? error) };
  }
  const elapsedMs = Date.now() - started;
  const answer = String(payload.answer ?? payload.error ?? "").replace(/\s+/gu, " ").trim();
  const evidence = Array.isArray(payload.evidence) ? payload.evidence.length : (typeof payload.evidence === "number" ? payload.evidence : 0);
  const stages = stageSummary(payload.traceFile);
  rows.push({ text, status: payload.__status, elapsedMs, evidence, answer, stages });
  console.log(`\n[${payload.__status}] ${elapsedMs}ms evidence=${evidence} :: ${text}`);
  console.log(`  → ${answer.slice(0, 240) || "(empty)"}`);
  if (stages.length) console.log(`  stages: ${stages.map(([stage, ms]) => `${stage}=${ms}ms`).join("  ")}`);
}

const total = rows.reduce((sum, row) => sum + row.elapsedMs, 0);
const answered = rows.filter(row => row.status === 200 && row.answer && row.evidence > 0).length;
console.log(`\n${rows.length} questions, ${answered} answered with evidence, mean ${Math.round(total / rows.length)}ms, max ${Math.max(...rows.map(row => row.elapsedMs))}ms`);

// --json=<path> records the run verbatim, so a report can be generated from what was measured.
const jsonIndex = args.findIndex(arg => arg.startsWith("--json="));
if (jsonIndex >= 0) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const target = args[jsonIndex].slice("--json=".length);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({
    schema: "scce.live_probe.v1",
    generatedAt: new Date().toISOString(),
    serverUrl,
    session: sessionId ?? null,
    questions: rows.length,
    answeredWithEvidence: answered,
    meanMs: Math.round(total / rows.length),
    maxMs: Math.max(...rows.map(row => row.elapsedMs)),
    rows
  }, null, 2)}\n`, "utf8");
  console.log(`wrote ${target}`);
}

function stageSummary(traceFile) {
  if (typeof traceFile !== "string") return [];
  let lines;
  try {
    lines = readFileSync(traceFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  } catch {
    return [];
  }
  const inputs = lines.map((event, index) => [event, index]).filter(([event]) => event.stage === "turn.input");
  const startIndex = inputs.length ? inputs[inputs.length - 1][1] : 0;
  const turn = lines.slice(startIndex).filter(event => !/^api\./u.test(event.stage));
  const gaps = [];
  for (let index = 1; index < turn.length; index++) {
    const gap = Date.parse(turn[index].time) - Date.parse(turn[index - 1].time);
    if (gap >= 250) gaps.push([turn[index].stage, gap]);
  }
  return gaps.sort((left, right) => right[1] - left[1]).slice(0, 6);
}
