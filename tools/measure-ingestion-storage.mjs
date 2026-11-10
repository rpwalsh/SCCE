#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createBrainDatabase, verifyOutputPath } from './create-brain-database.mjs';
import { benchmarkBuildIdentity } from './lib/benchmark-build-identity.mjs';

const help = `Usage: node tools/measure-ingestion-storage.mjs --config <local-config.json> --input <file> [--input <file>] --out <NEW ignored directory>
  --transcript                 Validate every input as a declared human-authored transcript.
  --source-system <alias>       Default: workspace for text; dialogue for transcripts.
  --readback --request-seed     Verify complete public pattern records / request seeds.
  --skip-observations           Explicitly skip raw n-gram observations, retaining models.
  --ngram-max-order <n> --ngram-max-counters <n> --ngram-vocabulary-limit <n>
  --max-evidence-chunk-bytes <n> --created-at <epoch-ms>
  --max-input-bytes <n>         Optional rejection bound; inputs are never truncated.
Every invocation creates and preserves a NEW local physical database. No old learned state is copied.
See docs/storage-amplification/native-ingestion-measurement.md.`;
export function parseMeasurementArguments(args) {
  const { values } = parseArgs({ args, options: {
    config: { type: 'string' }, input: { type: 'string', multiple: true }, out: { type: 'string' }, help: { type: 'boolean' },
    transcript: { type: 'boolean' }, 'source-system': { type: 'string' }, readback: { type: 'boolean' }, 'request-seed': { type: 'boolean' },
    'skip-observations': { type: 'boolean' }, 'ngram-max-order': { type: 'string' }, 'ngram-max-counters': { type: 'string' },
    'ngram-vocabulary-limit': { type: 'string' }, 'max-evidence-chunk-bytes': { type: 'string' }, 'created-at': { type: 'string' }, 'max-input-bytes': { type: 'string' }
  } });
  if (values.help) return values;
  if (!values.config || !values.out || !values.input?.length) throw Error('--config, one or more --input, and --out are required');
  for (const key of ['ngram-max-order', 'ngram-max-counters', 'ngram-vocabulary-limit', 'max-evidence-chunk-bytes', 'max-input-bytes', 'created-at']) {
    if (values[key] !== undefined && (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < (key === 'created-at' ? 0 : 1))) throw Error(`${key} must be a safe ${key === 'created-at' ? 'nonnegative' : 'positive'} integer`);
  }
  return values;
}
const sha = value => createHash('sha256').update(value).digest('hex');
const implementationRoot = fileURLToPath(new URL('../', import.meta.url));

