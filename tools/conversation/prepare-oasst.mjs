#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { mkdir, readFile, writeFile, open, unlink, rmdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argsMap, stableStringify, sha256Text, sha256Bytes } from '../sealed-eval/harness/lib/util.mjs';
import { fileHash } from '../blind-comparison/protocol.mjs';
import { createOasstTranscriptWriter } from './oasst-transcript-writer.mjs';

const digest = value => sha256Text(stableStringify(value));
function reason(row) {
  if (!row || typeof row.message_id !== 'string' || !row.message_id || typeof row.message_tree_id !== 'string') return 'invalid_source_identity';
  if (!['prompter', 'assistant'].includes(row.role)) return 'unsupported_source_role';
  if (row.review_result !== true || !Number.isInteger(row.review_count) || row.review_count < 1) return 'not_source_reviewed';
  if (row.deleted !== false) return 'deleted_or_unspecified';
  if (row.synthetic !== false || row.model_name != null || row.model != null) return 'synthetic_model_or_unspecified';
  if (typeof row.text !== 'string' || !row.text.trim()) return 'empty_source_text';
  if (row.text.includes('\0')) return 'source_nul_not_supported';
  return null;
}
async function* records(archive, maxRecordBytes, signal) {
  let pending = Buffer.alloc(0), lineNumber = 0;
  const input = createReadStream(archive, { highWaterMark: 65536 }), stream = createGunzip();
  const completion = pipeline(input, stream, { signal }); completion.catch(() => undefined);
  try {
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1); lineNumber++;
      if (line.length > maxRecordBytes) throw new Error('Source record exceeds declared byte budget');
      if (!line.length) continue;
      yield { row: JSON.parse(line.toString('utf8')), bytes: line, lineNumber, rawLineSha256: sha256Text(line.toString('utf8')) };
    }
    if (pending.length > maxRecordBytes) throw new Error('Source record exceeds declared byte budget');
  }
  if (pending.length) yield { row: JSON.parse(pending.toString('utf8')), bytes: pending, lineNumber: lineNumber + 1, rawLineSha256: sha256Text(pending.toString('utf8')) };
  await completion;
  } finally { input.destroy(); stream.destroy(); await completion.catch(() => undefined); }
}
function count(target, key) { target[key] = (target[key] ?? 0) + 1; }
function sourcePath(leaf, index, mode, maxTurns, maxDocumentBytes) {
  const reverse = [], seen = new Set(); let current = leaf, bytes = 0;
  while (current) {
    if (seen.has(current.id)) return { reason: 'cyclic_source_lineage' };
    if (reverse.length >= maxTurns) return { reason: 'source_path_exceeds_turn_budget' };
    seen.add(current.id); reverse.push(current); bytes += current.nfcBytes + (reverse.length > 1 ? 2 : 0);
    if (bytes > maxDocumentBytes) return { reason: 'source_path_exceeds_document_budget' };
    if (current.parentId == null) break;
    if (mode === 'root-pairs' && reverse.length >= 2) return { reason: 'not_top_level_reply' };
    const parent = index.get(current.parentId);
    if (!parent) return { reason: 'missing_eligible_ancestor' };
    if (parent.locale !== leaf.locale) return { reason: 'mixed_locale_source_path' };
    if (parent.role === current.role) return { reason: 'nonalternating_source_edge' };
    current = parent;
  }
  const chain = reverse.reverse(), root = chain[0];
  if (root?.role !== 'prompter' || root.parentId != null || root.treeId !== root.id || chain.length < 2) return { reason: 'incomplete_root_request_reply' };
  if (chain.some(message => message.treeId !== root.id)) return { reason: 'source_tree_identity_mismatch' };
  return { chain, rootId: root.id, leafId: leaf.id };
}
export async function prepareOasst(raw) {
  const options = { mode: 'root-pairs', maxRecordBytes: 4_000_000, maxDocumentBytes: 64 * 1024, maxPathTurns: 64, maxIndexBytes: 64 * 1024 * 1024, ...raw };
  if (!['root-pairs', 'paths'].includes(options.mode)) throw new Error('Mode must be root-pairs or paths');
  if (!options.limits || !Object.keys(options.limits).length || Object.entries(options.limits).some(([locale, n]) => !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(locale) || !Number.isInteger(n) || n < 1)) throw new Error('Declare positive per-locale limits');
  options.limits = Object.freeze({ ...options.limits });
  const positive = (name, value) => { if (!Number.isSafeInteger(value) || value < 1) throw Error(`Declare positive safe-integer ${name}`); return value; };
  for (const name of ['maxRecordBytes', 'maxDocumentBytes', 'maxPathTurns', 'maxIndexBytes']) positive(name, options[name]);
  if (options.packing !== undefined) {
    if (!options.packing || Object.keys(options.packing).some(key => !['maxSerializedBytes','maxTextBytes'].includes(key))) throw Error('Invalid packing declaration');
    positive('packing.maxSerializedBytes', options.packing.maxSerializedBytes); positive('packing.maxTextBytes', options.packing.maxTextBytes);
    options.packing = Object.freeze({ ...options.packing });
  }
  // Preserve the old admission defaults: the optional disk bound otherwise
  // derives from the already-declared finite root/path/record upper bounds.
  const maxSpoolBytes = positive('maxSpoolBytes', options.maxSpoolBytes ?? Object.values(options.limits).reduce((sum, n) => sum + n, 0)
    * (options.mode === 'root-pairs' ? 2 : options.maxPathTurns) * options.maxRecordBytes);
  options.signal?.throwIfAborted();
  const archive = path.resolve(options.archive), out = path.resolve(options.out), captureFile = path.resolve(options.capture ?? path.join(path.dirname(archive), 'capture.json')), licenseFile = path.resolve(options.license ?? path.join(path.dirname(archive), 'LICENSE'));
  const captureBytes = await readFile(captureFile), capture = JSON.parse(captureBytes.toString('utf8'));
  const archiveSha256 = await fileHash(archive);
  if (capture.schema !== 'scce.captured_source.v1' || capture.dataset !== 'OpenAssistant/oasst1' || !/^[a-f0-9]{40}$/u.test(capture.revision ?? '') || capture.file !== path.basename(archive) || capture.sha256 !== archiveSha256 || capture.bytes !== (await stat(archive)).size || typeof capture.license !== 'string' || !capture.license) throw new Error('Archive does not match its pinned capture provenance');
  const source = { dataset: capture.dataset, revision: capture.revision, ...(capture.url === undefined ? {} : { url: capture.url }), archiveSha256, captureSha256: sha256Bytes(captureBytes), license: capture.license, licenseSha256: await fileHash(licenseFile) };
  await mkdir(out, { recursive: false });
  const spool = path.join(out, '.source-preparation-index'), spoolFile = path.join(spool, 'records.bin'); await mkdir(spool);
  const index = new Map(), ids = new Set(), localeReports = Object.fromEntries(Object.keys(options.limits).map(locale => [locale, { requestedDocuments: options.limits[locale], sourceMessages: 0, eligibleMessages: 0, verifiedCandidatePaths: 0, availableRoots: 0, retainedDocuments: 0, retainedUniqueMessages: 0, sourceRejections: {}, pathRejections: {}, retainedPathLengths: {} }]));
  let indexBytes = 0, messagesRead = 0, spoolBytes = 0, spoolIndexBytes = 0, spooledRecords = 0, spoolHandle;
  const locatorKey = Symbol('owned source record offset');
  try {
    spoolHandle = await open(spoolFile, 'wx+');
    await options.onProgress?.({ stage: 'spool.opened', path: spoolFile }); options.signal?.throwIfAborted();
    for await (const { row, lineNumber, rawLineSha256 } of records(archive, options.maxRecordBytes, options.signal)) {
      options.signal?.throwIfAborted();
      messagesRead++;
      if (typeof row.message_id !== 'string') throw new Error('Source message identity is absent');
      if (ids.has(row.message_id)) throw new Error('Duplicate source message identity');
      ids.add(row.message_id); indexBytes += Buffer.byteLength(row.message_id);
      if (indexBytes > options.maxIndexBytes) throw new Error('Source metadata index exceeds declared byte budget');
      const report = localeReports[row.lang]; if (!report) continue;
      report.sourceMessages++;
      const rejected = reason(row); if (rejected) { count(report.sourceRejections, rejected); continue; }
      const nfc = row.text.normalize('NFC');
      const metadata = { id: row.message_id, parentId: row.parent_id ?? null, treeId: row.message_tree_id, role: row.role, locale: row.lang, lineNumber, rawLineSha256, originalTextSha256: sha256Text(row.text), nfcTextSha256: sha256Text(nfc), originalCodePoints: [...row.text].length, nfcCodePoints: [...nfc].length, nfcBytes: Buffer.byteLength(nfc) };
      indexBytes += Buffer.byteLength(stableStringify(metadata));
      if (indexBytes > options.maxIndexBytes) throw new Error('Source metadata index exceeds declared byte budget');
      index.set(metadata.id, metadata); report.eligibleMessages++;
    }
    const selected = Object.fromEntries(Object.keys(options.limits).map(locale => [locale, new Map()])), available = Object.fromEntries(Object.keys(options.limits).map(locale => [locale, new Set()]));
    for (const message of index.values()) {
      options.signal?.throwIfAborted();
      if (message.role !== 'assistant') continue;
      const report = localeReports[message.locale], result = sourcePath(message, index, options.mode, options.mode === 'root-pairs' ? 2 : options.maxPathTurns, options.maxDocumentBytes);
      if (result.reason) { count(report.pathRejections, result.reason); continue; }
      report.verifiedCandidatePaths++; available[message.locale].add(result.rootId);
      const rootRank = digest([archiveSha256, message.locale, result.rootId]), leafRank = digest([archiveSha256, result.rootId, result.leafId]);
      const group = selected[message.locale], current = group.get(result.rootId);
      if (current && current.leafRank <= leafRank) continue;
      group.set(result.rootId, { ...result, rootRank, leafRank });
      if (group.size > options.limits[message.locale]) {
        const worst = [...group.values()].sort((a, b) => b.rootRank.localeCompare(a.rootRank))[0]; group.delete(worst.rootId);
      }
    }
    const needed = new Set(Object.values(selected).flatMap(group => [...group.values()].flatMap(item => item.chain.map(m => m.id))));
    for await (const { row, bytes, lineNumber, rawLineSha256 } of records(archive, options.maxRecordBytes, options.signal)) {
      if (!needed.has(row.message_id)) continue;
      if (index.get(row.message_id)?.rawLineSha256 !== rawLineSha256 || index.get(row.message_id)?.lineNumber !== lineNumber) throw new Error('Selected source changed between preparation passes');
      if (spoolBytes + bytes.length > maxSpoolBytes) throw Error('Selected source-record spool exceeds declared byte budget');
      const locator = { offset: spoolBytes, length: bytes.length, sha256: sha256Bytes(bytes) };
      const locatorBytes = Buffer.byteLength(stableStringify({ id: row.message_id, ...locator }));
      indexBytes += locatorBytes; spoolIndexBytes += locatorBytes;
      if (indexBytes > options.maxIndexBytes) throw Error('Source metadata index exceeds declared byte budget');
      await spoolHandle.writeFile(bytes); Object.defineProperty(index.get(row.message_id), locatorKey, { value: locator });
      spoolBytes += bytes.length; spooledRecords++;
    }
    if (spooledRecords !== needed.size) throw Error('Selected source records are incomplete');
    await options.onProgress?.({ stage: 'spool.complete', path: spoolFile, records: spooledRecords, bytes: spoolBytes, maxBytes: maxSpoolBytes }); options.signal?.throwIfAborted();
    const documents = [];
    for (const [locale, group] of Object.entries(selected)) {
      const directory = path.join(out, 'train', locale); await mkdir(directory, { recursive: true });
      const writer = createOasstTranscriptWriter({ out, locale, packing: options.packing, signal: options.signal });
      const retained = new Set(), report = localeReports[locale]; report.availableRoots = available[locale].size;
      for (const item of [...group.values()].sort((a, b) => a.rootRank.localeCompare(b.rootRank))) {
        options.signal?.throwIfAborted();
        const turns = [], lineage = [], rawMetadata = []; let text = '', pointOffset = 0, rawMetadataBytes = 0;
        for (const metadata of item.chain) {
          options.signal?.throwIfAborted();
          const locator = metadata[locatorKey]; if (!locator) throw Error('Selected source record has no owned spool location');
          const bytes = Buffer.alloc(locator.length); let offset = 0;
          while (offset < bytes.length) { const read = await spoolHandle.read(bytes, offset, bytes.length - offset, locator.offset + offset); if (!read.bytesRead) throw Error('Selected source-record spool is incomplete'); offset += read.bytesRead; }
          if (sha256Bytes(bytes) !== locator.sha256) throw Error('Selected source-record spool hash changed');
          const row = JSON.parse(bytes.toString('utf8'));
          if (row.message_id !== metadata.id) throw Error('Selected source-record spool identity changed');
          if (options.packing) { const { text: originalText, ...fields } = row; rawMetadataBytes += Buffer.byteLength(stableStringify(fields));
            if (rawMetadataBytes > options.packing.maxSerializedBytes) throw Error('Complete source path metadata exceeds declared packing bounds'); rawMetadata.push(fields); }
          const surface = row.text.normalize('NFC');
          if (sha256Text(surface) !== metadata.nfcTextSha256 || sha256Text(row.text) !== metadata.originalTextSha256) throw new Error('Selected source text hash changed');
          if (turns.length) { text += '\n\n'; pointOffset += 2; }
          const turnIndex = turns.length;
          turns.push({ index: turnIndex, speakerId: row.role, surface, startCodePoint: pointOffset, endCodePoint: pointOffset + metadata.nfcCodePoints, ...(turnIndex ? { replyToTurnIndex: turnIndex - 1, commitmentScope: 'conversation' } : {}) });
          lineage.push({ ...metadata, originalMessageCodePointRange: [0, metadata.originalCodePoints], normalizedMessageCodePointRange: [0, metadata.nfcCodePoints], normalizedDocumentCodePointRange: [pointOffset, pointOffset + metadata.nfcCodePoints], sourceFlags: { review_result: row.review_result, review_count: row.review_count, deleted: row.deleted, synthetic: row.synthetic, model_name: row.model_name ?? null, model: row.model ?? null, modelFieldPresence: { model_name: Object.hasOwn(row, 'model_name'), model: Object.hasOwn(row, 'model') } } });
          text += surface; pointOffset += metadata.nfcCodePoints; retained.add(metadata.id);
        }
        const document = { schema: 'scce.dialogue_transcript.v1', text, turns, sourceMetadata: { ...source, locale, languageAliases: [locale], rootMessageId: item.rootId, replyMessageId: item.leafId, preparationMode: options.mode, normalization: 'NFC', selection: 'deterministic source-ID hash order; one actual branch per root', lineage, authorityAnnotations: 'None invented; reply edges confer conversation scope only, not external truth or request-authority labels.' } };
        await writer.add(document, rawMetadata);
        report.retainedDocuments++; count(report.retainedPathLengths, String(turns.length));
      }
      report.retainedUniqueMessages = retained.size;
      const output = await writer.finish(); documents.push(...output);
      if (options.packing) report.outputDocuments = output.length;
    }
    options.signal?.throwIfAborted();
    if (await fileHash(archive) !== archiveSha256) throw new Error('Pinned source archive changed during preparation');
    const licenseBytes = await readFile(licenseFile);
    if (sha256Bytes(licenseBytes) !== source.licenseSha256 || await fileHash(captureFile) !== source.captureSha256) throw Error('Pinned capture or license changed during preparation');
    options.signal?.throwIfAborted();
    await writeFile(path.join(out, 'LICENSE'), licenseBytes, { flag: 'wx' });
    const manifest = { schema: 'scce.oasst_dialogue_preparation.v1', source, mode: options.mode, limits: { perLocale: options.limits, maxRecordBytes: options.maxRecordBytes, maxDocumentBytes: options.maxDocumentBytes, maxPathTurns: options.maxPathTurns, maxSerializedIndexBytes: options.maxIndexBytes, maxSpoolBytes,
      ...(options.packing ? { packing: options.packing } : {}) }, resources: { spoolFilesCreated: 1, spooledRecords, spoolBytes, spoolIndexBytes }, messagesRead, serializedIndexBytes: indexBytes, locales: localeReports, documents, training: Object.keys(options.limits).map(locale => ({ locale, root: path.join(out, 'train', locale), authorship: 'human_authored', languageAliases: [locale], expectedDocuments: options.packing ? localeReports[locale].outputDocuments : localeReports[locale].retainedDocuments })), limitations: ['No diagnostic or private benchmark data was read.', 'No requestAuthority/external-evidence labels are invented from source prose.', 'Conversation-only annotations do not supply the neutral evidence-bearing contrast required for request-act hydration.', 'Source preparation is not proof of general conversational capability; train through the ordinary corpus lane and evaluate fresh held-out tasks.'] };
    await writeFile(path.join(out, 'preparation.json'), `${stableStringify({ ...manifest, digest: digest(manifest) })}\n`, { flag: 'wx' });
    return manifest;
  } finally {
    if (path.dirname(path.resolve(spool)) !== out || path.basename(spool) !== '.source-preparation-index') throw new Error('Unsafe temporary source-index cleanup');
    try { await spoolHandle?.close(); } finally {
      await unlink(spoolFile).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      await rmdir(spool);
    }
  }
}
async function main() {
  const args = argsMap(), need = key => { const value = args.get(key); if (!value) throw new Error(`Missing --${key}`); return value; };
  const allowed = new Set(['archive','out','capture','license','limits','mode','max-record-bytes','max-document-bytes','max-path-turns','max-index-bytes','max-spool-bytes','pack-max-serialized-bytes','pack-max-text-bytes']);
  for (const key of args.keys()) if (!allowed.has(key)) throw Error(`Unknown --${key}`);
  const limits = Object.fromEntries(need('limits').split(',').map(pair => { const [locale, limit] = pair.split('='); return [locale, Number(limit)]; }));
  const packing = args.has('pack-max-serialized-bytes') || args.has('pack-max-text-bytes')
    ? { maxSerializedBytes: Number(need('pack-max-serialized-bytes')), maxTextBytes: Number(need('pack-max-text-bytes')) } : undefined;
  const bounds = Object.fromEntries([['max-record-bytes','maxRecordBytes'],['max-document-bytes','maxDocumentBytes'],['max-path-turns','maxPathTurns'],['max-index-bytes','maxIndexBytes'],['max-spool-bytes','maxSpoolBytes']]
    .filter(([flag]) => args.has(flag)).map(([flag,key]) => [key,Number(args.get(flag))]));
  const controller = new AbortController(), cancel = () => controller.abort(new DOMException('OASST preparation cancelled', 'AbortError'));
  process.once('SIGINT',cancel); process.once('SIGTERM',cancel);
  let report;
  try { report = await prepareOasst({ archive: need('archive'), out: need('out'), capture: args.get('capture'), license: args.get('license'), limits,
    mode: args.get('mode') ?? 'root-pairs', ...bounds, ...(packing ? { packing } : {}), signal: controller.signal }); }
  finally { process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel); }
  console.log(stableStringify({ schema: report.schema, source: report.source, mode: report.mode, messagesRead: report.messagesRead, locales: report.locales, training: report.training, limitations: report.limitations }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
