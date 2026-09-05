#!/usr/bin/env node
// Makes one READY brain import the ACTIVE one (lifecycle rows are authoritative; the marker follows). Dry-run unless --apply.
// Usage: node tools/activate-brain-import.mjs <importRunId> [--apply] [--schema=scce3_runtime]
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const pg = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "adapters-node", "package.json"))("pg");
const args = process.argv.slice(2);
const importRunId = args.find(arg => !arg.startsWith("--"));
const apply = args.includes("--apply");
const schema = (args.find(arg => arg.startsWith("--schema=")) ?? "--schema=scce3_runtime").slice("--schema=".length);
if (!importRunId) throw new Error("usage: node tools/activate-brain-import.mjs <importRunId> [--apply] [--schema=...]");
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error(`unsafe schema ${schema}`);
const url = process.env.SCCE_DATABASE_URL;
if (!url) throw new Error("SCCE_DATABASE_URL is required");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const rows = (await client.query(`SELECT import_run_id, brain_version, state, root_path, updated_at FROM ${schema}.brain_import_lifecycle ORDER BY updated_at DESC`)).rows;
  const target = rows.find(row => row.import_run_id === importRunId);
  const active = rows.filter(row => row.state === "ACTIVE");
  console.log(JSON.stringify({ active: active.map(row => ({ importRunId: row.import_run_id, brainVersion: row.brain_version, rootPath: row.root_path })), target: target ? { importRunId: target.import_run_id, brainVersion: target.brain_version, state: target.state, rootPath: target.root_path } : null }, null, 2));
  if (!target) throw new Error(`no lifecycle row for ${importRunId}`);
  if (target.state === "ACTIVE") { console.log("already active"); process.exit(0); }
  if (target.state !== "READY") throw new Error(`activation requires READY, found ${target.state}`);
  if (!apply) { console.log("dry run; pass --apply to activate"); process.exit(0); }
  await client.query("BEGIN");
  await client.query(`UPDATE ${schema}.brain_import_lifecycle SET state='READY', reason=$2, revision=revision+1, updated_at=NOW() WHERE state='ACTIVE' AND import_run_id<>$1`, [importRunId, `deactivated by ${importRunId} (owner activation)`]);
  const activated = await client.query(`UPDATE ${schema}.brain_import_lifecycle SET state='ACTIVE', reason=NULL, revision=revision+1, updated_at=NOW() WHERE import_run_id=$1 AND state='READY'`, [importRunId]);
  if (activated.rowCount !== 1) throw new Error("activation compare-and-set failed");
  await client.query(
    `INSERT INTO ${schema}.model_state(id, model_json, updated_at)
     SELECT 'scce2.active_brain', jsonb_build_object('activeBrainVersion', brain_version, 'activeImportRunIds', jsonb_build_array(import_run_id), 'updatedAt', FLOOR(EXTRACT(EPOCH FROM updated_at)*1000)), updated_at
     FROM ${schema}.brain_import_lifecycle WHERE state='ACTIVE'
     ON CONFLICT(id) DO UPDATE SET model_json=EXCLUDED.model_json, updated_at=EXCLUDED.updated_at`
  );
  await client.query("COMMIT");
  console.log(`activated ${importRunId}`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
