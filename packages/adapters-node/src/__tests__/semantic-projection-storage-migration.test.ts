// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_REQUIRED_TABLES, canonicalStringify, createHasher, createLanguageInductionEngine,
  requestSeedLanguagePattern, semanticInductionProjection, toJsonValue, type InformationLabel,
  type JsonValue, type LanguagePatternRecord } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
import { requiredHydrationColumns } from "../postgres-schema.js";
import { DECODED_JSON_BYTE_LEDGER_KEY, decodeDurableArtifact, encodeDurableArtifact } from "../durable-artifact-storage.js";
import { LEGACY_SEMANTIC_PROJECTION_STORAGE_SCHEMA, SEMANTIC_PROJECTION_STORAGE_KEY,
  SEMANTIC_PROJECTION_STORAGE_SCHEMA } from "../semantic-projection-storage.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label: InformationLabel = { tenantId: "tenant.semantic-migration", principals: ["principal.owner"], compartments: [],
  exportClass: "restricted", mergePolicy: "isolated" };

function logicalFixture(): JsonValue {
  const hasher = createHasher();
  const model = createLanguageInductionEngine({ hasher }).induce({ documents: [{ id: "source.semantic-migration",
    text: "Alice follows Bob. Bob follows Alice. Mira directs Neralis. Neralis follows Mira.",
    evidenceIds: ["evidence.semantic-migration" as never], trust: 0.9 }] });
  return toJsonValue({ schema: "scce.induced_language_model.semantic_memory.v1", profileId: "profile.semantic-migration",
    sourceVersionId: "version.semantic-migration", semanticFrames: model.semanticFrames,
    graphBoundConstructions: model.graphBoundConstructions, lexicalClasses: model.lexicalClasses,
    relationHypothesisModel: model.relationHypothesisModel,
    semanticInductionProjection: semanticInductionProjection({ factors: model.semanticInductionFactors!,
      semanticFrames: model.semanticFrames, graphBoundConstructions: model.graphBoundConstructions,
      lexicalClasses: model.lexicalClasses, relationHypothesisModel: model.relationHypothesisModel, hasher }),
    counts: { follows: 3, directs: 1 } });
}

function legacyWire(logical: JsonValue): Record<string, unknown> {
  const current = encodeDurableArtifact(logical) as Record<string, unknown>;
  const pattern: LanguagePatternRecord = { id: "semantic.migration", profileId: "profile.semantic-migration",
    patternKind: "semantic_role", patternJson: logical, support: 1, entropy: 0,
    evidenceIds: [], updatedAt: 1, informationLabel: label };
  const seed = requestSeedLanguagePattern(pattern).patternJson as Record<string, unknown>;
  return { ...current,
    graphBoundConstructions: seed.graphBoundConstructions,
    lexicalClasses: seed.lexicalClasses,
    [SEMANTIC_PROJECTION_STORAGE_KEY]: { schema: LEGACY_SEMANTIC_PROJECTION_STORAGE_SCHEMA } };
}

function migrationFixture(initial: Record<string, unknown>) {
  const schema = "semantic_projection_migration";
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema, informationAccess: {
    tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let patternJson = structuredClone(initial), transactionSnapshot: Record<string, unknown> | undefined;
  adapter.query = async <T>(): Promise<T[]> => [];
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    let rows: unknown[] = [];
    if (sql === "BEGIN") transactionSnapshot = structuredClone(patternJson);
    else if (sql === "ROLLBACK" && transactionSnapshot) patternJson = transactionSnapshot;
    else if (sql.includes("SELECT to_regclass")) rows = [{ present: `${schema}.ngram_models` }];
    else if (sql.includes("SELECT id,profile_id,pattern_json,information_label") && sql.includes(SEMANTIC_PROJECTION_STORAGE_KEY)) {
      const marker = patternJson[SEMANTIC_PROJECTION_STORAGE_KEY] as { schema?: string } | undefined;
      if (marker?.schema === LEGACY_SEMANTIC_PROJECTION_STORAGE_SCHEMA && "semantic.migration" > String(params[0])) {
        rows = [{ id: "semantic.migration", profile_id: "profile.semantic-migration", pattern_json: patternJson, information_label: label }];
      }
    } else if (sql.includes("SET pattern_json=rewritten.pattern_json")) {
      const payload = JSON.parse(String(params[0])) as Array<{ id: string; pattern_json: Record<string, unknown> }>;
      if (payload.length === 1 && payload[0]!.id === "semantic.migration") {
        patternJson = payload[0]!.pattern_json; rows = [{ id: payload[0]!.id }];
      }
    } else if (sql.includes(`pattern_json ? '${SEMANTIC_PROJECTION_STORAGE_KEY}'`)) {
      const marker = patternJson[SEMANTIC_PROJECTION_STORAGE_KEY] as { schema?: string } | undefined;
      if (marker && marker.schema !== SEMANTIC_PROJECTION_STORAGE_SCHEMA) rows = [{ id: "semantic.migration" }];
    } else if (sql.includes("pattern_json->>'schema'=ANY")) rows = [];
    else if (sql.includes("SELECT id,frame_json->>'surface' AS surface")) rows = [];
    else if (sql.includes("AS pending")) rows = [{ pending: false }];
    else if (sql.includes("information_schema.tables")) rows = POSTGRES_REQUIRED_TABLES.map(table_name => ({ table_name }));
    else if (sql.includes("information_schema.columns")) rows = Object.entries(requiredHydrationColumns())
      .flatMap(([table_name, columns]) => columns.map(column_name => ({ table_name, column_name })));
    return { rows, rowCount: rows.length };
  } };
  Object.defineProperty(adapter.pool, "connect", { configurable: true, value: async () => client });
  return { adapter, calls, patternJson: () => patternJson };
}

