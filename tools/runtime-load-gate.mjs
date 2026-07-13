#!/usr/bin/env node

import { open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const MAX_PROMPT_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_COUNT = 10_000;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_PROMPT_ID_BYTES = 1024;
const MAX_CONVERSATION_ID_BYTES = 1024;
const MAX_WORKLOAD_ID_BYTES = 1024;
const MAX_READY_BODY_BYTES = 1024 * 1024;
const MAX_TURN_BODY_BYTES = 8 * 1024 * 1024;
const LATENCY_RESERVOIR_SIZE = 10_000;

class ResponseBodyLimitError extends Error {
  constructor(maxBytes) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = "ResponseBodyLimitError";
  }
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write([
    "Usage: pnpm load:gate --prompts <json|jsonl> --workload-id <immutable-id> [options]",
    "",
    "Options:",
    "  --server-url <url>          default http://127.0.0.1:3873",
    "  --requests <count>          total cap; default 100, or 100000 with duration",
    "  --duration-seconds <count>  run until the duration expires",
    "  --concurrency <count>       default 4",
    "  --timeout-ms <count>        per-turn timeout, default 120000",
    "  --max-error-rate <0..1>     default 0",
    "  --max-p95-ms <count>        optional latency-estimate gate",
    "  --min-throughput <count>    optional requests/second gate",
    "  --out <path>                optional JSON report path",
    "  --allow-remote              permit a non-loopback server URL",
    ""
  ].join("\n"));
  process.exit(0);
}

const promptPath = valueAfter("--prompts");
const workloadId = valueAfter("--workload-id")?.normalize("NFC").trim();
if (!promptPath || !workloadId) {
  process.stderr.write("runtime load gate requires --prompts <json|jsonl> and --workload-id <immutable-id>; no canned workload is embedded in the repository\n");
  process.exit(2);
}
if (Buffer.byteLength(workloadId, "utf8") > MAX_WORKLOAD_ID_BYTES) throw new Error(`workload-id exceeds ${MAX_WORKLOAD_ID_BYTES} UTF-8 bytes`);

const serverUrl = new URL(valueAfter("--server-url") ?? process.env.SCCE_LOAD_SERVER_URL ?? "http://127.0.0.1:3873");
if (!args.includes("--allow-remote") && !isLoopback(serverUrl.hostname)) throw new Error("non-loopback load targets require --allow-remote");
const concurrency = boundedInteger(numberAfter("--concurrency") ?? 4, 1, 256, "concurrency");
const timeoutMs = boundedInteger(numberAfter("--timeout-ms") ?? 120_000, 1, 3_600_000, "timeout-ms");
const durationSeconds = optionalPositive(numberAfter("--duration-seconds"), "duration-seconds");
const requestedCount = boundedInteger(numberAfter("--requests") ?? (durationSeconds === undefined ? 100 : 100_000), 1, 1_000_000, "requests");
const maxErrorRate = boundedNumber(numberAfter("--max-error-rate") ?? 0, 0, 1, "max-error-rate");
const maxP95Ms = optionalPositive(numberAfter("--max-p95-ms"), "max-p95-ms");
const minThroughput = optionalPositive(numberAfter("--min-throughput"), "min-throughput");
const outputPath = valueAfter("--out");
const prompts = await readPrompts(promptPath);
if (!prompts.length) throw new Error("load prompt file contains no prompts");
const workloadHash = `sha256:${createHash("sha256").update(JSON.stringify(prompts)).digest("hex")}`;

const readyBefore = await getJson(new URL("/api/ready", serverUrl), timeoutMs);
if (!readyBefore.ok || readyBefore.value?.ok !== true) throw new Error(`server is not ready: ${readyBefore.error ?? JSON.stringify(readyBefore.value)}`);

const startedAt = Date.now();
const deadline = durationSeconds === undefined ? Number.POSITIVE_INFINITY : startedAt + durationSeconds * 1000;
let nextIndex = 0;
let stopReason;
let latencyReservoirState = Number.parseInt(workloadHash.slice("sha256:".length, "sha256:".length + 8), 16) || 0x9e3779b9;
const metrics = {
  requests: 0,
  successes: 0,
  failures: 0,
  successfulLatencyCount: 0,
  successfulLatencySample: [],
  successfulResponseBytes: 0,
  statusCounts: new Map(),
  errorCounts: new Map()
};

await Promise.all(Array.from({ length: concurrency }, (_, workerId) => worker(workerId)));

