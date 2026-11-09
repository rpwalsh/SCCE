#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Strict application acceptance runner. The server receives only each natural-language spec;
// held-out tests are copied into the isolated output after SCCE has returned its artifacts.
// Missing cases, artifacts, toolchains, builds, or independent tests are failures, never skips.
// Usage: node tools/application-acceptance.mjs <plan.json> [--out=artifacts/application-acceptance.json]

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { campaignOptions } from "./blind-comparison/campaign.mjs";
import { canonical } from "./blind-comparison/protocol.mjs";
import { scrubEnvironment } from "./blind-comparison/runner.mjs";
import { nativeProgramApprovalAllowed } from "./blind-comparison/adapters/native-program-approval.mjs";

export const ACCEPTANCE_BUDGETS = Object.freeze(campaignOptions().budgets);

export const PLAN_SCHEMA = "scce.application_acceptance_plan.v1";
export const REQUIRED_CATEGORIES = Object.freeze([
  "typescript_web_crud",
  "python_service_cli",
  "kotlin_android_phonebook",
  "semantic_debug_repair"
]);
export const CATEGORY_LANGUAGES = Object.freeze({
  typescript_web_crud: "typescript",
  python_service_cli: "python",
  kotlin_android_phonebook: "kotlin"
});

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const asRecord = value => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;