describe("semantic projection v2 storage migration", () => {
  it("validates and transactionally rewrites v2 before publishing the schema version", async () => {
    const logical = logicalFixture(), legacy = legacyWire(logical), oldLedger = structuredClone(legacy[DECODED_JSON_BYTE_LEDGER_KEY]);
    const fixture = migrationFixture(legacy);
    await fixture.adapter.migrate();

    const stored = fixture.patternJson();
    expect(stored[SEMANTIC_PROJECTION_STORAGE_KEY]).toEqual({ schema: SEMANTIC_PROJECTION_STORAGE_SCHEMA });
    expect(stored).not.toHaveProperty("graphBoundConstructions");
    expect(stored).not.toHaveProperty("lexicalClasses");
    expect(stored[DECODED_JSON_BYTE_LEDGER_KEY]).toEqual(oldLedger);
    expect(canonicalStringify(decodeDurableArtifact(stored))).toBe(canonicalStringify(logical));
    const rewrite = fixture.calls.findIndex(call => call.sql.includes("SET pattern_json=rewritten.pattern_json"));
    const publish = fixture.calls.findIndex(call => call.sql.includes("VALUES('schema_version'"));
    expect(rewrite).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(rewrite);
    expect(fixture.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it.each(["query projection", "logical byte ledger"])("refuses corrupt v2 %s and rolls back without publishing", async corruption => {
    const legacy = legacyWire(logicalFixture());
    if (corruption === "query projection") {
      const graphs = legacy.graphBoundConstructions as Array<{ evidenceIds: string[] }>;
      graphs[0]!.evidenceIds.push("evidence.fabricated");
    } else {
      const ledger = legacy[DECODED_JSON_BYTE_LEDGER_KEY] as { decodedJsonBytes: number };
      ledger.decodedJsonBytes++;
    }
    const fixture = migrationFixture(legacy), before = structuredClone(legacy);
    await expect(fixture.adapter.migrate()).rejects.toThrow(
      corruption === "query projection" ? /failed exact replay validation/u : /byte ledger mismatch/u
    );
    expect(fixture.calls.some(call => call.sql === "ROLLBACK")).toBe(true);
    expect(fixture.calls.some(call => call.sql === "COMMIT" || call.sql.includes("VALUES('schema_version'"))).toBe(false);
    expect(fixture.patternJson()).toEqual(before);
  });

  it("refuses a marker with no schema before publishing the version", async () => {
    const wire = legacyWire(logicalFixture());
    wire[SEMANTIC_PROJECTION_STORAGE_KEY] = {};
    const fixture = migrationFixture(wire);
    await expect(fixture.adapter.migrate()).rejects.toThrow(/unsupported semantic projection storage row semantic\.migration/u);
    expect(fixture.calls.some(call => call.sql.includes("IS DISTINCT FROM $1"))).toBe(true);
    expect(fixture.calls.some(call => call.sql === "ROLLBACK")).toBe(true);
    expect(fixture.calls.some(call => call.sql === "COMMIT" || call.sql.includes("VALUES('schema_version'"))).toBe(false);
  });
});
