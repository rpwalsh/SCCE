// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPostgresStorageAdapter, readScceRuntimeConfig, trainGutenbergCorpus, trainLanguageCorpusText, trainOssCorpus } from "../packages/adapters-node/dist/index.js";

const args = new Map(process.argv.slice(2).map(value => {
  const match = /^--([^=]+)=(.*)$/u.exec(value);
  return match ? [match[1], match[2]] : [value.replace(/^--/u, ""), "true"];
}));
if (args.get("run") !== "true") {
  process.stdout.write("Usage: node tools/rehearse-corpus-training.mjs --run=true [--config=scce.config.json]\n");
  process.exit(0);
}

const configPath = args.get("config") ?? "scce.config.json";
const config = await readScceRuntimeConfig(configPath);
const schema = `scce_corpus_retry_${randomBytes(16).toString("hex")}`;
if (!/^scce_corpus_retry_[a-f0-9]{32}$/u.test(schema)) throw new Error("unsafe rehearsal schema");
const tmpRoot = path.resolve(".tmp");
await mkdir(tmpRoot, { recursive: true });
const root = await mkdtemp(path.join(tmpRoot, "corpus-training-rehearsal-"));
const relativeToTmp = path.relative(tmpRoot, root);
if (!relativeToTmp || relativeToTmp.startsWith("..") || path.isAbsolute(relativeToTmp)) throw new Error("fixture path escaped .tmp");
let storage;
let schemaOwned = false;
let error;
const report = { schema, credentialsRecorded: false, checks: [] };
const sanitize = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 4000);
const check = (id, passed, detail) => report.checks.push({ id, passed, detail: sanitize(detail) });
const count = async table => Number((await storage.query(`SELECT COUNT(*)::text AS count FROM ${storage.table(table)}`))[0].count);
try {
  storage = createPostgresStorageAdapter({
    url: config.database.url,
    schema,
    ssl: config.database.ssl,
    informationAccess: { tenantId: "scce.local", principalId: "scce.local.owner", compartments: [], maximumExportClass: "restricted" }
  });
  const before = await storage.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
  if (before.length) throw new Error(`schema unexpectedly exists: ${schema}`);
  await storage.migrate();
  schemaOwned = true;
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "book.txt"), [
    "*** START OF THE PROJECT GUTENBERG EBOOK RETRY FIXTURE ***",
    "A small public corpus document repeats enough words for a stable language model.",
    "*** END OF THE PROJECT GUTENBERG EBOOK RETRY FIXTURE ***"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "src", "pump.ts"), "export function pumpPressure(input: number) { return input + 1; }\n", "utf8");

  const g1 = await trainGutenbergCorpus({ storage, rootPath: root, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128 });
  const bookUri = pathToFileURL(path.join(root, "book.txt")).href;
  const sourceRows = await storage.query(`
    SELECT sv.id, s.canonical_uri AS uri, sv.content_hash AS "contentHash",
           sv.metadata_json->'_scceSourceVersion'->>'role' AS role,
           sv.metadata_json->'_scceSourceVersion'->'derivation' AS derivation
      FROM ${storage.table("source_versions")} sv
      JOIN ${storage.table("sources")} s ON s.id=sv.source_id
     WHERE s.canonical_uri=$1
     ORDER BY sv.id`, [bookUri]);
  const originalRow = sourceRows.find(row => row.role === "original");
  const derivativeRow = sourceRows.find(row => row.role === "evidence-derivative");
  const expectedRaw = await readFile(path.join(root, "book.txt"));
  const expectedDerivative = Buffer.from("A small public corpus document repeats enough words for a stable language model.", "utf8");
  const blobFor = async row => (await storage.query(`SELECT content FROM ${storage.table("blobs")} WHERE content_hash=$1`, [row.contentHash]))[0]?.content;
  const originalBlob = originalRow ? await blobFor(originalRow) : undefined;
  const derivativeBlob = derivativeRow ? await blobFor(derivativeRow) : undefined;
  const derivedEvidence = derivativeRow
    ? await storage.query(`SELECT source_version_id, content_hash, byte_start, byte_end, char_start, char_end, text_content FROM ${storage.table("evidence_spans")} WHERE source_version_id=$1`, [derivativeRow.id])
    : [];
  const evidenceSlicesValid = derivedEvidence.length > 0 && derivedEvidence.every(span => {
    const byteStart = Number(span.byte_start);
    const byteEnd = Number(span.byte_end);
    const charStart = Number(span.char_start);
    const charEnd = Number(span.char_end);
    const text = String(span.text_content);
    if (!derivativeBlob || derivativeBlob.subarray(byteStart, byteEnd).toString("utf8") !== text) return false;
    if ([...derivativeBlob.toString("utf8")].slice(charStart, charEnd).join("") !== text) return false;
    const expectedHash = `sha256_${createHash("sha256").update(derivativeBlob.subarray(byteStart, byteEnd)).digest("hex")}`;
    return expectedHash === span.content_hash;
  });
  check("gutenberg.raw-and-derivative-source-versions", sourceRows.length === 2 && originalRow && derivativeRow
    && originalBlob?.equals(expectedRaw) && derivativeBlob?.equals(expectedDerivative)
    && derivativeRow.derivation?.derivedFromSourceVersionId === originalRow.id
    && derivativeRow.derivation?.transformId === "scce.gutenberg.boilerplate-strip.v1", JSON.stringify({
      sourceRows: sourceRows.map(row => ({ id: row.id, role: row.role, derivation: row.derivation })),
      originalBytes: originalBlob?.byteLength ?? null,
      derivativeBytes: derivativeBlob?.byteLength ?? null
    }));
  check("gutenberg.derivative-evidence-slices-own-blob", evidenceSlicesValid, JSON.stringify({ evidence: derivedEvidence.length }));
  const aggregateDocuments = async () => Number((await storage.query(`SELECT COALESCE(SUM(documents_observed),0)::text AS count FROM ${storage.table("segmentation_aggregates")}`))[0].count);
  const gBefore = { observations: await count("ngram_observations"), models: await count("ngram_models"), events: await count("events"), segmentation: await count("segmentation_aggregates"), segmentationDocuments: await aggregateDocuments() };
  const g2 = await trainGutenbergCorpus({ storage, rootPath: root, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128 });
  const gAfter = { observations: await count("ngram_observations"), models: await count("ngram_models"), events: await count("events"), segmentation: await count("segmentation_aggregates"), segmentationDocuments: await aggregateDocuments() };
  check("gutenberg.completed", g1.filesTrained === 1 && g2.filesTrained === 1, JSON.stringify({ first: g1.filesTrained, retry: g2.filesTrained, firstSkipped: g1.filesSkipped, retrySkipped: g2.filesSkipped }));
  check("gutenberg.retry.event-stable", gAfter.events === gBefore.events, JSON.stringify({ before: gBefore, after: gAfter }));
  check("gutenberg.retry.segmentation-stable", gAfter.segmentationDocuments === gBefore.segmentationDocuments, JSON.stringify({ before: gBefore, after: gAfter }));

  const o1 = await trainOssCorpus({ storage, rootPath: root, maxFiles: 10, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128, includeDocs: true, includeSource: true });
  const oCode = await trainOssCorpus({ storage, rootPath: root, maxFiles: 10, maxFilesPerRun: 1, startFileIndex: 1, expectedSnapshotHash: o1.snapshotHash, maxFileBytes: 100_000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128, includeDocs: true, includeSource: true });
  const ossUri = `${o1.sourceUriBase}#path=${encodeURIComponent("src/pump.ts")}`;
  const ossSourceRowsAll = await storage.query(`
    SELECT sv.id, s.canonical_uri AS uri, sv.content_hash AS "contentHash",
           sv.metadata_json->'_scceSourceVersion'->>'role' AS role,
           sv.metadata_json->'_scceSourceVersion'->'derivation' AS derivation
      FROM ${storage.table("source_versions")} sv
      JOIN ${storage.table("sources")} s ON s.id=sv.source_id
     WHERE s.canonical_uri LIKE $1
     ORDER BY sv.id`, [`${o1.sourceUriBase}%`]);
  const ossSourceRows = ossSourceRowsAll.filter(row => /#path=src(?:%2F|\/)pump\.ts$/u.test(row.uri));
  const ossOriginals = ossSourceRows.filter(row => row.role === "original");
  const ossDerivatives = ossSourceRows.filter(row => row.role === "evidence-derivative");
  const expectedOssRaw = await readFile(path.join(root, "src", "pump.ts"));
  const ossBlobs = await Promise.all(ossSourceRows.map(row => blobFor(row)));
  const ossEvidence = ossDerivatives.length
    ? await storage.query(`SELECT source_version_id, content_hash, byte_start, byte_end, char_start, char_end, text_content FROM ${storage.table("evidence_spans")} WHERE source_version_id=ANY($1::text[])`, [ossDerivatives.map(row => row.id)])
    : [];
  const ossEvidenceSlicesValid = ossEvidence.length > 0 && ossEvidence.every(span => {
    const sourceIndex = ossDerivatives.findIndex(row => row.id === span.source_version_id);
    const bytes = sourceIndex >= 0 ? ossBlobs[ossSourceRows.indexOf(ossDerivatives[sourceIndex])] : undefined;
    if (!bytes) return false;
    const byteStart = Number(span.byte_start);
    const byteEnd = Number(span.byte_end);
    const charStart = Number(span.char_start);
    const charEnd = Number(span.char_end);
    const text = String(span.text_content);
    return bytes.subarray(byteStart, byteEnd).toString("utf8") === text
      && [...bytes.toString("utf8")].slice(charStart, charEnd).join("") === text
      && `sha256_${createHash("sha256").update(bytes.subarray(byteStart, byteEnd)).digest("hex")}` === span.content_hash;
  });
  check("oss.raw-and-projection-source-versions", ossOriginals.length === 2 && ossDerivatives.length === 2
    && ossOriginals.every(row => ossBlobs[ossSourceRows.indexOf(row)]?.equals(expectedOssRaw))
    && ossDerivatives.every((row, index) => ossOriginals.some(original => row.derivation?.derivedFromSourceVersionId === original.id)
      && typeof row.derivation?.transformId === "string"
      && row.derivation.transformId.startsWith("scce.oss.corpus-projection.v1:")
      && ossBlobs[ossSourceRows.indexOf(row)]?.byteLength > 0
      && !ossBlobs[ossSourceRows.indexOf(row)]?.equals(expectedOssRaw)), JSON.stringify({
      sourceRows: ossSourceRows.map(row => ({ id: row.id, role: row.role, derivation: row.derivation })),
      derivativeBytes: ossDerivatives.map(row => ossBlobs[ossSourceRows.indexOf(row)]?.byteLength ?? null)
    }));
  check("oss.projection-evidence-slices-own-blobs", ossEvidenceSlicesValid, JSON.stringify({ evidence: ossEvidence.length }));
  const oBefore = { observations: await count("ngram_observations"), models: await count("ngram_models"), events: await count("events"), segmentation: await count("segmentation_aggregates"), segmentationDocuments: await aggregateDocuments() };
  const o2 = await trainOssCorpus({ storage, rootPath: root, maxFiles: 10, maxFilesPerRun: 1, maxFileBytes: 100_000, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128, includeDocs: true, includeSource: true });
  const oAfter = { observations: await count("ngram_observations"), models: await count("ngram_models"), events: await count("events"), segmentation: await count("segmentation_aggregates"), segmentationDocuments: await aggregateDocuments() };
  check("oss.completed", o1.filesConsidered === 1 && o2.filesConsidered === 1, JSON.stringify({ first: o1.filesConsidered, retry: o2.filesConsidered, firstSkipped: o1.filesSkipped, retrySkipped: o2.filesSkipped, firstReports: o1.reports.map(item => ({ sourceSystem: item.sourceSystem, sourceVersionId: item.sourceVersionId })) }));
  check("oss.retry.event-stable", oAfter.events === oBefore.events, JSON.stringify({ before: oBefore, after: oAfter }));
  check("oss.retry.segmentation-stable", oAfter.segmentationDocuments === oBefore.segmentationDocuments, JSON.stringify({ before: oBefore, after: oAfter }));
  const lostAckInput = {
    storage,
    sourceSystem: "gutenberg",
    streamUri: "gutenberg:lost-ack",
    sourceUri: "fixture://gutenberg/lost-ack",
    text: "A lost acknowledgement must replay from the terminal checkpoint.",
    ngramMaxOrder: 2,
    ngramMaxCountersPerOrder: 64,
    ngramVocabularyLimit: 128,
    corpusCheckpoint: { rootUri: "fixture://gutenberg", itemUri: "lost-ack.txt", contentHash: "sha256_lost_ack", byteLength: 64 }
  };
  const originalTransaction = storage.transaction.bind(storage);
  let transactionDepth = 0;
  let injectLostAck = true;
  storage.transaction = async callback => {
    transactionDepth += 1;
    try {
      const result = await originalTransaction(callback);
      if (transactionDepth === 1 && injectLostAck) {
        injectLostAck = false;
        throw new Error("injected commit acknowledgement loss");
      }
      return result;
    } finally {
      transactionDepth -= 1;
    }
  };
  let lostAckThrown = false;
  try { await trainLanguageCorpusText(lostAckInput); } catch (caught) { lostAckThrown = caught instanceof Error && caught.message.includes("acknowledgement loss"); }
  storage.transaction = originalTransaction;
  const lostBefore = { events: await count("events"), segmentationDocuments: await aggregateDocuments() };
  await trainLanguageCorpusText(lostAckInput);
  const lostAfter = { events: await count("events"), segmentationDocuments: await aggregateDocuments() };
  check("corpus.commit-lost-ack-replayed", lostAckThrown && lostAfter.events === lostBefore.events && lostAfter.segmentationDocuments === lostBefore.segmentationDocuments, JSON.stringify({ lostAckThrown, before: lostBefore, after: lostAfter }));
  const completeCheckpoints = Number((await storage.query(`SELECT COUNT(*)::text AS count FROM ${storage.table("ingestion_checkpoints")} WHERE status='complete'`))[0].count);
  check("corpus.checkpoints.complete", completeCheckpoints === 5, JSON.stringify({ completeCheckpoints }));
  report.observed = { gutenberg: { first: gBefore, retry: gAfter }, oss: { first: oBefore, retry: oAfter } };
} catch (caught) {
  error = caught;
} finally {
  if (storage) {
    try {
      if (schemaOwned) {
        const exists = await storage.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
        if (exists.length !== 1) throw new Error(`owned rehearsal schema disappeared before cleanup: ${schema}`);
        await storage.query(`DROP SCHEMA "${schema}" CASCADE`);
        const remains = await storage.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
        if (remains.length) throw new Error(`failed to remove owned rehearsal schema: ${schema}`);
      }
    } finally {
      await storage.close();
    }
  }
  await rm(root, { recursive: true, force: true });
}
report.status = !error && report.checks.every(item => item.passed) ? "passed" : "failed";
report.error = error ? (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 1000) : null;
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;
