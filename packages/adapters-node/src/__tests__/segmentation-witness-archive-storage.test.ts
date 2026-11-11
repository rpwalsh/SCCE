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
import { normalizeWikiText, wikipediaLanguageSurface } from "../wikipedia.js";

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

describe("PostgreSQL segmentation witness archive storage", () => {
  it("cold-restores the declared learning view without replacing canonical gallery evidence", async () => {
    const raw = "Honey bees visit flowers.\n<gallery>\nBee 🐝.jpg | A honey bee collects nectar.\n</gallery>\nWorkers collect pollen.";
    const evidenceText = normalizeWikiText(raw);
    const languageText = wikipediaLanguageSurface(raw, undefined, evidenceText).text;
    expect(languageText).not.toBe(evidenceText);
    const sourceVersionId = "version.gallery" as never;
    const products = compileSourceInductionWindows({ documents: [{ id: "evidence.gallery", sourceVersionId,
      text: languageText, evidenceIds: ["evidence.gallery" as never] }], hasher });
    const witness = products.models[0]!.segmentationWitness.populations.flatMap(p => p.documents)[0]!;
    const owner = { text: evidenceText, learningText: languageText, sourceVersionId: String(sourceVersionId) };
    const access = fixtureAccess(new Map([[witness.ownerDocumentId, owner]]));
    const input = [{ value: witness, profileId }];
    const encoded = await encodeSegmentationWitnessArchives(input, access);
    expect((encoded[0]!.value as Record<string, Record<string, unknown>>)[SEGMENTATION_WITNESS_ARCHIVE_KEY]?.textView).toBe("learning");
    const wire = JSON.parse(JSON.stringify(encoded[0]!.value));
    const restored = await decodeSegmentationWitnessArchives([{ value: wire, profileId }], access);
    expect(canonicalStringify(restored[0]!.value)).toBe(canonicalStringify(witness));
    expect(owner.text).toBe(evidenceText);
    await expect(decodeSegmentationWitnessArchives([{ value: wire, profileId }],
      fixtureAccess(new Map([[witness.ownerDocumentId, { text: evidenceText, sourceVersionId: String(sourceVersionId) }]]))))
      .rejects.toThrow(/learning projection/u);
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
      replay: { schema: string; boundaryFeatureFactors: { surfaceFormDocumentCounts: number[]; boundaryContextClassCounts: number[] } | null }
    };
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
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      return [];
    };
    try {
      const first = Buffer.from([0, 1, 2, 255]), second = Buffer.from("same source bytes", "utf8");
      const ids = await adapter.blobs.putBatch!([
        { content: first, mediaType: "application/octet-stream" },
        { content: first, mediaType: "application/octet-stream" },
        { content: second, mediaType: "text/plain" }
      ]);
      expect(ids).toEqual([blobContentHash(first), blobContentHash(first), blobContentHash(second)]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.sql).toContain("VALUES ($1,$2,$3,$4),($5,$6,$7,$8)");
      expect(calls[0]!.sql).not.toMatch(/jsonb_to_recordset|base64|decode\(/u);
      expect(calls[0]!.params.filter(Buffer.isBuffer)).toEqual([first, second]);
    } finally {
      await adapter.close();
    }
  });
});
