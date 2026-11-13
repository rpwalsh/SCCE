import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argsMap } from '../sealed-eval/harness/lib/util.mjs';
import { canonical, fileHash } from './protocol.mjs';
import { createCanonicalCorpusReader } from '../lib/canonical-corpus-read.mjs';
import { retainedCanonicalReadOnlyClient } from './adapters/retained-sources.mjs';
import { sha256Bytes } from '../sealed-eval/harness/lib/util.mjs';

export async function exportRetainedCorpus(options, dependencies = {}) {
  const { schema, language, sourcePrefix, seed, documents, minBytes, maxBytes } = options;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema) || !language || !sourcePrefix || !seed
    || ![documents, minBytes, maxBytes].every(value => Number.isSafeInteger(value) && value > 0) || maxBytes < minBytes) throw new Error('Declare exact retained corpus selection');
  const out = path.resolve(options.out), table = name => `"${schema}"."${name}"`;
  const client = retainedCanonicalReadOnlyClient(dependencies.client, schema);
  const reader = createCanonicalCorpusReader(client, schema);
  const selected = await client.query(`SELECT sv.id AS source_version_id,sv.source_id,sv.content_hash,sv.byte_length,s.canonical_uri
    FROM ${table('source_versions')} sv JOIN ${table('sources')} s ON s.id=sv.source_id
    WHERE sv.byte_length BETWEEN $1 AND $2 AND left(s.canonical_uri,length($3))=$3
      AND EXISTS (SELECT 1 FROM ${table('evidence_spans')} e WHERE e.source_version_id=sv.id AND e.status='promoted')
    ORDER BY md5($4 || sv.id) LIMIT $5`, [minBytes, maxBytes, sourcePrefix, seed, documents]);
  if (selected.rows.length !== documents) throw new Error('Insufficient retained canonical sources; export never substitutes synthetic material');
  await mkdir(out);
  await mkdir(path.join(out, 'corpus'));
  const rows = [];
  for (const owner of selected.rows) {
    const bytes = await reader.bytes(owner.content_hash), digest = sha256Bytes(bytes);
    if (owner.content_hash !== `sha256_${digest}` || bytes.length !== Number(owner.byte_length)) throw new Error('Retained export source hash differs');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Retained export source is not exact UTF-8 text');
    const evidence = await client.query(`SELECT id,source_id,source_version_id,content_hash,byte_start,byte_end,char_start,char_end,status
      FROM ${table('evidence_spans')} WHERE source_version_id=$1 AND status='promoted' ORDER BY id`, [owner.source_version_id]);
    if (!evidence.rows.length) throw new Error('Retained export source lost promoted evidence');
    const points = [...text];
    for (const span of evidence.rows) {
      const surface = await reader.evidenceText(span);
      if (span.source_id !== owner.source_id || span.source_version_id !== owner.source_version_id || span.status !== 'promoted'
        || !Buffer.from(surface).equals(bytes.subarray(Number(span.byte_start), Number(span.byte_end)))
        || points.slice(Number(span.char_start), Number(span.char_end)).join('') !== surface) throw new Error('Retained export evidence ownership differs');
    }
    const relative = `corpus/${digest}.txt`;
    await writeFile(path.join(out, relative), bytes, { flag: 'wx' });
    if (await fileHash(path.join(out, relative)) !== digest) throw new Error('Retained exported bytes changed');
    rows.push({ documentId: owner.source_version_id, path: relative, sha256: digest, sizeBytes: bytes.length, language,
      metadata: { sourceId: owner.source_id, sourceVersionId: owner.source_version_id, canonicalUri: owner.canonical_uri,
        evidenceIds: evidence.rows.map(span => span.id) } });
  }
  const manifest = { schemaVersion: '1.0', corpusId: `retained-${sha256Bytes(Buffer.from(canonical(rows)))}`,
    description: 'Canonical retained source bytes; no task or answer material is ingested.', language,
    selection: { sourcePrefix, seed, documents, minBytes, maxBytes }, documents: rows.sort((a, b) => a.documentId < b.documentId ? -1 : 1) };
  const manifestFile = path.join(out, 'corpus-manifest.json');
  await writeFile(manifestFile, canonical(manifest) + '\n', { flag: 'wx' });
  return { manifestFile, sha256: await fileHash(manifestFile), documents: rows.length, bytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0) };
}

async function main() {
  const args = argsMap(process.argv.slice(2)), configPath = args.get('config');
  if (!configPath || !args.get('out')) throw new Error('--config and --out NEW_DIRECTORY required');
  const adapter = await import('../../packages/adapters-node/dist/index.js'), config = await adapter.readScceRuntimeConfig(configPath);
  const require = createRequire(new URL('../../packages/adapters-node/package.json', import.meta.url));
  const { Client } = require('pg'), client = new Client({ connectionString: config.database.url, connectionTimeoutMillis: 30000 });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout','30000',true)");
    const result = await exportRetainedCorpus({ out: args.get('out'), schema: args.get('schema') ?? config.database.schema,
      language: args.get('language') ?? 'en', sourcePrefix: args.get('source-prefix') ?? 'wikipedia://enwiki/',
      seed: args.get('seed') ?? 'retained-public-sources-v1', documents: Number(args.get('documents') ?? 10),
      minBytes: Number(args.get('min-bytes') ?? 8000), maxBytes: Number(args.get('max-bytes') ?? 60000) }, { client });
    process.stdout.write(canonical(result) + '\n');
  } finally { await client.query('ROLLBACK').finally(() => client.end()); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