export function validatePlan(plan) {
  const errors = [];
  if (plan?.schema !== PLAN_SCHEMA) errors.push(`schema must be ${PLAN_SCHEMA}`);
  if (!Array.isArray(plan?.cases) || plan.cases.length < REQUIRED_CATEGORIES.length) {
    errors.push(`cases must contain at least ${REQUIRED_CATEGORIES.length} entries`);
    return errors;
  }
  const ids = new Set();
  const categories = new Set();
  for (const [index, testCase] of plan.cases.entries()) {
    const label = `cases[${index}]`;
    if (!asRecord(testCase)) { errors.push(`${label} must be an object`); continue; }
    if (typeof testCase.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(testCase.id)) errors.push(`${label}.id is invalid`);
    else if (ids.has(testCase.id)) errors.push(`${label}.id duplicates ${testCase.id}`);
    else ids.add(testCase.id);
    if (typeof testCase.category !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(testCase.category)) errors.push(`${label}.category is invalid: ${String(testCase.category)}`);
    else categories.add(testCase.category);
    if (typeof testCase.spec !== "string" || !testCase.spec.trim()) errors.push(`${label}.spec must be nonempty text`);
    if (typeof testCase.expectedLanguage !== "string" || !testCase.expectedLanguage.trim()) errors.push(`${label}.expectedLanguage is required`);
    else if (CATEGORY_LANGUAGES[testCase.category] && testCase.expectedLanguage !== CATEGORY_LANGUAGES[testCase.category]) errors.push(`${label}.expectedLanguage must be ${CATEGORY_LANGUAGES[testCase.category]} for ${testCase.category}`);
    if (testCase.coverageBlocker !== undefined) {
      const blocker = testCase.coverageBlocker;
      if (!asRecord(blocker) || blocker.schema !== 'scce.application_coverage_blocker.v1' || blocker.languageId !== testCase.expectedLanguage
        || typeof blocker.reasonId !== 'string' || !blocker.reasonId.trim() || typeof blocker.detail !== 'string' || !blocker.detail.trim()) errors.push(`${label}.coverageBlocker requires exact language and explicit unavailable reason`);
      if (testCase.publicValidation !== undefined || testCase.heldOut !== undefined) errors.push(`${label}.blocked cells cannot fabricate validation permissions or private checks`);
      continue;
    }
    if (testCase.publicValidation === undefined) errors.push(`${label}.publicValidation is required`);
    else {
      const value = testCase.publicValidation;
      if (!asRecord(value) || !asRecord(value.permission) || !asRecord(value.toolInventory)
        || value.sha256 !== digest(canonical({ permission: value.permission, toolInventory: value.toolInventory }))
        || value.toolInventory.language !== testCase.expectedLanguage || value.permission.provider?.languageId !== testCase.expectedLanguage) errors.push(`${label}.publicValidation must pin the exact owner-published native permission and tool inventory`);
    }
    if (!Array.isArray(testCase.requiredGeneratedPaths) || testCase.requiredGeneratedPaths.length === 0) errors.push(`${label}.requiredGeneratedPaths must be nonempty`);
    else {
      if (new Set(testCase.requiredGeneratedPaths).size !== testCase.requiredGeneratedPaths.length) errors.push(`${label}.requiredGeneratedPaths contains duplicates`);
      for (const filePath of testCase.requiredGeneratedPaths) if (!safeRelativePath(filePath)) errors.push(`${label} has unsafe generated path ${String(filePath)}`);
    }
    if (!asRecord(testCase.heldOut) || !Array.isArray(testCase.heldOut.files) || testCase.heldOut.files.length === 0) {
      errors.push(`${label}.heldOut.files must name independent test files`);
    } else {
      const testTargets = new Set();
      const testKinds = new Set();
      for (const [fileIndex, file] of testCase.heldOut.files.entries()) {
        if (!asRecord(file) || !safeRelativePath(file.sourcePath) || !safeRelativePath(file.targetPath)) errors.push(`${label}.heldOut.files[${fileIndex}] has invalid sourcePath/targetPath`);
        else if (testTargets.has(file.targetPath.toLowerCase())) errors.push(`${label}.heldOut.files has duplicate targetPath ${file.targetPath}`);
        else testTargets.add(file.targetPath.toLowerCase());
        const target = typeof file?.targetPath === "string" ? file.targetPath.replace(/\\/gu, '/').toLowerCase() : '';
        if (target === "generated" || target.startsWith("generated/")) errors.push(`${label}.heldOut target cannot overwrite generated artifacts`);
        if (target === ".acceptance-result.json") errors.push(`${label}.heldOut cannot overwrite the runner result receipt`);
        if (file?.kind !== "unit" && file?.kind !== "e2e") errors.push(`${label}.heldOut.files[${fileIndex}].kind must be unit or e2e`);
        else testKinds.add(file.kind);
        if (typeof file?.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) errors.push(`${label}.heldOut.files[${fileIndex}].sha256 must be a lowercase SHA-256`);
      }
      for (const kind of ["unit", "e2e"]) if (!testKinds.has(kind)) errors.push(`${label}.heldOut.files must include an independent ${kind} test`);
      const command = testCase.heldOut.command;
      if (typeof command !== "string" || !command.trim()) errors.push(`${label}.heldOut.command is required`);
      if (!Array.isArray(testCase.heldOut.args) || testCase.heldOut.args.some(arg => typeof arg !== "string")) errors.push(`${label}.heldOut.args must be a string array`);
      if (testCase.heldOut.cwd !== undefined && !safeRelativePath(testCase.heldOut.cwd, true)) errors.push(`${label}.heldOut.cwd must stay inside the generated workspace`);
      if (testCase.heldOut.env !== undefined && (!asRecord(testCase.heldOut.env) || Object.values(testCase.heldOut.env).some(value => typeof value !== "string"))) errors.push(`${label}.heldOut.env must map names to strings`);
    }
  }
  for (const category of REQUIRED_CATEGORIES) if (!categories.has(category)) errors.push(`required category is missing: ${category}`);
  return errors;
}

