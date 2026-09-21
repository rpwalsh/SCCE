#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// SCCE diagnostic-only Wikipedia candidate snapshot. It clones one configured PostgreSQL database into a
// disposable database, checks real artifacts/evidence, and may activate only that disposable candidate so the
// ordinary server/CLI path can be exercised. It never qualifies or mutates the configured source database.
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "../packages/adapters-node/node_modules/pg/lib/index.js";
import { createPostgresStorageAdapter } from "../packages/adapters-node/dist/index.js";
import { validateBrainManifestContract } from "../packages/kernel/dist/index.js";
import { readRuntimeConfig, repoRoot } from "./lib/runtime-config.mjs";

const STATE_DEFAULT = path.join(repoRoot, ".tmp", "wikipedia-candidate-diagnostic.json");
const DATABASE_PATTERN = /^scce_wikipedia_candidate_[0-9a-f]{16}$/u;
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/u;

function help() {
  process.stdout.write([
    "Wikipedia candidate diagnostic (disposable database only)",
    "",
    "Usage:",
    "  node tools/wikipedia-candidate-diagnostic.mjs prepare [--config=path] [--source-schema=name] [--state=path]",
    "  node tools/wikipedia-candidate-diagnostic.mjs status [--config=path] [--state=path]",
    "  node tools/wikipedia-candidate-diagnostic.mjs activate-diagnostic [--config=path] [--state=path]",
    "  node tools/wikipedia-candidate-diagnostic.mjs cleanup [--config=path] [--state=path]",
    "",
    "prepare uses pg_dump/pg_restore to make a disposable database copy. activate-diagnostic performs only",
    "real structural manifest/artifact/evidence checks and enables the normal runtime for diagnostic testing.",
    "It records qualification:false and does not assert learned-speech, calibration, or release readiness.",
    "Credentials are read from the runtime config or SCCE_DATABASE_URL and are never written or passed on a command line."
  ].join("\n") + "\n");
}

function flag(args, name, fallback) {
  const value = args.find(arg => arg.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
}

function configFor(configPath) {
  const config = readRuntimeConfig(configPath);
  const sourceUrl = config.database?.url?.trim();
  if (!sourceUrl) throw new Error("database.url is missing from the selected runtime config");
  const parsed = new URL(sourceUrl);
  if (!/^postgres(?:ql)?:$/iu.test(parsed.protocol)) throw new Error("database.url must be PostgreSQL");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("candidate diagnostics require the local host PostgreSQL endpoint");
  }
  const sourceDatabase = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  const sourceSchema = config.database?.schema ?? "scce3_runtime";
  if (!sourceDatabase || !IDENTIFIER_PATTERN.test(sourceSchema)) throw new Error("configured database/schema is invalid");
  return { config, sourceUrl, parsed, sourceDatabase, sourceSchema, sourceHost: parsed.hostname, sourcePort: parsed.port || null };
}

function quoteIdentifier(value) {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`unsafe PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function quoteExtension(value) {
  if (!/^[a-z_][a-z0-9_-]*$/u.test(value)) throw new Error(`unsafe PostgreSQL extension name: ${value}`);
  return `"${value}"`;
}

function connectionOptions(parsed, database) {
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database,
    ssl: parsed.searchParams.get("sslmode") && parsed.searchParams.get("sslmode") !== "disable" ? true : undefined
  };
}

function pgToolEnvironment(parsed, database) {
  const env = { ...process.env, PGDATABASE: database };
  if (parsed.hostname) env.PGHOST = parsed.hostname;
  if (parsed.port) env.PGPORT = parsed.port;
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

function runTool(executable, args, env) {
  const result = spawnSync(executable, args, { env, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 1200)}`);
}

async function connectAdmin(parsed) {
  const client = new pg.Client(connectionOptions(parsed, "postgres"));
  await client.connect();
  return client;
}

async function readState(statePath) {
  if (!existsSync(statePath)) throw new Error(`diagnostic state file does not exist: ${statePath}`);
  const value = JSON.parse(await readFile(statePath, "utf8"));
  const expectedDumpPath = path.resolve(repoRoot, ".tmp", `${value?.targetDatabase ?? ""}.dump`);
  const actualDumpPath = typeof value?.dumpPath === "string" ? path.resolve(value.dumpPath) : "";
  if (!value || value.schema !== "scce.wikipediaCandidateDiagnostic.v1" || !DATABASE_PATTERN.test(value.targetDatabase)
    || !IDENTIFIER_PATTERN.test(value.sourceSchema) || value.targetSchema !== value.sourceSchema
    || !value.sourceDatabase || value.sourceDatabase === value.targetDatabase
    || typeof value.sourceHost !== "string" || (value.sourcePort !== null && typeof value.sourcePort !== "string")
    || value.diagnosticOnly !== true || value.qualification !== false || actualDumpPath !== expectedDumpPath) {
    throw new Error("diagnostic state is malformed");
  }
  return value;
}

