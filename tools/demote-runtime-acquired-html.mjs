#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Two retrieval-hygiene demotions, both reversible (status -> quarantined, previous status recorded):
//   default:    pages runtime acquisition fetched and promoted automatically before the consent gate existed (raw HTML)
//   --parents:  whole-article spans that fully contain two or more sentence-aligned sibling spans of the same source version
//   --references: link-dense spans (bibliographies), whose citation dates were answering questions about the subject
//   node tools/demote-runtime-acquired-html.mjs [--apply] [--parents] [--schema=scce3_runtime]
// Without --apply it only reports. Reads the database URL from SCCE_DATABASE_URL.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const pg = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "adapters-node", "package.json"))("pg");

const apply = process.argv.includes("--apply");
const minimumUrls = Number(process.argv.find(arg => arg.startsWith("--min-urls="))?.slice(11) ?? 3);
const charsPerUrl = Number(process.argv.find(arg => arg.startsWith("--chars-per-url="))?.slice(16) ?? 400);
const schema = process.argv.find(arg => arg.startsWith("--schema="))?.slice(9) ?? "scce3_runtime";
if (!/^[a-z0-9_]+$/u.test(schema)) throw new Error("schema must be a plain identifier");
const url = process.env.SCCE_DATABASE_URL;
if (!url) throw new Error("SCCE_DATABASE_URL is not set");

const client = new pg.Client({ connectionString: url });
await client.connect();
if (process.argv.includes("--parents")) {
  try {
    const parents = (await client.query(
      `select p.id, p.source_version_id, (p.char_end - p.char_start) as chars, count(c.id)::int as children
       from ${schema}.evidence_spans p
       join ${schema}.evidence_spans c on c.source_version_id = p.source_version_id and c.id <> p.id and c.char_start >= p.char_start and c.char_end <= p.char_end and (c.char_end - c.char_start) < (p.char_end - p.char_start)
       where p.status = 'promoted' and c.status = 'promoted'
       group by p.id, p.source_version_id, p.char_start, p.char_end
       having count(c.id) >= 2`
    )).rows;
    console.log(`${parents.length} whole-article parents covered by ${parents.reduce((sum, row) => sum + row.children, 0)} promoted children`);
    if (!apply || !parents.length) { if (!apply && parents.length) console.log("dry run: re-run with --apply --parents to demote them"); await client.end(); process.exit(0); }
    await client.query("begin");
    const demoted = await client.query(
      `update ${schema}.evidence_spans set status = 'quarantined', provenance_json = provenance_json || $1::jsonb where id = any($2) and status = 'promoted' returning id`,
      [JSON.stringify({ demotion: { reason: "whole-article parent superseded by sentence-aligned children", previousStatus: "promoted", demotedAt: new Date().toISOString() } }), parents.map(row => row.id)]
    );
    await client.query("commit");
    console.log(`demoted ${demoted.rows.length} parent spans`);
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { await client.end(); }
  process.exit(0);
}
if (process.argv.includes("--references")) {
  // A reference list is not an answer. "When was Ada Lovelace born?" answered 8 March 2018 -- the publication
  // date of a New York Times piece cited in the bibliography -- while the lead sentence carrying 10 December
  // 1815 sat promoted in the same corpus and lost the ranking. Link density is what separates them, and it
  // reads the same in every language.
  try {
    const dense = (await client.query(
      `select id, source_version_id, (length(text_content) - length(replace(text_content, 'http', ''))) / 4 as urls,
              greatest(1, length(text_content)) as chars
       from ${schema}.evidence_spans
       where status = 'promoted'
         and (length(text_content) - length(replace(text_content, 'http', ''))) / 4 >= $1
         and (length(text_content) - length(replace(text_content, 'http', ''))) / 4 >= greatest(1, length(text_content)) / $2`,
      [minimumUrls, charsPerUrl]
    )).rows;
    console.log(`${dense.length} promoted spans are link-dense enough to be reference lists (>= ${minimumUrls} URLs, one per <= ${charsPerUrl} chars)`);
    if (!apply || !dense.length) {
      if (!apply && dense.length) console.log("dry run: re-run with --apply --references to demote them");
      await client.end();
      process.exit(0);
    }
    await client.query("begin");
    const demoted = await client.query(
      `update ${schema}.evidence_spans set status = 'quarantined', provenance_json = provenance_json || $1::jsonb
       where id = any($2) and status = 'promoted' returning id`,
      [JSON.stringify({ demotion: { reason: "link-dense reference list, not answer evidence", previousStatus: "promoted", demotedAt: new Date().toISOString() } }), dense.map(row => row.id)]
    );
    await client.query("commit");
    console.log(`demoted ${demoted.rows.length} reference-list spans`);
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { await client.end(); }
  process.exit(0);
}

try {
  const versions = (await client.query(
    `select sv.id, sv.metadata_json->>'uri' as uri, (select count(*)::int from ${schema}.evidence_spans e where e.source_version_id = sv.id and e.status = 'promoted') as promoted
     from ${schema}.source_versions sv
     where sv.media_type like 'text/html%' and sv.metadata_json->>'schema' = 'scce.runtime_acquired_source.v1'`
  )).rows;
  const targets = versions.filter(row => row.promoted > 0);
  for (const row of targets) console.log(`${row.promoted} promoted spans  ${row.uri}`);
  console.log(`${targets.length} runtime-acquired HTML source versions with promoted spans`);
  if (!apply || !targets.length) {
    if (!apply && targets.length) console.log("dry run: re-run with --apply to demote them to quarantine");
    process.exit(0);
  }
  await client.query("begin");
  const ids = targets.map(row => row.id);
  const demoted = await client.query(
    `update ${schema}.evidence_spans set status = 'quarantined', provenance_json = provenance_json || $1::jsonb
     where source_version_id = any($2) and status = 'promoted' returning id`,
    [JSON.stringify({ demotion: { reason: "runtime-acquired page promoted before the consent gate; demoted for owner review", previousStatus: "promoted", demotedAt: new Date().toISOString() } }), ids]
  );
  const reopened = await client.query(`update ${schema}.quarantine_sources set decision = 'pending' where source_version_id = any($1) returning id`, [ids]);
  await client.query("commit");
  console.log(`demoted ${demoted.rows.length} spans; ${reopened.rows.length} quarantine records reopened for review (scce learn pending)`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
