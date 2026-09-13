#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The two live acceptance chains for the coding spine, read from the turn's own event ledger, never from its prose:
//   A. clean implementation: ProgramGraphBuilt -> BuildExecuted -> TestExecuted(passed) -> TaskNodeCompleted
//   B. declared first-attempt defect: BuildExecuted x2, TestExecuted(failed) then TestExecuted(passed),
//      TaskReplanned, ProgramRepaired, TaskNodeCompleted -- the repair loop, not just a flag.
//
//   node tools/coding-spine-acceptance.mjs [--out=artifacts/coding-spine.json]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const outPath = flag("out", "artifacts/coding-spine.json");
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const REQUEST = "Implement a TypeScript function uniqueStrings(values: string[]): string[] that returns the unique strings from an array in first-seen order, add tests, and validate it.";

async function turn(text, metadata) {
  const started = Date.now();
  const response = await fetch(`${serverUrl}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId: `coding-spine-${Date.now()}`, metadata })
  });
  const body = await response.json();
  const result = body.turn ?? body.result ?? body;
  const events = (result.events ?? []).map(event => ({ typeId: event.typeId, payload: event.payload ?? {} }));
  return { status: response.status, elapsedMs: Date.now() - started, answer: String(result.answer ?? "").slice(0, 400), events, taskReplanning: result.taskReplanning ?? null };
}

const count = (events, typeId, predicate = () => true) => events.filter(event => event.typeId === typeId && predicate(event.payload)).length;

function judgeA(run) {
  const e = run.events;
  const checks = {
    programGraphBuilt: count(e, "ProgramGraphBuilt") >= 1,
    buildExecuted: count(e, "BuildExecuted") >= 1,
    testPassed: count(e, "TestExecuted", p => p.passed === true) >= 1,
    taskCompleted: count(e, "TaskNodeCompleted") >= 1
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function judgeB(run) {
  const e = run.events;
  const checks = {
    programGraphBuilt: count(e, "ProgramGraphBuilt") >= 1,
    twoBuilds: count(e, "BuildExecuted") >= 2,
    firstTestFailed: count(e, "TestExecuted", p => p.attempt === 0 && p.passed === false) >= 1,
    taskReplanned: count(e, "TaskReplanned") >= 1,
    programRepaired: count(e, "ProgramRepaired") >= 1,
    secondTestPassed: count(e, "TestExecuted", p => p.attempt >= 1 && p.passed === true) >= 1,
    taskCompleted: count(e, "TaskNodeCompleted") >= 1
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

// Builds and tests execute only under the session's temporary operator grant (policy dryRunByDefault otherwise);
// granted for the two turns and withdrawn after, so the server is left as it was found.
async function operatorGrant(enabled) {
  const response = await fetch(`${serverUrl}/api/session/operator-grant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
  if (!response.ok) throw new Error(`operator grant ${enabled}: HTTP ${response.status}`);
}
await operatorGrant(true);
const a = await turn(REQUEST, {});
const verdictA = judgeA(a);
console.log(`A clean: ${verdictA.passed ? "PASS" : "FAIL"} ${JSON.stringify(verdictA.checks)} in ${(a.elapsedMs / 1000).toFixed(1)}s`);
console.log(`  events: ${a.events.map(event => event.typeId).filter(id => /Program|Build|Test|Task|Capability|Repair/.test(id)).join(", ")}`);

const b = await turn(REQUEST, { buildTest: { faultInjection: "unbalanced-brace" } });
const verdictB = judgeB(b);
console.log(`B repair: ${verdictB.passed ? "PASS" : "FAIL"} ${JSON.stringify(verdictB.checks)} in ${(b.elapsedMs / 1000).toFixed(1)}s`);
console.log(`  events: ${b.events.map(event => event.typeId).filter(id => /Program|Build|Test|Task|Capability|Repair/.test(id)).join(", ")}`);

await operatorGrant(false);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  schema: "scce.coding_spine_acceptance.v1",
  generatedAt: new Date().toISOString(),
  request: REQUEST,
  a: { ...a, verdict: verdictA },
  b: { ...b, fault: "unbalanced-brace", verdict: verdictB }
}, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
process.exit(verdictA.passed && verdictB.passed ? 0 : 1);
