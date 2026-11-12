// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
  POSTGRES_REQUIRED_TABLES,
  canonicalStringify,
  compileSourceInductionWindows,
  createHasher
} from "@scce/kernel";
import {
  SEGMENTATION_WITNESS_ARCHIVE_KEY,
  decodeSegmentationWitnessArchives,
  encodeSegmentationWitnessArchives,
  type SegmentationArchiveStorageAccess
} from "../segmentation-witness-archive-storage.js";
import { blobContentHash, createPostgresStorageAdapter } from "../postgres.js";
import { requiredHydrationColumns } from "../postgres-schema.js";

const hasher = createHasher();
const profileId = "profile.segmentation-archive.fixture";

function fixtureAccess(ownerDocuments: ReadonlyMap<string, { text: string; sourceVersionId: string }> = new Map()):
SegmentationArchiveStorageAccess {
  return {
    async getOwnerDocuments(ownerDocumentIds) {
      return new Map(ownerDocumentIds.flatMap(id => {
        const value = ownerDocuments.get(id);
        return value ? [[id, value] as const] : [];
      }));
    }
  };
}

function logicalFixture() {
  const text = Array.from({ length: 36 }, (_, index) =>
    `Evidence-owned clause ${index} binds alpha ${index % 5} to beta ${index % 7}.`).join(" ");
  const products = compileSourceInductionWindows({
    documents: [{ id: "document.segmentation-archive.fixture", sourceVersionId: "version.segmentation-archive.fixture" as never,
      sourceFamilyId: "family.segmentation-archive.fixture", evidenceIds: ["evidence.segmentation-archive.fixture" as never], text }],
    hasher
  });
  const languageWitness = products.models[0]!.segmentationWitness;
  const sourceWitness = languageWitness.populations.flatMap(population => population.documents)[0]!;
  const patternId = (witnessId: string) => `segmentation_archive.${hasher.digestHex(canonicalStringify([witnessId, profileId]))}`;
  const manifest = {
    schema: LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
    id: languageWitness.id,
    witnessSchema: languageWitness.schema,
    populationModelId: languageWitness.populationModelId,
    populations: languageWitness.populations.map(population => ({
      populationId: population.populationId,
      prior: population.prior,
      sourceWitnesses: population.documents.map(document => ({ witnessId: document.id, patternId: patternId(document.id) }))
    })),
    audit: languageWitness.audit
  };
  return {
    sourceWitness,
    manifest,
    ownerDocuments: new Map([[sourceWitness.ownerDocumentId, {
      text,
      sourceVersionId: String(sourceWitness.sourceVersionId)
    }]])
  };
}

function projectedFixture() {
  const owner = logicalFixture(), ownerText = owner.sourceWitness.text;
  const projectedText = ownerText.replace("alpha 0", "alpha x");
  expect(projectedText).not.toBe(ownerText);
  expect(projectedText.length).toBe(ownerText.length);
  const products = compileSourceInductionWindows({
    documents: [{ id: owner.sourceWitness.ownerDocumentId,
      sourceVersionId: owner.sourceWitness.sourceVersionId as never,
      sourceFamilyId: owner.sourceWitness.sourceFamilyId,
      evidenceIds: [...owner.sourceWitness.evidenceIds] as never[], text: projectedText }],
    hasher
  });
  const sourceWitness = products.models[0]!.segmentationWitness.populations.flatMap(population => population.documents)[0]!;
  return { sourceWitness, ownerDocuments: new Map([[sourceWitness.ownerDocumentId, {
    text: ownerText, sourceVersionId: String(sourceWitness.sourceVersionId)
  }]]) };
}

