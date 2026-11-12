#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * Starts (or targets) the normal SCCE server and asks source-bound questions
 * selected while a multi-corpus brain is built. The input cases, live answers,
 * compact citations, HTTP outcomes, and timings are retained in one receipt.
 * Credentials are resolved only in memory and are never serialized.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { productionReadinessFailures } from "./production-live-question-contract.mjs";
import { compactAcceptanceEvidence, evidenceMatchesSourceBinding } from "./lib/multicorpus-live-acceptance-contract.mjs";

const RECEIPT_SCHEMA = "scce.multicorpus_live_acceptance.v1";
const CASES_SCHEMA = "scce.multicorpus_acceptance_cases.v1";
const REQUIRED_CORPORA = Object.freeze(["wikipedia", "gutenberg", "dolly", "code", "openassistant"]);
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_TURN_TIMEOUT_MS = 900_000;
const MAX_CASES_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CASES = 200;

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const casesDocument = await readCasesDocument(options.casesPath);
const cases = validateCases(casesDocument);
const outputPath = path.resolve(options.outputPath);
const configPath = path.resolve(options.configPath);
const adapter = await import("../packages/adapters-node/dist/index.js");
const config = await adapter.readScceRuntimeConfig(configPath);
const configuredServerUrl = new URL(config.server.url);
const serverUrl = options.serverUrl ? new URL(options.serverUrl) : configuredServerUrl;
assertSafeTarget(serverUrl, options.allowRemote, options.targetOnly);

const configuredToken = config.security?.apiBearerToken;
const token = process.env.SCCE_API_BEARER_TOKEN?.trim()
  || (configuredToken?.startsWith("enc:v1:")
    ? adapter.resolveSecret(configuredToken, config, "SCCE API bearer token")
    : configuredToken);
const headers = {
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {})
};

await mkdir(path.dirname(outputPath), { recursive: true });
const startedAt = new Date().toISOString();
const startedMonotonicMs = performance.now();
const serverLog = [];
let child;
let preflight;
let postflight;
let fatalError = null;
const results = [];

try {
  if (!options.targetOnly) {
    child = startServer({ configPath, serverLog });
  }
  preflight = await waitForReady({
    serverUrl,
    headers,
    timeoutMs: options.startupTimeoutMs,
    child
  });
  const readinessFailures = productionReadinessFailures(preflight);
  if (readinessFailures.length) {
    throw new Error(`server is not a hydrated active brain: ${readinessFailures.join(", ")}`);
  }

  for (let index = 0; index < cases.length; index += 1) {
    const result = await runCase({
      testCase: cases[index],
      index,
      serverUrl,
      headers,
      timeoutMs: options.turnTimeoutMs
    });
    results.push(result);
    process.stdout.write(`[${result.status}] ${result.corpus}/${result.id} HTTP ${result.httpStatus ?? 0} ${result.elapsedMs}ms\n`);
    if (result.answer) process.stdout.write(`  ${preview(result.answer, 320)}\n`);
  }

  postflight = await fetchJsonBounded(
    new URL("/api/ready?detail=population&population=questions", serverUrl),
    { method: "GET", headers, timeoutMs: options.startupTimeoutMs }
  );
  if (postflight.status !== 200 || postflight.value?.ok !== true) {
    throw new Error(`postflight readiness returned HTTP ${postflight.status}`);
  }
  if (activeBrainIdentity(preflight) !== activeBrainIdentity(postflight.value)) {
    throw new Error("active brain changed during the acceptance run");
  }
} catch (error) {
  fatalError = safeMessage(error);
} finally {
  if (child) await stopServer(child);
}

