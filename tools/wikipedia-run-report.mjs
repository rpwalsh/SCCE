#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Read-only measured report for a bounded Wikipedia ingestion run.
// This tool never migrates, writes, or prints a database URL.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const SAFE_SCHEMA = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const BATCH_SIZE = 32;
const args = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const configPath = args.config ?? process.env.SCCE_REHEARSAL_CONFIG ?? "scce.config.json";
let statusInput;
let traceSummary;
let storage;
let report;

try {
  if (!args.schema || !SAFE_SCHEMA.test(args.schema)) throw new Error("--schema must be a safe PostgreSQL identifier");
  const configModule = await import("../packages/adapters-node/dist/index.js");
  const config = await configModule.readScceRuntimeConfig(configPath);
  statusInput = args.status ? await readJson(args.status, "status") : undefined;
  traceSummary = args.trace ? await aggregateTrace(args.trace) : { provided: false };
  storage = configModule.createPostgresStorageAdapter({
    url: config.database.url,
    schema: args.schema,
    ssl: config.database.ssl
  });

  const database = await storage.transaction(async () => {
    await storage.query("SET TRANSACTION READ ONLY");
    return inspectDatabase(storage, statusInput);
  });
  report = buildReport({ database, status: statusInput, trace: traceSummary, elapsedMs: Date.now() - startedAt, configPath });
} catch (error) {
  report = buildFailureReport({ error, status: statusInput, trace: traceSummary, elapsedMs: Date.now() - startedAt, configPath, schema: args.schema ?? null });
} finally {
  if (storage) await storage.close().catch(() => undefined);
}

await writeReport(args.out ?? "artifacts/wikipedia-run-report.json", report);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status === "failed") process.exitCode = 1;

