// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createClock,
  type InformationAccessContext
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../packages/adapters-node/src/postgres.js";
import { readScceRuntimeConfig } from "../packages/adapters-node/src/config.js";
import { createWikipediaV3Ingestor, type WikipediaV3IngestResult } from "../packages/adapters-node/src/wikipedia-v3-ingestor.js";
import { resolveWikipediaCorpusTarget } from "../packages/adapters-node/src/wikipedia.js";

const OWNED_SCHEMA_PATTERN = /^scce_wikipedia_replay_rehearsal_[0-9a-f]+$/u;
const BLOCK_ONE = "QlpoOTFBWSZTWZzIxvAAACMfgEAB4AUBAAQAP+ffQDAA+AKAAaAAAoABoAAAqpo1JibSnpMam1PKIPZqfDYbHBJBY8l6UvrTWqKr/taUyzXmLd0oTh2pHJy+iTgg4LGgzLFSCTwPBjCLi5YqYGaVTI3Ugbknl7dGBiYnJienzk7GTI7LELnSno0Nz2KkDbaqnR0eCcMzQzJnuZ0NUNTWpJ3/lTLKRWuDE3LjEf4u5IpwoSE5kY3g";
const BLOCK_TWO = "QlpoOTFBWSZTWZCMf2MAACMbgEAB8AUMAD/n30AwAPgCgAAAABQAAAAAKqaEap4NUybFGnlEHBc/DwPB7KkFD0bSlreW10TbZTlLKbX9imiqFcMZR0dPkqeyD2UNDKCCKEEFTyPJaEb7DYqTMTNVMyOUoHJU3cuzAsWOixu6MCyxgoQ0O0vRmT4NxQgXvNLfs7PBhjkamZWuhmLoXIKH8gxxzE54MTg0Fh/i7kinChISEY/sYA==";

type Check = { id: string; passed: boolean; detail: string };
type LegacySchemaCount = { schema: string | null; total: number; tables: Record<string, number> };
type LegacyCounts = { schema5: LegacySchemaCount; schema6: LegacySchemaCount };
type Scenario = {
  result: WikipediaV3IngestResult;
  resultPages: number;
  reachedEnd: boolean;
  learned: LearnedSnapshot;
  statusPath?: string;
  tracePath?: string;
};
type LearnedSnapshot = {
  counts: Record<string, number>;
  contributions: Record<string, number>;
  artifactDigests: Record<string, string>;
  manifestIdentities: unknown;
  manifests: unknown;
};

const checks: Check[] = [];
const owned: Array<{ schema: string; storage: PostgresStorageAdapter }> = [];
let fixtureRoot: string | undefined;
let primaryError: unknown;

function check(id: string, passed: boolean, detail: string): void {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownedSchema(prefix = "scce_wikipedia_replay_rehearsal"): string {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  if (!OWNED_SCHEMA_PATTERN.test(schema)) throw new Error("refusing unsafe rehearsal schema name");
  return schema;
}

function normalize(value: unknown, key?: string): unknown {
  if (key && /^(?:created|updated|observed|fetched|validated|imported|first|last)(?:_at|At)$/u.test(key)) return undefined;
  if (key && ["episode_id", "episodeId", "event_id", "eventId", "run_id", "runId"].includes(key)) return undefined;
  if (Array.isArray(value)) return value.map(item => normalize(item)).filter(item => item !== undefined);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([name, item]) => [name, normalize(item, name)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
  }
  return value;
}

function stable(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? "undefined";
}

function manifestDiff(left: unknown, right: unknown, pathName = "$", output: string[] = []): string[] {
  if (output.length >= 16) return output;
  if (Object.is(left, right)) return output;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) output.push(`${pathName}.length: ${left.length} != ${right.length}`);
    for (let index = 0; index < Math.min(left.length, right.length) && output.length < 16; index++) manifestDiff(left[index], right[index], `${pathName}[${index}]`, output);
    return output;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left as Record<string, unknown>), ...Object.keys(right as Record<string, unknown>)])].sort();
    for (const key of keys) {
      if (output.length >= 16) break;
      manifestDiff((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${pathName}.${key}`, output);
    }
    return output;
  }
  output.push(`${pathName}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  return output;
}

function manifestProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(manifestProjection);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "resumedFromOffset") continue;
    if (key === "importRunId") {
      output[key] = "ancestry-final";
      continue;
    }
    output[key] = manifestProjection(item);
  }
  return output;
}