function assertSameSourceDatabase(state, config) {
  if (state.sourceDatabase !== config.sourceDatabase || state.sourceHost !== config.sourceHost || state.sourcePort !== config.sourcePort) {
    throw new Error("diagnostic state belongs to a different configured PostgreSQL endpoint");
  }
}

function runtimeHint(targetDatabase) {
  return {
    targetDatabase,
    credentialHandling: "set SCCE_DATABASE_URL externally; it is not recorded by this tool",
    server: "PowerShell: $env:SCCE_DATABASE_URL = '<target PostgreSQL URL>'; pnpm scce:server",
    cli: "PowerShell: $env:SCCE_DATABASE_URL = '<target PostgreSQL URL>'; pnpm scce"
  };
}

function stateRecord({ configPath, sourceDatabase, sourceHost, sourcePort, sourceSchema, targetDatabase, dumpPath }) {
  return {
    schema: "scce.wikipediaCandidateDiagnostic.v1",
    diagnosticOnly: true,
    qualification: false,
    configPath: path.resolve(configPath),
    sourceDatabase,
    sourceHost,
    sourcePort,
    sourceSchema,
    targetDatabase,
    targetSchema: sourceSchema,
    dumpPath: path.resolve(dumpPath),
    createdAt: new Date().toISOString()
  };
}

async function databaseExists(client, name) {
  const rows = await client.query("SELECT datname, pg_get_userbyid(datdba) = current_user AS owner FROM pg_database WHERE datname=$1", [name]);
  return rows.rows[0] ?? null;
}

async function installedExtensions(parsed, database) {
  const client = new pg.Client(connectionOptions(parsed, database));
  await client.connect();
  try {
    const result = await client.query("SELECT extname FROM pg_extension ORDER BY extname");
    return result.rows.map(row => row.extname).filter(name => typeof name === "string" && /^[a-z_][a-z0-9_-]*$/u.test(name));
  } finally { await client.end(); }
}

