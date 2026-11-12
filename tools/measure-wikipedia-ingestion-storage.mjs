#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from 'node:crypto';
import { mkdir, statfs, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createBrainDatabase } from './create-brain-database.mjs';

const { values: args } = parseArgs({ options: {
  config: { type: 'string' }, out: { type: 'string' }, pages: { type: 'string', default: '3' },
  'implementation-root': { type: 'string', default: '.' }, 'minimum-free-gib': { type: 'string', default: '100' }
} });
if (!args.config || !args.out) throw Error('--config and a NEW ignored --out directory are required');
const pages = Number(args.pages), reserveBytes = Number(args['minimum-free-gib']) * 1024 ** 3;
if (!Number.isSafeInteger(pages) || pages < 1 || pages > 10 || !Number.isFinite(reserveBytes) || reserveBytes < 20 * 1024 ** 3) {
  throw Error('This measured cohort is bounded to 1–10 real articles and at least 20 GiB free-disk reserve');
}
const root = resolve(args['implementation-root']), out = resolve(args.out);
if (process.platform === 'win32' && !/^C:\\/iu.test(out)) throw Error('This laptop run is restricted to C:');
const api = await import(pathToFileURL(resolve(root, 'packages/adapters-node/dist/index.js')).href);
const kernel = await import(pathToFileURL(resolve(root, 'packages/kernel/dist/index.js')).href);
const configPath = resolve(out, 'config.json');
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const freeBytes = async () => { const fs = await statfs(out); return Number(fs.bavail) * Number(fs.bsize); };
if (await freeBytes() < reserveBytes + 2 * 1024 ** 3) throw Error('Insufficient C: headroom for the bounded measured cohort');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(Buffer.from(kernel.canonicalStringify(value)));
const report = { schema: 'scce.wikipedia_ingestion_storage.v1', status: 'preparing',
  scope: 'Real indexed Wikipedia pages through the normal ingestor; a fresh physical database; no brain activation or answer-quality claim.',
  implementationRoot: root, revision: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()),
  pagesRequested: pages, node: process.version, heapLimitBytes: (await import('node:v8')).getHeapStatistics().heap_size_limit,
  minimumFreeBytes: reserveBytes, freeBytesBefore: await freeBytes(), sourceBodiesRetainedInReceipt: false,
  memory: { peakHeapUsed: 0, peakRss: 0, peakExternal: 0 }, checks: {}, timings: {} };