const finishedAt = Date.now();
const elapsedSeconds = Math.max(0.001, (finishedAt - startedAt) / 1000);
const terminationReason = stopReason ?? (Date.now() >= deadline ? "duration_elapsed" : "request_cap_reached");
const latencies = [...metrics.successfulLatencySample].sort((left, right) => left - right);
const errorRate = metrics.failures / Math.max(1, metrics.requests);
const attemptedThroughput = metrics.requests / elapsedSeconds;
const successfulThroughput = metrics.successes / elapsedSeconds;
const latencyEstimator = metrics.successfulLatencyCount <= LATENCY_RESERVOIR_SIZE
  ? "all_successful_requests"
  : "bounded_reservoir_sample";
const successfulRequestLatencyEstimateMs = {
  ...latencySummary(latencies),
  populationCount: metrics.successfulLatencyCount,
  sampleCount: latencies.length,
  estimator: latencyEstimator
};
const summary = {
  schema: "scce.runtime_load_report.v1",
  ok: true,
  target: serverUrl.origin,
  workload: {
    promptFile: path.resolve(promptPath),
    promptCount: prompts.length,
    workloadId,
    workloadHash,
    requestedCount,
    requestedDurationSeconds: durationSeconds ?? null,
    concurrency,
    timeoutMs
  },
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: new Date(finishedAt).toISOString(),
  elapsedSeconds,
  terminationReason,
  requests: metrics.requests,
  successes: metrics.successes,
  failedRequests: metrics.failures,
  errorRate,
  attemptedThroughputRequestsPerSecond: attemptedThroughput,
  successfulThroughputRequestsPerSecond: successfulThroughput,
  successfulRequestLatencyEstimateMs,
  responseBytes: {
    total: metrics.successfulResponseBytes,
    mean: metrics.successes ? metrics.successfulResponseBytes / metrics.successes : 0
  },
  statusCounts: sortedCountRecord(metrics.statusCounts),
  errorCounts: sortedCountRecord(metrics.errorCounts),
  measurementBounds: {
    maxPromptInputBytes: MAX_PROMPT_INPUT_BYTES,
    maxPromptCount: MAX_PROMPT_COUNT,
    maxPromptBytes: MAX_PROMPT_BYTES,
    maxReadyBodyBytes: MAX_READY_BODY_BYTES,
    maxTurnBodyBytes: MAX_TURN_BODY_BYTES,
    latencyReservoirSize: LATENCY_RESERVOIR_SIZE
  },
  thresholds: {
    maxErrorRate,
    maxP95Ms: maxP95Ms ?? null,
    minThroughput: minThroughput ?? null,
    latencyEstimator
  },
  gateFailures: [],
  readyBefore: readyBefore.value,
  claimBoundary: "local_client_observation_not_independent_capacity_attestation"
};

if (metrics.requests === 0) summary.gateFailures.push("no requests completed");
if (metrics.successes === 0) summary.gateFailures.push("no successful requests completed");
if (durationSeconds !== undefined && terminationReason !== "duration_elapsed") {
  summary.gateFailures.push(`request cap ${requestedCount} reached before requested duration ${durationSeconds}s elapsed`);
}
if (errorRate > maxErrorRate) summary.gateFailures.push(`error rate ${errorRate.toFixed(6)} exceeds ${maxErrorRate.toFixed(6)}`);
if (maxP95Ms !== undefined && summary.successfulRequestLatencyEstimateMs.p95 > maxP95Ms) {
  summary.gateFailures.push(`successful-request p95 estimate ${summary.successfulRequestLatencyEstimateMs.p95.toFixed(3)}ms (${latencyEstimator}) exceeds ${maxP95Ms}ms`);
}
if (minThroughput !== undefined && successfulThroughput < minThroughput) summary.gateFailures.push(`successful throughput ${successfulThroughput.toFixed(3)} below ${minThroughput} requests/second`);
summary.ok = summary.gateFailures.length === 0;

const serialized = `${JSON.stringify(summary, null, 2)}\n`;
if (outputPath) await writeFile(path.resolve(outputPath), serialized, "utf8");
process.stdout.write(serialized);
process.exitCode = summary.ok ? 0 : 1;

