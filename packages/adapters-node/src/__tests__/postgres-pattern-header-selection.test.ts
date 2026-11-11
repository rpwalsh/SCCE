// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";
import { requiredHydrationColumns, schemaStatements } from "../postgres-schema.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const columns = ["pattern_schema", "component_recipe", "source_compilation_id", "owned_source_version_id", "pattern_language",
  "has_source_compilation", "has_source_version", "decoded_artifact_jsonb_bytes"];

it("materializes small selection headers at writes while retaining the canonical program body", () => {
  const ddl = schemaStatements("fixture").find(sql => sql.startsWith("ALTER TABLE fixture.language_patterns") && sql.includes("pattern_schema"));
  expect(ddl).toBeDefined();
  for (const column of columns) {
    expect(ddl).toContain(`ADD COLUMN IF NOT EXISTS ${column} `);
    expect(requiredHydrationColumns().language_patterns).toContain(column);
  }
  expect(ddl?.match(/GENERATED ALWAYS AS/gu)).toHaveLength(columns.length);
  expect(ddl).toContain("pattern_json ? 'sourceCompilationId'");
  expect(ddl).toContain("pattern_json ? 'sourceVersionId'");
  expect(ddl).toContain("jsonb_typeof(pattern_json#>'{_scceDecodedJsonByteLedger,decodedJsonbBytes}')='number'");
  expect(ddl).not.toMatch(/DROP|TRUNCATE|DELETE/u);
});

it.each([undefined, "request_seed" as const])("selects %s candidates without expanding bodies before row admission", async view => {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: "fixture.tenant", principalId: "fixture.owner", compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: string[] = [];
  adapter.query = async <T>(sql: string): Promise<T[]> => { calls.push(sql); return []; };
  await adapter.languageMemory.listLanguagePatterns({ view, profileIds: ["owned"], limit: 12, maxTotalJsonBytes: 4096 });
  const sql = calls.filter(call => call.includes("pattern_headers AS MATERIALIZED")).at(-1)!;
  const header = sql.slice(sql.indexOf("pattern_headers AS MATERIALIZED"), sql.indexOf("candidate_pool AS MATERIALIZED"));
  expect(header).not.toContain("jsonb_to_record");
  expect(header.replace("pg_column_size(pattern.pattern_json)", "stored_size")).not.toContain("pattern.pattern_json");
  for (const column of columns.filter(column => column !== "decoded_artifact_jsonb_bytes")) expect(header).toContain(`pattern.${column}`);
  expect(header).toContain(view ? "CASE WHEN pattern.pattern_schema='scce.request_requirement_pattern.v1' THEN pattern.decoded_artifact_jsonb_bytes ELSE NULL::numeric END AS decoded_jsonb_bytes" : "pattern.decoded_artifact_jsonb_bytes AS decoded_jsonb_bytes");
  expect(header).toContain("pattern.profile_id=ANY(");
  expect(sql).toContain("current_compilation");
  expect(sql).toContain("ranked.category_rank <= CEIL(");
});