const save = () => writeFile(resolve(out, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
let storage, timer, phase = 'preflight';
const abort = new AbortController();
const sampleMemory = () => {
  const usage = process.memoryUsage();
  report.memory.peakHeapUsed = Math.max(report.memory.peakHeapUsed, usage.heapUsed);
  report.memory.peakRss = Math.max(report.memory.peakRss, usage.rss);
  report.memory.peakExternal = Math.max(report.memory.peakExternal, usage.external);
};
try {
  const base = await api.readScceRuntimeConfig(args.config);
  const wiki = base.runtime.corpora?.wikipedia;
  if (!wiki?.dumpPath || !wiki.indexPath) throw Error('An explicitly configured retained dump and matching index are required');
  for (const item of [wiki.dumpPath, wiki.indexPath, base.runtime.tempRoot]) {
    if (process.platform === 'win32' && item && !/^C:\\/iu.test(resolve(item))) throw Error('Corpus and temporary paths must remain on C:');
  }
  const admin = api.createPostgresStorageAdapter({ ...base.database, informationAccess: base.security.informationAccess });
  try {
    const [location] = await admin.query("SELECT current_setting('data_directory') AS data_directory");
    if (process.platform === 'win32' && !/^C:[\\/]/iu.test(location.data_directory)) throw Error('PostgreSQL data directory is not on C:');
    report.databaseDataDirectory = location.data_directory;
  } finally { await admin.close(); }
  phase = 'create-empty-database';
  report.creation = await createBrainDatabase({ config: args.config, outputConfig: configPath }, { api: {
    ...api, readScceRuntimeConfig: async () => ({ ...base, runtime: { ...base.runtime,
      sourceInductionExecution: undefined,
      corpora: { ...base.runtime.corpora, wikipedia: { ...wiki,
        maxArticleChars: api.effectiveNgramShardChars(wiki.ngramShardChars) } } } })
  } });
  const config = await api.readScceRuntimeConfig(configPath);
  report.databaseName = report.creation.databaseName;
  report.execution = { sourceInduction: 'in-process', heapMiB: 7168,
    reason: 'The configured 7 GiB worker RSS reservation cannot hold a 7 GiB coordinator heap plus a worker; the existing in-process path keeps the heap unchanged.' };
  report.compilerSettings = { ngramMaxOrder: wiki.ngramMaxOrder ?? 4,
    ngramMaxCountersPerOrder: wiki.ngramMaxCountersPerOrder ?? 128,
    ngramVocabularyLimit: wiki.ngramVocabularyLimit ?? 8192, maxChunkBytes: config.runtime.maxChunkBytes,
    maxArticleChars: config.runtime.corpora.wikipedia.maxArticleChars };
  const openStorage = () => api.createPostgresStorageAdapter({ ...config.database, informationAccess: config.security.informationAccess });
  storage = openStorage();
  const allocation = async () => {
    const relations = await storage.query(`SELECT c.relname AS name,pg_table_size(c.oid)::text AS table_and_toast_bytes,
        pg_indexes_size(c.oid)::text AS index_bytes,pg_total_relation_size(c.oid)::text AS total_bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC,c.relname`, [config.database.schema]);
    const [database] = await storage.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
      pg_current_wal_insert_lsn()::text AS wal_lsn,coalesce(temp_bytes,0)::text AS temp_bytes,coalesce(temp_files,0)::text AS temp_files
      FROM pg_stat_database WHERE datname=current_database()`);
    return { ...database, allocatedBytes: relations.reduce((sum, row) => sum + Number(row.total_bytes), 0), relations };
  };
  report.before = await allocation();
  const expected = new Map();
  const putEvidence = storage.evidence.putEvidenceSpans?.bind(storage.evidence);
  if (!putEvidence) throw Error('Canonical batch evidence writer is required for independent readback capture');
  storage.evidence.putEvidenceSpans = async spans => {
    for (const span of spans) expected.set(String(span.id), { keys: Object.keys(span).sort(), digest: digest(span),
      contentHash: String(span.contentHash), byteLength: Buffer.byteLength(span.text, 'utf8') });
    return putEvidence(spans);
  };
  phase = 'real-wikipedia-ingestion';
  timer = setInterval(() => { sampleMemory(); void freeBytes().then(bytes => {
    if (bytes < reserveBytes) abort.abort(Error('Protected C: disk reserve reached; measured cohort failed'));
  }).catch(error => abort.abort(error)); }, 250);
  sampleMemory();
  const clock = kernel.createClock({ fixedTime: 1700000000000, stepMs: 1 }), hasher = kernel.createHasher();
  const idFactory = kernel.createIdFactory({ clock, hasher, namespace: 'wiki-ingestor-storage-cohort', deterministicReplay: true });
  const ingestor = api.createWikipediaV3Ingestor({ storage, config, clock, hasher, idFactory });
  let start = performance.now();
  const common = { dumpPath: wiki.dumpPath, indexPath: wiki.indexPath, maxPages: pages, maxBlocks: 1,
    signal: abort.signal, onStatus: async status => {
      report.progress = { state: status.state, stage: status.stage, pages: status.pages, evidence: status.evidence,
        pendingLanguagePages: status.pendingLanguagePages };
      sampleMemory(); await save();
    } };
  report.ingestion = await ingestor.ingest(common);
  report.timings.sourceAndPendingJournalMs = performance.now() - start;
  report.pendingJournalBytes = (await storage.query(`SELECT coalesce(sum(pg_column_size(metadata_json)),0)::text AS stored_bytes,
    coalesce(sum(octet_length(metadata_json::text)),0)::text AS decoded_json_bytes FROM ${storage.table('ingestion_checkpoints')}`))[0];
  const learningStart = performance.now();
  if (report.progress.pendingLanguagePages > 0) {
    report.finishPending = await ingestor.ingest({ ...common, finishPending: true });
  }
  // The ordinary bounded run may leave an open language journal. Its supported finish command reads no new pages.
  const journals = await storage.ingestion.list({ rootUri: report.ingestion.rootUri, limit: 100 });
  if (journals.some(row => row.metadata?.languageBatch?.state === 'open' && row.metadata.languageBatch.pendingSamples?.length)) {
    report.finishPending = await ingestor.ingest({ ...common, finishPending: true });
  }
  report.timings.ingestionMs = performance.now() - start;
  report.timings.finishPendingMs = performance.now() - learningStart;
  report.after = await allocation();
  report.applicationGrowthBytes = report.after.allocatedBytes - report.before.allocatedBytes;
  report.wholeDatabaseGrowthBytes = Number(report.after.database_bytes) - Number(report.before.database_bytes);
  [report.wal] = await storage.query('SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::text AS emitted_bytes', [report.after.wal_lsn, report.before.wal_lsn]);
  report.wal.scope = 'cluster-wide LSN delta; other cluster activity can contribute';
  const blobColumns = new Set((await storage.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='blobs'`, [config.database.schema])).map(row => row.column_name));
  report.costs = (await storage.query(`SELECT count(*)::text AS blob_rows,sum(byte_length)::text AS logical_blob_bytes,
      sum(octet_length(content))::text AS material_blob_bytes,
      ${blobColumns.has('range_parent_hash') ? 'count(*) FILTER(WHERE range_parent_hash IS NOT NULL)' : '0'}::text AS range_rows,
      ${blobColumns.has('archive_reference') ? 'count(*) FILTER(WHERE archive_reference IS NOT NULL)' : '0'}::text AS archive_rows FROM ${storage.table('blobs')}`))[0];
  report.sourceBytes = (await storage.query(`SELECT count(*)::text AS source_versions,
    sum(byte_length) FILTER(WHERE metadata_json->'_scceSourceVersion'->>'role'='original')::text AS original_source_bytes,
    sum(byte_length) FILTER(WHERE metadata_json->'_scceSourceVersion'->>'role'='evidence-derivative')::text AS evidence_source_bytes
    FROM ${storage.table('source_versions')} WHERE metadata_json->>'sourceSystem'='wikipedia'`))[0];
  report.evidenceBytes = { records: expected.size, bytes: [...expected.values()].reduce((sum, span) => sum + span.byteLength, 0) };
  report.journalBytes = (await storage.query(`SELECT coalesce(sum(pg_column_size(metadata_json)),0)::text AS stored_bytes,
      coalesce(sum(octet_length(metadata_json::text)),0)::text AS decoded_json_bytes FROM ${storage.table('ingestion_checkpoints')}`))[0];
  const sourceRows = await storage.query(`SELECT DISTINCT content_hash,byte_length,media_type FROM ${storage.table('source_versions')}
    WHERE metadata_json->>'sourceSystem'='wikipedia' ORDER BY content_hash`);
  await storage.close(); storage = undefined;
  phase = 'fresh-process-exact-readback';
  start = performance.now();
  const oraclePath = resolve(out, 'readback-oracle.json');
  await writeFile(oraclePath, JSON.stringify({ root, configPath, expected: [...expected], sourceRows }) + '\n');
  const reader = await promisify(execFile)(process.execPath, ['--max-old-space-size=7168', '--input-type=module', '-e', `
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    import { resolve } from 'node:path';
    import { createHash } from 'node:crypto';
    const input=JSON.parse(await readFile(process.argv[1],'utf8'));
    const api=await import(pathToFileURL(resolve(input.root,'packages/adapters-node/dist/index.js')).href);
    const kernel=await import(pathToFileURL(resolve(input.root,'packages/kernel/dist/index.js')).href);
    const config=await api.readScceRuntimeConfig(input.configPath);
    const storage=api.createPostgresStorageAdapter({...config.database,informationAccess:config.security.informationAccess});
    const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
    const digest=value=>sha(Buffer.from(kernel.canonicalStringify(value)));
    let evidenceChecked=0,sourceBytesChecked=0;
    const begin=performance.now();
    try {
      for(const [id,oracle] of input.expected){
        const span=await storage.evidence.getEvidence(id);
        if(!span)throw Error('Published evidence unavailable after process restart');
        const selected=Object.fromEntries(oracle.keys.map(key=>[key,span[key]]));
        if(digest(selected)!==oracle.digest||'sha256_'+sha(Buffer.from(span.text,'utf8'))!==oracle.contentHash
          ||Buffer.byteLength(span.text,'utf8')!==oracle.byteLength)throw Error('Cold evidence record/hash/ownership mismatch');
        evidenceChecked++;
      }
      for(const source of input.sourceRows){
        const bytes=await storage.blobs.get(source.content_hash);
        if('sha256_'+sha(bytes)!==source.content_hash||bytes.length!==Number(source.byte_length))throw Error('Cold source hash/length mismatch');
        sourceBytesChecked+=bytes.length;
      }
      console.log(JSON.stringify({evidenceChecked,sourceBytesChecked,elapsedMs:performance.now()-begin,
        memory:process.memoryUsage(),processMaxRssKiB:process.resourceUsage().maxRSS}));
    }finally{await storage.close();}
  `, oraclePath], { cwd: root, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  report.coldReadback = JSON.parse(reader.stdout.trim());
  const { evidenceChecked, sourceBytesChecked } = report.coldReadback;
  report.timings.freshProcessReadbackMs = performance.now() - start;
  report.checks = { pagesExactlyRequested: report.ingestion.pages === pages, noTruncation: report.ingestion.truncatedPages === 0,
    exactEvidenceRecords: evidenceChecked === expected.size && evidenceChecked > 0, evidenceChecked, sourceBytesChecked,
    existingBrainUntouched: true, brainActivated: false };
  if (Object.entries(report.checks).some(([key, value]) => ['pagesExactlyRequested','noTruncation','exactEvidenceRecords'].includes(key) && !value)) {
    throw Error('Measured ingestion did not satisfy its declared cohort contract');
  }
  report.status = 'complete';
  report.limits = ['Fresh application process with empty application caches; OS/PostgreSQL caches may be warm.',
    'Memory samples cover this Node process; Python/PostgreSQL and unsampled transient heap peaks are separate costs.',
    'This bounded cohort establishes no full-Wikipedia forecast, protected quality result, or backend comparison.'];
} catch (error) {
  report.status = 'failed'; report.error = { phase, name: error?.name ?? 'Error', message: String(error?.message ?? error)
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[database URL omitted]') };
  process.exitCode = 1;
} finally {
  clearInterval(timer); sampleMemory();
  report.memory.processMaxRssKiB = process.resourceUsage().maxRSS;
  report.freeBytesAfter = await freeBytes();
  await storage?.close(); await save();
  console.log(JSON.stringify({ status: report.status, phase, databaseName: report.databaseName,
    pages: report.ingestion?.pages, growthBytes: report.applicationGrowthBytes, receipt: resolve(out, 'receipt.json'), error: report.error }));
}