const failures = results.filter(result => result.status !== "passed");
const requiredCorpora = options.requiredCorpora;
const observedCorpora = [...new Set(cases.map(item => item.corpus))].sort();
const missingCorpora = requiredCorpora.filter(corpus => !observedCorpora.includes(corpus));
const unrun = cases.length - results.length;
const receipt = {
  schema: RECEIPT_SCHEMA,
  startedAt,
  completedAt: new Date().toISOString(),
  elapsedMs: roundMs(performance.now() - startedMonotonicMs),
  status: !fatalError && failures.length === 0 && unrun === 0 && missingCorpora.length === 0 ? "passed" : "failed",
  transport: {
    serverOrigin: serverUrl.origin,
    serverMode: options.targetOnly ? "existing" : "started_by_runner",
    endpoint: "/api/turn",
    configFile: path.basename(configPath),
    credentialsRecorded: false,
    remoteTargetAllowed: options.allowRemote,
    startupTimeoutMs: options.startupTimeoutMs,
    turnTimeoutMs: options.turnTimeoutMs
  },
  cases: {
    schema: CASES_SCHEMA,
    inputFile: path.resolve(options.casesPath),
    inputSha256: sha256(casesDocument.raw),
    selected: cases.length,
    requiredCorpora,
    observedCorpora,
    missingCorpora
  },
  brain: {
    before: readinessSummary(preflight),
    after: readinessSummary(postflight?.value)
  },
  summary: {
    attempted: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    notRun: unrun,
    latencyMs: numericSummary(results.map(result => result.elapsedMs)),
    evidenceSpans: results.reduce((sum, result) => sum + result.evidence.length, 0)
  },
  results,
  fatalError,
  serverLog: serverLog.slice(-32),
  credentialsRecorded: false
};

