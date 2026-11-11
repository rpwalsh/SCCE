#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

export const COHORTS = Object.freeze([64, 128, 256]);
export const IDS_PER_CONTRIBUTOR = 8;
export const DISPOSABLE_SCHEMA_PATTERN = /^scce_evidence_assoc_bench_[0-9a-f]{24}$/u;
const SHARED_NODE_ID = "shared-node";
const TOOL_SCHEMA = "scce.evidence_association_write_complexity_benchmark.v1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SUPPLIED_HISTORICAL_REFERENCE = Object.freeze({
  provenance: "user_supplied_historical_result_not_produced_by_this_invocation",
  source: "SCCE storage collapse implementation brief, prepared 2026-11-10",
  workload: { sharedNodes: 1, idsPerContributor: 8, evidenceIds: "distinct hash-shaped strings" },
  cohorts: [
    { contributors: 64, finalIds: 512, arrayWalBytes: 2_974_304, associationWalBytes: 297_680, arrayEntriesMaterialized: 16_640, associationEntriesInserted: 512 },
    { contributors: 128, finalIds: 1_024, arrayWalBytes: 12_154_992, associationWalBytes: 595_328, arrayEntriesMaterialized: 66_048, associationEntriesInserted: 1_024 },
    { contributors: 256, finalIds: 2_048, arrayWalBytes: 48_991_496, associationWalBytes: 1_219_704, arrayEntriesMaterialized: 263_168, associationEntriesInserted: 2_048,
      arrayElapsedMs: 1_178.22, associationElapsedMs: 139.67, arrayPreVacuumBytes: 26_566_656, associationPreVacuumBytes: 868_352 }
  ],
  caveat: "These figures are supplied history, not a result or reproduction claim from this tool run."
});

const usage = `Usage: node tools/evidence-association-benchmark.mjs --config <explicit-config.json> --out <new-receipt.json> --allow-disposable-schema

Runs fixed 64/128/256-contributor cohorts with 8 deterministic evidence IDs per contributor.
The selected config supplies connection details only. The configured SCCE schema is never read or
written. The tool creates a random scce_evidence_assoc_bench_* schema and drops only that schema.
The acknowledgement flag is mandatory. The output path must not already exist.`;

function merge(base, overlay) {
  if (overlay === null || typeof overlay !== "object" || Array.isArray(overlay)) return overlay ?? base;
  const result = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(overlay)) result[key] = merge(result[key], value);
  return result;
}

export function readExplicitConfig(configPath) {
  const absolute = path.resolve(configPath);
  let config = JSON.parse(readFileSync(absolute, "utf8"));
  const overlayPath = absolute.replace(/(\.json)?$/iu, "") + ".local.json";
  if (existsSync(overlayPath)) config = merge(config, JSON.parse(readFileSync(overlayPath, "utf8")));
  const url = config.database?.url;
  if (typeof url !== "string" || !url.trim()) throw new Error("The explicit config and its matching local overlay must provide database.url");
  return { absolute, overlayPath: existsSync(overlayPath) ? overlayPath : null, config };
}

export function parseBenchmarkArguments(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    config: { type: "string" }, out: { type: "string" }, "allow-disposable-schema": { type: "boolean" }, help: { type: "boolean", short: "h" }
  } });
  if (values.help) return { help: true };
  if (!values.config || !values.out) throw new Error("--config and --out are required");
  if (!values["allow-disposable-schema"]) throw new Error("--allow-disposable-schema is required; the benchmark creates and drops its own random schema");
  const configPath = path.resolve(values.config), outPath = path.resolve(values.out);
  const overlayPath = configPath.replace(/(\.json)?$/iu, "") + ".local.json";
  if ([configPath, overlayPath].some(candidate => candidate.toLowerCase() === outPath.toLowerCase())) {
    throw new Error("--out must not replace the selected config or its local overlay");
  }
  return { help: false, configPath, outPath };
}

export function evidenceId(contributor, slot) {
  assert.ok(Number.isSafeInteger(contributor) && contributor >= 0, "contributor must be a nonnegative integer");
  assert.ok(Number.isSafeInteger(slot) && slot >= 0 && slot < IDS_PER_CONTRIBUTOR, "slot is outside the fixed contributor batch");
  return createHash("sha256").update(`scce-evidence-association-benchmark:v1:${contributor}:${slot}`).digest("hex");
}

