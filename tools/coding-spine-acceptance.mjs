#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Live coding acceptance checks event reachability and independently executes returned JavaScript and TypeScript
// artifacts against held-out behavior. It does not score factual, conversational, or creative capability.
//   node tools/coding-spine-acceptance.mjs [--config=scce.config.json] [--out=artifacts/coding-spine.json]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const outPath = flag("out", "artifacts/coding-spine.json");
const HELD_OUT = `import assert from 'node:assert/strict';
import { uniqueStrings } from ${JSON.stringify("ENTRYPOINT")};
assert.deepEqual(uniqueStrings(['z', 'a', 'z', 'b', 'a']), ['z', 'a', 'b']);
assert.deepEqual(uniqueStrings([]), []);
assert.deepEqual(uniqueStrings(['', 'x', '', 'y', 'x']), ['', 'x', 'y']);
assert.deepEqual(uniqueStrings(['__proto__', 'toString', '__proto__']), ['__proto__', 'toString']);
`;

async function turn(text, metadata = {}, liveConfig) {
  const started = Date.now();
  const response = await fetch(`${liveConfig.serverUrl}/api/turn`, {
    method: "POST", headers: { "content-type": "application/json", ...(liveConfig.token ? { authorization: `Bearer ${liveConfig.token}` } : {}) },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ text, sessionId: `coding-spine-${Date.now()}`, metadata })
  });
  const responseText = await response.text();
  let body;
  try { body = JSON.parse(responseText); } catch { body = undefined; }
  const result = body?.turn ?? body?.result ?? body ?? {};
  const events = (result.events ?? []).map(event => ({ typeId: event.typeId, payload: event.payload ?? {} }));
  return { status: response.status, elapsedMs: Date.now() - started, answer: String(result.answer ?? "").slice(0, 400), events,
    taskReplanning: result.taskReplanning ?? null, programReadiness: result.programReadiness ?? null,
    programArtifacts: result.programArtifacts ?? result.buildTest?.artifacts ?? [], buildTest: result.buildTest ?? null,
    ...(response.ok ? {} : { httpFailure: httpFailureDetail(body, responseText, response.status) }) };
}

export function httpFailureDetail(body, fallbackText = "", status) {
  const error = body && typeof body === "object" && !Array.isArray(body) ? body.error : undefined;
  const candidates = [
    ["status", Number.isInteger(body?.status) ? body.status : status],
    ["code", body?.code ?? error?.code],
    ["error", typeof error === "string" ? error : error?.name],
    ["message", body?.message ?? error?.message],
    ["detail", body?.detail ?? body?.reason ?? error?.detail ?? error?.reason]
  ];
  const fields = Object.fromEntries(candidates.filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => [key, value.trim().slice(0, 1000)]));
  if (Number.isInteger(candidates[0][1])) fields.status = candidates[0][1];
  const detail = body?.detail && typeof body.detail === "object" && !Array.isArray(body.detail) ? body.detail : undefined;
  const detailFields = Object.fromEntries(["schema", "status", "reasonId", "languageId"]
    .filter(key => typeof detail?.[key] === "string").map(key => [key, detail[key].slice(0, 200)]));
  if (Object.keys(detailFields).length) fields.detail = detailFields;
  if (Object.keys(fields).some(key => key !== "status")) return fields;
  if (fallbackText.trim()) return { ...fields, bodyText: fallbackText.trim().slice(0, 1000) };
  if (Object.keys(fields).length) return fields;
  return { bodyText: "" };
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

export function artifactChecks(run, language = "javascript") {
  const artifacts = run.programArtifacts;
  const checks = { artifactsPresent: Array.isArray(artifacts) && artifacts.length > 0, uniquePaths: true, contentHashes: true,
    sourcePresent: false, testPresent: false, sourceUnambiguous: false, languageMatches: false, readinessVerified: run.programReadiness?.status === "ready" };
  if (!Array.isArray(artifacts)) return { checks: { ...checks, uniquePaths: false, contentHashes: false }, passed: false };
  const seen = new Set();
  const sources = [];
  for (const artifact of artifacts) {
    const path = artifact?.path;
    if (typeof path !== "string" || !path || isAbsolute(path) || path.startsWith("//") || path.startsWith("\\\\")
      || /^[a-z]:/iu.test(path) || path.split(/[\\/]/u).some(part => part === ".." || part === "")) {
      checks.uniquePaths = false;
      continue;
    }
    const normalized = resolve("artifact-root", path);
    const rel = relative(resolve("artifact-root"), normalized);
    const canonical = path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/").toLocaleLowerCase("en-US");
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || seen.has(canonical)
      || canonical === "__scce_acceptance_held_out__.mjs") checks.uniquePaths = false;
    seen.add(canonical);
    checks.contentHashes &&= typeof artifact.content === "string"
      && artifact.contentHash === `sha256_${createHash("sha256").update(artifact.content).digest("hex")}`;
    if (artifact.role === "source") sources.push(artifact);
    checks.testPresent ||= artifact.role === "test";
  }
  checks.sourcePresent = sources.length > 0;
  checks.sourceUnambiguous = sources.length === 1;
  const sourcePath = sources[0]?.path ?? "";
  checks.languageMatches = language === "typescript" ? /\.ts$/iu.test(sourcePath) : /\.(?:mjs|js)$/iu.test(sourcePath);
  return { checks, passed: Object.values(checks).every(Boolean) };
}

