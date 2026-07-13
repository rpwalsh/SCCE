#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPostgresStorageAdapter, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

const configPath = process.env.YOPP_REHEARSAL_CONFIG ?? "scce.config.json";
const suffix = `${process.pid}_${Date.now()}`;
const schema = `yopp_rehearsal_${suffix}`;
if (!/^yopp_rehearsal_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe rehearsal schema name");

const startedAt = new Date().toISOString();
let storage;
let primaryError;
const checks = [];
try {
  const config = await readScceRuntimeConfig(configPath);
  storage = createPostgresStorageAdapter({ url: config.database.url, schema, ssl: config.database.ssl });
  await seedLegacyDuplicateActiveRows();
  await storage.migrate();
  const verification = await storage.verify();
  check("schema.verify", verification.ok, verification.errors.join("; "));
  const migratedActive = await storage.brainImports.listLifecycle({ state: "ACTIVE", limit: 10 });
  const migratedReady = await storage.brainImports.getLifecycle("legacy-orphan-active");
  check(
    "migration.repair_multiple_active",
    same(migratedActive.map(row => row.importRunId), ["legacy-marker-active"]) && migratedReady?.state === "READY",
    JSON.stringify({ active: migratedActive.map(row => row.importRunId), orphan: migratedReady?.state })
  );
  let duplicateActiveRejected = false;
  try {
    await storage.query(`UPDATE "${schema}".brain_import_lifecycle SET state='ACTIVE' WHERE import_run_id='legacy-orphan-active'`);
  } catch (error) {
    duplicateActiveRejected = error && typeof error === "object" && error.code === "23505";
  }
  check("schema.single_active_unique_index", duplicateActiveRejected, duplicateActiveRejected ? "duplicate ACTIVE rejected" : "duplicate ACTIVE accepted");

  const first = lifecycle("rehearsal-run-a", "rehearsal-brain-a", 1_000);
  await storage.brainImports.putLifecycle(first);
  await transitionToReady(first.importRunId, 1_001);
  await storage.brainImports.activateReady({ brainVersion: first.brainVersion, importRunId: first.importRunId, updatedAt: 1_004 });
  const firstActive = await storage.brainImports.active();
  check("activation.first", firstActive.activeBrainVersion === first.brainVersion && same(firstActive.activeImportRunIds, [first.importRunId]), JSON.stringify(firstActive));

  const second = lifecycle("rehearsal-run-b", "rehearsal-brain-b", 2_000);
  await storage.brainImports.putLifecycle(second);
  let rejectedNonReady = false;
  try {
    await storage.brainImports.activateReady({ brainVersion: second.brainVersion, importRunId: second.importRunId, updatedAt: 2_001 });
  } catch {
    rejectedNonReady = true;
  }
  check("activation.reject_non_ready", rejectedNonReady, rejectedNonReady ? "CREATED candidate was rejected" : "CREATED candidate was accepted");
  const activeAfterRejectedCandidate = await storage.brainImports.active();
  check(
    "activation.failed_candidate_preserves_active",
    same(activeAfterRejectedCandidate.activeImportRunIds, [first.importRunId]),
    JSON.stringify(activeAfterRejectedCandidate)
  );

  await transitionToReady(second.importRunId, 2_002);
  await storage.brainImports.activateReady({ brainVersion: second.brainVersion, importRunId: second.importRunId, updatedAt: 2_005 });
  const replacement = await storage.brainImports.active();
  const oldLifecycle = await storage.brainImports.getLifecycle(first.importRunId);
  const newLifecycle = await storage.brainImports.getLifecycle(second.importRunId);
  check("activation.replacement_marker", replacement.activeBrainVersion === second.brainVersion && same(replacement.activeImportRunIds, [second.importRunId]), JSON.stringify(replacement));
  check("activation.replacement_states", oldLifecycle?.state === "READY" && newLifecycle?.state === "ACTIVE", JSON.stringify({ old: oldLifecycle?.state, next: newLifecycle?.state }));
} catch (error) {
  primaryError = error;
} finally {
  if (storage) {
    try {
      if (!/^yopp_rehearsal_[a-z0-9_]+$/u.test(storage.schema)) throw new Error("refusing cleanup outside rehearsal schema");
      await storage.query(`DROP SCHEMA IF EXISTS "${storage.schema}" CASCADE`);
      checks.push({ id: "cleanup.drop_disposable_schema", passed: true, detail: storage.schema });
    } catch (error) {
      checks.push({ id: "cleanup.drop_disposable_schema", passed: false, detail: message(error) });
      primaryError ??= error;
    }
    await storage.close().catch(error => { primaryError ??= error; });
  }
}

const report = {
  schema: "yopp.live_postgres_rehearsal.v1",
  startedAt,
  completedAt: new Date().toISOString(),
  configPath: path.resolve(configPath),
  disposableSchema: schema,
  credentialsRecorded: false,
  checks,
  status: !primaryError && checks.every(check => check.passed) ? "passed" : "failed",
  error: primaryError ? message(primaryError) : null
};
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/live-postgres-rehearsal.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;

function lifecycle(importRunId, brainVersion, createdAt) {
  const manifestHash = sha256(`${importRunId}:${brainVersion}`);
  return {
    importRunId,
    brainVersion,
    rootPath: `rehearsal://${importRunId}`,
    state: "CREATED",
    manifest: {
      schema: "scce.brainManifestContract.v1",
      importRunId,
      brainVersion,
      rootPath: `rehearsal://${importRunId}`,
      manifestHash,
      sourceSchema: "yopp.live_postgres_rehearsal.v1",
      runtimeContractVersion: 1,
      content: { graphShardCount: 1, languageShardCount: 1, ngramStateCount: 0, priorSectionCount: 1 },
      metadata: { rehearsal: true },
      createdAt
    },
    revision: 0,
    createdAt,
    updatedAt: createdAt
  };
}

async function seedLegacyDuplicateActiveRows() {
  await storage.query(`CREATE SCHEMA "${schema}"`);
  await storage.query(
    `CREATE TABLE "${schema}".brain_import_lifecycle (
      import_run_id TEXT PRIMARY KEY,
      brain_version TEXT NOT NULL,
      root_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('CREATED','IMPORTING','VALIDATING','READY','ACTIVE','STOPPED','FAILED','QUARANTINED','INCOMPATIBLE')),
      manifest_json JSONB NOT NULL,
      validation_json JSONB,
      reason TEXT,
      revision BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )`
  );
  await storage.query(
    `CREATE TABLE "${schema}".model_state (id TEXT PRIMARY KEY, model_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`
  );
  await storage.query(
    `INSERT INTO "${schema}".brain_import_lifecycle(import_run_id,brain_version,root_path,state,manifest_json,revision,created_at,updated_at)
     VALUES
       ('legacy-marker-active','legacy-brain-marker','legacy://marker','ACTIVE','{}'::jsonb,0,TO_TIMESTAMP(1),TO_TIMESTAMP(1)),
       ('legacy-orphan-active','legacy-brain-orphan','legacy://orphan','ACTIVE','{}'::jsonb,0,TO_TIMESTAMP(2),TO_TIMESTAMP(2))`
  );
  await storage.query(
    `INSERT INTO "${schema}".model_state(id,model_json,updated_at)
     VALUES('scce2.active_brain',$1::jsonb,TO_TIMESTAMP(1))`,
    [JSON.stringify({ activeBrainVersion: "legacy-brain-marker", activeImportRunIds: ["legacy-marker-active"] })]
  );
}

async function transitionToReady(importRunId, at) {
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "CREATED", toState: "IMPORTING", updatedAt: at, reason: "rehearsal" });
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "IMPORTING", toState: "VALIDATING", updatedAt: at + 1, reason: "rehearsal" });
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "VALIDATING", toState: "READY", updatedAt: at + 2, reason: "rehearsal", validation: {
    schema: "scce.brainValidationReport.v1",
    importRunId,
    brainVersion: importRunId === "rehearsal-run-a" ? "rehearsal-brain-a" : "rehearsal-brain-b",
    manifestHash: sha256(`${importRunId}:${importRunId === "rehearsal-run-a" ? "rehearsal-brain-a" : "rehearsal-brain-b"}`),
    validatorVersion: "live-postgres-rehearsal.v1",
    disposition: "PASSED",
    checks: [{ id: "rehearsal", passed: true, severity: "error", message: "rehearsal candidate" }],
    validatedAt: at + 2
  } });
}

function check(id, passed, detail) {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function message(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 1000);
}
