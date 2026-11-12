// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownPath = fileURLToPath(import.meta.url);

export async function inspectBrainProgress(configPath) {
  const adapters = await import("../packages/adapters-node/dist/index.js");
  const config = await adapters.readScceRuntimeConfig(configPath);
  const storage = adapters.createPostgresStorageAdapter({
    ...config.database,
    informationAccess: config.security.informationAccess
  });
  try {
    const tables = [
      "sources", "source_versions", "evidence_spans", "language_profiles", "ngram_models",
      "ngram_observations", "language_units", "language_patterns", "semantic_frames",
      "ingestion_checkpoints"
    ];
    const counts = {};
    for (const table of tables) {
      const [row] = await storage.query(`SELECT count(*)::text AS count FROM ${storage.table(table)}`);
      counts[table] = Number(row.count);
    }
    const checkpoints = await storage.query(
      `SELECT item_uri,phase,status,reason,updated_at::text AS updated_at
       FROM ${storage.table("ingestion_checkpoints")}
       ORDER BY updated_at DESC LIMIT 20`
    );
    const [database] = await storage.query("SELECT current_database() AS name,pg_database_size(current_database())::text AS bytes");
    return {
      schema: "scce.brain_progress_inspection.v1",
      databaseName: database.name,
      databaseBytes: Number(database.bytes),
      counts,
      checkpoints: checkpoints.map(row => ({
        itemUri: row.item_uri,
        phase: row.phase,
        status: row.status,
        reason: row.reason,
        updatedAt: row.updated_at
      }))
    };
  } finally {
    await storage.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
  if (!configPath || configPath.startsWith("--")) {
    console.error("Usage: node tools/inspect-brain-progress.mjs --config <local-config.json>");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(await inspectBrainProgress(path.resolve(configPath)), null, 2));
  }
}
