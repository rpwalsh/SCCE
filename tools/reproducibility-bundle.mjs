#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The one-command answer to "which exact source state produced the claimed result?"
 *
 * A result that cannot name its inputs cannot be reproduced by anyone but its author. This records every input a
 * clean-room engineer needs, each as a hash they can recompute: the source commit and the working tree on top of it,
 * the lockfile, the tracked configuration, the active brain, the corpus the database holds, the benchmark manifest,
 * the environment, the command, and the result file itself. Nothing here is a claim about quality; it is the custody
 * record a claim about quality must carry.
 *
 * Usage:
 *   node tools/reproducibility-bundle.mjs --command="node tools/reference-comparison.mjs" \
 *     --result=artifacts/reference-comparison.json --manifest=tools/reference-comparison.mjs
 *
 * The database identity is an identity, not a byte snapshot: table counts, latest timestamps and a digest over every
 * source version id. Two databases with the same identity hold the same corpus; a byte-level dump is the custodian's
 * job and is referenced by hash when one exists (--snapshot=<path>).
 */
const args = new Map(process.argv.slice(2)
  .filter(argument => argument.startsWith("--"))
  .map(argument => { const [name, ...rest] = argument.slice(2).split("="); return [name, rest.length ? rest.join("=") : "1"]; }));
const configPath = args.get("config") ?? process.env.SCCE_CONFIG ?? "scce.config.json";
const outputPath = args.get("out") ?? "artifacts/reproducibility-bundle.json";
const manifests = (args.get("manifest") ?? "").split(",").map(item => item.trim()).filter(Boolean);
const resultPath = args.get("result");
const snapshotPath = args.get("snapshot");
const command = args.get("command") ?? null;

if (!process.env.SCCE_DATABASE_URL) {
  try {
    process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
  } catch {
    process.stderr.write("no SCCE_DATABASE_URL, and no scce.config.local.json to read one from\n");
    process.exit(2);
  }
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const fileHash = filePath => existsSync(filePath) ? sha256(readFileSync(filePath)) : null;
const git = (...argv) => {
  try { return execFileSync("git", argv, { encoding: "utf8" }).trim(); } catch { return null; }
};

const source = {
  commit: git("rev-parse", "HEAD"),
  branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  // The tree on top of the commit, so an uncommitted change can never hide behind a clean-looking commit hash.
  dirty: (git("status", "--porcelain") ?? "").length > 0,
  workingTreeDiffSha256: sha256(git("diff", "HEAD") ?? ""),
  untrackedSourceFiles: (git("ls-files", "--others", "--exclude-standard", "packages", "tools") ?? "").split("\n").filter(Boolean).length
};

const { readScceRuntimeConfig } = await import("../packages/adapters-node/dist/index.js");
const { default: pg } = await import("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const config = await readScceRuntimeConfig(configPath);
const client = new pg.Client({ connectionString: config.database.url });
await client.connect();
await client.query("set statement_timeout to '600s'");
const schema = config.database.schema;
const one = async (sql, params = []) => (await client.query(sql, params)).rows[0] ?? {};

const postgresVersion = String((await one("select version() as v")).v ?? "");
const tables = ["sources", "source_versions", "evidence_spans", "evidence_anchor_index", "ngram_models", "ngram_observations", "language_profiles", "language_units", "language_patterns", "semantic_frames", "graph_nodes", "graph_edges"];
const tableIdentity = {};
for (const table of tables) {
  const exists = (await one("select to_regclass($1) as r", [`${schema}.${table}`])).r;
  if (!exists) { tableIdentity[table] = null; continue; }
  const estimate = await one("select reltuples::bigint as n from pg_class where oid = $1::regclass", [`${schema}.${table}`]);
  tableIdentity[table] = { estimatedRows: Number(estimate.n ?? -1) };
}
// Exact identity of the corpus: every source and every version, in a deterministic order.
const corpus = await one(`select count(*)::int as sources, md5(string_agg(canonical_uri, E'\\n' order by canonical_uri)) as uri_digest from ${schema}.sources`);
const versions = await one(`select count(*)::int as versions, md5(string_agg(id, E'\\n' order by id)) as id_digest, max(observed_at) as latest from ${schema}.source_versions`);
const evidence = await one(`select count(*)::int as spans, count(*) filter (where status = 'promoted')::int as promoted, max(observed_at) as latest from ${schema}.evidence_spans`);
const brainMarker = await one(`select to_regclass($1) as r`, [`${schema}.brain_lifecycle`]);
let brain = null;
try {
  const { createNodeRuntime } = await import("../packages/adapters-node/dist/index.js");
  const runtime = createNodeRuntime(config);
  const active = await runtime.storage.brainImports.active();
  brain = { activeImportRunIds: active.activeImportRunIds ?? [], activeBrainVersion: active.activeBrainVersion ?? null };
  await runtime.close?.();
} catch (error) {
  brain = { error: String(error).slice(0, 160) };
}
void brainMarker;
await client.end();

const bundle = {
  schema: "scce.reproducibility_bundle.v1",
  generatedAt: new Date().toISOString(),
  source,
  lockfile: { path: "pnpm-lock.yaml", sha256: fileHash("pnpm-lock.yaml") },
  configuration: {
    path: configPath,
    sha256: fileHash(configPath),
    localOverridePresent: existsSync("scce.config.local.json"),
    schema
  },
  brain,
  database: {
    postgresVersion,
    schema,
    tables: tableIdentity,
    corpus: { sources: corpus.sources, canonicalUriDigestMd5: corpus.uri_digest },
    sourceVersions: { count: versions.versions, idDigestMd5: versions.id_digest, latestObservedAt: versions.latest },
    evidence: { spans: evidence.spans, promoted: evidence.promoted, latestObservedAt: evidence.latest },
    snapshot: snapshotPath ? { path: snapshotPath, sha256: fileHash(snapshotPath) } : null
  },
  benchmark: manifests.map(manifest => ({ path: manifest, sha256: fileHash(manifest) })),
  environment: {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? null,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem()
  },
  command,
  result: resultPath ? { path: resultPath, sha256: fileHash(resultPath) } : null
};
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true }).catch(() => undefined);
writeFileSync(path.resolve(outputPath), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
process.stdout.write(
  `source ${source.commit?.slice(0, 12)}${source.dirty ? " (dirty tree, diff " + source.workingTreeDiffSha256.slice(0, 12) + ")" : " (clean)"}\n`
  + `lockfile ${bundle.lockfile.sha256?.slice(0, 12)}  config ${bundle.configuration.sha256?.slice(0, 12)}  brain ${JSON.stringify(brain)}\n`
  + `corpus ${corpus.sources} sources / ${versions.versions} versions (${String(versions.id_digest).slice(0, 12)}), ${evidence.promoted} promoted spans\n`
  + `${postgresVersion.split(" on ")[0]}  node ${process.version}  ${bundle.environment.cpu} x${bundle.environment.cpus}\n`
  + `wrote ${outputPath}\n`
);
process.exit(0);