export function evidenceIds(contributors) {
  assert.ok(Number.isSafeInteger(contributors) && contributors > 0, "contributors must be a positive integer");
  return Array.from({ length: contributors * IDS_PER_CONTRIBUTOR }, (_, index) =>
    evidenceId(Math.floor(index / IDS_PER_CONTRIBUTOR), index % IDS_PER_CONTRIBUTOR));
}

export function cumulativeWork(contributors) {
  assert.ok(Number.isSafeInteger(contributors) && contributors > 0, "contributors must be a positive integer");
  return {
    finalMemberships: contributors * IDS_PER_CONTRIBUTOR,
    modeledArrayEntriesMaterialized: IDS_PER_CONTRIBUTOR * contributors * (contributors + 1) / 2,
    associationEntriesInserted: contributors * IDS_PER_CONTRIBUTOR,
    statementsPerVariant: contributors
  };
}

function digestMembership(ids) {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

export function compareMembership(expected, actual) {
  const expectedSorted = [...expected].sort(), actualSorted = [...actual].sort();
  const exact = expectedSorted.length === actualSorted.length && expectedSorted.every((value, index) => value === actualSorted[index]);
  return { exact, expectedCount: expectedSorted.length, actualCount: actualSorted.length,
    expectedSha256: digestMembership(expectedSorted), actualSha256: digestMembership(actualSorted) };
}

export function localValidationPlan() {
  const cohorts = COHORTS.map(contributors => {
    const ids = evidenceIds(contributors), work = cumulativeWork(contributors);
    assert.equal(new Set(ids).size, work.finalMemberships, "deterministic evidence generator collided");
    return { contributors, idsPerContributor: IDS_PER_CONTRIBUTOR, ...work, expectedMembershipSha256: digestMembership(ids) };
  });
  const negativeControlIds = evidenceIds(COHORTS[0]);
  const negativeControl = compareMembership(negativeControlIds, negativeControlIds.slice(1));
  assert.equal(negativeControl.exact, false, "membership negative control was not detected");
  const sql = benchmarkSql("scce_evidence_assoc_bench_0123456789abcdef01234567");
  const sqlContract = {
    arrayNodeLookupIndex: /PRIMARY KEY/u.test(sql.createArray.join("\n")),
    arrayEvidenceLookupIndex: /USING gin \(evidence_ids\)/u.test(sql.createArray.join("\n")),
    associationNodeLookupIndex: /PRIMARY KEY \(node_id, evidence_id\)/u.test(sql.createAssociation.join("\n")),
    associationEvidenceLookupIndex: /\(evidence_id, node_id\)/u.test(sql.createAssociation.join("\n")),
    arrayRewriteUsesExistingAndIncoming: /current\.evidence_ids \|\| EXCLUDED\.evidence_ids/u.test(sql.arrayUpsert),
    associationWriteUsesIndependentRows: /unnest\(\$2::text\[\]\)/u.test(sql.associationInsert)
  };
  assert.ok(Object.values(sqlContract).every(Boolean), "local SQL contract validation failed");
  return {
    passed: true,
    generator: "sha256('scce-evidence-association-benchmark:v1:<zero-based-contributor>:<zero-based-slot>')",
    sqlContract,
    cohorts,
    negativeControl: { passed: !negativeControl.exact, mutation: "omit the first expected ID", ...negativeControl }
  };
}

function quoteIdentifier(identifier) {
  assert.match(identifier, /^[a-z_][a-z0-9_]*$/u, "unsafe SQL identifier");
  return `"${identifier}"`;
}

function qualified(schema, relation) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`;
}

export function benchmarkSql(schema) {
  const arrayTable = qualified(schema, "array_membership"), associationTable = qualified(schema, "evidence_membership");
  return {
    arrayTable,
    associationTable,
    createArray: [
      `CREATE TABLE ${arrayTable} (node_id text PRIMARY KEY, evidence_ids text[] NOT NULL)`,
      `CREATE INDEX array_membership_evidence_gin ON ${arrayTable} USING gin (evidence_ids)`
    ],
    createAssociation: [
      `CREATE TABLE ${associationTable} (node_id text NOT NULL, evidence_id text NOT NULL, PRIMARY KEY (node_id, evidence_id))`,
      `CREATE INDEX evidence_membership_reverse_idx ON ${associationTable} (evidence_id, node_id)`
    ],
    arrayUpsert: `INSERT INTO ${arrayTable} AS current (node_id, evidence_ids) VALUES ($1, $2::text[])
      ON CONFLICT (node_id) DO UPDATE SET evidence_ids = (
        SELECT array_agg(DISTINCT member ORDER BY member)
        FROM unnest(current.evidence_ids || EXCLUDED.evidence_ids) AS incoming(member)
      )`,
    associationInsert: `INSERT INTO ${associationTable} (node_id, evidence_id)
      SELECT $1, member FROM unnest($2::text[]) AS incoming(member) ON CONFLICT DO NOTHING`,
    arrayByNode: `SELECT evidence_ids FROM ${arrayTable} WHERE node_id=$1`,
    associationByNode: `SELECT evidence_id FROM ${associationTable} WHERE node_id=$1 ORDER BY evidence_id`,
    arrayByEvidence: `SELECT node_id FROM ${arrayTable} WHERE evidence_ids @> ARRAY[$1]::text[] ORDER BY node_id`,
    associationByEvidence: `SELECT node_id FROM ${associationTable} WHERE evidence_id=$1 ORDER BY node_id`
  };
}

function gitIdentity() {
  const run = args => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", windowsHide: true }).trim();
  try {
    const status = run(["status", "--porcelain"]);
    return { commit: run(["rev-parse", "HEAD"]), dirty: Boolean(status), changedPathCount: status ? status.split(/\r?\n/u).length : 0 };
  } catch {
    return { commit: null, dirty: null, changedPathCount: null };
  }
}

function safeError(error, fallback) {
  const raw = error instanceof Error ? error.message : String(error);
  return { name: error?.name ?? "Error", code: typeof error?.code === "string" ? error.code : null,
    message: (raw || fallback).replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted-database-url]").replace(/password\s*=\s*\S+/giu, "password=[redacted]").slice(0, 800) };
}

export function assertDisposableSchemaName(schema) {
  assert.match(schema, DISPOSABLE_SCHEMA_PATTERN, "refusing to create or drop a schema outside the benchmark namespace");
}

async function allocation(client, schema, relation) {
  const result = await client.query(`SELECT pg_relation_size(c.oid)::text AS heap_bytes,
    pg_table_size(c.oid)::text AS table_and_toast_bytes,
    pg_indexes_size(c.oid)::text AS index_bytes,
    pg_total_relation_size(c.oid)::text AS total_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r'`, [schema, relation]);
  assert.equal(result.rowCount, 1, `missing benchmark relation ${relation}`);
  return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()), Number(value)]));
}

