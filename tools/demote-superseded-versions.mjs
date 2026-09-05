#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// A re-ingested article leaves its earlier revision beside the new one; only the newest version keeps promoted evidence.
//   node tools/demote-superseded-versions.mjs [--apply] [--schema=scce3_runtime] [--media=text/x-wiki]
// Without --apply it only reports. Reads the database URL from SCCE_DATABASE_URL.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const pg = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "adapters-node", "package.json"))("pg");

const apply = process.argv.includes("--apply");
const schema = process.argv.find(arg => arg.startsWith("--schema="))?.slice(9) ?? "scce3_runtime";
const media = process.argv.find(arg => arg.startsWith("--media="))?.slice(8) ?? "text/x-wiki";
if (!/^[a-z0-9_]+$/u.test(schema)) throw new Error("schema must be a plain identifier");
const url = process.env.SCCE_DATABASE_URL;
if (!url) throw new Error("SCCE_DATABASE_URL is not set");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const superseded = (await client.query(
    `select sv.id, s.canonical_uri, sv.observed_at,
            (select count(*)::int from ${schema}.evidence_spans e where e.source_version_id = sv.id and e.status = 'promoted') as promoted
     from ${schema}.source_versions sv join ${schema}.sources s on s.id = sv.source_id
     where sv.media_type like $1
       and exists (select 1 from ${schema}.source_versions newer join ${schema}.sources ns on ns.id = newer.source_id
                   where ns.canonical_uri = s.canonical_uri and newer.media_type like $1 and newer.observed_at > sv.observed_at)`,
    [`${media}%`]
  )).rows;
  const targets = superseded.filter(row => row.promoted > 0);
  console.log(`${superseded.length} superseded versions, ${targets.length} still carrying ${targets.reduce((sum, row) => sum + row.promoted, 0)} promoted spans`);
  if (!apply || !targets.length) {
    if (!apply && targets.length) console.log("dry run: re-run with --apply to quarantine their evidence");
    process.exit(0);
  }
  await client.query("begin");
  const demoted = await client.query(
    `update ${schema}.evidence_spans set status = 'quarantined', provenance_json = provenance_json || $1::jsonb
     where source_version_id = any($2) and status = 'promoted' returning id`,
    [JSON.stringify({ demotion: { reason: "source version superseded by a newer ingested revision", previousStatus: "promoted", demotedAt: new Date().toISOString() } }), targets.map(row => row.id)]
  );
  await client.query("commit");
  console.log(`quarantined ${demoted.rows.length} spans across ${targets.length} superseded versions`);
} catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { await client.end(); }
