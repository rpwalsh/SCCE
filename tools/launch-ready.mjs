#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { exactHydrationSummary } from "./launch-ready-contract.mjs";

const root = process.cwd();
const serverUrl = argValue("--server-url") ?? process.env.SCCE_LIVE_SERVER_URL ?? "http://127.0.0.1:3873";
const json = process.argv.includes("--json");
const skipBuild = process.argv.includes("--skip-build");
const skipHygiene = process.argv.includes("--skip-hygiene");
const skipArchive = process.argv.includes("--skip-archive");
const archivePath = argValue("--archive") ?? defaultArchivePath();
const failures = [];
const steps = [];
if (!skipBuild) await runStep("build", pnpmCommand(), ["build"]);
if (!skipHygiene) await runStep("language-control", pnpmCommand(), ["hygiene:language-control"]);

const ready = await fetchJson(`${serverUrl}/api/ready`, "ready");
if (!ready.ok) failures.push(`ready endpoint failed: ${boundedFailureDetail(ready)}`);
const hydration = exactHydrationSummary(ready.value);
for (const failure of hydration.failures) failures.push(failure);

const stats = await fetchJson(`${serverUrl}/api/db/stats`, "db-stats");
if (!stats.ok) failures.push(`db stats endpoint failed: ${boundedFailureDetail(stats)}`);

const releaseGate = await runStep("live-release-gate", nodeCommand(), ["tools/release-gate.mjs", "--json"], {
  env: { ...process.env, SCCE_LIVE_SERVER_URL: serverUrl }
});
const releaseSummary = parseReleaseGate(releaseGate.stdout);
if (!releaseSummary?.ok) failures.push(`live release gate failed: ${releaseGate.stdout.slice(0, 1200)}${releaseGate.stderr.slice(0, 800)}`);

const archive = skipArchive ? { skipped: true } : await checkArchive(archivePath);

const summary = {
  schema: "scce.launch_ready.v1",
  ok: failures.length === 0,
  serverUrl,
  steps: steps.map(step => ({
    id: step.id,
    ok: step.ok,
    exitCode: step.exitCode,
    durationMs: step.durationMs
  })),
  ready: ready.value ?? { ok: false, error: String(ready.error) },
  hydration,
  databaseStats: stats.value ?? { ok: false, error: String(stats.error) },
  releaseGate: releaseSummary,
  archive,
  failures
};

if (json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write(`LAUNCH_READY ${summary.ok ? "PASS" : "FAIL"} server=${serverUrl}\n`);
  for (const step of summary.steps) process.stdout.write(`${step.ok ? "PASS" : "FAIL"} ${step.id} ${step.durationMs}ms\n`);
  process.stdout.write(`${summary.ready?.ok ? "PASS" : "FAIL"} ready\n`);
  process.stdout.write(`${summary.hydration?.ok ? "PASS" : "FAIL"} hydration ${JSON.stringify(summary.hydration?.rows ?? {})}\n`);
  if (summary.releaseGate) process.stdout.write(`${summary.releaseGate.ok ? "PASS" : "FAIL"} live-release-gate prompts=${summary.releaseGate.promptCasesConfigured}\n`);
  if (summary.archive?.skipped) process.stdout.write("SKIP archive\n");
  else process.stdout.write(`${summary.archive?.ok ? "PASS" : "FAIL"} archive ${summary.archive?.path ?? archivePath}\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
}

process.exitCode = summary.ok ? 0 : 1;

async function runStep(id, command, args, options = {}) {
  const started = Date.now();
  const result = await run(command, args, options);
  const step = { id, ...result, durationMs: Date.now() - started };
  steps.push(step);
  if (!step.ok) failures.push(`${id} failed with exit ${step.exitCode}: ${step.stderr.slice(0, 900)}${step.stdout.slice(0, 900)}`);
  return step;
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: root,
      env: cleanEnv(options.env ?? process.env),
      shell: options.shell ?? shellFor(command),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", code => resolve({ ok: code === 0, exitCode: code, stdout, stderr }));
  });
}

async function fetchJson(url, id) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    steps.push({ id, ok: response.ok, exitCode: response.ok ? 0 : response.status, stdout: text, stderr: "", durationMs: Date.now() - started });
    return { ok: response.ok && value?.ok !== false, value };
  } catch (error) {
    steps.push({ id, ok: false, exitCode: null, stdout: "", stderr: String(error), durationMs: Date.now() - started });
    return { ok: false, error };
  }
}

function parseReleaseGate(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
    }
  }
  return undefined;
}

function boundedFailureDetail(result) {
  if (result.error !== undefined) return String(result.error).slice(0, 500);
  const serialized = JSON.stringify(result.value);
  return (serialized === undefined ? "undefined response" : serialized).slice(0, 500);
}

async function checkArchive(candidate) {
  if (!candidate) return { ok: false, path: "", error: "no archive path available" };
  const archive = path.resolve(root, candidate);
  if (!existsSync(archive)) return { ok: false, path: archive, error: "archive not found" };
  const info = await stat(archive);
  const list = await run(tarCommand(), ["-tf", archive]);
  const entries = list.stdout.split(/\r?\n/u).filter(Boolean);
  const distEntries = entries.filter(entry => /(^|\/)dist(\/|$)/u.test(entry));
  const nodeModulesEntries = entries.filter(entry => /(^|\/)node_modules(\/|$)/u.test(entry));
  const ok = list.ok && info.size > 0 && distEntries.length === 0 && nodeModulesEntries.length === 0;
  if (!ok) failures.push(`archive sanity failed for ${archive}`);
  return {
    ok,
    path: archive,
    bytes: info.size,
    entries: entries.length,
    distEntries: distEntries.slice(0, 10),
    nodeModulesEntries: nodeModulesEntries.slice(0, 10)
  };
}

function defaultArchivePath() {
  const short = runSyncText("git", ["rev-parse", "--short", "HEAD"]).trim();
  return short ? path.join("..", `yopp-source-${short}.zip`) : undefined;
}

function runSyncText(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  } catch {
    return "";
  }
}

function pnpmCommand() {
  return "pnpm";
}

function nodeCommand() {
  return process.execPath;
}

function tarCommand() {
  return process.platform === "win32" ? "tar.exe" : "tar";
}

function shellFor(command) {
  return process.platform === "win32" && command === "pnpm";
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function cleanEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}
