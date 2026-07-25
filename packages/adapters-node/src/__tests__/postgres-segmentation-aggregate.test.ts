import { afterEach, describe, expect, it } from "vitest";
import { SEGMENTATION_SCHEMA_V2, segmentUnicodeSurfaceV2, type SegmentationAggregateKey } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

const KEY: SegmentationAggregateKey = {
  segmentationVersion: SEGMENTATION_SCHEMA_V2,
  languageCluster: "script:Hani",
  tenantId: "tenant.fixture",
  corpusRole: "role.fixture",
  activeImportVersion: "import.fixture"
};

function fixture(existingRow: Record<string, unknown> | undefined) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("SELECT") && sql.includes("segmentation_aggregates")) {
      return (existingRow ? [existingRow] : []) as T[];
    }
    return [] as T[];
  };
  const txClient = { async query() { return { rows: [] }; }, release() {} };
  (adapter.pool as unknown as { connect: () => Promise<typeof txClient> }).connect = async () => txClient;
  return { adapter, calls };
}

describe("Postgres segmentation aggregate store", () => {
  it("readAggregate returns undefined when nothing has been observed yet", async () => {
    const { adapter } = fixture(undefined);
    expect(await adapter.segmentationAggregates.readAggregate(KEY)).toBeUndefined();
  });

  it("observeDocument inserts a fresh aggregate row on the first observation", async () => {
    const { adapter, calls } = fixture(undefined);
    const model = segmentUnicodeSurfaceV2("我爱北京天安门广场太阳升");

    const result = await adapter.segmentationAggregates.observeDocument({ key: KEY, model, observedAt: 1_000 });

    expect(result.documentsObserved).toBe(1);
    const insert = calls.find(c => c.sql.includes("INSERT INTO") && c.sql.includes("segmentation_aggregates"));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe(SEGMENTATION_SCHEMA_V2);
    expect(insert!.params[5]).toBe(1); // documents_observed
  });

  it("observeDocument folds onto the existing row rather than resetting the count", async () => {
    const existingRow = {
      segmentation_version: SEGMENTATION_SCHEMA_V2,
      language_cluster: "script:Hani",
      tenant_id: "tenant.fixture",
      corpus_role: "role.fixture",
      active_import_version: "import.fixture",
      documents_observed: 3,
      lexical_segments_observed: 40,
      spaced_boundary_observations: 0,
      total_boundary_observations: 36,
      first_observed_at: new Date(500),
      last_observed_at: new Date(900)
    };
    const { adapter, calls } = fixture(existingRow);
    const model = segmentUnicodeSurfaceV2("我们一起去公园散步吧朋友");

    const result = await adapter.segmentationAggregates.observeDocument({ key: KEY, model, observedAt: 2_000 });

    expect(result.documentsObserved).toBe(4);
    expect(result.firstObservedAt).toBe(500); // preserved
    expect(result.lastObservedAt).toBe(2_000);
    const insert = calls.find(c => c.sql.includes("INSERT INTO") && c.sql.includes("segmentation_aggregates"));
    expect(insert!.params[5]).toBe(4);
  });
});
