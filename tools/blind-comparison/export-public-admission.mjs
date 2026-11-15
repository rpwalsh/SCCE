import { mkdir, open, readFile, rename, stat, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonical, fileHash } from './protocol.mjs';
import { PUBLIC_ADMISSION_SCHEMA, admissionArtifacts } from './public-admission.mjs';
import { retainedCanonicalReadOnlyClient } from './adapters/retained-sources.mjs';
import { createCanonicalCorpusReader } from '../lib/canonical-corpus-read.mjs';
import { informationLabelAllowsRead, normalizeInformationLabel } from '../../packages/kernel/dist/index.js';
import { argsMap } from '../sealed-eval/harness/lib/util.mjs';

const positive = n => Number.isSafeInteger(n) && n > 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, target) => { const rel = path.relative(path.resolve(root), path.resolve(target)); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
class AdmissionExportError extends Error {}
export function requirePublicAccess(label, access) {
  let normalized;
  try { normalized = normalizeInformationLabel(label); } catch { throw new AdmissionExportError('Missing or invalid canonical information label'); }
  if (normalized.exportClass !== 'public' || !['same_owner', 'explicit', 'isolated'].includes(normalized.mergePolicy) || normalized.principals.length || normalized.compartments.length
    || !informationLabelAllowsRead(normalized, access)) throw new AdmissionExportError('Canonical record is inaccessible or not unrestricted public export');
  return normalized;
}
export function exportOptions(raw) {
  const options = { maxItemBytes: 128 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, pageRows: 128,
    maxMetadataBytes: 256 * 1024 * 1024, maxSources: 100000, ...raw };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.schema) || !options.out || !options.informationAccess
    || !['maxItemBytes', 'maxTotalBytes', 'pageRows', 'maxMetadataBytes', 'maxSources'].every(k => positive(options[k]))
    || options.pageRows > 1000 || (!!options.allPublicCurrent === !!options.selection)) throw new AdmissionExportError('Declare config, one source selection mode and positive bounded export limits');
  if (options.selection && (!Array.isArray(options.selection.sources) || !options.selection.sources.length
    || options.selection.sources.length > options.maxSources || options.selection.sources.some(s => !s || typeof s.sourceVersionId !== 'string'
      || !/^sha256_[a-f0-9]{64}$/u.test(s.contentHash)) || new Set(options.selection.sources.map(s => s.sourceVersionId)).size !== options.selection.sources.length)) throw new AdmissionExportError('Invalid source-version/hash selection');
  for (const source of options.selection?.sources ?? []) {
    if (source.naturalLanguage !== undefined && (typeof source.naturalLanguage !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(source.naturalLanguage))
      || source.formalLanguage !== undefined && (typeof source.formalLanguage !== 'string' || !/^[a-z][a-z0-9_+-]*$/u.test(source.formalLanguage))
      || source.usageClass !== undefined && !['factual_source', 'code_prior', 'language_prior', 'lexical_language_prior', 'unclassified_background'].includes(source.usageClass)) throw new AdmissionExportError('Invalid explicit source language or usage declaration');
  }
  return options;
}
export async function exportPublicAdmission(raw, dependencies) {
  const options = exportOptions(raw), out = path.resolve(options.out), table = name => `"${options.schema}"."${name}"`;
  await mkdir(out, { recursive: true });
  const resolvedOut = await realpath(out);
  for (const root of options.forbiddenRoots ?? []) if (within(await realpath(root), resolvedOut)) throw new AdmissionExportError('Admission export must be outside configured public ingestion roots');
  const lockPath = path.join(out, '.export.lock'), lock = await open(lockPath, 'wx');
  try {
  await unlink(path.join(out, 'admitted-public-manifest.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await mkdir(path.join(out, 'corpus'), { recursive: true });
  const client = retainedCanonicalReadOnlyClient(dependencies.client, options.schema);
  const limitsClient = { query: async (sql, params) => {
    if (sql.includes('blob.content,blob.byte_length')) {
      const preflight = await client.query(`SELECT byte_length,range_parent_hash FROM ${table('blobs')} WHERE content_hash=$1`, [params[0]]);
      if (preflight.rows.length !== 1 || !Number.isSafeInteger(Number(preflight.rows[0].byte_length))
        || Number(preflight.rows[0].byte_length) > options.maxItemBytes) throw new AdmissionExportError('Canonical blob or parent exceeds per-item memory budget');
    }
    return client.query(sql, params);
  } };
  const reader = dependencies.reader ?? createCanonicalCorpusReader(limitsClient, options.schema);
  const selection = new Map((options.selection?.sources ?? []).map(s => [s.sourceVersionId, s]));
  const artifacts = new Map(), publicSources = [], counts = { source: 0, evidence: 0, profile: 0, ngram: 0, excludedNonPublicSources: 0, excludedSupersededSources: 0 };
  let totalBytes = 0, metadataBytes = 0;
  const metadataPending = path.join(out, 'source-index.jsonl.pending'), metadata = await open(metadataPending, 'w');
  const sourcePending = path.join(out, 'sources.jsonl.pending'), sourcesFile = await open(sourcePending, 'w');
  const snapshot = async emit => {
    const hash = createHash('sha256'); let cursor = '', matched = 0, sourceCount = 0;
    const record = async row => { const line = canonical(JSON.parse(JSON.stringify(row))) + '\n'; hash.update(line); if (emit) { metadataBytes += Buffer.byteLength(line); if (metadataBytes > options.maxMetadataBytes) throw new AdmissionExportError('Metadata budget exceeded'); await metadata.write(line); } };
    for (;;) {
      const owners = await client.query(`SELECT sv.id,sv.source_id,sv.content_hash,sv.byte_length,sv.media_type,sv.observed_at,sv.information_label,s.canonical_uri,
        sv.metadata_json->>'sourceKind' AS source_kind,
        NOT EXISTS (SELECT 1 FROM ${table('source_versions')} newer WHERE newer.source_id=sv.source_id
          AND (newer.observed_at,newer.id)>(sv.observed_at,sv.id) AND EXISTS (SELECT 1 FROM ${table('evidence_spans')} ne WHERE ne.source_version_id=newer.id AND ne.status='promoted')) AS current
        FROM ${table('source_versions')} sv JOIN ${table('sources')} s ON s.id=sv.source_id WHERE sv.id>$1
        AND (EXISTS (SELECT 1 FROM ${table('evidence_spans')} e WHERE e.source_version_id=sv.id AND e.status='promoted')
          OR EXISTS (SELECT 1 FROM ${table('language_profiles')} p WHERE p.source_version_id=sv.id)) ORDER BY sv.id LIMIT $2`, [cursor, options.pageRows]);
      if (!owners.rows.length) break;
      for (const owner of owners.rows) {
        cursor = owner.id;
        const declared = selection.get(owner.id);
        if (!options.allPublicCurrent && !declared) continue;
        if (!owner.current) { if (declared) throw new AdmissionExportError('Selected source version has a newer promoted canonical owner'); if (emit) counts.excludedSupersededSources++; continue; }
        try { requirePublicAccess(owner.information_label, options.informationAccess); }
        catch (error) { if (declared) throw error; if (emit) counts.excludedNonPublicSources++; continue; }
        if (declared && declared.contentHash !== owner.content_hash) throw new AdmissionExportError('Selected canonical source hash changed');
        matched++; if (++sourceCount > options.maxSources) throw new AdmissionExportError('Source count budget exceeded');
        const length = Number(owner.byte_length);
        if (!Number.isSafeInteger(length) || length < 0 || length > options.maxItemBytes || !/^sha256_[a-f0-9]{64}$/u.test(owner.content_hash)) throw new AdmissionExportError('Canonical source exceeds per-item budget or has invalid identity');
        try { const uri = new URL(owner.canonical_uri); if (uri.username || uri.password) throw new AdmissionExportError('Canonical source URI contains credentials'); }
        catch (error) { if (error instanceof AdmissionExportError) throw error; }
        const relative = `corpus/${owner.content_hash.slice(7)}.bin`;
        const row = { kind: 'source', sourceVersionId: owner.id, sourceId: owner.source_id, contentHash: owner.content_hash,
          byteLength: length, mediaType: owner.media_type, observedAt: owner.observed_at instanceof Date ? owner.observed_at.toISOString() : owner.observed_at, canonicalUri: owner.canonical_uri,
          public: true, path: relative, usageClass: declared?.usageClass ?? (owner.source_kind === 'lexical_knowledge' ? 'lexical_language_prior' : 'unclassified_background'),
          ...(declared?.naturalLanguage ? { naturalLanguage: declared.naturalLanguage } : {}),
          ...(declared?.formalLanguage ? { formalLanguage: declared.formalLanguage } : {}) };
        await record(row);
        if (emit) {
          counts.source++; await sourcesFile.write(canonical(row) + '\n');
          publicSources.push({ id: owner.id, public: true, ...(row.naturalLanguage ? { naturalLanguage: row.naturalLanguage } : {}), ...(row.formalLanguage ? { formalLanguage: row.formalLanguage } : {}) });
          if (!artifacts.has(relative)) {
            totalBytes += length; if (totalBytes > options.maxTotalBytes) throw new AdmissionExportError('Total source byte budget exceeded');
            const target = path.join(out, relative); let reuse = false;
            try { reuse = (await stat(target)).size === length && await fileHash(target) === owner.content_hash.slice(7); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!reuse) {
              const bytes = await reader.bytes(owner.content_hash);
              if (bytes.length !== length || digest(bytes) !== owner.content_hash.slice(7)) throw new AdmissionExportError('Canonical source bytes differ');
              const pending = `${target}.pending`; const handle = await open(pending, 'w');
              try { await handle.writeFile(bytes); } finally { await handle.close(); }
              if (await fileHash(pending) !== owner.content_hash.slice(7)) throw new AdmissionExportError('Exported source bytes differ');
              await rename(pending, target);
            }
            artifacts.set(relative, { path: relative, sha256: owner.content_hash.slice(7), sizeBytes: length });
          }
        }
        for (const [kind, relation, predicate, fields] of [
          ['evidence', 'evidence_spans', 'source_version_id=$1 AND status=\'promoted\'', 'id,source_id,source_version_id,content_hash,byte_start,byte_end,char_start,char_end,status,information_label'],
          ['profile', 'language_profiles', 'source_version_id=$1', 'id,source_version_id,information_label'],
          ['ngram', 'ngram_models', `profile_id IN (SELECT id FROM ${table('language_profiles')} WHERE source_version_id=$1)`, 'id,profile_id,updated_at,information_label']
        ]) {
          let after = '';
          for (;;) {
            const rows = await client.query(`SELECT ${fields} FROM ${table(relation)} WHERE ${predicate} AND id>$2 ORDER BY id LIMIT $3`, [owner.id, after, options.pageRows]);
            if (!rows.rows.length) break;
            for (const value of rows.rows) {
              after = value.id; requirePublicAccess(value.information_label, options.informationAccess);
              if (kind === 'evidence' && value.source_id !== owner.source_id) throw new AdmissionExportError('Canonical evidence source owner differs');
              if (kind === 'evidence' && (!/^sha256_[a-f0-9]{64}$/u.test(value.content_hash)
                || !['byte_start', 'byte_end', 'char_start', 'char_end'].every(k => Number.isSafeInteger(Number(value[k])) && Number(value[k]) >= 0)
                || Number(value.byte_end) < Number(value.byte_start) || Number(value.char_end) < Number(value.char_start)
                || Number(value.byte_end) > length || Number(value.char_end) > length)) throw new AdmissionExportError('Canonical evidence coordinates or content identity differ');
              const { information_label, ...publicValue } = value;
              await record({ kind, ...publicValue }); if (emit) counts[kind]++;
            }
          }
        }
      }
    }
    if (!sourceCount || !options.allPublicCurrent && matched !== selection.size) throw new AdmissionExportError('Selected canonical source is missing, unpromoted or inaccessible');
    return hash.digest('hex');
  };
  let snapshotDigest;
  try { snapshotDigest = await snapshot(true); } finally { await metadata.close(); await sourcesFile.close(); }
  await dependencies.refreshSnapshot?.();
  if (snapshotDigest !== await snapshot(false)) throw new AdmissionExportError('Canonical admission metadata changed during export; resnapshot after publication stabilizes');
  await rename(metadataPending, path.join(out, 'source-index.jsonl')); await rename(sourcePending, path.join(out, 'sources.jsonl'));
  for (const name of ['source-index.jsonl', 'sources.jsonl']) artifacts.set(name, { path: name, sha256: await fileHash(path.join(out, name)), sizeBytes: (await stat(path.join(out, name))).size });
  const manifest = { schema: PUBLIC_ADMISSION_SCHEMA, complete: true, purpose: 'candidate_initial_public_prior',
    scope: options.allPublicCurrent ? 'all_accessible_unrestricted_public_current_sources_with_promoted_evidence_or_direct_profiles' : 'explicit_source_version_hash_selection',
    snapshotDigest, sourceCount: counts.source, counts, totalUniqueSourceBytes: totalBytes, sourceIndex: 'sources.jsonl',
    metadataIndex: 'source-index.jsonl', sources: publicSources, artifacts: [...artifacts.values()],
    limits: { maxItemBytes: options.maxItemBytes, maxTotalBytes: options.maxTotalBytes, maxMetadataBytes: options.maxMetadataBytes, pageRows: options.pageRows },
    limitations: 'Candidate background admission only. No equal Qwen pretraining, task competence, full factual coverage, stable finalization or private-material absence attestation. Per-case packets remain separate; unclassified/XML/lexical corpora are not factual case sources.' };
  const manifestFile = path.join(out, 'admitted-public-manifest.json');
  await admissionArtifacts(manifest, manifestFile);
  const pending = `${manifestFile}.pending`; const handle = await open(pending, 'w');
  try { await handle.writeFile(canonical(manifest) + '\n'); } finally { await handle.close(); }
  await rename(pending, manifestFile);
  return { manifestFile, sha256: await fileHash(manifestFile), snapshotDigest, counts, totalUniqueSourceBytes: totalBytes };
  } finally { await lock.close(); await unlink(lockPath); }
}
async function main() {
  const args = argsMap(process.argv.slice(2));
  if (!args.get('config') || !args.get('out')) throw new AdmissionExportError('--config and --out outside ingestion roots are required');
  const adapter = await import('../../packages/adapters-node/dist/index.js'), config = await adapter.readScceRuntimeConfig(args.get('config'));
  const require = createRequire(new URL('../../packages/adapters-node/package.json', import.meta.url));
  const { Client } = require('pg'), client = new Client({ connectionString: config.database.url, connectionTimeoutMillis: 30000 });
  await client.connect();
  const begin = async () => { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await client.query("SELECT set_config('statement_timeout','30000',true)"); };
  try {
    await begin();
    const options = { out: args.get('out'), schema: config.database.schema, informationAccess: config.security?.informationAccess,
      allPublicCurrent: args.has('all-public-current'), selection: args.has('source-selection') ? JSON.parse(await readFile(args.get('source-selection'), 'utf8')) : undefined,
      forbiddenRoots: config.runtime.allowedRoots ?? [] };
    for (const [flag, key] of [['max-item-bytes','maxItemBytes'],['max-total-bytes','maxTotalBytes'],['max-metadata-bytes','maxMetadataBytes'],['page-rows','pageRows']]) if (args.has(flag)) options[key] = Number(args.get(flag));
    const result = await exportPublicAdmission(options, { client, refreshSnapshot: async () => { await client.query('ROLLBACK'); await begin(); } });
    process.stdout.write(canonical(result) + '\n');
  } finally { await client.query('ROLLBACK').finally(() => client.end()); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof AdmissionExportError ? error.message : 'Public admission export failed; no completed current manifest was certified. Check source selection, access, bounds and canonical currentness.'); process.exitCode = 1; });