function manifestProgress(value: unknown): number[] {
  if (!value || typeof value !== "object") return [0, 0, 0, 0, 0, 0];
  const manifest = value as Record<string, unknown>;
  const content = manifest.content && typeof manifest.content === "object" ? manifest.content as Record<string, unknown> : {};
  const metadata = manifest.metadata && typeof manifest.metadata === "object" ? manifest.metadata as Record<string, unknown> : {};
  const result = metadata.result && typeof metadata.result === "object" ? metadata.result as Record<string, unknown> : {};
  const number = (key: string): number => {
    const value = result[key] ?? content[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return [number("pages"), number("evidence"), number("ngramModels"), number("languageUnits"), number("languagePatterns"), number("lastCheckpointOffset")];
}

async function legacySchemaCounts(adapter: PostgresStorageAdapter): Promise<LegacyCounts> {
  const namespaces = await adapter.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^scce[56](?:_|$)' ORDER BY nspname"
  );
  const pick = (prefix: string): string | null => {
    const names = namespaces.map(row => row.nspname).filter(name => name === `${prefix}_runtime` || name === prefix || name.startsWith(`${prefix}_`));
    return names.find(name => name === `${prefix}_runtime`) ?? names[0] ?? null;
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

const LEARNED_TABLES = [
  "language_profiles", "language_profile_signatures", "ngram_observations", "ngram_models",
  "language_units", "language_patterns", "semantic_frames"
] as const;

async function learnedSnapshot(adapter: PostgresStorageAdapter): Promise<LearnedSnapshot> {
  const counts: Record<string, number> = {};
  const contributions: Record<string, number> = {};
  const artifactDigests: Record<string, string> = {};
  for (const table of LEARNED_TABLES) {
    const rows = await adapter.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(t) AS row FROM ${adapter.table(table)} t`);
    counts[table] = rows.length;
    contributions[table] = rows.length;
    const canonicalRows = rows.map(item => normalize(item.row)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    artifactDigests[table] = stable(canonicalRows);
    if (table === "ngram_observations") {
      const totals = await adapter.query<{ observations: string; mass: string }>(
        `SELECT COUNT(*)::text AS observations, COALESCE(SUM(count),0)::text AS mass FROM ${adapter.table(table)}`
      );
      contributions.ngramObservations = Number(totals[0]?.observations ?? "0");
      contributions.ngramObservationMass = Number(totals[0]?.mass ?? "0");
    }
  }
  const segmentation = await adapter.query<{ documents: string; lexical: string; spaced: string; total: string }>(
    `SELECT COALESCE(SUM(documents_observed),0)::text AS documents,
            COALESCE(SUM(lexical_segments_observed),0)::text AS lexical,
            COALESCE(SUM(spaced_boundary_observations),0)::text AS spaced,
            COALESCE(SUM(total_boundary_observations),0)::text AS total
       FROM ${adapter.table("segmentation_aggregates")}`
  );
  const segmentationRows = await adapter.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${adapter.table("segmentation_aggregates")}`);
  counts.segmentation_aggregates = Number(segmentationRows[0]?.count ?? "0");
  contributions.segmentationAggregates = counts.segmentation_aggregates;
  contributions.segmentationDocuments = Number(segmentation[0]?.documents ?? "0");
  contributions.segmentationLexicalSegments = Number(segmentation[0]?.lexical ?? "0");
  contributions.segmentationSpacedBoundaries = Number(segmentation[0]?.spaced ?? "0");
  contributions.segmentationBoundaries = Number(segmentation[0]?.total ?? "0");

  const lifecycleRows = await adapter.query<{ import_run_id: string; manifest_json: unknown; state: string; revision: string }>(
    `SELECT import_run_id, manifest_json, state, revision::text AS revision
       FROM ${adapter.table("brain_import_lifecycle")} ORDER BY import_run_id`
  );
  // A bounded resume legitimately leaves historical partial lifecycle rows. Compare only the most advanced
  // canonical final manifest; meaningful count differences in that row still fail the replay check.
  const finalRow = lifecycleRows
    .map(row => ({ row, progress: manifestProgress(row.manifest_json) }))
    .sort((left, right) => {
      for (let index = 0; index < left.progress.length; index++) {
        const difference = right.progress[index]! - left.progress[index]!;
        if (difference) return difference;
      }
      return left.row.import_run_id.localeCompare(right.row.import_run_id);
    })[0];
  const finalManifest = finalRow?.row.manifest_json && typeof finalRow.row.manifest_json === "object"
    ? finalRow.row.manifest_json as Record<string, unknown>
    : undefined;
  const replayManifest = finalManifest?.replayManifest && typeof finalManifest.replayManifest === "object"
    ? finalManifest.replayManifest as Record<string, unknown>
    : undefined;
  const manifestIdentities = finalManifest ? {
    manifestHash: finalManifest.manifestHash ?? null,
    brainVersion: finalManifest.brainVersion ?? null,
    replayId: replayManifest?.id ?? null,
    replayByteHash: replayManifest?.byteHash ?? null
  } : null;
  const ancestry = finalRow ? [{
    ancestryId: "ancestry-final",
    state: finalRow.row.state,
    manifest: normalize(manifestProjection(finalRow.row.manifest_json))
  }] : [];
  return { counts, contributions, artifactDigests, manifestIdentities, manifests: normalize(ancestry) };
}

async function scenario(
  storage: PostgresStorageAdapter,
  config: Parameters<typeof createWikipediaV3Ingestor>[0]["config"],
  dumpPath: string,
  mode: "full" | "resumed",
  reportPaths?: { statusPath: string; tracePath: string }
): Promise<Scenario> {
  if (reportPaths) process.env.SCCE_INGEST_TRACE = reportPaths.tracePath;
  const clock = createClock({ fixedTime: 1_700_000_000_000 });
  const onStatus = reportPaths
    ? async (status: unknown): Promise<void> => { await writeFile(reportPaths.statusPath, JSON.stringify(status)); }
    : undefined;
  const input = (overrides: { maxPages?: number; fresh?: boolean; resume?: boolean } = {}) => ({ dumpPath, ...overrides, ...(onStatus ? { onStatus } : {}) });
  const ingest = async (overrides: { maxPages?: number; fresh?: boolean; resume?: boolean } = {}): Promise<WikipediaV3IngestResult> => {
    const ingestor = createWikipediaV3Ingestor({ storage, config, clock });
    return ingestor.ingest(input(overrides));
  };
  const results: WikipediaV3IngestResult[] = [];
  if (mode === "full") {
    results.push(await ingest({ fresh: true }));
  } else {
    results.push(await ingest({ fresh: true, maxPages: 1 }));
    results.push(await ingest({ resume: true, maxPages: 1 }));
    results.push(await ingest({ resume: true, maxPages: 1 }));
  }
  const result = results[results.length - 1]!;
  const reached = await storage.query<{ reached: string }>(
    `SELECT metadata_json->>'reachedEnd' AS reached
       FROM ${storage.table("ingestion_checkpoints")}
      WHERE root_uri=$1 AND phase='stored' AND status='complete' AND metadata_json->>'reachedEnd'='true'
      ORDER BY offset_bytes DESC, id DESC LIMIT 1`,
    [result.rootUri]
  );
  const learned = await learnedSnapshot(storage);
  return {
    result,
    resultPages: results.reduce((sum, item) => sum + item.pages, 0),
    reachedEnd: reached[0]?.reached === "true",
    learned,
    statusPath: reportPaths?.statusPath,
    tracePath: reportPaths?.tracePath
  };
}

function runWikipediaReport(input: { schema: string; configPath: string; statusPath: string; tracePath: string; outPath: string }): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [
      "tools/wikipedia-run-report.mjs",
      `--schema=${input.schema}`,
      `--config=${input.configPath}`,
      `--status=${input.statusPath}`,
      `--trace=${input.tracePath}`,
      `--out=${input.outPath}`
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const line = stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean).at(-1);
    if (!line) throw new Error("wikipedia-run-report produced an empty report");
    return JSON.parse(line) as Record<string, any>;
  } catch (error) {
    throw new Error(`wikipedia-run-report failed: ${safeMessage(error)}`);
  }
}

async function lostCommitAckScenario(
  storage: PostgresStorageAdapter,
  config: Parameters<typeof createWikipediaV3Ingestor>[0]["config"],
  dumpPath: string
): Promise<{ learned: LearnedSnapshot; failedAfterCommit: boolean }> {
  const clock = createClock({ fixedTime: 1_700_000_000_000 });
  const first = createWikipediaV3Ingestor({ storage, config, clock });
  const privateIngestor = first as unknown as {
    ingestLanguageShard: (...args: any[]) => Promise<unknown>;
  };
  const original = privateIngestor.ingestLanguageShard.bind(first);
  let injected = false;
  privateIngestor.ingestLanguageShard = async (...args: any[]): Promise<unknown> => {
    const committed = await original(...args);
    if (!injected) {
      injected = true;
      throw new Error("rehearsal lost commit acknowledgement after durable commit");
    }
    return committed;
  };
  let failedAfterCommit = false;
  try {
    await first.ingest({ dumpPath, fresh: true });
  } catch (error) {
    if (!/lost commit acknowledgement after durable commit/u.test(safeMessage(error))) throw error;
    failedAfterCommit = true;
  }
  const resumed = createWikipediaV3Ingestor({ storage, config, clock });
  await resumed.ingest({ dumpPath, resume: true });
  return { learned: await learnedSnapshot(storage), failedAfterCommit };
}

async function dropOwnedSchema(storage: PostgresStorageAdapter, schema: string): Promise<void> {
  if (!OWNED_SCHEMA_PATTERN.test(schema) || storage.schema !== schema) throw new Error("refusing cleanup outside exact owned schema");
  const present = await storage.query<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present", [schema]);
  const owner = await storage.query<{ owner: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname=$1 AND r.rolname=current_user) AS owner", [schema]);
  if (present[0]?.present !== true || owner[0]?.owner !== true) throw new Error("refusing cleanup of absent or unowned schema");
  await storage.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

try {
  const configPath = process.env.SCCE_REHEARSAL_CONFIG ?? "scce.config.json";
  const loaded = await readScceRuntimeConfig(configPath);
  const databaseUrl = (process.env.SCCE_TEST_DATABASE_URL ?? process.env.SCCE_DATABASE_URL ?? loaded.database.url).trim();
  if (!/^postgres(?:ql)?:\/\//iu.test(databaseUrl)) throw new Error("a PostgreSQL database URL is required");
  const informationAccess: InformationAccessContext = {
    tenantId: "scce.public.corpus", principalId: "wikipedia-replay-rehearsal", compartments: [],
    maximumExportClass: "public", explicitMergeAuthority: true
  };

  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "scce-wikipedia-replay-rehearsal-"));
  const dumpPath = path.join(fixtureRoot, "enwiki-latest-pages-articles-multistream.xml.bz2");
  await writeFile(dumpPath, Buffer.concat([Buffer.from(BLOCK_ONE, "base64"), Buffer.from(BLOCK_TWO, "base64")]));
  let legacyBefore: LegacyCounts | undefined;
  const results: Record<string, Scenario> = {};
  for (const mode of ["full", "resumed"] as const) {
    const schema = ownedSchema();
    const storage = createPostgresStorageAdapter({ url: databaseUrl, schema, ssl: loaded.database.ssl, informationAccess });
    owned.push({ schema, storage });
    const present = await storage.query<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present", [schema]);
    check(`${mode}.schema-absent`, present[0]?.present === false, "fresh owned schema was absent before migration");
    if (!legacyBefore) {
      legacyBefore = await legacySchemaCounts(storage);
      checks.push({ id: "legacy.schema5-readonly-baseline", passed: true, detail: JSON.stringify(legacyBefore.schema5) });
      checks.push({ id: "legacy.schema6-readonly-baseline", passed: true, detail: JSON.stringify(legacyBefore.schema6) });
    }
    const config = {
      ...loaded,
      database: { ...loaded.database, url: databaseUrl, schema },
      runtime: {
        ...loaded.runtime,
        corpora: {
          ...loaded.runtime.corpora,
          wikipedia: {
            ...loaded.runtime.corpora?.wikipedia,
            enabled: true, dumpPath, indexPath: undefined, maxPagesPerRun: 2500, maxBlocksPerRun: 0,
            allowedNamespaces: [0], languageTrainingDocumentLimit: 0, ngramShardChars: 1_200_000
          }
        }
      }
    };
    await storage.migrate();
    const verified = await storage.verify();
    check(`${mode}.schema-migrated`, verified.ok, verified.errors.join("; "));
    const corpus = resolveWikipediaCorpusTarget(config, dumpPath);
    if (!corpus) throw new Error(`${mode}: fixture did not resolve as a Wikipedia dump`);
    const reportPaths = mode === "full" ? {
      statusPath: path.join(fixtureRoot!, "full-status.json"),
      tracePath: path.join(fixtureRoot!, "full-ingest-trace.jsonl"),
      outPath: path.join(fixtureRoot!, "full-run-report.json")
    } : undefined;
    results[mode] = await scenario(storage, config, dumpPath, mode, reportPaths);
    check(`${mode}.pages`, results[mode]!.resultPages === 2, `processed ${results[mode]!.resultPages} fixture pages`);
    check(`${mode}.eof`, results[mode]!.reachedEnd, "stored checkpoint reached EOF");
    if (reportPaths) {
      const runReport = runWikipediaReport({ schema, configPath, ...reportPaths });
      const database = (runReport.databaseInspection ?? {}) as Record<string, any>;
      const pages = (database.wikipedia?.pages ?? {}) as Record<string, any>;
      const versions = (database.wikipedia?.sourceVersions ?? {}) as Record<string, any>;
      const evidence = (database.evidenceOffsets ?? {}) as Record<string, any>;
      const journal = (database.journal ?? {}) as Record<string, any>;
      const training = (journal.trainingDocuments ?? {}) as Record<string, any>;
      const progress = (journal.progressCounts ?? {}) as Record<string, any>;
      const trace = (runReport.trace ?? {}) as Record<string, any>;
      check("run-report.status", runReport.status === "passed", `report status ${String(runReport.status)}`);
      check("run-report.pages", pages.pageSources === 2, `report measured ${String(pages.pageSources)} page sources`);
      check("run-report.versions", versions.total >= 2 && versions.pageOriginal >= 2, `report measured ${String(versions.total)} source versions (${String(versions.pageOriginal)} originals)`);
      check("run-report.evidence", evidence.passed === true && evidence.spansChecked > 0 && evidence.mismatches === 0, `evidence spans=${String(evidence.spansChecked)} mismatches=${String(evidence.mismatches)}`);
      check("run-report.journal", journal.latestState === "idle" && journal.openRows === 0 && journal.pendingSamples === 0 && progress.pages === 2 && progress.sources === versions.total && progress.evidence === evidence.spansChecked, `journal state=${String(journal.latestState)} pages=${String(progress.pages)} sources=${String(progress.sources)} evidence=${String(progress.evidence)}`);
      check("run-report.training", training.acceptedForTraining >= 2 && training.committedTrainingDocuments >= 2 && training.pendingSamples === 0, `training accepted=${String(training.acceptedForTraining)} committed=${String(training.committedTrainingDocuments)} pending=${String(training.pendingSamples)}`);
      check("run-report.trace", trace.provided === true && trace.records > 0 && trace.malformed === 0 && Object.keys((trace.byStage ?? {}) as object).length > 0, `trace records=${String(trace.records)} malformed=${String(trace.malformed)}`);
    }
  }
  const lostSchema = ownedSchema();
  const lostStorage = createPostgresStorageAdapter({ url: databaseUrl, schema: lostSchema, ssl: loaded.database.ssl, informationAccess });
  owned.push({ schema: lostSchema, storage: lostStorage });
  const lostPresent = await lostStorage.query<{ present: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present", [lostSchema]);
  check("lost-ack.schema-absent", lostPresent[0]?.present === false, "fresh owned schema was absent before migration");
  const lostConfig = {
    ...loaded,
    database: { ...loaded.database, url: databaseUrl, schema: lostSchema },
    runtime: {
      ...loaded.runtime,
      corpora: {
        ...loaded.runtime.corpora,
        wikipedia: {
          ...loaded.runtime.corpora?.wikipedia,
          enabled: true, dumpPath, indexPath: undefined, maxPagesPerRun: 2500, maxBlocksPerRun: 0,
          allowedNamespaces: [0], languageTrainingDocumentLimit: 0, ngramShardChars: 1_200_000
        }
      }
    }
  };
  await lostStorage.migrate();
  const lostVerified = await lostStorage.verify();
  check("lost-ack.schema-migrated", lostVerified.ok, lostVerified.errors.join("; "));
  const lost = await lostCommitAckScenario(lostStorage, lostConfig, dumpPath);
  check("lost-ack.injected-after-commit", lost.failedAfterCommit, "first process failed only after the learned transaction committed");
  const full = results.full!.learned;
  const resumed = results.resumed!.learned;
  check("replay.learned-artifacts-equivalent", stable(full.artifactDigests) === stable(resumed.artifactDigests), "normalized learned artifact rows match");
  check("replay.contributions-equivalent", stable(full.contributions) === stable(resumed.contributions), "ngram and segmentation contribution totals match");
  const manifestDifferences = manifestDiff(full.manifests, resumed.manifests);
  check("replay.manifests-equivalent", manifestDifferences.length === 0, manifestDifferences.length ? manifestDifferences.join("; ") : "manifest ancestry and content match after operational normalization");
  check("replay.single-ngram-model", full.counts.ngram_models === 1 && resumed.counts.ngram_models === 1, JSON.stringify({ full: full.counts.ngram_models, resumed: resumed.counts.ngram_models }));
  check("lost-ack.learned-artifacts-equivalent", stable(full.artifactDigests) === stable(lost.learned.artifactDigests), "committed lost-ack replay learned artifacts match uninterrupted output");
  check("lost-ack.contributions-equivalent", stable(full.contributions) === stable(lost.learned.contributions), "committed lost-ack replay contribution totals match uninterrupted output");
  check("replay.manifest-identities-equivalent", stable(full.manifestIdentities) === stable(resumed.manifestIdentities) && stable(full.manifestIdentities) === stable(lost.learned.manifestIdentities), "canonical manifest and replay artifact identities match all replay paths");
  check("lost-ack.manifests-equivalent", stable(full.manifests) === stable(lost.learned.manifests), "committed lost-ack replay final manifest matches uninterrupted output");

  if (!legacyBefore) throw new Error("legacy baseline was not established");
  const after = await legacySchemaCounts(owned[0]!.storage);
  check("legacy.schema5-unchanged", stable(after.schema5) === stable(legacyBefore.schema5), "schema5 remains unchanged");
  check("legacy.schema6-unchanged", stable(after.schema6) === stable(legacyBefore.schema6), "schema6 remains unchanged");
} catch (error) {
  primaryError = error;
} finally {
  for (const item of [...owned].reverse()) {
    try {
      await dropOwnedSchema(item.storage, item.schema);
      checks.push({ id: `cleanup.${item.schema}`, passed: true, detail: "exact owned schema dropped" });
    } catch (error) {
      checks.push({ id: `cleanup.${item.schema}`, passed: false, detail: safeMessage(error) });
      primaryError ??= error;
    }
    await item.storage.close().catch(error => { primaryError ??= error; });
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }).catch(error => { primaryError ??= error; });
}

const report = {
  schema: "scce.wikipediaReplayRehearsal.v1",
  credentialsRecorded: false,
  checks,
  status: primaryError ? "failed" : checks.every(item => item.passed) ? "passed" : "failed",
  error: primaryError ? safeMessage(primaryError) : null
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;