function safeRelativePath(value, allowDot = false) {
  if (typeof value !== "string" || !value || /[\0:]/u.test(value) || path.isAbsolute(value)) return allowDot && value === ".";
  if (allowDot && value === ".") return true;
  if (value.split(/[\\/]/u).some(segment => segment === "" || segment === "." || segment === "..")) return false;
  const normalized = path.normalize(value);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function inside(root, child) {
  const relative = path.relative(root, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function runCommand(command, args, cwd, env, timeoutMs, outputBytes) {
  const startedAt = Date.now();
  return await new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let totalBytes = 0, outputExceeded = false;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const appendBounded = (current, part, markTruncated) => {
      const bytes = Buffer.from(part, "utf8");
      const room = Math.max(0, outputBytes - totalBytes);
      totalBytes += bytes.length;
      if (bytes.length <= room) return current + part;
      outputExceeded = true;
      child.kill("SIGKILL");
      markTruncated();
      return current;
    };
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", part => { stdout = appendBounded(stdout, part, () => { stdoutTruncated = true; }); });
    child.stderr.setEncoding("utf8").on("data", part => { stderr = appendBounded(stderr, part, () => { stderrTruncated = true; }); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); resolve({ command, args, code: null, signal: null, timedOut, outputExceeded, durationMs: Date.now() - startedAt, stdout, stderr, stdoutTruncated, stderrTruncated, error: error.message }); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ command, args, code, signal, timedOut, outputExceeded, durationMs: Date.now() - startedAt, stdout, stderr, stdoutTruncated, stderrTruncated }); });
  });
}

export async function requestApplication(testCase, options) {
  const validation = testCase.publicValidation && structuredClone(testCase.publicValidation), trace = [], seen = new Set();
  let approvedInput;
  if (!options.token) throw Error("application acceptance requires API authentication");
  if (!validation || validation.sha256 !== digest(canonical({ permission: validation.permission, toolInventory: validation.toolInventory }))) throw Error("application approval scope is not owner-pinned");
  const body = { text: testCase.spec, requestedAuthority: "program", sessionId: `acceptance-${options.runId}-${testCase.id}` };
  const request = async (route, payload) => {
    const url = new URL(route, options.serverUrl);
    if (!['http:','https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw Error("Application acceptance requires a credential-free loopback URL");
    const remaining = options.remainingMs();
    if (remaining <= 0) throw Error("application time budget exceeded");
    const started = performance.now();
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      body: canonical(payload), signal: AbortSignal.timeout(Math.max(1, Math.floor(remaining))) });
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > ACCEPTANCE_BUDGETS.outputBytes) { await reader.cancel(); throw Error("application response byte budget exceeded"); } chunks.push(item.value); } }
    finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks), result = { status: response.status, body: JSON.parse(bytes.toString("utf8")) };
    trace.push({ route, status: response.status, bytes: size, elapsedMs: performance.now() - started, requestSha256: digest(canonical(payload)), responseSha256: digest(bytes) });
    return result;
  };
  try {
  let response = await request('/api/turn', body);
  while (response.status === 202 && response.body?.pendingApproval) {
    const pending = response.body.pendingApproval, permission = validation?.permission;
    const input = { steps: [{ files: { 'native-tools.json': canonical(validation?.toolInventory ?? {}) } }], budgets: ACCEPTANCE_BUDGETS };
    const contract = { approvals: ['process.build_test'], targetPaths: permission?.targetPaths, nativeValidationPermission: permission };
    if (!validation || validation.sha256 !== digest(canonical({ permission, toolInventory: validation.toolInventory }))
      || !nativeProgramApprovalAllowed({ input, contract, pending }) || seen.has(pending.fingerprint) || seen.size >= ACCEPTANCE_BUDGETS.maxSteps) throw Error("application approval scope mismatch or repeated stale plan");
    seen.add(pending.fingerprint);
    const approved = await request('/api/session/approve', { planId: pending.planId });
    if (approved.status !== 200 || approved.body?.approved?.planId !== pending.planId || approved.body.approved.fingerprint !== pending.fingerprint
      || canonical(approved.body.approved.input) !== canonical(pending.input)) throw Error("application approval record changed");
    approvedInput = structuredClone(pending.input);
    response = await request('/api/turn', body);
  }
  const { decodeProgramArtifactWire } = await import('../packages/kernel/dist/program-artifact-wire.js');
  return { ...response, body: decodeProgramArtifactWire(response.body), trace, approvedInput };
  } catch (error) { error.applicationTrace = trace; throw error; }
}

