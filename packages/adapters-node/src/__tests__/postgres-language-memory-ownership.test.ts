// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_REQUIRED_TABLES, type SourceVersionId } from "@scce/kernel";
import { clearResidentNgramModelJson, createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

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

  it("supersedes stale request-requirement rows in one source scope before storing fresh target/range patterns", async () => {
    const { adapter, calls } = fixture();
    adapter.transaction = async operation => operation();
    const pattern = {
      id: "request_requirement_pattern.fixture.nava-sula",
      profileId: "profile.fixture",
      patternKind: "semantic_role" as const,
      support: 0.9,
      entropy: 0.1,
      patternJson: {
        schema: "scce.request_requirement_pattern.v1",
        compilerFingerprint: "scce.request_requirement_pattern.targets_and_ranges.v1",
        sourceVersionId: "source-version.fixture",
        sourceSystem: "corrections",
        surface: "nava sula",
        requirementTargets: { brevityDetailBalance: 0.92 },
        requirementTargetBounds: { brevityDetailBalance: { lower: 0.92, upper: 0.92 } }
      },
      evidenceIds: [],
      updatedAt: 1,
      informationLabel: {
        tenantId: "tenant.fixture",
        principals: ["principal.fixture"],
        compartments: [],
        exportClass: "restricted" as const,
        mergePolicy: "isolated" as const
      }
    };

    await adapter.languageMemory.replaceRequestRequirementPatterns?.({
      profileId: pattern.profileId,
      sourceVersionId: "source-version.fixture" as SourceVersionId,
      sourceSystem: "corrections",
      schema: "scce.request_requirement_pattern.v1",
      compilerFingerprint: "scce.request_requirement_pattern.targets_and_ranges.v1",
      patterns: [pattern]
    });

    const deletion = calls.find(call => call.sql.includes("DELETE FROM \"fixture\".\"language_patterns\""));
    const insertion = calls.find(call => call.sql.includes("INSERT INTO \"fixture\".\"language_patterns\""));
    expect(deletion).toBeDefined();
    expect(deletion?.sql).toContain("pattern.pattern_json->>'schema'=$2");
    expect(deletion?.sql).toContain("pattern.pattern_json->>'sourceVersionId'=$3");
    expect(deletion?.sql).toContain("pattern.pattern_json->>'sourceSystem'=$4");
    expect(deletion?.params.slice(0, 4)).toEqual([
      "profile.fixture",
      "scce.request_requirement_pattern.v1",
      "source-version.fixture",
      "corrections"
    ]);
    expect(insertion).toBeDefined();
    expect(calls.indexOf(deletion!)).toBeLessThan(calls.indexOf(insertion!));
    expect(JSON.stringify(insertion?.params)).toContain("requirementTargets");
    expect(JSON.stringify(insertion?.params)).toContain("0.92");
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
    // warmup, verified live). Records are admitted until the byte budget is
    // exhausted, in the SAME relevance order as the count limit, and the top
    // record always loads so an undersized budget degrades to one record
    // instead of zero. The two tests below hold the budget quantity itself.
    const modelSql = calls[0]!.sql;
    expect(modelSql).toContain("ORDER BY COALESCE((model.model_json->'model'->>'totalUnigramCount')::numeric, 0) DESC, model.updated_at DESC, model.id ASC");
    const unitSql = calls[1]!.sql;
    expect(unitSql).toContain("SUM(octet_length(unit.metadata_json::text) + octet_length(unit.unit_text)) OVER (ORDER BY unit.alpha DESC, unit.id ASC");
    expect(unitSql).toContain("running_json_bytes <=");
    expect(calls[1]?.params.at(-1)).toBe(24 * 1024 * 1024);

    // Without a budget the classic count-limited query is byte-identical
    // to the previous contract.
    await adapter.languageMemory.listNgramModels({ limit: 12 });
    expect(calls[2]?.sql).not.toContain("running_json_bytes");
  });

  // The budget bounds the bytes this process hydrates, so the deciding quantity is the uncompressed JSON text
  // length; pg_column_size reports compressed, possibly-TOASTed storage and under-counts the heap it must bound.
  it("bounds the budget by uncompressed JSON text length, not by compressed storage size", async () => {
    clearResidentNgramModelJson();
    const { adapter } = modelFixture([
      { id: "model.a", storedBytes: 100, jsonBytes: 400 },
      { id: "model.b", storedBytes: 100, jsonBytes: 400 },
      { id: "model.c", storedBytes: 100, jsonBytes: 400 }
    ]);

    // Every record fits three times over weighed by stored size (300 of 1000) and the third does not fit weighed
    // by JSON text (1200 of 1000), so the returned prefix names which quantity decided.
    const admitted = await adapter.languageMemory.listNgramModels({ limit: 12, maxTotalJsonBytes: 1000 });
    expect(admitted.map(model => model.id)).toEqual(["model.a", "model.b"]);
  });

  it("admits the top record when the budget is smaller than it, rather than returning nothing", async () => {
    clearResidentNgramModelJson();
    const { adapter } = modelFixture([
      { id: "model.solo.a", storedBytes: 100, jsonBytes: 400 },
      { id: "model.solo.b", storedBytes: 100, jsonBytes: 400 }
    ]);

    const admitted = await adapter.languageMemory.listNgramModels({ limit: 12, maxTotalJsonBytes: 100 });
    expect(admitted.map(model => model.id)).toEqual(["model.solo.a"]);
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

    // Found by content, not position: a one-off probe for the
    // referenced_by_language_memory column (tools/migrations) can
    // precede it. This test is about the profile query's shape.
    const call = calls.find(entry => entry.sql.includes("lp.ngram_keys"))!;
    expect(call).toBeDefined();
    const sql = call.sql;
    expect(sql).toContain("lp.ngram_keys && $1::text[]");
    expect(sql).toContain("FROM unnest(lp.ngram_keys)");
    expect(sql.indexOf("lp.ngram_keys &&")).toBeLessThan(sql.indexOf("LIMIT $2"));
    expect(call.params[0]).toEqual(["qel", "ela"]);
    expect(call.params[1]).toBe(19);
  });
});

/** Ranked ngram_models rows whose stored size and JSON text length differ, in the order the relevance query returns. */
function modelFixture(models: ReadonlyArray<{ id: string; storedBytes: number; jsonBytes: number }>): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const { adapter, calls } = fixture();
  const label = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
  const updatedAt = new Date(1);
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("pg_column_size(model.model_json) AS stored_bytes")) {
      return models.map(model => ({
        id: model.id,
        stream_id: "stream.fixture",
        language_hint: "script:Latn",
        max_order: 3,
        discount: "0.75",
        updated_at: updatedAt,
        information_label: label,
        stored_bytes: String(model.storedBytes)
      })) as unknown as T[];
    }
    if (sql.includes("octet_length(model.model_json::text) AS json_bytes")) {
      const wanted = new Set((params[0] as string[] | undefined) ?? []);
      return models.filter(model => wanted.has(model.id)).map(model => ({
        id: model.id,
        updated_at: updatedAt,
        model_json: { profileId: "profile.fixture", model: { totalUnigramCount: 1 } },
        json_bytes: String(model.jsonBytes)
      })) as unknown as T[];
    }
    return [];
  };
  return { adapter, calls };
}

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
