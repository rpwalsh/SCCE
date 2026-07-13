#!/usr/bin/env node
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createEvaluationCondition } from "../packages/kernel/dist/index.js";
import { createNodeRuntime, createPostgresStorageAdapter, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";
import { verifyCitations } from "./sealed-eval/harness/lib/citations.mjs";
import { verifyYoppEvaluationTrace } from "./sealed-eval/integration/yopp-trace-verifier.mjs";

const configPath = path.resolve(process.env.YOPP_REHEARSAL_CONFIG ?? "scce.config.json");
const schema = `yopp_rehearsal_adapter_${process.pid}_${Date.now()}`;
if (!/^yopp_rehearsal_adapter_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe rehearsal schema name");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "yopp-adapter-rehearsal-"));
const documentPath = path.join(fixtureRoot, "document.txt");
const manifestPath = path.join(fixtureRoot, "corpus-manifest.json");
const text = "The Azurite Marker calibration phrase is cobalt lattice seven.";
const bytes = Buffer.from(text, "utf8");
const conditionInput = { conditionId: "full", seed: "live-adapter-rehearsal", clockIso: "2026-07-12T19:30:00.000-07:00", scope: "answer-quality" };
const checks = [];
let cleanupStorage;
let runtime;
let primaryError;

try {
  await writeFile(documentPath, bytes);
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: "1.0",
    corpusId: "live-adapter-rehearsal",
    documents: [{ documentId: "doc-azurite", path: "document.txt", sha256: sha256(bytes), sizeBytes: bytes.length, mediaType: "text/plain", normalization: "none" }]
  }, null, 2)}\n`, "utf8");

  const loadedConfig = await readScceRuntimeConfig(configPath);
  const config = { ...loadedConfig, database: { ...loadedConfig.database, schema } };
  runtime = createNodeRuntime(config, { deterministicReplay: true, runSeed: conditionInput.seed });
  await runtime.storage.migrate();
  const verify = await runtime.storage.verify();
  check("schema.verify", verify.ok, verify.errors.join("; "));
  const ingest = await runtime.kernel.ingest({
    content: bytes,
    uri: pathToFileURL(documentPath).href,
    namespace: "rehearsal",
    mediaType: "text/plain",
    metadata: { title: "Azurite Marker", documentId: "doc-azurite", rehearsal: true }
  });
  check("corpus.ingest", ingest.evidence > 0, `evidence=${ingest.evidence}`);
  const training = await runtime.kernel.train({ config: { promotion: { minTrust: 0, namespaces: ["rehearsal"] }, learningGoals: [] } });
  check("corpus.promote", training.promotedEvidence > 0, `promotedEvidence=${training.promotedEvidence}`);
  const searchProbe = await runtime.storage.evidence.searchEvidence({ features: ["sym:azurite", "sym:marker"], limit: 8 });
  check("corpus.search_probe", searchProbe.some(row => row.span.status === "promoted"), JSON.stringify(searchProbe.map(row => ({ status: row.span.status, features: row.span.features.slice(0, 16) }))));
  await activateRehearsalBrain(runtime.storage, 1_000);
  await runtime.close();
  runtime = undefined;

  const child = spawn(process.execPath, ["tools/sealed-eval/integration/yopp-jsonl-adapter.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      YOPP_EVAL_CONDITION: conditionInput.conditionId,
      YOPP_EVAL_SCOPE: conditionInput.scope,
      YOPP_EVAL_SEED: conditionInput.seed,
      YOPP_EVAL_CLOCK: conditionInput.clockIso,
      YOPP_EVAL_RUN_ID: "live-adapter-rehearsal",
      YOPP_EVAL_CORPUS_MANIFEST: manifestPath,
      YOPP_EVAL_CONFIG_PATH: configPath,
      YOPP_EVAL_DATABASE_SCHEMA: schema
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ schemaVersion: "1.0", questionId: "q-azurite", category: "knowledge", prompt: "What is Azurite Marker?" })}\n`);
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  check("adapter.exit", code === 0, JSON.stringify({ code, signal, stderr: sanitized(stderr) }));
  const lines = stdout.split(/\r?\n/u).filter(line => line.trim());
  check("adapter.one_output", lines.length === 1, `lines=${lines.length}`);
  const answer = JSON.parse(lines[0]);
  check("adapter.answer", answer.status === "ok" && typeof answer.answer === "string" && answer.answer.length > 0, JSON.stringify({ status: answer.status, answer: answer.answer, support: answer.support, metadata: answer.metadata, error: answer.error ?? null }));
  const citationChecks = await verifyCitations([{ ...answer, questionId: "q-azurite", systemId: "yopp", conditionId: "full" }], manifestPath);
  check("adapter.exact_citation", citationChecks.length > 0 && citationChecks.every(row => row.ok), JSON.stringify(citationChecks));
  const condition = createEvaluationCondition(conditionInput);
  const traceVerification = verifyYoppEvaluationTrace(condition, answer.trace);
  check("adapter.evaluation_trace", traceVerification.valid, JSON.stringify(traceVerification.violations));
  checks.push({ id: "adapter.output_summary", passed: true, detail: JSON.stringify({ answerChars: answer.answer.length, citations: answer.citations.length, traceEvents: answer.trace.length }) });
} catch (error) {
  primaryError = error;
} finally {
  if (runtime) await runtime.close().catch(error => { primaryError ??= error; });
  try {
    const config = await readScceRuntimeConfig(configPath);
    cleanupStorage = createPostgresStorageAdapter({ url: config.database.url, schema, ssl: config.database.ssl });
    if (!/^yopp_rehearsal_adapter_[a-z0-9_]+$/u.test(cleanupStorage.schema)) throw new Error("refusing cleanup outside rehearsal schema");
    await cleanupStorage.query(`DROP SCHEMA IF EXISTS "${cleanupStorage.schema}" CASCADE`);
    checks.push({ id: "cleanup.drop_disposable_schema", passed: true, detail: cleanupStorage.schema });
  } catch (error) {
    checks.push({ id: "cleanup.drop_disposable_schema", passed: false, detail: sanitized(error) });
    primaryError ??= error;
  }
  if (cleanupStorage) await cleanupStorage.close().catch(error => { primaryError ??= error; });
  await rm(fixtureRoot, { recursive: true, force: true }).catch(error => { primaryError ??= error; });
}