async function boundedFile(file, budget) {
  if ((await stat(file)).size > budget) throw Error("application file byte budget exceeded");
  const bytes = await readFile(file);
  if (bytes.length > budget) throw Error("application file byte budget exceeded");
  return bytes;
}

export async function executeCase(testCase, options) {
  if (testCase.coverageBlocker) return { id: testCase.id, category: testCase.category, expectedLanguage: testCase.expectedLanguage,
    status: 'failed', coverageBlocker: structuredClone(testCase.coverageBlocker), elapsedMs: 0, calls: [], nativeChecks: 'not_attempted',
    failures: [`coverage blocked: ${testCase.coverageBlocker.reasonId}: ${testCase.coverageBlocker.detail}`] };
  const started = performance.now(), remainingMs = () => Math.max(0, ACCEPTANCE_BUDGETS.timeMs - (performance.now() - started));
  const caseReport = { id: testCase.id, category: testCase.category, expectedLanguage: testCase.expectedLanguage, specSha256: digest(Buffer.from(testCase.spec, "utf8")), failures: [] };
  caseReport.publicValidationSha256 = testCase.publicValidation?.sha256 ?? null;
  const finished = () => ({ ...caseReport, elapsedMs: performance.now() - started, status: caseReport.failures.length ? "failed" : "passed" });
  caseReport.heldOutTests = testCase.heldOut.files.map(file => ({ kind: file.kind, sourcePath: file.sourcePath, targetPath: file.targetPath, sha256: file.sha256 }));
  caseReport.heldOutCommand = { command: testCase.heldOut.command, args: [...testCase.heldOut.args], cwd: testCase.heldOut.cwd ?? "." };
  let apiResponse;
  let approvedInput;
  try {
    const response = await requestApplication(testCase, { ...options, remainingMs });
    apiResponse = response.body;
    caseReport.calls = response.trace;
    approvedInput = response.approvedInput;
    caseReport.httpStatus = response.status;
    caseReport.responseSha256 = digest(Buffer.from(JSON.stringify(apiResponse), "utf8"));
    if (response.status !== 200) caseReport.failures.push(`SCCE turn returned HTTP ${response.status}: ${JSON.stringify(apiResponse).slice(0, 700)}`);
  } catch (error) {
    caseReport.calls = error.applicationTrace ?? [];
    caseReport.failures.push(`SCCE turn failed: ${error instanceof Error ? error.message : String(error)}`);
    return finished();
  }

  const artifacts = Array.isArray(apiResponse.programArtifacts) ? apiResponse.programArtifacts : [];
  let manifest;
  try { const artifact = artifacts.find(item => item.path === 'program.graph.json'); if (artifact?.contentHash === `sha256_${digest(artifact.content)}`) manifest = JSON.parse(artifact.content); } catch {}
  const program = manifest?.kind === 'program_graph' ? { language: manifest.shape?.target?.language, entrypoint: manifest.sourceEmission?.entrypoint,
    build: manifest.validation?.build, test: manifest.validation?.test } : undefined;
  const events = Array.isArray(apiResponse.events) ? apiResponse.events : [];
  caseReport.events = events.map(event => String(asRecord(event)?.typeId ?? "unknown"));
  caseReport.eventIdentities = events.map(event => ({ id: event.id ?? null, typeId: event.typeId, hash: event.hash ?? null, payloadSha256: digest(canonical(event.payload ?? null)) }));
  caseReport.program = program ? { language: program.language, entrypoint: program.entrypoint, build: program.build, test: program.test } : null;
  const buildTest = asRecord(apiResponse.buildTest);
  const attempts = Array.isArray(buildTest?.attempts) && buildTest.attempts.length
    ? buildTest.attempts
    : buildTest ? [{ build: buildTest.build, test: buildTest.test }] : [];
  caseReport.sccBuildTest = buildTest ? {
    passed: buildTest.passed === true,
    repairAttempted: buildTest.repairAttempted === true,
    repairApplied: buildTest.repairApplied === true,
    testExecutionReceipt: buildTest.testExecutionReceipt ?? null,
    attempts: attempts.map(attempt => {
      const row = asRecord(attempt) ?? {};
      const stage = value => {
        const run = asRecord(value) ?? {};
        return { code: run.code ?? null, durationMs: run.durationMs ?? null,
          stdoutSha256: digest(Buffer.from(String(run.stdout ?? ""), "utf8")),
          stderrSha256: digest(Buffer.from(String(run.stderr ?? ""), "utf8")) };
      };
      return { build: stage(row.build), test: stage(row.test) };
    })
  } : null;
  if (!program) caseReport.failures.push("turn did not return a ProgramGraph");
  if (program?.language !== testCase.expectedLanguage) caseReport.failures.push(`generated language ${String(program?.language)} does not match ${testCase.expectedLanguage}`);
  if (canonical(program?.build ?? null) !== canonical(testCase.publicValidation?.permission?.build ?? null)
    || canonical(program?.test ?? null) !== canonical(testCase.publicValidation?.permission?.test ?? null)) caseReport.failures.push("generated commands do not match owner-published validation permission");
  if (!apiResponse.programReadiness || asRecord(apiResponse.programReadiness)?.status !== "ready") caseReport.failures.push("program readiness was not ready");
  if (apiResponse.programReadiness?.artifactCount !== artifacts.length
    || canonical(apiResponse.programReadiness?.artifactIds?.slice().sort() ?? []) !== canonical(artifacts.map(item => item.artifactId).sort())) caseReport.failures.push("program readiness artifact identities mismatch");
  if (!asRecord(apiResponse.buildTest)?.passed) caseReport.failures.push("SCCE build/test execution did not pass");
  const testReceipt = buildTest?.testExecutionReceipt, expectedTest = testCase.publicValidation?.permission?.test;
  if (buildTest?.build?.code !== 0 || buildTest?.test?.code !== 0 || testReceipt?.status !== 'executed'
    || testReceipt.command !== expectedTest?.command || canonical(testReceipt.args ?? []) !== canonical(expectedTest?.args ?? [])
    || testReceipt.cwd !== expectedTest?.cwd) caseReport.failures.push("native build/test command receipt is incomplete or outside published scope");
  if (!events.some(event => asRecord(event)?.typeId === "BuildExecuted")) caseReport.failures.push("turn ledger has no BuildExecuted event");
  if (!events.some(event => asRecord(event)?.typeId === "TestExecuted" && asRecord(asRecord(event)?.payload)?.passed === true)) caseReport.failures.push("turn ledger has no passing TestExecuted event");
  if (testCase.category === "semantic_debug_repair") {
    const failedBuildIndex = events.findIndex(event => asRecord(event)?.typeId === "BuildExecuted" && Number(asRecord(asRecord(event)?.payload)?.code) !== 0);
    const passedBuildIndex = events.findIndex((event, index) => index > failedBuildIndex && asRecord(event)?.typeId === "BuildExecuted" && Number(asRecord(asRecord(event)?.payload)?.code) === 0);
    const failedTestIndex = events.findIndex(event => asRecord(event)?.typeId === "TestExecuted" && asRecord(asRecord(event)?.payload)?.passed === false);
    const passedTestIndex = events.findIndex((event, index) => index > failedTestIndex && asRecord(event)?.typeId === "TestExecuted" && asRecord(asRecord(event)?.payload)?.passed === true);
    const repairedIndex = events.findIndex(event => asRecord(event)?.typeId === "ProgramRepaired");
    if (failedBuildIndex < 0 || passedBuildIndex < 0) caseReport.failures.push("debug/repair case lacks ordered failing then passing build records");
    if (failedTestIndex < 0 || passedTestIndex < 0) caseReport.failures.push("debug/repair case lacks ordered failing then passing test records");
    if (repairedIndex < 0 || repairedIndex <= failedTestIndex || (passedTestIndex >= 0 && repairedIndex >= passedTestIndex)) caseReport.failures.push("debug/repair case lacks ProgramRepaired between failed and passing tests");
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) caseReport.failures.push("SCCE returned no program artifacts");
  const byPath = new Map(), pathIdentities = new Set();
  let artifactBytes = 0;
  for (const artifact of artifacts) {
    const item = asRecord(artifact);
    if (!item || !safeRelativePath(item.path) || typeof item.content !== "string") {
      caseReport.failures.push(`invalid generated artifact record: ${String(item?.path)}`);
      continue;
    }
    if (pathIdentities.has(item.path.toLowerCase())) caseReport.failures.push(`duplicate generated artifact path: ${item.path}`);
    pathIdentities.add(item.path.toLowerCase());
    byPath.set(item.path, item);
    artifactBytes += Buffer.byteLength(item.content);
  }
  if (artifactBytes > ACCEPTANCE_BUDGETS.artifactBytes) caseReport.failures.push("generated artifact byte budget exceeded");
  if (approvedInput && canonical(approvedInput.files) !== canonical(artifacts.map(item => ({ path: item.path, hash: item.contentHash,
    byteLength: Buffer.byteLength(item.content) })).sort((a, b) => a.path.localeCompare(b.path)))) caseReport.failures.push("final artifacts differ from the explicitly approved file identities");
  if (caseReport.failures.length) return finished();
  for (const requiredPath of testCase.requiredGeneratedPaths) if (!byPath.has(requiredPath)) caseReport.failures.push(`required generated artifact is absent: ${requiredPath}`);
  const runRoot = await mkdtemp(path.join(options.outputRoot, `${testCase.id}-`));
  const artifactRoot = path.resolve(runRoot, "generated");
  const resultReceiptPath = path.resolve(runRoot, ".acceptance-result.json");
  await mkdir(artifactRoot, { recursive: true });
  const generated = [];
  for (const [relativePath, item] of byPath) {
    const target = path.resolve(artifactRoot, relativePath);
    if (!inside(artifactRoot, target)) { caseReport.failures.push(`artifact path escapes workspace: ${relativePath}`); continue; }
    const bytes = Buffer.from(item.content, "utf8");
    const sha256 = digest(bytes);
    if (typeof item.contentHash !== "string" || !/^sha256_[a-f0-9]{64}$/u.test(item.contentHash)) caseReport.failures.push(`generated artifact lacks a valid SHA-256 contentHash: ${relativePath}`);
    else if (item.contentHash.slice(7) !== sha256) caseReport.failures.push(`artifact hash mismatch: ${relativePath}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    generated.push({ path: relativePath, role: item.role ?? null, bytes: bytes.length, sha256, declaredContentHash: item.contentHash ?? null });
  }
  caseReport.generatedArtifacts = generated;
  caseReport.workspace = runRoot;

  const immutableFiles = [], planRoot = await realpath(options.planDirectory);
  let heldOutBytes = 0;
  for (const heldOut of testCase.heldOut.files) {
    const source = path.resolve(options.planDirectory, heldOut.sourcePath);
    if (!inside(options.planDirectory, source)) { caseReport.failures.push(`held-out test source escapes plan directory: ${heldOut.sourcePath}`); continue; }
    let bytes;
    try {
      if (!inside(planRoot, await realpath(source))) throw Error("held-out source symlink escapes plan directory");
      bytes = await boundedFile(source, ACCEPTANCE_BUDGETS.caseBytes - heldOutBytes);
      heldOutBytes += bytes.length;
    }
    catch (error) { caseReport.failures.push(`held-out test is missing: ${heldOut.sourcePath}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    if (digest(bytes) !== heldOut.sha256) { caseReport.failures.push(`held-out test hash mismatch: ${heldOut.sourcePath}`); continue; }
    const target = path.resolve(runRoot, heldOut.targetPath);
    if (!inside(runRoot, target)) { caseReport.failures.push(`held-out test target escapes workspace: ${heldOut.targetPath}`); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    immutableFiles.push({ path: target, sha256: heldOut.sha256 });
  }
  const cwd = path.resolve(runRoot, testCase.heldOut.cwd ?? ".");
  if (!inside(runRoot, cwd)) caseReport.failures.push("held-out working directory escapes workspace");
  if (!caseReport.failures.length && remainingMs() > 0) {
    const receiptNonce = randomUUID();
    const result = await runCommand(testCase.heldOut.command, testCase.heldOut.args, cwd, {
      ...scrubEnvironment(),
      ...(testCase.heldOut.env ?? {}),
      SCCE_GENERATED_ROOT: artifactRoot,
      SCCE_ACCEPTANCE_CASE: testCase.id,
      SCCE_ACCEPTANCE_RUN_NONCE: receiptNonce,
      SCCE_ACCEPTANCE_RECEIPT_PATH: resultReceiptPath
    }, remainingMs(), ACCEPTANCE_BUDGETS.outputBytes);
    caseReport.independentTest = { ...result, receipt: null };
    if (result.code !== 0 || result.timedOut || result.outputExceeded) caseReport.failures.push(`independent held-out test failed with code ${String(result.code)}${result.error ? `: ${result.error}` : ""}`);
    else {
      try {
        const receipt = JSON.parse((await boundedFile(resultReceiptPath, ACCEPTANCE_BUDGETS.outputBytes)).toString("utf8"));
        const receiptErrors = validateExecutionReceipt(receipt, { testCase, nonce: receiptNonce, generated });
        caseReport.independentTest.receipt = receipt;
        caseReport.failures.push(...receiptErrors);
      } catch (error) {
        caseReport.failures.push(`independent test execution receipt missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const item of [...immutableFiles, ...generated.map(item => ({ path: path.join(artifactRoot, item.path), sha256: item.sha256 }))]) {
      try { if (!inside(await realpath(runRoot), await realpath(item.path)) || digest(await boundedFile(item.path, ACCEPTANCE_BUDGETS.caseBytes)) !== item.sha256) throw Error("changed"); }
      catch { caseReport.failures.push(`immutable application/test file changed or disappeared: ${path.relative(runRoot, item.path)}`); }
    }
  } else if (remainingMs() <= 0) caseReport.failures.push("application time budget exceeded");
  return finished();
}

export function validateExecutionReceipt(receipt, input) {
  const errors = [];
  if (receipt?.schema !== "scce.application_test_receipt.v1") errors.push("held-out result has invalid receipt schema");
  if (receipt?.caseId !== input.testCase.id) errors.push("held-out result caseId mismatch");
  if (receipt?.runNonce !== input.nonce) errors.push("held-out result run nonce mismatch");
  if (!Array.isArray(receipt?.tests)) { errors.push("held-out result has no test counts"); return errors; }
  const artifactHashes = new Map(input.generated.map(file => [file.path, file.sha256]));
  for (const kind of ["unit", "e2e"]) {
    const rows = receipt.tests.filter(row => row?.kind === kind);
    if (!rows.length) { errors.push(`held-out result has no ${kind} execution count`); continue; }
    let executed = 0;
    let passed = 0;
    let failed = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.executedCount) || row.executedCount < 0
        || !Number.isSafeInteger(row.passedCount) || row.passedCount < 0
        || !Number.isSafeInteger(row.failedCount) || row.failedCount < 0) {
        errors.push(`${kind} receipt counts must be nonnegative integers`);
        continue;
      }
      executed += row.executedCount;
      passed += row.passedCount;
      failed += row.failedCount;
      if (!Array.isArray(row.generatedArtifacts) || row.generatedArtifacts.length === 0) errors.push(`${kind} receipt must name exercised generated artifacts`);
      else for (const artifact of row.generatedArtifacts) {
        if (typeof artifact?.path !== "string" || artifactHashes.get(artifact.path) !== artifact.sha256) errors.push(`${kind} receipt references an unknown or changed generated artifact`);
      }
    }
    if (executed < 1 || passed < 1 || failed !== 0 || passed !== executed) errors.push(`${kind} tests did not report positive, fully passing execution counts`);
  }
  return errors;
}

export function applicationReportStatus(cases, expectedCount, failures = []) {
  return !failures.length && cases.length === expectedCount && cases.every(row => row.status === 'passed' && !row.coverageBlocker) ? 'passed' : 'failed';
}

async function main() {
  const planPath = process.argv[2];
  if (!planPath) throw new Error("usage: node tools/application-acceptance.mjs <plan.json> [--out=report.json]");
  const absolutePlanPath = path.resolve(planPath);
  const planBytes = await boundedFile(absolutePlanPath, ACCEPTANCE_BUDGETS.caseBytes);
  const expectedPlanHash = process.argv.find(arg => arg.startsWith('--plan-sha256='))?.slice('--plan-sha256='.length);
  if (!expectedPlanHash || expectedPlanHash !== digest(planBytes)) throw Error("provide the exact owner-published --plan-sha256");
  const plan = JSON.parse(planBytes.toString("utf8"));
  const errors = validatePlan(plan);
  if (errors.length) throw new Error(`invalid application acceptance plan:\n- ${errors.join("\n- ")}`);
  const runId = randomUUID();
  const adapter = await import('../packages/adapters-node/dist/index.js');
  const configPath = process.argv.find(arg => arg.startsWith('--config='))?.slice('--config='.length) ?? 'scce.config.json';
  const config = await adapter.readScceRuntimeConfig(configPath);
  const configuredToken = config.security?.apiBearerToken;
  const token = process.env.SCCE_API_BEARER_TOKEN?.trim() || (configuredToken?.startsWith('enc:v1:') ? adapter.resolveSecret(configuredToken, config, 'SCCE API bearer token') : configuredToken);
  if (!token) throw Error("application acceptance requires configured API authentication");
  const server = new URL(process.env.SCCE_SERVER_URL ?? config.server.url);
  if (!['http:','https:'].includes(server.protocol) || !['127.0.0.1','localhost','[::1]'].includes(server.hostname) || server.username || server.password) throw Error("Application acceptance requires a credential-free loopback URL");
  const outputRoot = await mkdtemp(path.join(tmpdir(), "scce-application-acceptance-"));
  const options = {
    runId,
    planDirectory: path.dirname(absolutePlanPath),
    outputRoot,
    serverUrl: server.origin, token
  };
  const report = {
    schema: "scce.application_acceptance_report.v1",
    runId,
    planSha256: digest(planBytes),
    generatedAt: new Date().toISOString(),
    serverUrl: options.serverUrl,
    status: "failed",
    cases: []
  };
  try {
    for (const testCase of plan.cases) {
      const row = await executeCase(testCase, options);
      report.cases.push(row);
      process.stdout.write(`${row.status.toUpperCase()} ${row.id} (${row.category})${row.failures.length ? `: ${row.failures.join("; ")}` : ""}\n`);
    }
  } catch (error) {
    report.failures = [`acceptance runner failed: ${error instanceof Error ? error.message : String(error)}`];
    for (const testCase of plan.cases.slice(report.cases.length)) report.cases.push({ id: testCase.id, category: testCase.category, status: "failed", failures: [report.failures[0]] });
  }
  report.status = applicationReportStatus(report.cases, plan.cases.length, report.failures);
  const outArg = process.argv.find(arg => arg.startsWith("--out="));
  const outPath = path.resolve(process.cwd(), outArg ? outArg.slice("--out=".length) : path.join(outputRoot, "report.json"));
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${report.status.toUpperCase()} report=${outPath}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 2; });
}
