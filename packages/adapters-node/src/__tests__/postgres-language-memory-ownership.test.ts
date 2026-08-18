import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_REQUIRED_TABLES } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres language-memory ownership queries", () => {
  it("filters plural profile ownership before unit and pattern limits", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listLanguageUnits({ profileIds: ["profile.a", "profile.b"], sourceSystem: "fixture", limit: 5 });
    await adapter.languageMemory.listLanguagePatterns({ profileIds: ["profile.a", "profile.b"], sourceSystem: "fixture", limit: 5 });

    expect(calls[0]?.sql).toContain("profile_id=ANY($1::text[])");
    expect(calls[0]?.sql.indexOf("profile_id=ANY")).toBeLessThan(calls[0]!.sql.indexOf("LIMIT"));
    expect(calls[0]?.params[0]).toEqual(["profile.a", "profile.b"]);
    expect(calls[1]?.sql).toContain("profile_id=ANY($1::text[])");
    expect(calls[1]?.sql.indexOf("profile_id=ANY")).toBeLessThan(calls[1]!.sql.indexOf("LIMIT"));
  });

  it("requires exact profile ownership for model and observation reads", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listNgramModels({ profileIds: ["profile.a"], limit: 7 });
    await adapter.languageMemory.listNgramObservations({ profileIds: ["profile.a"], limit: 7 });

    expect(calls[0]?.sql).toContain("model_json->>'profileId'=ANY($1::text[])");
    expect(calls[0]?.sql).not.toContain("sourceVersionId");
    expect(calls[0]?.params[0]).toEqual(["profile.a"]);
    expect(calls[0]?.params.at(-1)).toBe(7);
    expect(calls[1]?.sql).toContain("FROM unnest($5::text[]) AS owner(owner_id)");
    expect(calls[1]?.sql).toContain("metadata_json->>'profileId'=owner.owner_id");
    expect(calls[1]?.params[4]).toEqual(["profile.a"]);
    expect(calls[1]?.params.at(-1)).toBe(7);
    expect(calls).toHaveLength(2);
  });

  it("enforces the cumulative JSON byte budget in relevance order for model and unit reads", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listNgramModels({ limit: 12, maxTotalJsonBytes: 64 * 1024 * 1024 });
    await adapter.languageMemory.listLanguageUnits({ limit: 40, maxTotalJsonBytes: 24 * 1024 * 1024 });

    // Count limits stopped bounding memory once whole-novel training grew
    // single model_json blobs to tens of MB (a 4GB server heap OOMed at
    // warmup, verified live). The window sum admits records until the
    // byte budget is exhausted, in the SAME relevance order as the count
    // limit, and the top record always loads so an undersized budget
    // degrades to one record instead of zero.
    const modelSql = calls[0]!.sql;
    expect(modelSql).toContain("SUM(octet_length(model.model_json::text)) OVER (ORDER BY model.updated_at DESC, model.id ASC");
    expect(modelSql).toContain("running_json_bytes <=");
    expect(modelSql).toContain("relevance_rank = 1");
    expect(calls[0]?.params.at(-1)).toBe(64 * 1024 * 1024);
    const unitSql = calls[1]!.sql;
    expect(unitSql).toContain("SUM(octet_length(unit.metadata_json::text) + octet_length(unit.unit_text)) OVER (ORDER BY unit.alpha DESC, unit.id ASC");
    expect(unitSql).toContain("running_json_bytes <=");
    expect(calls[1]?.params.at(-1)).toBe(24 * 1024 * 1024);

    // Without a budget the classic count-limited query is byte-identical
    // to the previous contract.
    await adapter.languageMemory.listNgramModels({ limit: 12 });
    expect(calls[2]?.sql).not.toContain("running_json_bytes");
  });

  it("requires exact profile ownership for semantic-frame reads", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listSemanticFrames({
      profileIds: ["profile.a"],
      sourceSystem: "fixture",
      limit: 9
    });

    const sql = calls[0]!.sql;
    expect(sql).toContain("frame_json->>'profileId'=ANY");
    expect(sql).not.toContain("sourceVersionId");
    expect(sql.indexOf("profileId")).toBeLessThan(sql.indexOf("LIMIT"));
    expect(calls[0]?.params[0]).toBe("fixture");
    expect(calls[0]?.params[1]).toEqual(["profile.a"]);
    expect(calls[0]?.params.at(-1)).toBe(9);
  });

  it("filters exact semantic-frame surfaces before the matching rank limit", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listSemanticFrames({ surface: "surface.fixture", limit: 11 });

    const sql = calls[0]!.sql;
    expect(sql).toContain("frame_json->>'surface'=$1");
    expect(sql).toContain("ORDER BY alpha DESC, created_at DESC, id ASC LIMIT $6");
    expect(sql.indexOf("frame_json->>'surface'=$1")).toBeLessThan(sql.indexOf("ORDER BY"));
    expect(calls[0]?.params[0]).toBe("surface.fixture");
    expect(calls[0]?.params.at(-1)).toBe(11);
  });

  it("migrates an idempotent expression index matching exact surface ranking", async () => {
    const { adapter } = fixture();
    const statements: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: Array<Record<string, string>> }> {
        statements.push(sql);
        if (sql.includes("information_schema.tables")) {
          return { rows: POSTGRES_REQUIRED_TABLES.map(table_name => ({ table_name })) };
        }
        if (sql.includes("information_schema.columns")) {
          const identifiers = [...new Set(statements
            .filter(statement => statement.startsWith("CREATE TABLE"))
            .flatMap(statement => statement.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []))];
          return {
            rows: POSTGRES_REQUIRED_TABLES.flatMap(table_name => identifiers.map(column_name => ({ table_name, column_name })))
          };
        }
        return { rows: [] };
      },
      release(): void {}
    };
    (adapter.pool as unknown as { connect: () => Promise<typeof client> }).connect = async () => client;

    await adapter.migrate();

    expect(statements.filter(statement => statement.includes("semantic_frames_surface_rank"))).toEqual([
      `CREATE INDEX IF NOT EXISTS idx_fixture_semantic_frames_surface_rank ON "fixture".semantic_frames((frame_json->>'surface'),alpha DESC,created_at DESC,id ASC)`
    ]);
    expect(statements.some(statement =>
      statement.includes("UPDATE \"fixture\".language_profiles profile")
      && statement.includes("jsonb_array_elements(profile.profile_json->'charNgrams')")
    )).toBe(true);
  });

  it("bounds referenced profile discovery with index-backed semi-joins", async () => {
    const { adapter, calls } = fixture();

    await adapter.model.listLanguageProfiles({ limit: 17, referencedByLanguageMemory: true });

    const sql = calls[0]!.sql;
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("profile_id=lp.id");
    // Four correlated index-backed probes stay EXISTS; the ngram_observations
    // probe is a recursive skip scan over the (metadata_json->>'profileId')
    // expression index -- a correlated EXISTS there seq-scanned the multi-GB
    // observations table once per candidate profile without observations.
    expect(sql.match(/OFFSET 0/g)).toHaveLength(4);
    expect(sql).toContain("WITH RECURSIVE obs_profiles");
    expect(sql).toContain("o.metadata_json->>'profileId' > op.pid");
    expect(sql).not.toContain("EXISTS (SELECT 1 FROM \"fixture\".ngram_observations");
    expect(sql).toContain("LIMIT $1");
    expect(sql).not.toMatch(/artifact_refs|GROUP BY/i);
    expect(calls[0]?.params[0]).toBe(17);
  });

  it("ranks profile candidates from the indexed durable trigram set before applying the bound", async () => {
    const { adapter, calls } = fixture();

    await adapter.model.listLanguageProfiles({
      limit: 19,
      referencedByLanguageMemory: true,
      surfaceNgrams: ["QEL", "ela", "qel"]
    });

    const sql = calls[0]!.sql;
    expect(sql).toContain("lp.ngram_keys && $1::text[]");
    expect(sql).toContain("FROM unnest(lp.ngram_keys)");
    expect(sql.indexOf("lp.ngram_keys &&")).toBeLessThan(sql.indexOf("LIMIT $2"));
    expect(calls[0]?.params[0]).toEqual(["qel", "ela"]);
    expect(calls[0]?.params[1]).toBe(19);
  });
});

function fixture(): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture",
    informationAccess: {
      tenantId: "tenant.fixture",
      principalId: "principal.fixture",
      compartments: [],
      maximumExportClass: "restricted"
    }
  });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return [];
  };
  return { adapter, calls };
}