async function indexes(client, schema, relation) {
  const result = await client.query(`SELECT i.relname AS name,am.amname AS method,ix.indisprimary AS primary,ix.indisunique AS unique,
    pg_get_indexdef(i.oid) AS definition
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_index ix ON ix.indrelid=t.oid JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname=$1 AND t.relname=$2 ORDER BY i.relname`, [schema, relation]);
  return result.rows.map(row => ({ name: row.name, method: row.method, primary: row.primary, unique: row.unique, definition: row.definition }));
}

async function walLsn(client) {
  try {
    const result = await client.query("SELECT pg_current_wal_insert_lsn()::text AS lsn");
    return { available: true, lsn: result.rows[0].lsn };
  } catch (error) {
    return { available: false, error: safeError(error, "WAL insertion LSN is unavailable") };
  }
}

async function walMeasurement(client, before) {
  if (!before.available) return { available: false, reason: "start_lsn_unavailable", error: before.error };
  const after = await walLsn(client);
  if (!after.available) return { available: false, reason: "end_lsn_unavailable", error: after.error };
  try {
    const result = await client.query("SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::text AS bytes", [after.lsn, before.lsn]);
    return { available: true, startLsn: before.lsn, endLsn: after.lsn, bytes: Number(result.rows[0].bytes),
      scope: "cluster_wide_insertion_lsn_delta_background_activity_may_contribute" };
  } catch (error) {
    return { available: false, reason: "lsn_diff_unavailable", error: safeError(error, "WAL LSN difference is unavailable") };
  }
}

async function verifyIndexContract(client, schema, variant) {
  const relation = variant === "array" ? "array_membership" : "evidence_membership";
  const inventory = await indexes(client, schema, relation);
  const primary = inventory.find(index => index.primary && index.method === "btree");
  const reverse = variant === "array"
    ? inventory.find(index => index.name === "array_membership_evidence_gin" && index.method === "gin")
    : inventory.find(index => index.name === "evidence_membership_reverse_idx" && index.method === "btree");
  assert.ok(primary, `${variant} node-to-evidence primary index is missing`);
  assert.ok(reverse, `${variant} evidence-to-node reverse index is missing`);
  if (variant === "array") {
    assert.match(primary.definition, /USING btree \(node_id\)$/u, "array primary index has the wrong key order");
    assert.match(reverse.definition, /USING gin \(evidence_ids\)$/u, "array evidence index has the wrong key");
  } else {
    assert.match(primary.definition, /USING btree \(node_id, evidence_id\)$/u, "association primary index has the wrong key order");
    assert.match(reverse.definition, /USING btree \(evidence_id, node_id\)$/u, "association reverse index has the wrong key order");
  }
  return { passed: true, nodeToEvidence: primary.name, evidenceToNode: reverse.name, indexes: inventory };
}