await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  schema: RECEIPT_SCHEMA,
  status: receipt.status,
  attempted: receipt.summary.attempted,
  passed: receipt.summary.passed,
  failed: receipt.summary.failed,
  report: outputPath
})}\n`);
if (receipt.status !== "passed") process.exitCode = 1;

function startServer({ configPath: resolvedConfigPath, serverLog: log }) {
  const entrypoint = path.resolve("packages/server/dist/index.js");
  const spawned = spawn(process.execPath, ["--max-old-space-size=7168", entrypoint, "--config", resolvedConfigPath], {
    cwd: process.cwd(),
    env: { ...process.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  collectServerLines(spawned.stdout, "stdout", log);
  collectServerLines(spawned.stderr, "stderr", log);
  return spawned;
}

function collectServerLines(stream, channel, target) {
  let pending = "";
  stream?.setEncoding("utf8");
  stream?.on("data", chunk => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      target.push({ channel, line: sanitizeLogLine(line), observedAt: new Date().toISOString() });
      if (target.length > 64) target.shift();
    }
  });
}

async function waitForReady({ serverUrl: base, headers: requestHeaders, timeoutMs, child: processHandle }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server has not answered readiness";
  while (Date.now() < deadline) {
    if (processHandle && processHandle.exitCode !== null) {
      throw new Error(`server exited before readiness with code ${processHandle.exitCode}`);
    }
    try {
      const response = await fetchJsonBounded(
        new URL("/api/ready?detail=population&population=questions", base),
        { method: "GET", headers: requestHeaders, timeoutMs: Math.min(10_000, Math.max(1, deadline - Date.now())) }
      );
      if (response.status === 200 && response.value?.ok === true) return response.value;
      lastError = `readiness HTTP ${response.status}: ${preview(response.text, 240)}`;
    } catch (error) {
      lastError = safeMessage(error);
    }
    await delay(Math.min(750, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`server readiness timed out after ${timeoutMs}ms: ${lastError}`);
}

async function runCase({ testCase, index, serverUrl: base, headers: requestHeaders, timeoutMs }) {
  const started = performance.now();
  let response;
  let body;
  let transportError = null;
  try {
    response = await fetchJsonBounded(new URL("/api/turn", base), {
      method: "POST",
      headers: requestHeaders,
      timeoutMs,
      body: JSON.stringify({
        text: testCase.question,
        requestedAuthority: testCase.requestedAuthority,
        sessionId: `multicorpus-acceptance-${randomUUID()}`,
        conversationId: `multicorpus-acceptance-${testCase.id}-${randomUUID()}`,
        metadata: {
          evaluation: {
            schema: "scce.multicorpus_acceptance_case.v1",
            caseId: testCase.id,
            corpus: testCase.corpus,
            sourceBindings: testCase.sourceBindings
          }
        }
      })
    });
    body = response.value;
  } catch (error) {
    transportError = safeMessage(error);
  }

  const elapsedMs = roundMs(performance.now() - started);
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  const evidence = Array.isArray(body?.evidence) ? body.evidence.map(compactAcceptanceEvidence).slice(0, 32) : [];
  const reasons = [];
  if (transportError) reasons.push(`transport:${transportError}`);
  if (response && response.status !== 200) reasons.push(`http_${response.status}`);
  if (!/[\p{L}\p{N}]/u.test(answer)) reasons.push("empty_answer");
  if (evidence.length === 0) reasons.push("no_evidence");
  for (const expected of testCase.expectedAnswerTerms) {
    if (!normalized(answer).includes(normalized(expected))) reasons.push(`missing_answer_term:${expected}`);
  }
  if (testCase.expectedAnyAnswerTerms.length
    && !testCase.expectedAnyAnswerTerms.some(expected => normalized(answer).includes(normalized(expected)))) {
    reasons.push(`missing_any_answer_term:${testCase.expectedAnyAnswerTerms.join("|")}`);
  }
  for (const binding of testCase.sourceBindings) {
    if (!evidence.some(span => evidenceMatchesSourceBinding(span, binding))) {
      reasons.push(`missing_source_binding:${binding.sourceId}`);
    }
  }
  return {
    schema: "scce.multicorpus_live_acceptance_case_result.v1",
    index,
    id: testCase.id,
    corpus: testCase.corpus,
    question: testCase.question,
    requestedAuthority: testCase.requestedAuthority,
    sourceBindings: testCase.sourceBindings,
    expectations: {
      allAnswerTerms: testCase.expectedAnswerTerms,
      anyAnswerTerms: testCase.expectedAnyAnswerTerms
    },
    status: reasons.length === 0 ? "passed" : "failed",
    failureReasons: [...new Set(reasons)],
    httpStatus: response?.status ?? null,
    elapsedMs,
    answer,
    answerSha256: answer ? sha256(answer) : null,
    evidence,
    episodeId: typeof body?.episodeId === "string" ? body.episodeId : null,
    epistemicForce: typeof body?.epistemicForce === "string" ? body.epistemicForce : null,
    entailment: compactEntailment(body?.entailment),
    withheld: body?.withheld ?? body?.detail ?? null,
    transportError
  };
}

async function fetchJsonBounded(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("request timeout", "TimeoutError")), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: "error",
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map(value => Buffer.from(value))).toString("utf8");
    let value;
    try { value = text ? JSON.parse(text) : null; }
    catch { throw new Error(`HTTP ${response.status} returned invalid JSON: ${preview(text, 240)}`); }
    return { status: response.status, text, value };
  } finally {
    clearTimeout(timeout);
  }
}

async function readCasesDocument(inputPath) {
  const resolved = path.resolve(inputPath);
  const raw = await readFile(resolved, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_CASES_BYTES) throw new Error(`cases input exceeds ${MAX_CASES_BYTES} bytes`);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`cases input is not valid JSON: ${safeMessage(error)}`); }
  const value = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cases)
      ? parsed.cases
      : Array.isArray(parsed?.acceptanceCases)
        ? parsed.acceptanceCases
        : Array.isArray(parsed?.acceptance?.cases)
          ? parsed.acceptance.cases
          : undefined;
  if (!value) throw new Error("cases input must be an array or contain cases/acceptanceCases/acceptance.cases");
  return { raw, value };
}

function validateCases(document) {
  if (!document.value.length || document.value.length > MAX_CASES) throw new Error(`cases input must contain 1-${MAX_CASES} cases`);
  const ids = new Set();
  return document.value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`case ${index} must be an object`);
    const id = requiredString(raw.id, `case ${index}.id`, 256);
    if (ids.has(id)) throw new Error(`duplicate case id ${id}`);
    ids.add(id);
    const corpus = requiredString(raw.corpus, `${id}.corpus`, 64).toLocaleLowerCase();
    const question = requiredString(raw.question ?? raw.prompt, `${id}.question`, 20_000);
    const requestedAuthority = raw.requestedAuthority ?? "factual";
    if (!["factual", "reasoned", "creative", "translation", "program", "action"].includes(requestedAuthority)) {
      throw new Error(`${id}.requestedAuthority is invalid`);
    }
    const sourceBindings = normalizeSourceBindings(raw.sourceBindings ?? raw.expectedSources ?? raw.expectedSourceIds, id);
    if (!sourceBindings.length) throw new Error(`${id} requires at least one source binding from the committed build`);
    return {
      id,
      corpus,
      question,
      requestedAuthority,
      sourceBindings,
      expectedAnswerTerms: stringArray(raw.expectedAnswerTerms ?? raw.expectedTerms, `${id}.expectedAnswerTerms`, 32, 256),
      expectedAnyAnswerTerms: stringArray(raw.expectedAnyAnswerTerms ?? raw.expectedAnyTerms, `${id}.expectedAnyAnswerTerms`, 32, 256)
    };
  });
}

function normalizeSourceBindings(value, id) {
  const values = Array.isArray(value) ? value : [];
  if (values.length > 32) throw new Error(`${id}.sourceBindings may contain at most 32 entries`);
  return values.map((binding, index) => {
    if (typeof binding === "string") return { sourceId: requiredString(binding, `${id}.sourceBindings[${index}]`, 1024) };
    if (!isRecord(binding)) throw new Error(`${id}.sourceBindings[${index}] must be a string or object`);
    return {
      sourceId: requiredString(binding.sourceId, `${id}.sourceBindings[${index}].sourceId`, 1024),
      ...(typeof binding.sourceVersionId === "string" && binding.sourceVersionId ? { sourceVersionId: binding.sourceVersionId } : {}),
      ...(typeof binding.contentHash === "string" && binding.contentHash ? { contentHash: binding.contentHash } : {})
    };
  });
}

function readinessSummary(value) {
  if (!isRecord(value)) return null;
  const postgres = isRecord(value.postgres) ? value.postgres : {};
  const activeBrain = isRecord(postgres.activeBrain) ? postgres.activeBrain : {};
  return {
    ok: value.ok === true,
    warmup: isRecord(value.warmup) ? {
      ok: value.warmup.ok === true,
      complete: value.warmup.complete === true,
      phase: value.warmup.phase ?? null
    } : null,
    postgres: {
      ok: postgres.ok === true,
      connected: postgres.connected === true,
      schema: postgres.schema ?? null,
      countSemantics: postgres.countSemantics ?? null,
      population: postgres.tablePopulation ?? null
    },
    activeBrain: {
      activeBrainVersion: activeBrain.activeBrainVersion ?? null,
      activeImportRunIds: Array.isArray(activeBrain.activeImportRunIds) ? activeBrain.activeImportRunIds : []
    }
  };
}

function activeBrainIdentity(value) {
  const active = value?.postgres?.activeBrain;
  return JSON.stringify({
    version: active?.activeBrainVersion ?? null,
    imports: Array.isArray(active?.activeImportRunIds) ? active.activeImportRunIds : []
  });
}

function compactEntailment(value) {
  if (!isRecord(value)) return null;
  return Object.fromEntries(["verdict", "confidence", "supported", "contradicted"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function parseArguments(argv) {
  const help = argv.includes("--help") || argv.includes("-h");
  const valueAfter = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (help) return { help: true };
  const configPath = valueAfter("--config");
  const casesPath = valueAfter("--cases") ?? valueAfter("--build-receipt");
  if (!configPath || !casesPath) throw new Error("--config and --cases (or --build-receipt) are required");
  const requiredCorpora = (valueAfter("--required-corpora") ?? REQUIRED_CORPORA.join(","))
    .split(",").map(value => value.trim().toLocaleLowerCase()).filter(Boolean);
  return {
    help: false,
    configPath,
    casesPath,
    outputPath: valueAfter("--out") ?? ".scce/verification/multicorpus-live-acceptance/receipt.json",
    serverUrl: valueAfter("--server-url"),
    targetOnly: argv.includes("--target-only"),
    allowRemote: argv.includes("--allow-remote"),
    startupTimeoutMs: positiveInteger(valueAfter("--startup-timeout-ms") ?? DEFAULT_STARTUP_TIMEOUT_MS, "startup-timeout-ms", 3_600_000),
    turnTimeoutMs: positiveInteger(valueAfter("--turn-timeout-ms") ?? DEFAULT_TURN_TIMEOUT_MS, "turn-timeout-ms", 86_400_000),
    requiredCorpora: [...new Set(requiredCorpora)]
  };
}

function helpText() {
  return [
    "Usage:",
    "  node tools/multicorpus-live-acceptance.mjs --config <fresh-brain-config.json> --cases <cases-or-build-receipt.json> [options]",
    "",
    "Options:",
    "  --build-receipt <path>       alias for --cases; reads top-level acceptanceCases",
    "  --out <path>                 default .scce/verification/multicorpus-live-acceptance/receipt.json",
    "  --server-url <loopback-url>  override config.server.url",
    "  --target-only                use an already-running server instead of starting one",
    "  --required-corpora <csv>     default wikipedia,gutenberg,dolly,code,openassistant",
    "  --startup-timeout-ms <n>     default 300000",
    "  --turn-timeout-ms <n>        default 900000",
    "  --allow-remote               explicitly permit a non-loopback target (never records credentials)",
    "",
    "Each case requires id, corpus, question (or prompt), and at least one exact source binding.",
    "Optional expectedAnswerTerms are all required; expectedAnyAnswerTerms require at least one match.",
    "The runner resolves the local bearer token only in memory and never writes it to the receipt.",
    ""
  ].join("\n");
}

function assertSafeTarget(url, allowRemote, targetOnly) {
  if (url.username || url.password) throw new Error("server URL must not contain credentials");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("server URL must use HTTP or HTTPS");
  if (!allowRemote && !isLoopback(url.hostname)) throw new Error("non-loopback server targets require --allow-remote");
  if (!targetOnly && !isLoopback(url.hostname)) throw new Error("the runner only starts a local loopback server; use --target-only for a remote target");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function sanitizeLogLine(value) {
  return preview(String(value), 1_000)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/((?:SCCE_DATABASE_URL|SCCE_API_BEARER_TOKEN)\s*=\s*)\S+/giu, "$1[REDACTED]");
}

function stringArray(value, label, maxItems, maxLength) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} strings`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`, maxLength));
}

function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const text = value.normalize("NFC").trim();
  if (text.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return text;
}

function positiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return parsed;
}

function normalized(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function numericSummary(values) {
  if (!values.length) return { min: null, median: null, mean: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: roundMs(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    max: sorted.at(-1)
  };
}

function finiteNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function isLoopback(hostname) { return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname.toLocaleLowerCase()); }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function preview(value, limit) { const text = String(value ?? "").replace(/\s+/gu, " ").trim(); return text.length <= limit ? text : `${text.slice(0, limit)}...`; }
function roundMs(value) { return Math.round(value * 100) / 100; }
function safeMessage(error) { return error instanceof Error ? error.message : String(error); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
