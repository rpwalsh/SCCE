// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createClock,
  type IngestedSourceFile,
  type IngestionCheckpoint,
  type InformationAccessContext
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../packages/adapters-node/src/postgres.js";
import { readScceRuntimeConfig } from "../packages/adapters-node/src/config.js";
import { createWikipediaV3Ingestor } from "../packages/adapters-node/src/wikipedia-v3-ingestor.js";
import { resolveWikipediaCorpusTarget, streamWikipediaMultistream } from "../packages/adapters-node/src/wikipedia.js";
import { prepareLanguageCorpusTraining, commitLanguageCorpusTraining } from "../packages/adapters-node/src/language-corpus-trainer.js";

const OWNED_SCHEMA_PATTERN = /^scce_wikipedia_source_contract_[0-9a-f]+$/u;
const schema = `scce_wikipedia_source_contract_${randomUUID().replaceAll("-", "")}`;
if (!OWNED_SCHEMA_PATTERN.test(schema)) throw new Error("refusing unsafe contract schema name");
const BLOCK_ONE = "QlpoOTFBWSZTWZzIxvAAACMfgEAB4AUBAAQAP+ffQDAA+AKAAaAAAoABoAAAqpo1JibSnpMam1PKIPZqfDYbHBJBY8l6UvrTWqKr/taUyzXmLd0oTh2pHJy+iTgg4LGgzLFSCTwPBjCLi5YqYGaVTI3Ugbknl7dGBiYnJienzk7GTI7LELnSno0Nz2KkDbaqnR0eCcMzQzJnuZ0NUNTWpJ3/lTLKRWuDE3LjEf4u5IpwoSE5kY3g";
const BLOCK_TWO = "QlpoOTFBWSZTWZCMf2MAACMbgEAB8AUMAD/n30AwAPgCgAAAABQAAAAAKqaEap4NUybFGnlEHBc/DwPB7KkFD0bSlreW10TbZTlLKbX9imiqFcMZR0dPkqeyD2UNDKCCKEEFTyPJaEb7DYqTMTNVMyOUoHJU3cuzAsWOixu6MCyxgoQ0O0vRmT4NxQgXvNLfs7PBhjkamZWuhmLoXIKH8gxxzE54MTg0Fh/i7kinChISEY/sYA==";

const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
let root: string | undefined;
let storage: PostgresStorageAdapter | undefined;
let primaryError: unknown;
let claimedFreshSchema = false;