function parseArgs(raw) {
  const out = {};
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument ${item}`);
    const equal = item.indexOf("=");
    const name = equal >= 0 ? item.slice(2, equal) : item.slice(2);
    const value = equal >= 0 ? item.slice(equal + 1) : raw[++index];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    if (!["schema", "status", "trace", "out", "config"].includes(name)) throw new Error(`unknown option --${name}`);
    out[name] = value;
  }
  return out;
}

async function inspectDatabase(adapter, status) {
  const sourceScope = wikiScope(status);
  const schemaInspection = await queryRows(adapter, `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema=$1 AND table_type='BASE TABLE'
    ORDER BY table_name`, [adapter.schema]);
  const requiredTables = [
    "sources", "source_versions", "blobs", "evidence_spans", "ingestion_checkpoints",
    "language_profiles", "ngram_observations", "ngram_models", "language_units", "language_patterns",
    "semantic_frames", "translation_alignments", "relation_observations", "brain_import_lifecycle",
    "calibration_observations"
  ];
  const present = new Set(schemaInspection.map(row => row.table_name));
  const missing = requiredTables.filter(table => !present.has(table));
  if (missing.length) throw new Error(`schema is missing required report tables: ${missing.join(", ")}`);

  const pages = await wikiPages(adapter, sourceScope);
  const versions = await wikiVersions(adapter, sourceScope);
  const learned = await learnedCounts(adapter);
  const pending = await pendingJournal(adapter, status?.rootUri, status?.inputManifestId);
  const lifecycle = await lifecycleCounts(adapter);
  const calibration = await calibrationCounts(adapter);
  const evidence = await verifyEvidence(adapter, sourceScope);
  const statusConsistency = compareStatusCounts(sourceScope, pages, versions, evidence, pending, status);
  return {
    schema: adapter.schema,
    schemaInspection: { tableCount: schemaInspection.length, missingRequiredTables: missing },
    wikipedia: { pages, sourceVersions: versions },
    learnedTables: learned,
    journal: pending,
    lifecycle,
    calibration,
    evidenceOffsets: evidence,
    statusConsistency
  };
}

function compareStatusCounts(scope, pages, versions, evidence, journal, status) {
  const stable = status && ["completed", "stopped", "failed"].includes(status.state);
  const progress = journal.progressCounts;
  const checks = {
    snapshotAvailableWhenStable: !stable || progress !== null,
    pages: !stable || progress === null || progress.pages === pages.pageSources,
    sources: !stable || progress === null || progress.sources === versions.total,
    evidence: !stable || progress === null || progress.evidence === evidence.spansChecked
  };
  return {
    runLocalStatus: { pages: scope.expectedPages, sources: scope.expectedSources, evidence: scope.expectedEvidence, state: status?.state ?? null },
    journalProgressCounts: progress,
    durable: { pages: pages.pageSources, sources: versions.total, evidence: evidence.spansChecked },
    checks,
    comparison: stable ? "journal-progress-counts" : status ? "deferred-while-writer-may-be-active" : "no-status",
    passed: Object.values(checks).every(Boolean)
  };
}

function wikiScope(status) {
  const dumpPath = typeof status?.dumpPath === "string" && status.dumpPath.trim() ? status.dumpPath : null;
  return {
    dumpPath,
    expectedPages: Number.isFinite(Number(status?.pages)) ? Number(status.pages) : null,
    expectedSources: Number.isFinite(Number(status?.sources)) ? Number(status.sources) : null,
    expectedEvidence: Number.isFinite(Number(status?.evidence)) ? Number(status.evidence) : null
  };
}

function wikiWhere(adapter, alias, scope, params = []) {
  const where = [`(${alias}.namespace LIKE 'wikipedia-%' OR ${alias}.canonical_uri LIKE 'wikipedia://%')`];
  if (scope.dumpPath) {
    params.push(scope.dumpPath);
    where.push(`${alias}.id IN (SELECT source_id FROM ${adapter.table("source_versions")} WHERE metadata_json->>'sourceSystem'='wikipedia' AND metadata_json->>'dumpPath'=$${params.length})`);
  }
  return where;
}

async function wikiPages(adapter, scope) {
  const params = [];
  const where = wikiWhere(adapter, "s", scope, params);
  const [row] = await queryRows(adapter, `
    SELECT COUNT(DISTINCT sv.source_id)::text AS source_rows,
      COUNT(DISTINCT sv.source_id) FILTER (WHERE sv.metadata_json ? 'pageId')::text AS page_sources,
      COUNT(DISTINCT sv.source_id) FILTER (WHERE NOT (sv.metadata_json ? 'pageId'))::text AS non_page_sources
    FROM ${adapter.table("source_versions")} sv JOIN ${adapter.table("sources")} s ON s.id=sv.source_id
    WHERE ${where.join(" AND ")} AND sv.metadata_json->>'sourceSystem'='wikipedia'`, params);
  return {
    sourceRows: Number(row?.source_rows ?? 0),
    pageSources: Number(row?.page_sources ?? 0),
    nonPageSources: Number(row?.non_page_sources ?? 0),
    scope: scope.dumpPath ? "status.dumpPath" : "all-wikipedia-sources"
  };
}

async function wikiVersions(adapter, scope) {
  const params = [];
  const where = wikiWhere(adapter, "s", scope, params);
  const [row] = await queryRows(adapter, `
    SELECT COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE sv.metadata_json #>> '{_scceSourceVersion,role}'='original')::text AS original,
      COUNT(*) FILTER (WHERE sv.metadata_json #>> '{_scceSourceVersion,role}'='evidence-derivative')::text AS derivative,
      COUNT(*) FILTER (WHERE sv.metadata_json ? 'pageId' AND sv.metadata_json #>> '{_scceSourceVersion,role}'='original')::text AS page_original,
      COUNT(*) FILTER (WHERE sv.metadata_json ? 'pageId' AND sv.metadata_json #>> '{_scceSourceVersion,role}'='evidence-derivative')::text AS page_derivative,
      COUNT(*) FILTER (WHERE NOT (sv.metadata_json ? 'pageId'))::text AS non_page
    FROM ${adapter.table("source_versions")} sv JOIN ${adapter.table("sources")} s ON s.id=sv.source_id
    WHERE ${where.join(" AND ")} AND sv.metadata_json->>'sourceSystem'='wikipedia'`, params);
  return {
    total: Number(row?.total ?? 0),
    original: Number(row?.original ?? 0),
    derivative: Number(row?.derivative ?? 0),
    pageOriginal: Number(row?.page_original ?? 0),
    pageDerivative: Number(row?.page_derivative ?? 0),
    nonPage: Number(row?.non_page ?? 0),
    scope: scope.dumpPath ? "status.dumpPath" : "all-wikipedia-sources"
  };
}

async function learnedCounts(adapter) {
  const tables = [
    "language_profiles", "ngram_observations", "ngram_models", "language_units", "language_patterns",
    "semantic_frames", "translation_alignments", "relation_observations", "segmentation_aggregates",
    "induced_language_models", "segmentation_population_models", "language_identities"
  ];
  const counts = {};
  for (const table of tables) {
    const [row] = await queryRows(adapter, `SELECT COUNT(*)::text AS count FROM ${adapter.table(table)}`);
    counts[table] = Number(row?.count ?? 0);
  }
  return { scope: "schema-total", counts };
}

async function pendingJournal(adapter, rootUri, inputManifestId) {
  const params = [];
  const where = ["metadata_json ? 'languageBatch'"];
  if (rootUri) {
    params.push(rootUri);
    where.push(`root_uri=$${params.length}`);
  }
  if (inputManifestId) {
    params.push(inputManifestId);
    where.push(`metadata_json->>'inputManifestId'=$${params.length}`);
  }
  const [row] = await queryRows(adapter, `
    SELECT COUNT(*) FILTER (WHERE metadata_json->'languageBatch'->>'state'='open')::text AS open_rows,
      COUNT(*) FILTER (WHERE metadata_json->'languageBatch'->>'state'='idle')::text AS idle_rows,
      COALESCE(MAX(jsonb_array_length(COALESCE(metadata_json->'languageBatch'->'pendingSamples','[]'::jsonb))),0)::text AS pending_samples,
      COALESCE(MAX((metadata_json->'languageBatch'->>'pendingChars')::bigint),0)::text AS max_pending_chars,
      (ARRAY_AGG(metadata_json->'inputManifestId' ORDER BY updated_at DESC))[1] AS input_manifest_id,
      (ARRAY_AGG(metadata_json->'languageBatch'->>'state' ORDER BY updated_at DESC))[1] AS latest_state,
      (ARRAY_AGG(metadata_json->'languageBatch'->>'languageTrainingDocumentCount' ORDER BY updated_at DESC))[1] AS accepted_for_training,
      (ARRAY_AGG(metadata_json->'languageBatch'->>'languageSkippedDocumentCount' ORDER BY updated_at DESC))[1] AS omitted_by_training_limit,
      (ARRAY_AGG(metadata_json->'languageBatch'->'progressCounts' ORDER BY updated_at DESC))[1] AS progress_counts
    FROM ${adapter.table("ingestion_checkpoints")}
    WHERE ${where.join(" AND ")}`, params);
  const progress = row?.progress_counts && typeof row.progress_counts === "object" && !Array.isArray(row.progress_counts)
    ? row.progress_counts
    : null;
  return {
    scope: rootUri ? (inputManifestId ? "status.rootUri+inputManifestId" : "status.rootUri") : "schema-total",
    inputManifestId: row?.input_manifest_id ?? null,
    latestState: row?.latest_state ?? null,
    openRows: Number(row?.open_rows ?? 0),
    idleRows: Number(row?.idle_rows ?? 0),
    pendingSamples: Number(row?.pending_samples ?? 0),
    maxPendingChars: Number(row?.max_pending_chars ?? 0),
    trainingDocuments: row?.accepted_for_training === undefined || row?.accepted_for_training === null
      ? null
      : {
        acceptedForTraining: Number(row.accepted_for_training),
        pendingSamples: Number(row.pending_samples ?? 0),
        committedTrainingDocuments: Math.max(0, Number(row.accepted_for_training) - Number(row.pending_samples ?? 0)),
        omittedByTrainingLimit: Number(row.omitted_by_training_limit ?? 0)
      },
    progressCounts: progress
  };
}

async function lifecycleCounts(adapter) {
  const rows = await queryRows(adapter, `SELECT state, COUNT(*)::text AS count FROM ${adapter.table("brain_import_lifecycle")} GROUP BY state ORDER BY state`);
  return Object.fromEntries(rows.map(row => [row.state, Number(row.count)]));
}

async function calibrationCounts(adapter) {
  const [total] = await queryRows(adapter, `SELECT COUNT(*)::text AS count, COUNT(DISTINCT calibration_id)::text AS calibration_ids FROM ${adapter.table("calibration_observations")}`);
  const rows = await queryRows(adapter, `SELECT calibration_id, COUNT(*)::text AS count FROM ${adapter.table("calibration_observations")} GROUP BY calibration_id ORDER BY calibration_id`);
  return {
    total: Number(total?.count ?? 0),
    distinctCalibrationIds: Number(total?.calibration_ids ?? 0),
    byCalibrationId: Object.fromEntries(rows.map(row => [row.calibration_id, Number(row.count)]))
  };
}

async function verifyEvidence(adapter, scope) {
  const params = [];
  const where = ["e.source_version_id=sv.id", "sv.metadata_json->>'sourceSystem'='wikipedia'"];
  if (scope.dumpPath) {
    params.push(scope.dumpPath);
    where.push(`sv.metadata_json->>'dumpPath'=$${params.length}`);
  }
  let lastId = "";
  let spans = 0;
  let blobs = 0;
  let mismatches = 0;
  const mismatchExamples = [];
  for (;;) {
    const batchParams = [...params, lastId, BATCH_SIZE];
    const rows = await queryRows(adapter, `
      SELECT e.id, e.byte_start, e.byte_end, e.char_start, e.char_end, e.text_content,
        sv.content_hash AS source_blob_hash, source_blob.byte_length AS source_byte_length, source_blob.content
      FROM ${adapter.table("evidence_spans")} e
      JOIN ${adapter.table("source_versions")} sv ON ${where.join(" AND ")}
      JOIN ${adapter.table("blobs")} source_blob ON source_blob.content_hash=sv.content_hash
      WHERE e.id>$${params.length + 1}
      ORDER BY e.id ASC LIMIT $${params.length + 2}`, batchParams);
    if (!rows.length) break;
    for (const row of rows) {
      spans += 1;
      const bytes = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content ?? []);
      const digest = `sha256_${createHash("sha256").update(bytes).digest("hex")}`;
      const text = bytes.toString("utf8");
      const byteStart = Number(row.byte_start);
      const byteEnd = Number(row.byte_end);
      const charStart = Number(row.char_start);
      const charEnd = Number(row.char_end);
      const byteSurface = byteStart >= 0 && byteEnd >= byteStart && byteEnd <= bytes.length ? bytes.subarray(byteStart, byteEnd).toString("utf8") : null;
      const codepointSurface = charStart >= 0 && charEnd >= charStart ? [...text].slice(charStart, charEnd).join("") : null;
      const checks = [
        digest === row.source_blob_hash,
        Number(row.source_byte_length) === bytes.length,
        Number.isInteger(byteStart) && Number.isInteger(byteEnd) && byteStart >= 0 && byteEnd >= byteStart && byteEnd <= bytes.length,
        Number.isInteger(charStart) && Number.isInteger(charEnd) && charStart >= 0 && charEnd >= charStart && charEnd <= [...text].length,
        byteSurface === row.text_content,
        codepointSurface === row.text_content
      ];
      blobs += 1;
      if (checks.some(value => !value)) {
        mismatches += 1;
        if (mismatchExamples.length < 8) mismatchExamples.push({ id: row.id, failedChecks: checks.map((value, index) => value ? null : index).filter(value => value !== null) });
      }
      lastId = row.id;
    }
    if (rows.length < BATCH_SIZE) break;
  }
  return { scope: scope.dumpPath ? "status.dumpPath" : "all-wikipedia-source-versions", coordinateContract: "source-contract-codepoint-indexed-char-ranges", spansChecked: spans, blobsHashed: blobs, mismatches, mismatchExamples, boundedBatchSize: BATCH_SIZE, passed: mismatches === 0 };
}

async function aggregateTrace(filePath) {
  const byStage = new Map();
  let records = 0;
  let malformed = 0;
  let sampledPeakHeapBeforeMB = null;
  let sampledPeakHeapAfterMB = null;
  let sampledPeakRssAfterMB = null;
  const input = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { malformed += 1; continue; }
    if (entry?.phase !== "end" || typeof entry.stage !== "string") continue;
    records += 1;
    const current = byStage.get(entry.stage) ?? { calls: 0, wallMs: 0, cpuUserMs: 0, cpuSystemMs: 0, counters: {} };
    current.calls += 1;
    current.wallMs += finite(entry.wallMs);
    current.cpuUserMs += finite(entry.cpuUserMs);
    current.cpuSystemMs += finite(entry.cpuSystemMs);
    sampledPeakHeapBeforeMB = maximum(sampledPeakHeapBeforeMB, entry.heapBeforeMB);
    sampledPeakHeapAfterMB = maximum(sampledPeakHeapAfterMB, entry.heapAfterMB);
    sampledPeakRssAfterMB = maximum(sampledPeakRssAfterMB, entry.rssAfterMB);
    if (entry.counters && typeof entry.counters === "object") {
      for (const [key, value] of Object.entries(entry.counters)) if (typeof value === "number" && Number.isFinite(value)) current.counters[key] = (current.counters[key] ?? 0) + value;
    }
    byStage.set(entry.stage, current);
  }
  return {
    provided: true,
    records,
    malformed,
    sampledPeaks: { heapBeforeMB: sampledPeakHeapBeforeMB, heapAfterMB: sampledPeakHeapAfterMB, rssAfterMB: sampledPeakRssAfterMB, note: "maxima from recorded stage samples; not an OS process peak" },
    byStage: Object.fromEntries([...byStage.entries()].sort(([a], [b]) => a.localeCompare(b)))
  };
}

function buildReport({ database, status, trace, elapsedMs, configPath }) {
  const pages = Number(status?.pages ?? database.wikipedia.pages.pageSources);
  const statusElapsedMs = status?.startedAt && (status.finishedAt ?? status.updatedAt) ? Math.max(0, Number(status.finishedAt ?? status.updatedAt) - Number(status.startedAt)) : null;
  const training = status
    ? { assessment: status.fullTrainingComplete === true ? "reported_complete_by_ingestor" : "partial_or_incomplete", state: status.state, fullTrainingRequested: status.fullTrainingRequested === true, fullTrainingComplete: status.fullTrainingComplete === true, stoppedByHeapSafetyBound: status.stoppedByHeapSafetyBound === true, stoppedByOwner: status.stoppedByOwner === true, warnings: Array.isArray(status.warnings) ? status.warnings.length : null }
    : { assessment: "unknown_without_status", reason: "no --status file supplied" };
  const passed = database.evidenceOffsets.passed && database.statusConsistency.passed && database.schemaInspection.missingRequiredTables.length === 0;
  return {
    schema: "scce.wikipediaRunReport.v1",
    status: passed ? "passed" : "failed",
    credentialsRecorded: false,
    configPath: path.resolve(configPath),
    database: { schema: database.schema, readOnlyTransaction: true },
    elapsedMs,
    ingestion: { statusPages: status?.pages ?? null, pagesMeasured: pages, pagesPerSecond: rate(pages, statusElapsedMs ?? elapsedMs), statusElapsedMs },
    training,
    databaseInspection: database,
    trace
  };
}

function buildFailureReport({ error, status, trace, elapsedMs, configPath, schema }) {
  return { schema: "scce.wikipediaRunReport.v1", status: "failed", credentialsRecorded: false, configPath: path.resolve(configPath), database: { schema, readOnlyTransaction: false }, elapsedMs, ingestion: { statusPages: status?.pages ?? null, pagesMeasured: null, pagesPerSecond: null, statusElapsedMs: null }, training: { assessment: status ? "unverified_due_to_report_error" : "unknown_without_status" }, trace: trace ?? { provided: false }, error: safeMessage(error) };
}

async function queryRows(adapter, sql, params = []) { return adapter.query(sql, params); }

function finite(value) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function maximum(current, value) { return typeof value === "number" && Number.isFinite(value) ? Math.max(current ?? value, value) : current; }
function rate(pages, elapsedMs) { return elapsedMs > 0 && Number.isFinite(pages) ? Number((pages / (elapsedMs / 1000)).toFixed(3)) : null; }
function safeMessage(error) { return String(error instanceof Error ? error.message : error).replace(/postgres(?:ql)?:\/\/[^\s"'`]+/giu, "[redacted-database-url]").slice(0, 1200); }

async function readJson(filePath, label) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) { throw new Error(`unable to read ${label} file ${path.resolve(filePath)}: ${safeMessage(error)}`); }
}

async function writeReport(filePath, value) {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
