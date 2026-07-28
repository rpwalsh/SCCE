#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RETRIEVAL_RANK_FEATURE_SCHEMA_V1 } from "../packages/kernel/dist/index.js";
import { createPostgresStorageAdapter, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

const configPath = path.resolve(process.env.SCCE_REHEARSAL_CONFIG ?? "scce.config.json");
const schema = `scce_rehearsal_sparse_ranking_${process.pid}_${Date.now()}`;
if (!/^scce_rehearsal_sparse_ranking_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe rehearsal schema name");
const TASK_CLASS = "graph.node_rank.v1";
const checks = [];
let storage;
let primaryError;

try {
  const loadedConfig = await readScceRuntimeConfig(configPath);
  storage = createPostgresStorageAdapter({ url: loadedConfig.database.url, schema, ssl: loadedConfig.database.ssl });
  await storage.migrate();
  const verify = await storage.verify();
  check("schema.verify", verify.ok, verify.errors.join("; "));

  check("readActive.no_model_yet", (await storage.sparseRanking.readActive(TASK_CLASS, RETRIEVAL_RANK_FEATURE_SCHEMA_V1)) === undefined);

  await storage.sparseRanking.putCheckpoint(fixtureCheckpoint({ lifecycle: "candidate" }));
  check("putCheckpoint.candidate", true);

  await storage.sparseRanking.putCheckpoint(fixtureCheckpoint({ lifecycle: "approved" }));
  check("putCheckpoint.approved_overwrite", true);

  let refusedBeforeApproval = false;
  try {
    await storage.sparseRanking.putCheckpoint(fixtureCheckpoint({ modelId: "model.rehearsal.shadow-only", lifecycle: "shadow" }));
    await storage.sparseRanking.activate({ modelId: "model.rehearsal.shadow-only", taskClass: TASK_CLASS, featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1 });
  } catch (error) {
    refusedBeforeApproval = /only "approved" models may activate/.test(String(error?.message ?? error));
  }
  check("activate.refuses_non_approved", refusedBeforeApproval);

  await storage.sparseRanking.activate({ modelId: "model.rehearsal", taskClass: TASK_CLASS, featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1 });
  check("activate.approved_model", true);

  const active = await storage.sparseRanking.readActive(TASK_CLASS, RETRIEVAL_RANK_FEATURE_SCHEMA_V1);
  check(
    "readActive.round_trip",
    active?.modelId === "model.rehearsal"
      && active?.lifecycle === "active"
      && active?.featureSchemaId === RETRIEVAL_RANK_FEATURE_SCHEMA_V1
      && Array.isArray(active?.state?.coordinates),
    JSON.stringify(active)
  );

  await storage.sparseRanking.rollback({ taskClass: TASK_CLASS, featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, reason: "sparse ranking rehearsal rollback" });
  const afterRollback = await storage.sparseRanking.readActive(TASK_CLASS, RETRIEVAL_RANK_FEATURE_SCHEMA_V1);
  check("rollback.clears_active_slot", afterRollback === undefined, JSON.stringify(afterRollback));
} catch (error) {
  primaryError = error;
} finally {
  if (storage) {
    try {
      if (!/^scce_rehearsal_sparse_ranking_[a-z0-9_]+$/u.test(storage.schema)) throw new Error("refusing cleanup outside rehearsal schema");
      await storage.query(`DROP SCHEMA IF EXISTS "${storage.schema}" CASCADE`);
      checks.push({ id: "cleanup.drop_disposable_schema", passed: true, detail: storage.schema });
    } catch (error) {
      checks.push({ id: "cleanup.drop_disposable_schema", passed: false, detail: sanitized(error) });
      primaryError ??= error;
    }
    await storage.close().catch(error => { primaryError ??= error; });
  }
}

const report = {
  schema: "scce.live_sparse_ranking_rehearsal.v1",
  completedAt: new Date().toISOString(),
  configPath,
  disposableSchema: schema,
  credentialsRecorded: false,
  fixtureContainsSyntheticDataOnly: true,
  checks,
  status: !primaryError && checks.every(entry => entry.passed) ? "passed" : "failed",
  error: primaryError ? sanitized(primaryError) : null
};
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/live-sparse-ranking-rehearsal.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;

function check(id, passed, detail) {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

function fixtureCheckpoint(patch = {}) {
  return {
    modelId: "model.rehearsal",
    taskClass: TASK_CLASS,
    featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
    lifecycle: "candidate",
    state: {
      schemaVersion: "scce.ftrl-proximal-ranker.v1",
      modelId: "model.rehearsal",
      featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
      hyperparameters: { alpha: 0.1, beta: 1, l1: 0, l2: 0 },
      createdAt: 1_000,
      updatedAt: 1_000,
      examplesSeen: 0,
      coordinates: []
    },
    trainingWindow: { firstExampleAt: 1_000, lastExampleAt: 1_000 },
    examplesSeen: 0,
    informationLabel: { tenantId: "sparse-ranking-rehearsal", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" },
    createdAt: 1_000,
    ...patch
  };
}

function sanitized(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 1000);
}