async function installExtensions(parsed, database, extensions) {
  if (extensions.length === 0) return;
  const client = new pg.Client(connectionOptions(parsed, database));
  await client.connect();
  try {
    for (const extension of extensions) await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteExtension(extension)}`);
  } finally { await client.end(); }
}

async function prepare(configPath, statePath, sourceSchemaFlag) {
  if (existsSync(statePath)) throw new Error(`diagnostic state already exists: ${statePath}`);
  const { parsed, sourceDatabase, sourceSchema, sourceHost, sourcePort } = configFor(configPath);
  const selectedSchema = sourceSchemaFlag ?? sourceSchema;
  if (!IDENTIFIER_PATTERN.test(selectedSchema)) throw new Error("source schema is unsafe");
  const targetDatabase = `scce_wikipedia_candidate_${randomBytes(8).toString("hex")}`;
  const dumpPath = path.join(repoRoot, ".tmp", `${targetDatabase}.dump`);
  await mkdir(path.dirname(dumpPath), { recursive: true });
  const extensions = await installedExtensions(parsed, sourceDatabase);
  const admin = await connectAdmin(parsed);
  try {
    if (sourceDatabase === targetDatabase) throw new Error("refusing to clone into the configured source database");
    if (await databaseExists(admin, targetDatabase)) throw new Error("generated diagnostic database already exists");
    await admin.query(`CREATE DATABASE ${quoteIdentifier(targetDatabase)}`);
  } finally { await admin.end(); }
  try {
    await installExtensions(parsed, targetDatabase, extensions);
    runTool("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--schema=${selectedSchema}`, "--file", dumpPath, "--dbname", sourceDatabase], pgToolEnvironment(parsed, sourceDatabase));
    runTool("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", targetDatabase, dumpPath], pgToolEnvironment(parsed, targetDatabase));
  } catch (error) {
    await dropDatabase(parsed, targetDatabase).catch(() => undefined);
    await rm(dumpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const state = stateRecord({ configPath, sourceDatabase, sourceHost, sourcePort, sourceSchema: selectedSchema, targetDatabase, dumpPath });
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryStatePath = `${statePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryStatePath, statePath);
  } catch (error) {
    await dropDatabase(parsed, targetDatabase).catch(() => undefined);
    await rm(dumpPath, { force: true }).catch(() => undefined);
    throw error;
  } finally { await rm(temporaryStatePath, { force: true }).catch(() => undefined); }
  process.stdout.write(`${JSON.stringify(state)}\n`);
}

async function dropDatabase(parsed, targetDatabase) {
  if (!DATABASE_PATTERN.test(targetDatabase)) throw new Error("refusing cleanup outside generated diagnostic database");
  const admin = await connectAdmin(parsed);
  try {
    const row = await databaseExists(admin, targetDatabase);
    if (!row) return false;
    if (row.owner !== true) throw new Error("refusing cleanup of a database not owned by current_user");
    await admin.query(`DROP DATABASE ${quoteIdentifier(targetDatabase)}`);
    return true;
  } finally { await admin.end(); }
}

async function tableCount(client, schema, table) {
  const present = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${schema}.${table}`]);
  if (!present[0]?.present) return null;
  const rows = await client.query(`SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
  return Number(rows[0]?.count ?? 0);
}

async function verifyEvidence(storage, state, manifest) {
  const dumpPath = manifest?.metadata?.result?.dumpPath;
  if (typeof dumpPath !== "string" || dumpPath.length === 0) return { scope: state.sourceSchema, spansChecked: 0, mismatches: 0, mismatchExamples: [], passed: false, message: "manifest has no dumpPath for evidence scoping" };
  let lastId = "";
  let spansChecked = 0;
  let mismatches = 0;
  const mismatchExamples = [];
  for (;;) {
    const rows = await storage.query(`
      SELECT e.id, e.byte_start, e.byte_end, e.char_start, e.char_end, e.text_content,
        sv.content_hash AS source_blob_hash, source_blob.byte_length AS source_byte_length, source_blob.content
      FROM ${storage.table("evidence_spans")} e
      JOIN ${storage.table("source_versions")} sv ON e.source_version_id=sv.id
      JOIN ${storage.table("blobs")} source_blob ON source_blob.content_hash=sv.content_hash
      WHERE sv.metadata_json->>'sourceSystem'='wikipedia' AND sv.metadata_json->>'dumpPath'=$1 AND e.id>$2
      ORDER BY e.id ASC LIMIT 64`, [dumpPath, lastId]);
    if (rows.length === 0) break;
    for (const row of rows) {
      const bytes = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content ?? []);
      const text = bytes.toString("utf8");
      const byteStart = Number(row.byte_start);
      const byteEnd = Number(row.byte_end);
      const charStart = Number(row.char_start);
      const charEnd = Number(row.char_end);
      const byteSurface = byteStart >= 0 && byteEnd >= byteStart && byteEnd <= bytes.length ? bytes.subarray(byteStart, byteEnd).toString("utf8") : null;
      const codepointSurface = charStart >= 0 && charEnd >= charStart ? [...text].slice(charStart, charEnd).join("") : null;
      const checks = [
        `sha256_${createHash("sha256").update(bytes).digest("hex")}` === row.source_blob_hash,
        Number(row.source_byte_length) === bytes.length,
        Number.isInteger(byteStart) && Number.isInteger(byteEnd) && byteStart >= 0 && byteEnd >= byteStart && byteEnd <= bytes.length,
        Number.isInteger(charStart) && Number.isInteger(charEnd) && charStart >= 0 && charEnd >= charStart && charEnd <= [...text].length,
        byteSurface === row.text_content,
        codepointSurface === row.text_content
      ];
      spansChecked += 1;
      if (checks.some(value => !value)) {
        mismatches += 1;
        if (mismatchExamples.length < 8) mismatchExamples.push({ id: row.id, failedChecks: checks.map((value, index) => value ? null : index).filter(value => value !== null) });
      }
      lastId = row.id;
    }
    if (rows.length < 64) break;
  }
  return { scope: dumpPath, spansChecked, mismatches, mismatchExamples, passed: mismatches === 0 };
}

async function manifestArtifactCounts(storage, state, manifest) {
  const result = manifest?.metadata?.result;
  const dumpPath = result?.dumpPath;
  if (typeof dumpPath !== "string" || dumpPath.length === 0) return { passed: false, message: "manifest has no dumpPath for artifact scoping" };
  const [row] = await storage.query(`
    SELECT
      (SELECT COUNT(*) FROM ${storage.table("source_versions")} sv WHERE sv.metadata_json->>'sourceSystem'='wikipedia' AND sv.metadata_json->>'dumpPath'=$1)::text AS source_versions,
      (SELECT COUNT(DISTINCT sv.source_id) FROM ${storage.table("source_versions")} sv WHERE sv.metadata_json->>'sourceSystem'='wikipedia' AND sv.metadata_json->>'dumpPath'=$1)::text AS pages,
      (SELECT COUNT(*) FROM ${storage.table("evidence_spans")} e JOIN ${storage.table("source_versions")} sv ON sv.id=e.source_version_id WHERE sv.metadata_json->>'sourceSystem'='wikipedia' AND sv.metadata_json->>'dumpPath'=$1)::text AS evidence`, [dumpPath]);
  const actual = { pages: Number(row?.pages ?? 0), sources: Number(row?.source_versions ?? 0), evidence: Number(row?.evidence ?? 0) };
  const expected = { pages: Number(result.pages ?? -1), sources: Number(result.sources ?? -1), evidence: Number(result.evidence ?? -1) };
  const passed = actual.pages === expected.pages && actual.sources === expected.sources && actual.evidence === expected.evidence;
  return { passed, expected, actual, message: passed ? "manifest page/source/evidence counts match scoped durable rows" : "manifest page/source/evidence counts differ from scoped durable rows" };
}

async function journalManifestCheck(storage, state, manifest) {
  const result = manifest?.metadata?.result;
  const inputManifestId = result?.inputManifestId;
  if (typeof inputManifestId !== "string" || inputManifestId.length === 0) {
    return { passed: false, message: "manifest metadata has no inputManifestId" };
  }
  const rows = await storage.query(`
    SELECT metadata_json->'languageBatch' AS language_batch
    FROM ${storage.table("ingestion_checkpoints")}
    WHERE metadata_json->>'inputManifestId'=$1
    ORDER BY updated_at DESC LIMIT 1`, [inputManifestId]);
  const progress = rows[0]?.language_batch?.progressCounts;
  const keys = ["pages", "sources", "evidence", "graphNodes", "graphEdges", "graphHyperedges", "languageProfiles", "ngramObservations", "ngramModels", "languageUnits", "languagePatterns", "semanticFrames", "relationCandidates", "promotedRelations"];
  const passed = !!progress && keys.every(key => Number(progress[key]) === Number(result[key] ?? 0));
  return { passed, inputManifestId, message: passed ? "manifest counts match the latest durable language-batch journal" : "manifest counts do not match the latest durable language-batch journal" };
}

async function diagnosticChecks(storage, state) {
  const lifecycleRows = await storage.query(`SELECT import_run_id, brain_version, state, manifest_json FROM ${quoteIdentifier(state.sourceSchema)}.${quoteIdentifier("brain_import_lifecycle")} WHERE state='VALIDATING' ORDER BY updated_at DESC, import_run_id LIMIT 1`);
  const candidate = lifecycleRows[0];
  const checks = [];
  if (!candidate) return { candidate: null, checks: [{ id: "candidate.validating", passed: false, message: "no VALIDATING Wikipedia candidate found" }], evidence: null, journal: null };
  const manifest = candidate.manifest_json;
  try {
    const manifestChecks = validateBrainManifestContract(manifest);
    checks.push(...manifestChecks.map(check => ({ id: `manifest.${check.id}`, passed: check.passed, message: check.message })));
    checks.push({ id: "candidate.source_schema", passed: manifest.sourceSchema === "scce.wikipediaV3Import.v1", message: "candidate is a Wikipedia v3 manifest" });
  } catch (error) {
    checks.push({ id: "manifest.contract", passed: false, message: `manifest contract could not be checked: ${error instanceof Error ? error.message : String(error)}` });
  }
  const journalCheck = await journalManifestCheck(storage, state, manifest);
  checks.push({ id: "manifest.journal_counts", passed: journalCheck.passed, message: journalCheck.message });
  const artifactCounts = await manifestArtifactCounts(storage, state, manifest);
  checks.push({ id: "manifest.artifact_counts", passed: artifactCounts.passed, message: artifactCounts.message });
  const evidence = await verifyEvidence(storage, state, manifest);
  checks.push({ id: "evidence.coordinate_contract", passed: evidence.passed, message: `${evidence.spansChecked} Wikipedia evidence spans checked; mismatches=${evidence.mismatches}` });
  for (const table of ["sources", "source_versions", "blobs", "evidence_spans", "language_profiles", "ngram_models"]) {
    const count = await tableCount(storage, state.sourceSchema, table);
    checks.push({ id: `artifact.${table}`, passed: count !== null && count > 0, message: `${table} count=${count ?? "missing"}`, count });
  }
  return { candidate, checks, evidence, journal: journalCheck };
}

async function status(configPath, statePath) {
  const state = await readState(statePath);
  const config = configFor(configPath);
  assertSameSourceDatabase(state, config);
  const targetUrl = new URL(config.sourceUrl);
  targetUrl.pathname = `/${state.targetDatabase}`;
  const targetStorage = createPostgresStorageAdapter({ url: targetUrl.toString(), schema: state.sourceSchema });
  try {
    const verification = await targetStorage.verify();
    const diagnostic = verification.ok ? await diagnosticChecks(targetStorage, state) : { candidate: null, checks: [] };
    const active = await targetStorage.brainImports.active();
    process.stdout.write(`${JSON.stringify({ ...state, targetDatabase: state.targetDatabase, verification, diagnostic, active, runtime: runtimeHint(state.targetDatabase), qualification: false })}\n`);
  } finally { await targetStorage.close(); }
}

async function activateDiagnostic(configPath, statePath) {
  const state = await readState(statePath);
  const config = configFor(configPath);
  assertSameSourceDatabase(state, config);
  const targetUrl = new URL(config.sourceUrl);
  targetUrl.pathname = `/${state.targetDatabase}`;
  const storage = createPostgresStorageAdapter({ url: targetUrl.toString(), schema: state.sourceSchema });
  try {
    const diagnostic = await diagnosticChecks(storage, state);
    if (!diagnostic.candidate || diagnostic.checks.some(check => !check.passed)) throw new Error(`diagnostic structural checks failed: ${diagnostic.checks.filter(check => !check.passed).map(check => check.id).join(", ")}`);
    const candidate = diagnostic.candidate;
    const validation = {
      schema: "scce.brainValidationReport.v1",
      importRunId: candidate.import_run_id,
      brainVersion: candidate.brain_version,
      manifestHash: candidate.manifest_json.manifestHash,
      validatorVersion: "wikipedia-candidate-diagnostic.v1",
      disposition: "PASSED",
      checks: diagnostic.checks.map(check => ({ id: check.id, passed: check.passed, severity: "error", message: check.message })),
      validatedAt: Date.now()
    };
    await storage.brainImports.transitionLifecycle({ importRunId: candidate.import_run_id, expectedState: "VALIDATING", toState: "READY", updatedAt: validation.validatedAt, reason: "diagnostic-only activation; not release qualification", validation });
    const active = await storage.brainImports.activateReady({ brainVersion: candidate.brain_version, importRunId: candidate.import_run_id, updatedAt: validation.validatedAt });
    process.stdout.write(`${JSON.stringify({ schema: "scce.wikipediaCandidateDiagnostic.activation.v1", diagnosticOnly: true, qualification: false, active, runtime: runtimeHint(state.targetDatabase), importRunId: candidate.import_run_id })}\n`);
  } finally { await storage.close(); }
}

async function cleanup(configPath, statePath) {
  const state = await readState(statePath);
  const config = configFor(configPath);
  assertSameSourceDatabase(state, config);
  const { parsed } = config;
  const dropped = await dropDatabase(parsed, state.targetDatabase);
  await rm(statePath, { force: true });
  await rm(state.dumpPath, { force: true });
  process.stdout.write(`${JSON.stringify({ schema: "scce.wikipediaCandidateDiagnostic.cleanup.v1", diagnosticOnly: true, targetDatabase: state.targetDatabase, dropped })}\n`);
}

const args = process.argv.slice(2);
const command = args[0] ?? "--help";
if (command === "--help" || command === "-h") help();
else {
  try {
    const configPath = flag(args, "config", process.env.SCCE_CONFIG ?? path.join(repoRoot, "scce.config.json"));
    const statePath = path.resolve(flag(args, "state", STATE_DEFAULT));
    if (command === "prepare") await prepare(configPath, statePath, flag(args, "source-schema", undefined));
    else if (command === "status") await status(configPath, statePath);
    else if (command === "activate-diagnostic") await activateDiagnostic(configPath, statePath);
    else if (command === "cleanup") await cleanup(configPath, statePath);
    else throw new Error(`unknown command: ${command}`);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error).replace(/postgres(?:ql)?:\/\/[^\s"'`]+/giu, "[redacted-database-url]").slice(0, 1400)}\n`);
    process.exitCode = 1;
  }
}