export function isSafeHeldOutRoot(root, base = tmpdir()) {
  const resolvedBase = resolve(base);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedBase, resolvedRoot);
  return Boolean(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    && !rel.includes(sep) && rel.startsWith("scce-coding-heldout-"));
}

export async function executeHeldOut(run, language = "javascript") {
  const integrity = artifactChecks(run, language);
  if (!integrity.passed) return { passed: false, error: "artifact integrity/path checks failed", checks: integrity.checks };
  const source = run.programArtifacts.find(artifact => artifact.role === "source");
  const root = await mkdtemp(join(tmpdir(), "scce-coding-heldout-"));
  if (!isSafeHeldOutRoot(root)) throw new Error("held-out temporary directory is outside the expected temp root");
  try {
    for (const artifact of run.programArtifacts) {
      const target = resolve(root, ...artifact.path.split(/[\\/]/u));
      const rel = relative(root, target);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`artifact path escapes root: ${artifact.path}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, artifact.content, { encoding: "utf8", flag: "wx" });
    }
    const heldoutPath = join(root, "__scce_acceptance_held_out__.mjs");
    await writeFile(heldoutPath, HELD_OUT.replace('"ENTRYPOINT"', JSON.stringify(pathToFileURL(resolve(root, ...source.path.split(/[\\/]/u))).href)), "utf8");
    const execution = spawnSync(process.execPath, ["--max-old-space-size=128", heldoutPath], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
    return { passed: execution.status === 0, status: execution.status, signal: execution.signal, stderr: execution.stderr.slice(0, 2000), error: execution.error?.message };
  } finally {
    if (isSafeHeldOutRoot(root)) await rm(root, { recursive: true, force: true });
  }
}

async function liveConfig() {
  const adapters = await import("../packages/adapters-node/dist/index.js");
  const config = await adapters.readScceRuntimeConfig(flag("config", process.env.SCCE_CONFIG ?? "scce.config.json"));
  const configuredToken = config.security?.apiBearerToken;
  const token = process.env.SCCE_API_BEARER_TOKEN?.trim() || (configuredToken?.startsWith("enc:v1:")
    ? adapters.resolveSecret(configuredToken, config, "SCCE API bearer token") : configuredToken);
  return { serverUrl: process.env.SCCE_SERVER_URL ?? config.server.url, token };
}

export async function runAcceptance(outputPath = outPath) {
  const config = await liveConfig();
  const scenarios = [
    { id: "javascript.clean", language: "javascript", request: "Implement a JavaScript function uniqueStrings(values) that returns unique strings in first-seen order. Add and run tests.", fault: undefined },
    { id: "typescript.clean", language: "typescript", request: "Implement a TypeScript function uniqueStrings(values: string[]): string[] that returns unique strings in first-seen order. Add and run tests.", fault: undefined },
    { id: "typescript.repair", language: "typescript", request: "Implement a TypeScript function uniqueStrings(values: string[]): string[] that returns unique strings in first-seen order. Add and run tests.", fault: "unbalanced-brace" }
  ];
  const results = [];
  for (const scenario of scenarios) {
    const run = await turn(scenario.request, scenario.fault ? { buildTest: { faultInjection: scenario.fault } } : {}, config);
    const eventVerdict = scenario.fault ? judgeRepair(run) : judgeClean(run);
    const artifacts = artifactChecks(run, scenario.language);
    const heldOut = await executeHeldOut(run, scenario.language);
    const passed = run.status === 200 && eventVerdict.passed && artifacts.passed && heldOut.passed;
    results.push({ ...scenario, run, eventVerdict, artifactVerdict: artifacts, heldOut, passed });
    console.log(`${scenario.id}: ${passed ? "PASS" : "FAIL"} ${JSON.stringify({ httpFailure: run.httpFailure, events: eventVerdict.checks, artifacts: artifacts.checks, heldOut })} in ${(run.elapsedMs / 1000).toFixed(1)}s`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({
    schema: "scce.coding_spine_acceptance.v4", generatedAt: new Date().toISOString(),
    scope: { languages: ["javascript", "typescript"], lanes: ["programming", "debugging"], excluded: ["chat", "creative", "factual", "proof"] },
    scenarios: results.map(({ run, ...scenario }) => ({ ...scenario, run }))
  }, null, 2) + "\n", "utf8");
  console.log(`wrote ${outputPath}`);
  return results.every(result => result.passed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAcceptance().then(passed => process.exit(passed ? 0 : 1)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
