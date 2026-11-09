#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function auditStorageAmplification(client, schema, scope = 'Unspecified database snapshot') {
  if (typeof schema !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(schema)) throw new Error('Invalid schema identifier');
  const quote = name => '"' + name.replaceAll('"', '""') + '"';
  const table = name => `${quote(schema)}.${quote(name)}`;
  const rows = async (sql, args = []) => (await client.query(sql, args)).rows;
  const report = { schema: 'scce.storage_amplification_audit.v2', databaseSchema: schema, scope,
    startedAt: new Date().toISOString(), readOnlyApplicationData: true, columnBytes: {} };
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    report.server = (await rows("SELECT current_setting('server_version') AS version"))[0];
    report.relations = await rows(`SELECT c.relname AS table, pg_relation_size(c.oid)::text AS heap_bytes,
      pg_table_size(c.oid)::text AS table_and_toast_bytes, pg_indexes_size(c.oid)::text AS index_bytes,
      pg_total_relation_size(c.oid)::text AS allocated_bytes,
      CASE WHEN c.reltoastrelid<>0 THEN pg_total_relation_size(c.reltoastrelid)::text ELSE '0' END AS toast_bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC`, [schema]);
    const columns = await rows('SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1', [schema]);
    const available = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
    for (const [name, candidates] of Object.entries({
      language_patterns: ['pattern_json', 'evidence_ids', 'information_label'],
      language_units: ['metadata_json', 'features', 'evidence_ids', 'competence_vector', 'information_label'],
      graph_nodes: ['representation_json', 'features', 'evidence_ids', 'metadata_json', 'information_label'],
      graph_edges: ['features', 'evidence_ids', 'temporal_scope', 'metadata_json', 'information_label']
    })) {
      const selected = candidates.filter(column => available.has(`${name}.${column}`));
      if (!selected.length) continue;
      const totals = selected.map(column => `COALESCE(sum(pg_column_size(${quote(column)})),0)::text AS ${quote(column + '_stored_bytes')}`);
      report.columnBytes[name] = (await rows(`SELECT count(*)::text AS rows,${totals.join(',')} FROM ${table(name)}`))[0];
    }
    report.patternKinds = await rows(`SELECT source_system,pattern_kind,pattern_json->>'schema' AS schema,
      count(*)::text AS rows,sum(pg_column_size(pattern_json))::text AS stored_json_bytes,
      max(pg_column_size(pattern_json))::text AS largest_stored_json_bytes
      FROM ${table('language_patterns')} GROUP BY 1,2,3 ORDER BY sum(pg_column_size(pattern_json)) DESC`);
    report.largestPatterns = await rows(`WITH largest AS MATERIALIZED (
      SELECT id,source_system,pattern_kind,pattern_json FROM ${table('language_patterns')}
      ORDER BY pg_column_size(pattern_json) DESC,id LIMIT 12
    ) SELECT id,source_system,pattern_kind,pattern_json->>'schema' AS schema,
      pg_column_size(pattern_json)::text AS stored_json_bytes,
      octet_length(pattern_json::text)::text AS rendered_json_bytes,
      (SELECT jsonb_object_agg(key,octet_length(value::text)) FROM jsonb_each(
        CASE WHEN jsonb_typeof(pattern_json)='object' THEN pattern_json ELSE '{}'::jsonb END)) AS member_rendered_bytes
      FROM largest ORDER BY pg_column_size(pattern_json) DESC,id`);
    report.nodeKinds = await rows(`SELECT type_id,representation_json->>'schema' AS schema,count(*)::text AS rows,
      sum(pg_column_size(representation_json))::text AS stored_representation_bytes,
      sum(pg_column_size(features))::text AS stored_feature_bytes,
      sum(pg_column_size(evidence_ids))::text AS stored_evidence_id_bytes
      FROM ${table('graph_nodes')} GROUP BY 1,2 ORDER BY sum(pg_column_size(representation_json)) DESC`);
    report.unitSourceMetadata = await rows(`SELECT metadata_json->>'sourceSystem' AS source_system,
      count(*)::text AS rows,sum(pg_column_size(metadata_json))::text AS metadata_stored_bytes,
      sum(CASE WHEN metadata_json ? 'sourceMetadata' THEN octet_length((metadata_json->'sourceMetadata')::text) ELSE 0 END)::text AS source_metadata_rendered_bytes
      FROM ${table('language_units')} GROUP BY 1 ORDER BY sum(pg_column_size(metadata_json)) DESC`);
    report.legacyRequestWitnesses = await rows(`SELECT key,count(*)::text AS rows,
      count(DISTINCT encode(sha256(convert_to(value::text,'UTF8')),'hex'))::text AS distinct_values,
      sum(octet_length(value::text))::text AS rendered_bytes,max(octet_length(value::text))::text AS largest_rendered_bytes
      FROM ${table('language_patterns')} p CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(pattern_json)='object' THEN pattern_json ELSE '{}'::jsonb END) e
      WHERE source_system='request_communicative_act' AND key IN ('trainingSourceVersionIds','trainingSourceDigests')
      GROUP BY key ORDER BY key`);
    report.sourceBytes = await rows(`SELECT metadata_json->>'sourceSystem' AS source_system,
      metadata_json->'_scceSourceVersion'->>'role' AS role,count(*)::text AS versions,sum(byte_length)::text AS bytes
      FROM ${table('source_versions')} GROUP BY 1,2 ORDER BY 1,2`);
    report.completed = true;
    report.qualification = 'Live column bytes and allocated relations differ. TOAST is already included in table/total sizes; do not add it twice. Source bytes include acquired sources that may not be learned. This audit does not measure dead space, prove a corpus expansion ratio, or change data.';
    return report;
  } finally {
    await client.query('ROLLBACK');
    report.finishedAt = new Date().toISOString();
  }
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string', default: 'scce.config.json' },
    out: { type: 'string' }, scope: { type: 'string' }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log('Usage: node tools/audit-storage-amplification.mjs --config=scce.config.json --out=storage-audit.json [--scope="Windows 29-article candidate"]');
    console.log('Read-only repeatable-read audit. No migration, VACUUM, or schema creation. Exact scans can take several minutes. Output path must be new.');
    return;
  }
  if (!values.out) throw new Error('--out is required');
  const { readScceRuntimeConfig, createPostgresStorageAdapter } = await import('../packages/adapters-node/dist/index.js');
  const config = await readScceRuntimeConfig(values.config);
  const storage = createPostgresStorageAdapter({ ...config.database, informationAccess: config.security.informationAccess });
  let client;
  try {
    client = await storage.pool.connect();
    const report = await auditStorageAmplification(client, config.database.schema, values.scope);
    const out = resolve(values.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ completed: true, report: out }));
  } finally {
    client?.release();
    await storage.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
