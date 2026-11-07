#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Live coding acceptance checks event reachability and independently executes returned JavaScript artifacts against
// held-out behavior. It does not score factual, conversational, or creative capability.
//   node tools/coding-spine-acceptance.mjs [--out=artifacts/coding-spine.json]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const outPath = flag("out", "artifacts/coding-spine.json");
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const TASK = "Implement a JavaScript function uniqueStrings(values) that returns unique strings in first-seen order. Add and run tests.";
const HELD_OUT = `import assert from 'node:assert/strict';
import { uniqueStrings } from ${JSON.stringify("ENTRYPOINT")};
assert.deepEqual(uniqueStrings(['z', 'a', 'z', 'b', 'a']), ['z', 'a', 'b']);
assert.deepEqual(uniqueStrings([]), []);
assert.deepEqual(uniqueStrings(['', 'x', '', 'y', 'x']), ['', 'x', 'y']);
assert.deepEqual(uniqueStrings(['__proto__', 'toString', '__proto__']), ['__proto__', 'toString']);
`;

async function turn(text, metadata = {}) {
  const started = Date.now();
  const response = await fetch(`${serverUrl}/api/turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId: `coding-spine-${Date.now()}`, metadata })
  });
  const body = await response.json();
  const result = body.turn ?? body.result ?? body;
  const events = (result.events ?? []).map(event => ({ typeId: event.typeId, payload: event.payload ?? {} }));
  return { status: response.status, elapsedMs: Date.now() - started, answer: String(result.answer ?? "").slice(0, 400), events,
    taskReplanning: result.taskReplanning ?? null, programArtifacts: result.programArtifacts ?? result.buildTest?.artifacts ?? [], buildTest: result.buildTest ?? null };
}

const count = (events, typeId, predicate = () => true) => events.filter(event => event.typeId === typeId && predicate(event.payload)).length;

function judgeClean(run) {
  const e = run.events;
  const checks = {
    programGraphBuilt: count(e, "ProgramGraphBuilt") >= 1,
    buildExecuted: count(e, "BuildExecuted") >= 1,
    testPassed: count(e, "TestExecuted", p => p.passed === true) >= 1,
    taskCompleted: count(e, "TaskNodeCompleted") >= 1,
    verifiedBuildReceipt: run.buildTest?.passed === true && run.buildTest?.testExecutionReceipt?.status === "executed"
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function judgeRepair(run) {
  const e = run.events;
  const checks = {
    programGraphBuilt: count(e, "ProgramGraphBuilt") >= 1,
    twoBuilds: count(e, "BuildExecuted") >= 2,
    firstTestFailed: count(e, "TestExecuted", p => p.attempt === 0 && p.passed === false) >= 1,
    taskReplanned: count(e, "TaskReplanned") >= 1,
    programRepaired: count(e, "ProgramRepaired") >= 1,
    secondTestPassed: count(e, "TestExecuted", p => p.attempt >= 1 && p.passed === true) >= 1,
    taskCompleted: count(e, "TaskNodeCompleted") >= 1,
    verifiedBuildReceipt: run.buildTest?.passed === true && run.buildTest?.testExecutionReceipt?.status === "executed"
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function artifactChecks(run) {
  const artifacts = run.programArtifacts;
  const checks = { artifactsPresent: Array.isArray(artifacts) && artifacts.length > 0, uniquePaths: true, contentHashes: true, sourcePresent: false, testPresent: false };
  if (!Array.isArray(artifacts)) return { checks: { ...checks, uniquePaths: false, contentHashes: false }, passed: false };
  const seen = new Set();
  for (const artifact of artifacts) {
    const path = artifact?.path;
    if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/u).some(part => part === ".." || part === "")) {
      checks.uniquePaths = false;
      continue;
    }
    const normalized = resolve("artifact-root", path);
    const rel = relative(resolve("artifact-root"), normalized);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || seen.has(path)) checks.uniquePaths = false;
    seen.add(path);
    checks.contentHashes &&= typeof artifact.content === "string"
      && artifact.contentHash === `sha256_${createHash("sha256").update(artifact.content).digest("hex")}`;
    checks.sourcePresent ||= artifact.role === "source";
    checks.testPresent ||= artifact.role === "test";
  }
  return { checks, passed: Object.values(checks).every(Boolean) };
}

async function executeHeldOut(run) {
  const source = run.programArtifacts.find(artifact => artifact.role === "source");
  const root = await mkdtemp(join(tmpdir(), "scce-coding-heldout-"));
  try {
    for (const artifact of run.programArtifacts) {
      const target = resolve(root, artifact.path);
      const rel = relative(root, target);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`artifact path escapes root: ${artifact.path}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, artifact.content, { encoding: "utf8", flag: "wx" });
    }
    const heldoutPath = join(root, "held-out.mjs");
    await writeFile(heldoutPath, HELD_OUT.replace('"ENTRYPOINT"', JSON.stringify(pathToFileURL(resolve(root, source.path)).href)), "utf8");
    const execution = spawnSync(process.execPath, [heldoutPath], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
    return { passed: execution.status === 0, status: execution.status, signal: execution.signal, stderr: execution.stderr.slice(0, 2000), error: execution.error?.message };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const clean = await turn(TASK);
const cleanVerdict = judgeClean(clean);
const cleanArtifacts = artifactChecks(clean);
const cleanHeldOut = cleanArtifacts.passed ? await executeHeldOut(clean) : { passed: false, error: "artifact integrity/path checks failed" };
console.log(`A clean JS application behavior: ${cleanVerdict.passed && cleanArtifacts.passed && cleanHeldOut.passed ? "PASS" : "FAIL"} ${JSON.stringify({ events: cleanVerdict.checks, artifacts: cleanArtifacts.checks, heldOut: cleanHeldOut })} in ${(clean.elapsedMs / 1000).toFixed(1)}s`);

const repair = await turn(TASK, { buildTest: { faultInjection: "unbalanced-brace" } });
const repairVerdict = judgeRepair(repair);
const repairArtifacts = artifactChecks(repair);
const repairHeldOut = repairArtifacts.passed ? await executeHeldOut(repair) : { passed: false, error: "artifact integrity/path checks failed" };
console.log(`B injected-failure repair: ${repairVerdict.passed && repairArtifacts.passed && repairHeldOut.passed ? "PASS" : "FAIL"} ${JSON.stringify({ events: repairVerdict.checks, artifacts: repairArtifacts.checks, heldOut: repairHeldOut })} in ${(repair.elapsedMs / 1000).toFixed(1)}s`);

await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(dirname(outPath), { recursive: true }).then(() => writeFile(outPath, JSON.stringify({
  schema: "scce.coding_spine_acceptance.v2", generatedAt: new Date().toISOString(), task: TASK,
  scope: { language: "javascript", lanes: ["programming", "debugging"], excluded: ["chat", "creative", "factual", "proof"] },
  clean: { ...clean, eventVerdict: cleanVerdict, artifactVerdict: cleanArtifacts, heldOut: cleanHeldOut },
  repair: { ...repair, fault: "unbalanced-brace", eventVerdict: repairVerdict, artifactVerdict: repairArtifacts, heldOut: repairHeldOut }
}, null, 2) + "\n", "utf8")));
console.log(`wrote ${outPath}`);
process.exit(clean.status === 200 && repair.status === 200 && cleanVerdict.passed && repairVerdict.passed
  && cleanArtifacts.passed && repairArtifacts.passed && cleanHeldOut.passed && repairHeldOut.passed ? 0 : 1);