/** Call the ordinary trainer; this tool owns measurement and verification only. */
export async function measureIngestionStorage(options) {
  const out = resolve(options.out); await mkdir(dirname(out), { recursive: true }); await mkdir(out);
  // Require the whole artifact directory to be ignored, not merely its credential file suffix.
  try { execFileSync('git', ['-C', out, 'check-ignore', '--quiet', '--', out], { stdio: 'ignore', windowsHide: true }); }
  catch { throw Error('--out must be a new Git-ignored directory inside this worktree'); }
  const configPath = await verifyOutputPath(resolve(out, 'fixture.local.json'));
  const api = await import(new URL('../packages/adapters-node/dist/index.js', import.meta.url).href);
  const kernel = await import(new URL('../packages/kernel/dist/index.js', import.meta.url).href);
  const canonical = kernel.canonicalStringify, digest = value => sha(canonical(value));
  const sourceSystem = kernel.canonicalCorpusSourceSystemId(options['source-system'] ?? (options.transcript ? 'dialogue' : 'workspace'));
  const registryDefaults = kernel.corpusNgramSettings(kernel.createCorpusRegistry(), sourceSystem);
  const report = { schema: 'scce.native_ingestion_storage_measurement.v1', at: new Date().toISOString(), status: 'preflight',
    scope: 'Complete explicitly supplied local inputs through canonical prepare/commit in a fresh physical database; no old learned-state copy, migration of existing data, corpus-wide throughput claim, or answer-quality claim.',
    transcript: Boolean(options.transcript), sourceSystem, trainingOptions: { registryNgramDefaults: registryDefaults,
      skipNgramObservationPersistence: Boolean(options['skip-observations']), segmentation: 'local_bootstrap', overrides: {} }, batches: [], databasePreserved: true };
  const trainingOverrides = {};
  for (const [flag, name] of Object.entries({ 'ngram-max-order': 'ngramMaxOrder', 'ngram-max-counters': 'ngramMaxCountersPerOrder', 'ngram-vocabulary-limit': 'ngramVocabularyLimit', 'max-evidence-chunk-bytes': 'maxEvidenceChunkBytes', 'created-at': 'createdAt' })) {
    if (options[flag] !== undefined) trainingOverrides[name] = Number(options[flag]);
  }
  report.trainingOptions.overrides = trainingOverrides;
  const save = () => writeFile(resolve(out, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
  let storage, stage = 'preflight';
  try {
    for (const input of options.input) {
      const info = await stat(resolve(input)); if (!info.isFile()) throw Error('Each --input must be a regular local file');
      if (options['max-input-bytes'] !== undefined && info.size > Number(options['max-input-bytes'])) throw Error('Input exceeds explicit max-input-bytes; no truncation performed');
    }
    report.build = { kernel: await benchmarkBuildIdentity(resolve(implementationRoot, 'packages/kernel/dist/index.js')),
      adapters: await benchmarkBuildIdentity(resolve(implementationRoot, 'packages/adapters-node/dist/index.js')) };
    stage = 'create-new-database'; report.creation = await createBrainDatabase({ config: options.config, outputConfig: configPath });
    const config = await api.readScceRuntimeConfig(configPath); report.databaseName = report.creation.databaseName;
    storage = api.createPostgresStorageAdapter({ ...config.database, informationAccess: config.security.informationAccess });
    const label = { tenantId: config.security.informationAccess.tenantId, principals: [config.security.informationAccess.principalId],
      compartments: [...config.security.informationAccess.compartments], exportClass: 'restricted', mergePolicy: 'isolated' };
    async function allocation() {
      const relations = await storage.query(`SELECT c.relname AS table,pg_relation_size(c.oid)::text AS heap_bytes,
        pg_table_size(c.oid)::text AS table_and_toast_bytes,pg_indexes_size(c.oid)::text AS index_bytes,pg_total_relation_size(c.oid)::text AS total_bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC,c.relname`, [config.database.schema]);
      return { allocatedBytes: relations.reduce((sum, row) => sum + Number(row.total_bytes), 0), relations };
    }
    async function denominator() {
      return (await storage.query(`WITH owners AS (SELECT DISTINCT e.source_version_id FROM ${storage.table('evidence_spans')} e
        JOIN ${storage.table('language_profiles')} p ON p.source_version_id=e.source_version_id WHERE e.status='promoted'),
        blobs AS (SELECT v.content_hash,max(v.byte_length) AS bytes,min(v.byte_length) AS minimum FROM ${storage.table('source_versions')} v JOIN owners o ON o.source_version_id=v.id GROUP BY v.content_hash)
        SELECT count(*)::text AS unique_admitted_learned_hashes,coalesce(sum(bytes),0)::text AS unique_admitted_normalized_utf8_bytes,
          count(*) FILTER(WHERE bytes<>minimum)::text AS conflicting_lengths FROM blobs`))[0];
    }
    const expected = new Map(), verify = options.readback || options['request-seed'];
    if (verify) {
      const put = storage.languageMemory.putLanguagePatterns.bind(storage.languageMemory), replace = storage.languageMemory.replaceLanguagePatternProjection.bind(storage.languageMemory);
      storage.languageMemory.putLanguagePatterns = async rows => { rows.forEach(row => expected.set(row.id, structuredClone(row))); return put(rows); };
      storage.languageMemory.replaceLanguagePatternProjection = async change => { change.patterns.forEach(row => expected.set(row.id, structuredClone(row))); return replace(change); };
    }
    async function verifyPatterns(view) {
      const wanted = [...expected.values()].sort((a, b) => a.id.localeCompare(b.id)), actual = [], families = {};
      const key = row => JSON.stringify([row.patternKind, row.patternJson?.schema ?? null]);
      for (const familyKey of [...new Set(wanted.map(key))]) {
        const family = wanted.filter(row => key(row) === familyKey), kind = family[0].patternKind, schema = family[0].patternJson.schema;
        const found = []; for (let i = 0; i < family.length; i += 32) { const batch = family.slice(i, i + 32);
          const rows = await storage.languageMemory.listLanguagePatterns({ ...(view ? { view } : {}), patternKind: kind,
            ...(schema ? { patternSchemas: [schema] } : {}), patternIds: batch.map(row => row.id), limit: batch.length, maxTotalJsonBytes: 64 * 1024 * 1024, requireComplete: true });
          if (rows.length !== batch.length) throw Error('Public readback returned an incomplete bounded page'); found.push(...rows); }
        found.sort((a, b) => a.id.localeCompare(b.id)); actual.push(...found);
        const oracle = view ? family.map(kernel.requestSeedLanguagePattern) : family;
        families[familyKey] = { rows: found.length, expectedSha256: digest(oracle), actualSha256: digest(found) };
        if (families[familyKey].expectedSha256 !== families[familyKey].actualSha256) throw Error('Exact public pattern readback mismatch');
      }
      actual.sort((a, b) => a.id.localeCompare(b.id));
      return { passed: true, rows: actual.length, expectedSha256: digest(view ? wanted.map(kernel.requestSeedLanguagePattern) : wanted), actualSha256: digest(actual), families };
    }
    report.empty = await allocation(); report.status = 'measuring'; await save();
    for (const [index, file] of options.input.entries()) {
      expected.clear(); stage = 'read-input'; const path = resolve(file), raw = await readFile(path);
      if (options['max-input-bytes'] !== undefined && raw.length > Number(options['max-input-bytes'])) throw Error('Input exceeds explicit max-input-bytes; no truncation performed');
      const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
      const declared = options.transcript ? kernel.validateDeclaredTranscriptSource(JSON.parse(utf8)) : undefined;
      const text = api.normalizeCorpusTrainingText(declared ? declared.text : utf8), sourceUri = pathToFileURL(path).href;
      const batch = { index, inputPath: path, inputFileBytes: raw.length, inputFileSha256: sha(raw), normalizedUtf8Bytes: Buffer.byteLength(text), normalizedTextSha256: sha(Buffer.from(text)), transcriptTurns: declared?.turns.length ?? 0 };
      const input = { storage, sourceSystem, sourceUri, streamUri: sourceSystem + ':' + sourceUri, text,
        ...(declared ? { transcriptTurns: declared.turns } : {}), informationLabel: label, ...trainingOverrides,
        ...(options['created-at'] !== undefined ? { clock: kernel.createClock({ fixedTime: Number(options['created-at']), stepMs: 1 }) } : {}),
        ...(options['skip-observations'] ? { skipNgramObservationPersistence: true } : {}),
        corpusMetadata: { title: basename(path), relativePath: basename(path), sourceHash: sha(raw), corpusRole: kernel.corpusRoleIdForSourceSystem(sourceSystem),
          ...(declared ? { authorship: 'human_authored', transcriptSchema: declared.schema, annotatedTurns: declared.turns.length, sourceMetadata: declared.sourceMetadata } : {}) } };
      stage = 'prepare'; let began = performance.now(); const prepared = await api.prepareLanguageCorpusTraining(input); batch.prepareMs = performance.now() - began;
      stage = 'commit'; began = performance.now(); batch.training = await api.commitLanguageCorpusTraining(input, prepared); batch.commitMs = performance.now() - began;
      batch.physical = await allocation(); batch.sourceDenominator = await denominator();
      const bytes = Number(batch.sourceDenominator.unique_admitted_normalized_utf8_bytes); batch.growthBytes = batch.physical.allocatedBytes - report.empty.allocatedBytes;
      batch.growthToUniqueAdmittedSourceRatio = bytes ? batch.growthBytes / bytes : null;
      batch.allocatedToUniqueAdmittedSourceRatio = bytes ? batch.physical.allocatedBytes / bytes : null;
      if (options.readback) { stage = 'public-full-readback'; batch.fullReadback = await verifyPatterns(); }
      if (options['request-seed']) { stage = 'public-request-seed'; batch.requestSeed = await verifyPatterns('request_seed'); }
      report.batches.push(batch); await save(); console.log(JSON.stringify({ batch: index, databaseName: report.databaseName, admittedUniqueBytes: bytes, growthBytes: batch.growthBytes, ratio: batch.growthToUniqueAdmittedSourceRatio }));
    }
    report.status = 'complete'; report.qualification = 'Table totals include TOAST and indexes exactly once. Allocation includes live rows, page slack and any dead versions; growth subtracts the empty fresh schema. Each batch ratio uses unique content hashes with promoted evidence AND learned profiles, not acquired inputs or summed duplicate files. Prepare and commit are separate wall times, not isolated SQL or whole-corpus throughput.';
  } catch (error) {
    if (error.receipt) { report.creation = error.receipt; report.databaseName = error.receipt.databaseName; }
    report.status = 'failed'; report.error = { stage, name: error.name, code: typeof error.code === 'string' ? error.code : null };
    throw Object.assign(Error('Measurement failed; inspect the receipt and local build/database prerequisites'), { measurementReport: report });
  } finally { try { await storage?.close(); } finally { report.finishedAt = new Date().toISOString(); await save(); } }
  return { databaseName: report.databaseName, receipt: resolve(out, 'receipt.json'), complete: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const options = parseMeasurementArguments(process.argv.slice(2)); console.log(options.help ? help : JSON.stringify(await measureIngestionStorage(options))); }
  catch (error) { console.error(JSON.stringify({ complete: false, error: error.measurementReport ? error.message : 'Invalid arguments or output directory; use --help', name: error.name, code: typeof error.code === 'string' ? error.code : null })); process.exitCode = 1; }
}
