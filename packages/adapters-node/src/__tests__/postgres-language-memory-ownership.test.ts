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
  });

  it("bounds referenced profile discovery with index-backed semi-joins", async () => {
    const { adapter, calls } = fixture();

    await adapter.model.listLanguageProfiles({ limit: 17, referencedByLanguageMemory: true });

    const sql = calls[0]!.sql;
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("profile_id=lp.id");
    expect(sql.match(/OFFSET 0/g)).toHaveLength(5);
    expect(sql).toContain("LIMIT $1");
    expect(sql).not.toMatch(/artifact_refs|GROUP BY|WITH\s/i);
    expect(calls[0]?.params[0]).toBe(17);
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