async function worker(workerId) {
  while (true) {
    if (Date.now() >= deadline) {
      stopReason ??= "duration_elapsed";
      return;
    }
    const index = nextIndex++;
    if (index >= requestedCount) {
      stopReason ??= "request_cap_reached";
      return;
    }
    const prompt = prompts[index % prompts.length];
    const requestStarted = performance.now();
    let responseStatus;
    try {
      const response = await fetch(new URL("/api/turn?full=1", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: prompt.text,
          sessionId: `load-${startedAt.toString(36)}-${workerId}-${index}`,
          conversationId: prompt.conversationId
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      responseStatus = response.status;
      const responseBytes = await consumeResponseBody(response, MAX_TURN_BODY_BYTES);
      metrics.requests += 1;
      increment(metrics.statusCounts, String(response.status));
      if (response.ok) {
        metrics.successes += 1;
        metrics.successfulResponseBytes += responseBytes;
        sampleSuccessfulLatency(performance.now() - requestStarted);
      } else {
        metrics.failures += 1;
        increment(metrics.errorCounts, `http_${response.status}`);
      }
    } catch (error) {
      metrics.requests += 1;
      metrics.failures += 1;
      increment(metrics.statusCounts, responseStatus === undefined ? "error" : String(responseStatus));
      increment(metrics.errorCounts, errorKind(error));
    }
  }
}

async function readPrompts(candidate) {
  const absolute = path.resolve(candidate);
  const text = await readUtf8FileBounded(absolute, MAX_PROMPT_INPUT_BYTES);
  const parsed = path.extname(absolute).toLocaleLowerCase() === ".jsonl"
    ? text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line))
    : JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : parsed?.prompts;
  if (!Array.isArray(rows)) throw new Error("prompt input must be an array or contain a prompts array");
  if (rows.length > MAX_PROMPT_COUNT) throw new Error(`prompt input exceeds ${MAX_PROMPT_COUNT} prompts`);
  return rows.map((row, index) => {
    const text = typeof row === "string" ? row : row?.text ?? row?.prompt;
    if (typeof text !== "string" || !text.trim()) throw new Error(`prompt ${index + 1} has no text`);
    const normalizedText = text.trim();
    if (Buffer.byteLength(normalizedText, "utf8") > MAX_PROMPT_BYTES) throw new Error(`prompt ${index + 1} exceeds ${MAX_PROMPT_BYTES} UTF-8 bytes`);
    const id = String(typeof row === "object" && row?.id ? row.id : `prompt.${index + 1}`).normalize("NFC").trim();
    if (!id || Buffer.byteLength(id, "utf8") > MAX_PROMPT_ID_BYTES) throw new Error(`prompt ${index + 1} id must be within 1..${MAX_PROMPT_ID_BYTES} UTF-8 bytes`);
    const conversationId = typeof row === "object" && typeof row?.conversationId === "string"
      ? row.conversationId.normalize("NFC").trim()
      : undefined;
    if (conversationId !== undefined && (!conversationId || Buffer.byteLength(conversationId, "utf8") > MAX_CONVERSATION_ID_BYTES)) {
      throw new Error(`prompt ${index + 1} conversationId must be within 1..${MAX_CONVERSATION_ID_BYTES} UTF-8 bytes`);
    }
    return {
      id,
      text: normalizedText,
      conversationId
    };
  });
}

async function getJson(url, requestTimeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    const text = await readResponseTextBounded(response, MAX_READY_BODY_BYTES);
    return { ok: response.ok, value: text ? JSON.parse(text) : null, error: response.ok ? undefined : `${response.status} ${response.statusText}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readUtf8FileBounded(filePath, maxBytes) {
  const handle = await open(filePath, "r");
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`prompt input exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function consumeResponseBody(response, maxBytes) {
  const result = await readResponseBodyBounded(response, maxBytes, false);
  return result.bytes;
}

async function readResponseTextBounded(response, maxBytes) {
  const result = await readResponseBodyBounded(response, maxBytes, true);
  return Buffer.concat(result.chunks, result.bytes).toString("utf8");
}

async function readResponseBodyBounded(response, maxBytes, collect) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyLimitError(maxBytes);
  }
  if (!response.body) return { bytes: 0, chunks: [] };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyLimitError(maxBytes);
      }
      if (collect) chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, chunks };
}

function sampleSuccessfulLatency(value) {
  metrics.successfulLatencyCount += 1;
  if (metrics.successfulLatencySample.length < LATENCY_RESERVOIR_SIZE) {
    metrics.successfulLatencySample.push(value);
    return;
  }
  latencyReservoirState ^= latencyReservoirState << 13;
  latencyReservoirState ^= latencyReservoirState >>> 17;
  latencyReservoirState ^= latencyReservoirState << 5;
  const random = (latencyReservoirState >>> 0) / 0x1_0000_0000;
  const slot = Math.floor(random * metrics.successfulLatencyCount);
  if (slot < LATENCY_RESERVOIR_SIZE) metrics.successfulLatencySample[slot] = value;
}

function errorKind(error) {
  if (error instanceof ResponseBodyLimitError) return "response_body_too_large";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "network_error";
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCountRecord(counts) {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function latencySummary(values) {
  if (!values.length) return { min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    min: values[0],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values[values.length - 1]
  };
}

function percentile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function valueAfter(flag) {
  const direct = args.find(arg => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberAfter(flag) {
  const value = valueAfter(flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be finite`);
  return parsed;
}

function boundedInteger(value, minimum, maximum, field) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${field} must be an integer within [${minimum},${maximum}]`);
  return value;
}

function optionalPositive(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

function boundedNumber(value, minimum, maximum, field) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${field} must be within [${minimum},${maximum}]`);
  return value;
}