try {
  const configPath = process.env.SCCE_REHEARSAL_CONFIG ?? "scce.config.json";
  const loaded = await readScceRuntimeConfig(configPath);
  const databaseUrl = (process.env.SCCE_TEST_DATABASE_URL ?? process.env.SCCE_DATABASE_URL ?? loaded.database.url).trim();
  if (!/^postgres(?:ql)?:\/\//iu.test(databaseUrl)) throw new Error("a PostgreSQL database URL is required");
  const informationAccess: InformationAccessContext = {
    tenantId: "scce.public.corpus",
    principalId: "wikipedia-source-contract",
    compartments: [],
    maximumExportClass: "public",
    explicitMergeAuthority: true
  };
  storage = createPostgresStorageAdapter({ url: databaseUrl, schema, ssl: loaded.database.ssl, informationAccess });
  const preexisting = await storage.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present",
    [schema]
  );
  check("schema.absent-before-create", preexisting[0]?.present === false, "owned schema was absent before migration");
  if (preexisting[0]?.present) throw new Error("owned schema already exists; refusing to use it");
  claimedFreshSchema = true;

  const legacyBefore = await legacySchemaCounts(storage);
  check("schema5.baseline-present", legacyBefore.schema5.total > 0, JSON.stringify(legacyBefore.schema5));
  check("schema6.baseline-zero", legacyBefore.schema6.total === 0, JSON.stringify(legacyBefore.schema6));

  await storage.migrate();
  check("schema.migrated", (await storage.verify()).ok, "production adapter migration verified");
  const legacyAfterMigration = await legacySchemaCounts(storage);
  check("schema5.unchanged-after-migration", JSON.stringify(legacyAfterMigration.schema5) === JSON.stringify(legacyBefore.schema5), JSON.stringify({ before: legacyBefore.schema5, after: legacyAfterMigration.schema5 }));
  check("schema6.unchanged-after-migration", JSON.stringify(legacyAfterMigration.schema6) === JSON.stringify(legacyBefore.schema6), JSON.stringify({ before: legacyBefore.schema6, after: legacyAfterMigration.schema6 }));

  root = await mkdtemp(path.join(os.tmpdir(), "scce-wikipedia-source-contract-"));
  const dumpPath = path.join(root, "enwiki-latest-pages-articles-multistream.xml.bz2");
  await writeFile(dumpPath, Buffer.concat([Buffer.from(BLOCK_ONE, "base64"), Buffer.from(BLOCK_TWO, "base64")]));
  const corpusConfig = {
    ...loaded,
    database: { ...loaded.database, url: databaseUrl, schema },
    runtime: {
      ...loaded.runtime,
      corpora: {
        ...loaded.runtime.corpora,
        wikipedia: {
          ...loaded.runtime.corpora?.wikipedia,
          enabled: true,
          dumpPath,
          indexPath: undefined,
          maxPagesPerRun: 1,
          maxBlocksPerRun: 0,
          allowedNamespaces: [0]
        }
      }
    }
  };
  const corpus = resolveWikipediaCorpusTarget(corpusConfig, dumpPath);
  if (!corpus) throw new Error("Wikipedia fixture did not resolve");
  const page = await firstPage(corpus);
  check("fixture.compressed-page", page !== undefined, "real bzip2 fixture yielded a Wikipedia page");
  if (!page) throw new Error("compressed fixture yielded no admissible page");

  const ingestor = createWikipediaV3Ingestor({ storage, config: corpusConfig, clock: createClock({ fixedTime: 1_700_000_000_000 }) });
  const privateIngestPage = (ingestor as unknown as {
    ingestPage(file: IngestedSourceFile, checkpoint: IngestionCheckpoint, episodeId: string): Promise<unknown>;
  }).ingestPage.bind(ingestor);
  const derivativeText = `${page.file.text}\nDerived source projection.`;
  const derivativeFile: IngestedSourceFile = {
    ...page.file,
    evidenceDerivative: {
      bytes: Buffer.from(derivativeText, "utf8"),
      text: derivativeText,
      kind: "extracted-text",
      transformId: "wikipedia-source-contract.derivative.v1",
      originalCoordinateSpace: "source-bytes",
      redactionMap: []
    }
  };

  const originalUpsertNodes = storage.graph.upsertNodes;
  if (!originalUpsertNodes) throw new Error("production graph store lacks upsertNodes seam");
  storage.graph.upsertNodes = async () => { throw new Error("injected Wikipedia graph write failure"); };
  await expectFailure(() => privateIngestPage(derivativeFile, page.checkpoint, "wikipedia-source-contract-failure"), "injected Wikipedia graph write failure");
  storage.graph.upsertNodes = originalUpsertNodes;
  const failedCounts = await sourceCounts(storage);
  check("transaction.rollback-after-graph-error", Object.values(failedCounts).every(count => count === 0), JSON.stringify(failedCounts));

  const successful = await privateIngestPage(derivativeFile, page.checkpoint, "wikipedia-source-contract-success");
  check("transaction.successful-retry", Boolean(successful), "same page committed after graph failure was removed");
  const committed = await sourceRows(storage, page.file.uri);
  check("source-versions.raw-and-derived", committed.length === 2 && committed.some(row => row.role === "original") && committed.some(row => row.role === "evidence-derivative"), JSON.stringify(committed.map(row => row.role)));
  check("source-derivation.metadata", committed.some(row => row.derivation?.transformId === "wikipedia-source-contract.derivative.v1" && row.derivation?.derivedFromSourceVersionId), "derived version points to original version");
  await verifyBlobs(storage, committed);
  await verifyEvidenceSlices(storage, committed);

  const plainText = "This plain text Wikipedia fixture intentionally contains no markup and is passed through without a normalization derivative. ".repeat(4);
  const plainFile: IngestedSourceFile = {
    ...page.file,
    uri: `${page.file.uri}/plain-fixture`,
    mediaType: "text/plain; charset=utf-8",
    bytes: Buffer.from(plainText, "utf8"),
    text: plainText,
    evidenceDerivative: undefined
  };
  await privateIngestPage(plainFile, { ...page.checkpoint, id: `${page.checkpoint.id}:plain`, itemUri: plainFile.uri }, "wikipedia-source-contract-plain");
  const plainRows = await sourceRows(storage, plainFile.uri);
  check("plain-text.no-normalization-derivative", plainRows.length === 1 && plainRows[0]?.role === "original" && plainRows[0].derivation === null, JSON.stringify(plainRows.map(row => row.role)));

  const duplicateFile: IngestedSourceFile = { ...page.file, uri: `${page.file.uri}/duplicate-page`, evidenceDerivative: undefined };
  await privateIngestPage(duplicateFile, { ...page.checkpoint, id: `${page.checkpoint.id}:duplicate`, itemUri: duplicateFile.uri }, "wikipedia-source-contract-duplicate");
  const duplicateRows = await sourceRows(storage, duplicateFile.uri);
  check("duplicate-page.source-ownership", duplicateRows.length === 1 && committed[0] !== undefined && duplicateRows[0]!.id !== committed[0]!.id && duplicateRows[0]!.sourceId !== committed[0]!.sourceId, JSON.stringify({ original: committed[0], duplicate: duplicateRows[0] }));
  await verifyPreparedTraining(storage);
  const legacyAfter = await legacySchemaCounts(storage);
  check("schema5.unchanged-after-ingest", JSON.stringify(legacyAfter.schema5) === JSON.stringify(legacyBefore.schema5), JSON.stringify({ before: legacyBefore.schema5, after: legacyAfter.schema5 }));
  check("schema6.unchanged-after-ingest", JSON.stringify(legacyAfter.schema6) === JSON.stringify(legacyBefore.schema6), JSON.stringify({ before: legacyBefore.schema6, after: legacyAfter.schema6 }));
} catch (error) {
  primaryError = error;
} finally {
  if (root) {
    const resolvedRoot = path.resolve(root);
    const expectedTempRoot = path.resolve(os.tmpdir());
    if (path.dirname(resolvedRoot) !== expectedTempRoot || !path.basename(resolvedRoot).startsWith("scce-wikipedia-source-contract-")) {
      primaryError ??= new Error("refusing fixture cleanup outside the expected temporary directory");
    } else {
      await rm(resolvedRoot, { recursive: true, force: true }).catch(error => { primaryError ??= error; });
    }
  }
  if (storage && claimedFreshSchema) {
    try {
      const owned = OWNED_SCHEMA_PATTERN.test(storage.schema);
      const present = await storage.query<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present", [storage.schema]);
      const owner = await storage.query<{ owner: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname=$1 AND r.rolname=current_user) AS owner", [storage.schema]);
      if (!owned || present[0]?.present !== true || owner[0]?.owner !== true) throw new Error("refusing cleanup outside exact owned schema");
      await storage.query(`DROP SCHEMA IF EXISTS "${storage.schema}" CASCADE`);
      checks.push({ id: "cleanup.drop-owned-schema", passed: true, detail: "exact temporary schema dropped" });
    } catch (error) {
      checks.push({ id: "cleanup.drop-owned-schema", passed: false, detail: safeMessage(error) });
      primaryError ??= error;
    }
    await storage.close().catch(error => { primaryError ??= error; });
  }
}

