import { createRequire } from 'node:module';
import { hash } from '../protocol.mjs';
import { sha256Text, sha256Bytes } from '../../sealed-eval/harness/lib/util.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export function retainedSourceBindings(input, contract) {
  const manifest = contract.retainedSources;
  if (manifest === undefined) return undefined;
  if (contract.operation !== 'turn' || contract.requestedAuthority !== 'factual' || contract.sourceAdmission !== undefined || contract.sourceTrust !== undefined
    || !manifest || manifest.schema !== 'scce.blind-retained-sources.v1' || Object.keys(manifest).some(key => !['schema', 'sources'].includes(key))
    || !Array.isArray(manifest.sources) || !manifest.sources.length) throw new Error('Invalid retained public source manifest');
  const visible = new Map();
  for (const step of input.steps) for (const source of step.sources) {
    if (visible.has(source.id) && visible.get(source.id) !== source.text) throw new Error('Retained public source changed between steps');
    visible.set(source.id, source.text);
  }
  const ids = new Set(), versions = new Set();
  for (const source of manifest.sources) {
    if (!source || Object.keys(source).some(key => !['id', 'sourceId', 'sourceVersionId', 'contentHash', 'canonicalUri', 'evidenceIds'].includes(key))
      || ![source.id, source.sourceId, source.sourceVersionId, source.canonicalUri].every(nonempty)
      || !/^sha256_[a-f0-9]{64}$/u.test(source.contentHash) || !Array.isArray(source.evidenceIds) || !source.evidenceIds.length
      || source.evidenceIds.some(id => !nonempty(id)) || new Set(source.evidenceIds).size !== source.evidenceIds.length
      || ids.has(source.id) || versions.has(source.sourceVersionId) || !visible.has(source.id)
      || `sha256_${sha256Text(visible.get(source.id))}` !== source.contentHash) throw new Error('Retained public source identity or bytes differ');
    ids.add(source.id); versions.add(source.sourceVersionId);
  }
  if (ids.size !== visible.size) throw new Error('Every public source requires a retained canonical binding');
  return manifest.sources.map(source => ({ ...source, evidenceIds: [...source.evidenceIds], text: visible.get(source.id) }));
}

export function retainedCanonicalReadOnlyClient(client, schema) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new Error('Invalid retained source schema');
  const table = name => `"${schema}"."${name}"`;
  const cache = new Map();
  const readOnlyClient = { query: async (sql, params) => {
    // Canonical archive verification cache writes stay ephemeral; byte hashing is unchanged.
    if (/^\s*INSERT INTO /u.test(sql) && sql.includes(table('storage_meta')) && String(params?.[0]).startsWith('corpus_archive_verification:')) {
      cache.set(params[0], JSON.parse(params[1])); return { rows: [] };
    }
    if (!/^\s*SELECT\b/iu.test(sql)) throw new Error('Retained verification permits read-only canonical queries');
    if (sql.includes('WHERE key=$1') && cache.has(params?.[0])) return { rows: [{ value_json: cache.get(params[0]) }] };
    return client.query(sql, params);
  } };
  return readOnlyClient;
}

export async function verifyRetainedSources({ input, contract, client, schema }) {
  const sources = retainedSourceBindings(input, contract);
  if (!sources) throw new Error('Retained source manifest required');
  const readOnlyClient = retainedCanonicalReadOnlyClient(client, schema);
  const table = name => `"${schema}"."${name}"`;
  const { createCanonicalCorpusReader } = await import('../../lib/canonical-corpus-read.mjs');
  const reader = createCanonicalCorpusReader(readOnlyClient, schema), verified = [];
  for (const source of sources) {
    const result = await readOnlyClient.query(`SELECT sv.id AS source_version_id,sv.source_id,sv.content_hash,sv.byte_length,s.canonical_uri
      FROM ${table('source_versions')} sv JOIN ${table('sources')} s ON s.id=sv.source_id WHERE sv.id=$1`, [source.sourceVersionId]);
    const owner = result.rows[0];
    if (result.rows.length !== 1 || owner.source_id !== source.sourceId || owner.source_version_id !== source.sourceVersionId
      || owner.content_hash !== source.contentHash || owner.canonical_uri !== source.canonicalUri) throw new Error('Retained canonical source ownership differs');
    const bytes = await reader.bytes(source.contentHash);
    if (bytes.length !== Number(owner.byte_length) || `sha256_${sha256Bytes(bytes)}` !== source.contentHash
      || !Buffer.from(source.text, 'utf8').equals(bytes)) throw new Error('Retained canonical source bytes differ');
    const evidence = await readOnlyClient.query(`SELECT id,source_id,source_version_id,content_hash,byte_start,byte_end,char_start,char_end,status
      FROM ${table('evidence_spans')} WHERE id=ANY($1::text[])`, [source.evidenceIds]);
    if (evidence.rows.length !== source.evidenceIds.length || new Set(evidence.rows.map(row => row.id)).size !== evidence.rows.length) throw new Error('Retained promoted evidence is missing');
    const points = [...source.text], witnesses = [];
    for (const span of evidence.rows) {
      if (!source.evidenceIds.includes(span.id) || span.source_id !== source.sourceId || span.source_version_id !== source.sourceVersionId
        || span.status !== 'promoted') throw new Error('Retained evidence ownership or promotion differs');
      const text = await reader.evidenceText(span);
      if (Number(span.byte_end) > bytes.length || Number(span.char_end) > points.length
        || !Buffer.from(text, 'utf8').equals(bytes.subarray(Number(span.byte_start), Number(span.byte_end)))
        || points.slice(Number(span.char_start), Number(span.char_end)).join('') !== text) throw new Error('Retained evidence coordinates differ');
      witnesses.push({ id: span.id, contentHash: span.content_hash });
    }
    witnesses.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    verified.push({ id: source.id, sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, contentHash: source.contentHash,
      canonicalUri: source.canonicalUri, evidence: witnesses });
  }
  const receipt = { schema: 'scce.blind-retained-source-verification.v1', manifestHash: hash(contract.retainedSources), sources: verified };
  return { ...receipt, digest: hash(receipt) };
}

export async function verifyConfiguredRetainedSources(input, contract, config, timeMs) {
  if (!config.configPath) throw new Error('Retained sources require the canonical candidate config');
  const adapter = await import('../../../packages/adapters-node/dist/index.js');
  const runtime = await adapter.readScceRuntimeConfig(config.configPath);
  const require = createRequire(new URL('../../../packages/adapters-node/package.json', import.meta.url));
  const { Client } = require('pg'), client = new Client({ connectionString: runtime.database.url, connectionTimeoutMillis: Math.max(1, Math.floor(timeMs)) });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, Math.floor(timeMs)))]);
    return await verifyRetainedSources({ input, contract, client, schema: config.cliSchema ?? runtime.database.schema });
  } finally {
    await client.query('ROLLBACK').finally(() => client.end());
  }
}

export function retainedAnswerProvenanceMatches(turn, receipt) {
  if (!receipt || !Array.isArray(turn?.evidence) || !turn.evidence.length) return false;
  return turn.evidence.every(span => receipt.sources.some(source => source.sourceId === span.sourceId && source.sourceVersionId === span.sourceVersionId
    && span.status === 'promoted' && source.evidence.some(witness => witness.id === span.id && witness.contentHash === span.contentHash)));
}