async function runVariant(client, schema, variant, contributors) {
  const sql = benchmarkSql(schema), relation = variant === "array" ? "array_membership" : "evidence_membership";
  const createStatements = variant === "array" ? sql.createArray : sql.createAssociation;
  for (const statement of createStatements) await client.query(statement);
  const emptyAllocation = await allocation(client, schema, relation);
  const expected = evidenceIds(contributors), startWal = await walLsn(client), started = performance.now();
  let affectedRows = 0;
  for (let contributor = 0; contributor < contributors; contributor++) {
    const ids = Array.from({ length: IDS_PER_CONTRIBUTOR }, (_, slot) => evidenceId(contributor, slot));
    const result = await client.query(variant === "array" ? sql.arrayUpsert : sql.associationInsert, [SHARED_NODE_ID, ids]);
    affectedRows += result.rowCount ?? 0;
  }
  const elapsedMs = performance.now() - started, wal = await walMeasurement(client, startWal);
  const membershipResult = variant === "array"
    ? await client.query(sql.arrayByNode, [SHARED_NODE_ID])
    : await client.query(sql.associationByNode, [SHARED_NODE_ID]);
  const actual = variant === "array" ? membershipResult.rows[0]?.evidence_ids ?? [] : membershipResult.rows.map(row => row.evidence_id);
  const membership = compareMembership(expected, actual);
  assert.equal(membership.exact, true, `${variant} final membership differs from the deterministic oracle`);
  const samples = [expected[0], expected[Math.floor(expected.length / 2)], expected.at(-1)];
  for (const sample of samples) {
    const reverse = await client.query(variant === "array" ? sql.arrayByEvidence : sql.associationByEvidence, [sample]);
    assert.deepEqual(reverse.rows.map(row => row.node_id), [SHARED_NODE_ID], `${variant} reverse evidence lookup failed`);
  }
  const indexContract = await verifyIndexContract(client, schema, variant);
  const beforeMaintenance = await allocation(client, schema, relation);
  await client.query(`VACUUM (ANALYZE) ${qualified(schema, relation)}`);
  const afterVacuumAnalyze = await allocation(client, schema, relation);
  await client.query(`VACUUM (FULL, ANALYZE) ${qualified(schema, relation)}`);
  const afterVacuumFull = await allocation(client, schema, relation);
  await client.query(`DROP TABLE ${qualified(schema, relation)}`);
  return { result: {
    elapsedMs: Number(elapsedMs.toFixed(2)), affectedRows, wal,
    membership, reverseLookupSamplesChecked: samples.length, indexContract,
    allocation: { empty: emptyAllocation, beforeMaintenance, afterVacuumAnalyze, afterVacuumFull }
  }, membership: actual };
}

async function runLiveBenchmark(client, schema) {
  const metadata = await client.query("SELECT current_database() AS database, current_setting('server_version') AS server_version");
  const cohorts = [];
  for (const [index, contributors] of COHORTS.entries()) {
    const executionOrder = index % 2 === 0 ? ["array", "association"] : ["association", "array"];
    const results = {}, memberships = {};
    for (const variant of executionOrder) {
      const executed = await runVariant(client, schema, variant, contributors);
      results[variant] = executed.result; memberships[variant] = executed.membership;
    }
    const crossVariantMembership = compareMembership(memberships.array, memberships.association);
    assert.equal(crossVariantMembership.exact, true, "array and association variants retained different memberships");
    const arrayWal = results.array.wal.available ? results.array.wal.bytes : null;
    const associationWal = results.association.wal.available ? results.association.wal.bytes : null;
    cohorts.push({ contributors, idsPerContributor: IDS_PER_CONTRIBUTOR, executionOrder, cumulativeWork: cumulativeWork(contributors),
      crossVariantMembership,
      observedWalRatioArrayOverAssociation: arrayWal !== null && associationWal > 0 ? Number((arrayWal / associationWal).toFixed(4)) : null,
      variants: results });
  }
  return { status: "executed", database: metadata.rows[0].database, postgresVersion: metadata.rows[0].server_version, cohorts };
}