const report = {
  schema: "scce.wikipediaSourceContract.v1",
  disposableSchema: schema,
  credentialsRecorded: false,
  checks,
  status: primaryError ? "failed" : checks.every(check => check.passed) ? "passed" : "failed",
  error: primaryError ? safeMessage(primaryError) : null
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;

async function firstPage(corpus: NonNullable<ReturnType<typeof resolveWikipediaCorpusTarget>>): Promise<{ file: IngestedSourceFile; checkpoint: IngestionCheckpoint } | undefined> {
  for await (const item of streamWikipediaMultistream(corpus, { discoverIndex: false })) {
    if (item.type === "file") return { file: item.file, checkpoint: item.checkpoint };
  }
  return undefined;
}

async function sourceCounts(adapter: PostgresStorageAdapter): Promise<Record<string, number>> {
  const tables = ["sources", "source_versions", "blobs", "evidence_spans", "quarantine_sources", "ingestion_checkpoints", "graph_nodes", "graph_edges", "graph_hyperedges", "events"];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await adapter.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${adapter.table(table)}`);
    counts[table] = Number(rows[0]?.count ?? "0");
  }
  return counts;
}

/** Exercise the shared trainer against the same disposable Postgres adapter, including additive state. */
async function verifyPreparedTraining(adapter: PostgresStorageAdapter): Promise<void> {
  const input = {
    storage: adapter, sourceSystem: "wikipedia", streamUri: "fixture://wikipedia-prepared-training",
    sourceUri: "fixture://wikipedia-prepared-training", createdAt: 1_700_000_000_000,
    text: "A reader opens a book. Another reader closes the same book. ".repeat(3),
    languageOnly: true, ngramMaxOrder: 2, ngramVocabularyLimit: 32
  };
  const before = await trainingState(adapter);
  const prepared = await prepareLanguageCorpusTraining(input);
  check("training.prepare-no-durable-writes", await trainingState(adapter) === before, "source, learning and additive state unchanged after preparation");
  const putModels = adapter.languageMemory.putNgramModels;
  if (!putModels) throw new Error("production language store lacks batch model write seam");
  adapter.languageMemory.putNgramModels = async () => { throw new Error("injected prepared model failure"); };
  try {
    await expectFailure(() => commitLanguageCorpusTraining(input, prepared), "injected prepared model failure");
  } finally {
    adapter.languageMemory.putNgramModels = putModels;
  }
  check("training.rollback-source-and-additive-state", await trainingState(adapter) === before, "source, evidence, signatures, segmentation, learned rows and events restored after model failure");
  const learned = await commitLanguageCorpusTraining(input, prepared);
  check("training.retry-commits-models", learned.ngramModels > 0, `committed ${learned.ngramModels} models`);
  const source = await sourceRows(adapter, input.sourceUri);
  check("training.source-persisted", source.length === 1, "trained fixture has one durable source version");
  await verifyBlobs(adapter, source);
  await verifyEvidenceSlices(adapter, source);
  const after = await trainingState(adapter);
  await expectFailure(() => commitLanguageCorpusTraining(input, prepared), "already committed");
  check("training.repeated-token-no-additive-write", await trainingState(adapter) === after, "same preparation cannot contribute twice within the process; durable replay remains a separate gate");
}

async function trainingState(adapter: PostgresStorageAdapter): Promise<string> {
  const tables = ["sources", "source_versions", "blobs", "evidence_spans", "quarantine_sources", "language_profiles",
    "language_profile_signatures", "segmentation_aggregates", "ngram_observations", "ngram_models",
    "language_units", "language_patterns", "semantic_frames", "events"];
  const hashes: Array<[string, string]> = [];
  for (const table of tables) {
    const [row] = await adapter.query<{ digest: string }>(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]')) AS digest FROM ${adapter.table(table)} t`);
    if (!row) throw new Error(`missing fixture state digest for ${table}`);
    hashes.push([table, row.digest]);
  }
  return JSON.stringify(hashes);
}

