#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// "Given a stage and an outcome, what were the deciding quantities." Emits JSON only -- no prose, no verdict.
// Reads calibration_observations READ ONLY; a later lane fits a per-stage policy from exactly these rows.
//
//   node tools/cognitive-credit-query.mjs                                 # every stage, every outcome source
//   node tools/cognitive-credit-query.mjs --stage=stage.retrieval         # one stage
//   node tools/cognitive-credit-query.mjs --source=outcome.source.graded  # graded rows only
//   node tools/cognitive-credit-query.mjs --episode=<episodeId>           # one turn's whole chain
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.SCCE_REPO_ROOT ? path.resolve(process.env.SCCE_REPO_ROOT) : path.resolve(here, "..");
const require_ = createRequire(pathToFileURL(path.join(repoRoot, "packages", "adapters-node", "package.json")));
const pg = require_("pg");

const arg = name => {
  const hit = process.argv.slice(2).find(token => token.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const stage = arg("stage");
const source = arg("source");
const episode = arg("episode");
const limit = Number(arg("limit") ?? 20000);
const STAGE_SCHEMA = "scce.cognitive_credit.stage_observation.v1";

const config = JSON.parse(readFileSync(path.join(repoRoot, "scce.config.json"), "utf8"));
let localConfig = {};
for (const candidate of [path.join(repoRoot, "scce.config.local.json"), path.resolve(process.cwd(), "scce.config.local.json")]) {
  if (!existsSync(candidate)) continue;
  localConfig = JSON.parse(readFileSync(candidate, "utf8"));
  break;
}
const databaseUrl = process.env.SCCE_DATABASE_URL ?? localConfig?.database?.url ?? config?.database?.url;
const schema = localConfig?.database?.schema ?? config?.database?.schema;
if (!databaseUrl) throw new Error("no database url; set SCCE_DATABASE_URL or scce.config.local.json");
if (!/^[a-z0-9_]+$/u.test(String(schema ?? ""))) throw new Error("schema must be a plain identifier");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
let rows = [];
try {
  await client.query(`SET search_path TO "${schema}"`);
  await client.query("SET statement_timeout TO 120000");
  await client.query("BEGIN READ ONLY");
  const where = ["metadata_json->>'schema' = $1"];
  const params = [STAGE_SCHEMA];
  if (stage) { params.push(stage); where.push(`metadata_json->>'stageId' = $${params.length}`); }
  if (source) { params.push(source); where.push(`metadata_json->>'outcomeSource' = $${params.length}`); }
  if (episode) { params.push(episode); where.push(`source_record_id = $${params.length}`); }
  params.push(limit);
  rows = (await client.query(
    `select calibration_id, subsystem_id, task_class, raw_score, outcome, final_outcome, source_record_id, metadata_json, created_at
     from calibration_observations where ${where.join(" and ")} order by created_at desc limit $${params.length}`,
    params
  )).rows;
  await client.query("COMMIT");
} finally {
  await client.end();
}

/** Per (stage, outcome source, label): how many, and the mean of every deciding quantity that stage recorded. */
const groups = new Map();
for (const row of rows) {
  const meta = row.metadata_json ?? {};
  const key = [meta.stageId, meta.outcomeSource, row.final_outcome].join("|");
  const group = groups.get(key) ?? {
    stageId: meta.stageId, chainId: meta.chainId, calibrationId: row.calibration_id, subsystemId: row.subsystem_id,
    outcomeSource: meta.outcomeSource, outcomeLabel: row.final_outcome, supervised: meta.supervised === true,
    observations: 0, reached: 0, episodes: new Set(), decidingQuantitySum: 0, quantitySums: {}, quantityCounts: {}
  };
  group.observations += 1;
  if (meta.reached === true) group.reached += 1;
  group.episodes.add(row.source_record_id);
  group.decidingQuantitySum += Number(row.raw_score);
  for (const [name, value] of Object.entries(meta.decidingQuantities ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    group.quantitySums[name] = (group.quantitySums[name] ?? 0) + value;
    group.quantityCounts[name] = (group.quantityCounts[name] ?? 0) + 1;
  }
  groups.set(key, group);
}

const report = {
  schema: "scce.cognitive_credit.stage_query.v1",
  filter: { stage: stage ?? null, outcomeSource: source ?? null, episodeId: episode ?? null },
  stageObservations: rows.length,
  distinctEpisodes: new Set(rows.map(row => row.source_record_id)).size,
  groups: [...groups.values()]
    .sort((left, right) => right.observations - left.observations || String(left.stageId).localeCompare(String(right.stageId)))
    .map(group => ({
      stageId: group.stageId, chainId: group.chainId, calibrationId: group.calibrationId, subsystemId: group.subsystemId,
      outcomeSource: group.outcomeSource, outcomeLabel: group.outcomeLabel, supervised: group.supervised,
      observations: group.observations, episodes: group.episodes.size,
      reachedRate: Number((group.reached / group.observations).toFixed(4)),
      meanDecidingQuantity: Number((group.decidingQuantitySum / group.observations).toFixed(6)),
      meanQuantities: Object.fromEntries(Object.keys(group.quantitySums).sort()
        .map(name => [name, Number((group.quantitySums[name] / group.quantityCounts[name]).toFixed(6))]))
    }))
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