async function saveReceipt(outPath, report) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBenchmarkArguments(argv);
  if (options.help) { process.stdout.write(usage + "\n"); return 0; }
  if (existsSync(options.outPath)) throw new Error("--out must be a new path; refusing to replace an existing receipt");
  const selected = readExplicitConfig(options.configPath);
  const localValidation = localValidationPlan();
  const report = {
    schema: TOOL_SCHEMA, createdAt: new Date().toISOString(), status: "preflight",
    classification: "synthetic_postgresql_scaling_test",
    build: { ...gitIdentity(), node: process.version },
    safety: {
      explicitConfigPath: selected.absolute,
      matchingLocalOverlayUsed: selected.overlayPath,
      environmentDatabaseOverrideIgnored: Boolean(process.env.SCCE_DATABASE_URL),
      configuredScceSchemaIgnored: selected.config.database?.schema ?? null,
      benchmarkSchema: null,
      policy: "Create a random benchmark-owned schema; fully qualify every relation; drop only that validated schema; never read or write the configured SCCE schema."
    },
    workload: { sharedNodes: 1, idsPerContributor: IDS_PER_CONTRIBUTOR, cohorts: COHORTS, transactionShape: "one autocommit DML statement per contributor per variant" },
    localValidation,
    suppliedHistoricalReference: SUPPLIED_HISTORICAL_REFERENCE,
    liveRun: null,
    cleanup: { attempted: false, schemaDropped: false },
    caveats: [
      "WAL is a cluster-wide insertion-LSN delta; unrelated cluster activity can contribute.",
      "Elapsed times are a single local synthetic run, not an inference or end-to-end ingestion latency benchmark.",
      "Allocation before maintenance includes dead row versions and GIN pending state. VACUUM ANALYZE and VACUUM FULL sizes are reported separately.",
      "Modeled cumulative entries describe the known rewrite algorithm; they are not PostgreSQL buffer-I/O counters.",
      "Supplied historical figures are provenance-separated and are never relabeled as results of this invocation."
    ]
  };
  const schema = `scce_evidence_assoc_bench_${randomBytes(12).toString("hex")}`;
  assertDisposableSchemaName(schema); report.safety.benchmarkSchema = schema;
  let client, connected = false, schemaCreated = false, exitCode = 0, stage = "load-postgres-client";
  try {
    const require = createRequire(new URL("../packages/adapters-node/package.json", import.meta.url));
    const { Client } = require("pg");
    client = new Client({ connectionString: selected.config.database.url, ...(selected.config.database.ssl === undefined ? {} : { ssl: selected.config.database.ssl }),
      application_name: "scce-evidence-association-benchmark", connectionTimeoutMillis: 5_000 });
    stage = "connect";
    try { await client.connect(); connected = true; }
    catch (error) {
      report.status = "skipped_postgresql_unavailable";
      report.liveRun = { status: "skipped_postgresql_unavailable", reason: "Could not connect using the explicitly selected config; no schema was created.", error: safeError(error, "PostgreSQL connection unavailable") };
    }
    if (connected) {
      await client.query("SET statement_timeout='60s'");
      await client.query("SET lock_timeout='5s'");
      stage = "create-disposable-schema";
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`); schemaCreated = true;
      stage = "execute-cohorts";
      report.liveRun = await runLiveBenchmark(client, schema);
      report.status = "executed";
    }
  } catch (error) {
    report.status = "failed"; exitCode = 1;
    report.liveRun = { status: "failed", stage, error: safeError(error, "Benchmark failed") };
  } finally {
    if (schemaCreated) {
      report.cleanup.attempted = true;
      try {
        assertDisposableSchemaName(schema);
        await client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
        report.cleanup.schemaDropped = true;
      } catch (error) {
        report.cleanup.error = safeError(error, "Benchmark schema cleanup failed");
        report.status = "failed_cleanup"; exitCode = 1;
      }
    }
    if (client) {
      try { await client.end(); } catch (error) {
        report.cleanup.connectionCloseError = safeError(error, "PostgreSQL connection close failed");
        if (connected) { report.status = "failed_cleanup"; exitCode = 1; }
      }
    }
  }
  await saveReceipt(options.outPath, report);
  process.stdout.write(JSON.stringify({ status: report.status, receipt: options.outPath, cleanup: report.cleanup }) + "\n");
  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
if (invokedPath === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1;
  });
}