interface LegacySchemaCount {
  schema: string | null;
  total: number;
  tables: Record<string, number>;
}

async function legacySchemaCounts(adapter: PostgresStorageAdapter): Promise<{ schema5: LegacySchemaCount; schema6: LegacySchemaCount }> {
  const namespaces = await adapter.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^scce[56](?:_|$)' ORDER BY nspname"
  );
  const pick = (prefix: string): string | null => {
    const candidates = namespaces.map(row => row.nspname).filter(name => name === `${prefix}_runtime` || name === prefix || name.startsWith(`${prefix}_`));
    return candidates.find(name => name === `${prefix}_runtime`) ?? candidates[0] ?? null;
  };
  return { schema5: await countLegacySchema(adapter, pick("scce5")), schema6: await countLegacySchema(adapter, pick("scce6")) };
}

async function countLegacySchema(adapter: PostgresStorageAdapter, schemaName: string | null): Promise<LegacySchemaCount> {
  const tables = ["sources", "source_versions", "blobs", "evidence_spans", "ngram_models", "ingestion_checkpoints"];
  if (!schemaName) return { schema: null, total: 0, tables: Object.fromEntries(tables.map(table => [table, 0])) };
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const present = await adapter.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [`${schemaName}.${table}`]);
    if (!present[0]?.present) {
      counts[table] = 0;
      continue;
    }
    const rows = await adapter.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "${schemaName}"."${table}"`);
    counts[table] = Number(rows[0]?.count ?? "0");
  }
  return { schema: schemaName, total: Object.values(counts).reduce((sum, count) => sum + count, 0), tables: counts };
}

async function sourceRows(adapter: PostgresStorageAdapter, uri: string): Promise<Array<{ id: string; sourceId: string; contentHash: string; role: string | null; derivation: Record<string, unknown> | null }>> {
  return adapter.query(`
    SELECT sv.id, sv.source_id AS "sourceId", sv.content_hash AS "contentHash",
           sv.metadata_json->'_scceSourceVersion'->>'role' AS role,
           sv.metadata_json->'_scceSourceVersion'->'derivation' AS derivation
      FROM ${adapter.table("source_versions")} sv
      JOIN ${adapter.table("sources")} s ON s.id=sv.source_id
     WHERE s.canonical_uri=$1
     ORDER BY sv.id`, [uri]);
}

async function verifyBlobs(adapter: PostgresStorageAdapter, rows: ReadonlyArray<{ contentHash: string }>): Promise<void> {
  for (const row of rows) {
    const blobs = await adapter.query<{ content: Buffer; byte_length: string; content_hash: string }>(`SELECT content, byte_length, content_hash FROM ${adapter.table("blobs")} WHERE content_hash=$1`, [row.contentHash]);
    const blob = blobs[0];
    if (!blob) throw new Error(`missing blob ${row.contentHash}`);
    const digest = `sha256_${createHash("sha256").update(blob.content).digest("hex")}`;
    check("blob.hash-and-length", blob.content_hash === digest && Number(blob.byte_length) === blob.content.byteLength, row.contentHash);
  }
}

async function verifyEvidenceSlices(adapter: PostgresStorageAdapter, rows: ReadonlyArray<{ id: string; role: string | null }>): Promise<void> {
  const ids = rows.map(row => row.id);
  const evidence = await adapter.query<{ source_version_id: string; byte_start: string; byte_end: string; char_start: string; char_end: string; text_content: string }>(`SELECT source_version_id, byte_start, byte_end, char_start, char_end, text_content FROM ${adapter.table("evidence_spans")} WHERE source_version_id=ANY($1::text[])`, [ids]);
  if (!evidence.length) throw new Error("committed page has no evidence spans");
  const sourceBytes = new Map<string, Buffer>();
  for (const row of rows) {
    const blobs = await adapter.query<{ content: Buffer }>(`SELECT b.content FROM ${adapter.table("blobs")} b JOIN ${adapter.table("source_versions")} sv ON sv.content_hash=b.content_hash WHERE sv.id=$1`, [row.id]);
    if (!blobs[0]) throw new Error(`missing evidence source blob ${row.id}`);
    sourceBytes.set(row.id, blobs[0].content);
  }
  for (const span of evidence) {
    const byteStart = Number(span.byte_start);
    const byteEnd = Number(span.byte_end);
    const charStart = Number(span.char_start);
    const charEnd = Number(span.char_end);
    const expected = span.text_content;
    const bytes = sourceBytes.get(span.source_version_id);
    if (!bytes) throw new Error(`unknown evidence source version ${span.source_version_id}`);
    const sourceText = bytes.toString("utf8");
    const byteSurface = bytes.subarray(byteStart, byteEnd).toString("utf8");
    const codepointSurface = [...sourceText].slice(charStart, charEnd).join("");
    check("evidence.byte-slice", byteSurface === expected, `${byteStart}:${byteEnd} expected=${expected.length} actual=${byteSurface.length}`);
    check("evidence.codepoint-slice", codepointSurface === expected, `${span.source_version_id} ${charStart}:${charEnd} expected=${expected.length} actual=${codepointSurface.length} sourceChars=${[...sourceText].length}`);
  }
}

async function expectFailure(work: () => Promise<unknown>, expected: string): Promise<void> {
  try { await work(); } catch (error) {
    check("transaction.injected-failure", safeMessage(error).includes(expected), safeMessage(error));
    return;
  }
  throw new Error("injected failure was not raised");
}

function check(id: string, passed: boolean, detail: string): void {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]").slice(0, 1000);
}