const report = {
  schema: "yopp.live_adapter_rehearsal.v1",
  completedAt: new Date().toISOString(),
  configPath,
  disposableSchema: schema,
  credentialsRecorded: false,
  fixtureContainsSyntheticDataOnly: true,
  checks,
  status: !primaryError && checks.every(check => check.passed) ? "passed" : "failed",
  error: primaryError ? sanitized(primaryError) : null
};
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/live-adapter-rehearsal.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;

async function activateRehearsalBrain(storage, createdAt) {
  const importRunId = "adapter-rehearsal-run";
  const brainVersion = "adapter-rehearsal-brain";
  const manifestHash = sha256(Buffer.from(`${importRunId}:${brainVersion}`, "utf8"));
  const manifest = {
    schema: "scce.brainManifestContract.v1",
    importRunId,
    brainVersion,
    rootPath: "rehearsal://adapter",
    manifestHash,
    sourceSchema: "yopp.live_adapter_rehearsal.v1",
    runtimeContractVersion: 1,
    content: { graphShardCount: 1, languageShardCount: 0, ngramStateCount: 0, priorSectionCount: 1 },
    metadata: { rehearsal: true },
    createdAt
  };
  await storage.brainImports.putLifecycle({ importRunId, brainVersion, rootPath: manifest.rootPath, state: "CREATED", manifest, revision: 0, createdAt, updatedAt: createdAt });
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "CREATED", toState: "IMPORTING", updatedAt: createdAt + 1 });
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "IMPORTING", toState: "VALIDATING", updatedAt: createdAt + 2 });
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "VALIDATING", toState: "READY", updatedAt: createdAt + 3, validation: {
    schema: "scce.brainValidationReport.v1",
    importRunId,
    brainVersion,
    manifestHash,
    validatorVersion: "live-adapter-rehearsal.v1",
    disposition: "PASSED",
    checks: [{ id: "synthetic-ingest", passed: true, severity: "error", message: "synthetic corpus ingested" }],
    validatedAt: createdAt + 3
  } });
  await storage.brainImports.activateReady({ brainVersion, importRunId, updatedAt: createdAt + 4 });
}

function check(id, passed, detail) {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitized(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 1000);
}