describe("PostgreSQL segmentation witness archive storage", () => {
  it("stores a bounded exact delta when a length-preserving source projection differs from its evidence owner", async () => {
    const logical = projectedFixture(), storage = fixtureAccess(logical.ownerDocuments);
    const encoded = await encodeSegmentationWitnessArchives([{ value: logical.sourceWitness, profileId }], storage);
    const wire = encoded[0]!.value as Record<string, unknown>;
    const reference = wire[SEGMENTATION_WITNESS_ARCHIVE_KEY] as { textPatches: unknown[] };
    expect(reference.textPatches.length).toBeGreaterThan(0);
    expect(wire).not.toHaveProperty("text");
    const decoded = await decodeSegmentationWitnessArchives([{ value: wire, profileId }], storage);
    expect(decoded[0]!.value).toEqual(logical.sourceWitness);
  });

  it("reuses evidence-owned text, stores replay state without a DAG body, and cold-restores the identical logical witness", async () => {
    const logical = logicalFixture(), storage = fixtureAccess(logical.ownerDocuments);
    const encoded = await encodeSegmentationWitnessArchives([
      { value: logical.sourceWitness, profileId },
      { value: logical.manifest, profileId }
    ], storage);

    expect(encoded.every(result => result.handled)).toBe(true);
    const sourceWire = encoded[0]!.value as Record<string, unknown>;
    const manifestWire = encoded[1]!.value as Record<string, unknown>;
    expect(sourceWire).not.toHaveProperty("text");
    expect(sourceWire).not.toHaveProperty("fullDag");
    expect(sourceWire).toHaveProperty(SEGMENTATION_WITNESS_ARCHIVE_KEY);
    expect(JSON.stringify(sourceWire)).not.toContain(Buffer.from(logical.sourceWitness.text).toString("base64"));
    const sourceReference = sourceWire[SEGMENTATION_WITNESS_ARCHIVE_KEY] as {
      replay: { schema: string; boundaryFeatureFactors: { surfaceFormDocumentCounts: number[]; boundaryContextClassCounts: number[] } | null };
      textPatches: unknown[];
    };
    expect(sourceReference.textPatches).toEqual([]);
    expect(sourceReference.replay.schema).toBe("scce.surface_segmentation_replay.v1");
    expect(sourceReference.replay.boundaryFeatureFactors?.surfaceFormDocumentCounts).toBeInstanceOf(Array);
    expect(sourceReference.replay.boundaryFeatureFactors?.boundaryContextClassCounts).toBeInstanceOf(Array);
    expect(JSON.stringify(sourceReference.replay)).not.toContain("documentCountBySurfaceFormClass");
    expect(JSON.stringify(sourceReference.replay)).not.toContain("classCountByBoundaryContext");
    expect(Buffer.byteLength(JSON.stringify(sourceWire))).toBeLessThan(Buffer.byteLength(JSON.stringify(logical.sourceWitness)) / 3);
    const populations = manifestWire.populations as Array<Record<string, unknown>>;
    expect(populations.every(population => Array.isArray(population.witnessIds) && !Object.hasOwn(population, "sourceWitnesses"))).toBe(true);

    const decoded = await decodeSegmentationWitnessArchives(encoded.map(result => ({ value: result.value, profileId })), storage);
    expect(decoded.map(result => result.value)).toEqual([logical.sourceWitness, logical.manifest]);
    const rewritten = await encodeSegmentationWitnessArchives([{ value: decoded[0]!.value, profileId }], storage);
    expect(rewritten[0]).toEqual({ value: sourceWire, handled: true });
  });

  it("fails closed for changed replay state and compact manifests while preserving valid pre-v35 logical rows", async () => {
    const logical = logicalFixture(), storage = fixtureAccess(logical.ownerDocuments);
    const encoded = await encodeSegmentationWitnessArchives([
      { value: logical.sourceWitness, profileId },
      { value: logical.manifest, profileId }
    ], storage);
    await expect(encodeSegmentationWitnessArchives([{
      value: structuredClone(logical.sourceWitness),
      profileId
    }], fixtureAccess(logical.ownerDocuments))).rejects.toThrow(/re-induction is required/u);

    const sourceWire = structuredClone(encoded[0]!.value) as Record<string, unknown>;
    const reference = sourceWire[SEGMENTATION_WITNESS_ARCHIVE_KEY] as { replay: { expectedGraphDigest: string } };
    reference.replay.expectedGraphDigest = "0".repeat(64);
    await expect(decodeSegmentationWitnessArchives([{ value: sourceWire, profileId }], storage)).rejects.toThrow(/recipe digest changed/u);

    const manifestWire = structuredClone(encoded[1]!.value) as Record<string, unknown>;
    const population = (manifestWire.populations as Array<{ witnessIds: string[] }>)[0]!;
    population.witnessIds[0] += ".changed";
    await expect(decodeSegmentationWitnessArchives([{ value: manifestWire, profileId }], fixtureAccess())).rejects.toThrow(/logical digest changed/u);
    expect(await decodeSegmentationWitnessArchives([{ value: logical.sourceWitness, profileId }], fixtureAccess()))
      .toEqual([{ value: logical.sourceWitness, handled: true }]);
    expect(await decodeSegmentationWitnessArchives([{ value: logical.manifest, profileId }], fixtureAccess()))
      .toEqual([{ value: logical.manifest, handled: true }]);
    const changedLegacy = structuredClone(logical.sourceWitness) as unknown as { fullDag: { factors: { arcs: unknown[] } } };
    changedLegacy.fullDag.factors.arcs = [];
    await expect(decodeSegmentationWitnessArchives([{ value: changedLegacy, profileId }], fixtureAccess()))
      .rejects.toThrow(/segmentation/u);
  });

  it("migrates an existing PostgreSQL brain without deleting its valid logical witness rows", async () => {
    const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
    const statements: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: unknown[] }> {
        statements.push(sql);
        if (sql.includes("SELECT to_regclass")) return { rows: [{ present: "fixture.ngram_models" }] };
        if (sql.includes("information_schema.tables")) {
          return { rows: POSTGRES_REQUIRED_TABLES.map(table_name => ({ table_name })) };
        }
        if (sql.includes("information_schema.columns")) {
          return { rows: Object.entries(requiredHydrationColumns()).flatMap(([table_name, columns]) =>
            columns.map(column_name => ({ table_name, column_name }))) };
        }
        return { rows: [] };
      },
      release(): void {}
    };
    Object.defineProperty(adapter, "pool", { value: {
      connect: async () => client,
      end: async () => undefined
    } });
    adapter.query = async <T>(): Promise<T[]> => [];
    try {
      await expect(adapter.migrate()).resolves.toBeUndefined();
      expect(statements).toContain("COMMIT");
      expect(statements).not.toContain("ROLLBACK");
      expect(statements.some(sql => sql.includes("pattern_json->>'schema'=ANY"))).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it("binds blob batches as native BYTEA parameters without a JSON/base64 transport", async () => {
    const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const headers = new Map<string, Record<string, unknown>>();
    const client = {
      async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
        calls.push({ sql, params });
        if (sql.startsWith("INSERT INTO") && sql.includes('"blobs"')) {
          for (let offset = 0; offset < params.length; offset += 4) headers.set(String(params[offset]), {
            content_hash: params[offset], byte_length: String(params[offset + 2]), stored_byte_length: String(params[offset + 2]),
            range_parent_hash: null, range_start: null, range_end: null, archive_reference: null
          });
        }
        return { rows: sql.startsWith("SELECT content_hash") ? (params[0] as string[]).map(id => headers.get(id)!) : [] };
      },
      release() {}
    };
    (adapter.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query(sql, params)).rows as T[];
    try {
      const first = Buffer.from([0, 1, 2, 255]), second = Buffer.from("same source bytes", "utf8");
      const ids = await adapter.blobs.putBatch!([
        { content: first, mediaType: "application/octet-stream" },
        { content: first, mediaType: "application/octet-stream" },
        { content: second, mediaType: "text/plain" }
      ]);
      expect(ids).toEqual([blobContentHash(first), blobContentHash(first), blobContentHash(second)]);
      const inserts = calls.filter(call => call.sql.startsWith("INSERT INTO") && call.sql.includes('"blobs"'));
      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.sql).toContain("VALUES ($1,$2,$3,$4),($5,$6,$7,$8)");
      expect(inserts[0]!.sql).not.toMatch(/jsonb_to_recordset|base64|decode\(/u);
      expect(inserts[0]!.params.filter(Buffer.isBuffer)).toEqual([first, second]);
      expect(calls.some(call => call.sql === "COMMIT")).toBe(true);
    } finally {
      await adapter.close();
    }
  });
});
