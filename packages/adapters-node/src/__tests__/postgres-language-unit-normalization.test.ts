// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import type { InformationLabel, LanguageUnitRecord } from "@scce/kernel";
import {
  canonicalLanguageUnitSchemaStatements,
  LANGUAGE_UNIT_EVIDENCE_SET_RELATION,
  LANGUAGE_UNIT_INFORMATION_LABEL_RELATION,
  LANGUAGE_UNIT_VALUES_RELATION
} from "../canonical-language-unit-store.js";
import { requiredHydrationColumns } from "../postgres-schema.js";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const q = '"unit_normalization"';
const logicalColumns = ["id", "profile_id", "source_version_id", "script", "unit_kind", "unit_text", "features",
  "competence_vector", "alpha", "evidence_ids", "metadata_json", "information_label"];
const compact = (sql: string) => sql.replace(/\s+/gu, " ").trim();

afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

function unit(): LanguageUnitRecord {
  return {
    id: "unit.exact", profileId: "profile.exact", sourceVersionId: "version.exact" as LanguageUnitRecord["sourceVersionId"],
    script: "script.Latn", unitKind: "symbol", text: "\tβ e\u0301💠\r\n", features: ["sym:β", "sym:β", "sym:💠"],
    competenceVector: [0.125, 0.5, 1], alpha: 0.75,
    evidenceIds: ["evidence.z", "evidence.a", "evidence.z"] as LanguageUnitRecord["evidenceIds"],
    metadata: { count: 3, sourceSystem: "fixture" },
    informationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["test"], exportClass: "restricted", mergePolicy: "isolated" }
  };
}

function fixture(readRows: unknown[] = []) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://offline.invalid/no_database", schema: "unit_normalization",
    informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[]; kind: "query" | "mutation" }> = [];
  Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params, kind: "query" });
    return sql.startsWith(`SELECT * FROM ${q}."${LANGUAGE_UNIT_VALUES_RELATION}" unit WHERE`) ? readRows as T[] : [];
  };
  Object.defineProperty(adapter, "mutateLanguageMemory", { value: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params, kind: "mutation" }); return true;
  } });
  return { adapter, calls };
}

describe("canonical Postgres language-unit normalization", () => {
  it("shares evidence arrays and labels in two independent value dictionaries", () => {
    const statements = canonicalLanguageUnitSchemaStatements(q);
    const tables = statements.filter(sql => sql.startsWith("CREATE TABLE"));
    expect(tables).toHaveLength(2);
    expect(tables[0]).toContain(`${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION}`);
    expect(tables[0]).toContain("evidence_ids TEXT[] NOT NULL,UNIQUE(evidence_ids)");
    expect(tables[0]).not.toContain("information_label");
    expect(tables[1]).toContain(`${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION}`);
    expect(tables[1]).toContain("information_label JSONB NOT NULL,UNIQUE(information_label)");
    expect(tables[1]).not.toContain("evidence_ids");
    expect(tables.every(sql => sql.includes("id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"))).toBe(true);
  });

  it("keeps only dictionary references in physical rows and exposes exactly the former twelve logical columns", () => {
    const statements = canonicalLanguageUnitSchemaStatements(q), columns = requiredHydrationColumns();
    expect(columns.language_units).toEqual([...logicalColumns.filter(column => column !== "evidence_ids" && column !== "information_label"), "evidence_set_id", "information_label_id"]);
    expect(columns[LANGUAGE_UNIT_EVIDENCE_SET_RELATION]).toEqual(["id", "evidence_ids"]);
    expect(columns[LANGUAGE_UNIT_INFORMATION_LABEL_RELATION]).toEqual(["id", "information_label"]);
    expect(columns[LANGUAGE_UNIT_VALUES_RELATION]).toEqual(logicalColumns);
    const view = statements.find(sql => sql.startsWith("CREATE OR REPLACE VIEW"))!;
    expect(view).toContain(`${q}.${LANGUAGE_UNIT_VALUES_RELATION}`);
    const projection = view.slice(view.indexOf("SELECT ") + 7, view.indexOf("\n      FROM "));
    expect(projection.split(",").map(column => column.trim().split(".").at(-1))).toEqual(logicalColumns);
    expect(view).toContain(`JOIN ${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION} evidence_set ON evidence_set.id=unit.evidence_set_id`);
    expect(view).toContain(`JOIN ${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION} label ON label.id=unit.information_label_id`);
    expect(projection).not.toContain("evidence_set_id");
    expect(projection).not.toContain("information_label_id");
  });

  it("verifies exact migrated values before dropping either inline column and requires resolved foreign keys", () => {
    const sql = compact(canonicalLanguageUnitSchemaStatements(q).find(statement => statement.startsWith("DO "))!);
    const equality = sql.indexOf("WHERE evidence_set.evidence_ids IS DISTINCT FROM unit.evidence_ids OR label.information_label IS DISTINCT FROM unit.information_label");
    expect(equality).toBeGreaterThan(sql.indexOf(`UPDATE ${q}.language_units unit`));
    const refusal = sql.indexOf("RAISE EXCEPTION 'Language-unit normalization changed a logical row'");
    expect(refusal).toBeGreaterThan(equality);
    for (const column of ["evidence_ids", "information_label"]) expect(sql.indexOf(`DROP COLUMN ${column}`)).toBeGreaterThan(refusal);
    expect(sql).toContain("has_inline_evidence IS DISTINCT FROM has_inline_label");
    expect(sql).toContain("Incomplete language-unit normalization source columns");
    expect(sql).toContain("WHERE evidence_set_id IS NULL OR information_label_id IS NULL");
    expect(sql).toContain("Language-unit normalization left an unresolved reference");
    for (const [reference, dictionary] of [["evidence_set_id", LANGUAGE_UNIT_EVIDENCE_SET_RELATION], ["information_label_id", LANGUAGE_UNIT_INFORMATION_LABEL_RELATION]]) {
      expect(sql).toContain(`ALTER COLUMN ${reference} SET NOT NULL`);
      expect(sql).toContain(`FOREIGN KEY(${reference}) REFERENCES ${q}.${dictionary}(id) ON DELETE RESTRICT`);
    }
    // DISTINCT operates on whole arrays, preserving order and multiplicity inside each migrated value.
    expect(sql).toContain(`SELECT DISTINCT evidence_ids FROM ${q}.language_units ON CONFLICT(evidence_ids) DO NOTHING`);
    expect(sql).not.toContain("unnest(");
  });

  it("writes normalized rows while preserving initial ordered duplicates and the existing update DISTINCT union", async () => {
    const { adapter, calls } = fixture(), original = unit(), before = structuredClone(original);
    await adapter.languageMemory.putLanguageUnit(original);
    const writes = calls.filter(call => call.kind === "mutation");
    expect(writes).toHaveLength(1);
    const sql = compact(writes[0]!.sql), payload = JSON.parse(String(writes[0]!.params[0])) as Array<Record<string, unknown>>;
    expect(payload[0]).toMatchObject({ unit_text: original.text, evidence_ids_json: original.evidenceIds,
      features_json: original.features, competence_vector_json: original.competenceVector, information_label: original.informationLabel });
    expect(original).toEqual(before);
    expect(sql).toContain("array_agg(v.value ORDER BY v.ordinality)");
    expect(sql).toContain("jsonb_array_elements_text(r.evidence_ids_json) WITH ORDINALITY");
    expect(sql).toContain("CASE WHEN unit.id IS NULL THEN input.incoming_evidence_ids ELSE (SELECT ARRAY(SELECT DISTINCT unnest(evidence_set.evidence_ids || input.incoming_evidence_ids))) END AS evidence_ids");
    expect(sql).toContain(`INSERT INTO ${q}."${LANGUAGE_UNIT_EVIDENCE_SET_RELATION}"(evidence_ids)`);
    expect(sql).toContain(`INSERT INTO ${q}."${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION}"(information_label)`);
    expect(sql).toContain("ON CONFLICT(evidence_ids) DO NOTHING");
    expect(sql).toContain("ON CONFLICT(information_label) DO NOTHING");
    const physical = /INSERT INTO "unit_normalization"\."language_units" AS unit\(([^)]+)\)/u.exec(sql);
    expect(physical).not.toBeNull();
    expect(physical![1]!.split(",").map(column => column.trim())).toEqual([
      "id", "profile_id", "source_version_id", "script", "unit_kind", "unit_text", "features", "competence_vector", "alpha",
      "metadata_json", "evidence_set_id", "information_label_id"
    ]);
    expect(sql).toContain("evidence_set_id=EXCLUDED.evidence_set_id");
    expect(sql).toContain("information_label_id=EXCLUDED.information_label_id");
  });

  it("locks only physical unit rows when joining labels, merging metadata and paging maintenance", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.putLanguageUnit(unit());
    const labelRead = calls.find(call => call.sql.includes("SELECT unit.id,label.information_label"))!;
    const metadataRead = calls.find(call => call.sql.includes("SELECT unit.id,unit.metadata_json AS value"))!;
    expect(labelRead).toBeDefined(); expect(metadataRead).toBeDefined();
    for (const call of [labelRead, metadataRead]) {
      const sql = compact(call.sql);
      expect(sql).toContain(`FROM ${q}."language_units" unit JOIN ${q}."${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION}" label`);
      expect(sql).toMatch(/FOR UPDATE OF unit$/u);
      expect(sql).not.toContain("FOR UPDATE OF label");
    }
    await adapter.languageMemory.listUnitSourceMetadataPage!({ limit: 4, maxTotalJsonBytes: 4096 });
    const maintenance = compact(calls.at(-1)!.sql);
    expect(maintenance).toContain(`FROM ${q}."language_units" unit_record JOIN ${q}."${LANGUAGE_UNIT_VALUES_RELATION}" unit ON unit.id=unit_record.id`);
    expect(maintenance).toContain("FOR UPDATE OF unit_record");
    expect(maintenance).not.toMatch(/FOR UPDATE(?:\s*\)|$)/u);
  });

  it("restores the old logical record through the compatibility view without exposing physical references", async () => {
    const original = unit();
    const row = { id: original.id, profile_id: original.profileId, source_version_id: original.sourceVersionId, script: original.script,
      unit_kind: original.unitKind, unit_text: original.text, features: original.features, competence_vector: original.competenceVector,
      alpha: String(original.alpha), evidence_ids: original.evidenceIds, metadata_json: original.metadata,
      information_label: original.informationLabel as InformationLabel };
    const { adapter, calls } = fixture([row]);
    expect(await adapter.languageMemory.listLanguageUnits({ profileId: original.profileId, limit: 1 })).toEqual([original]);
    const read = calls.find(call => call.sql.startsWith(`SELECT * FROM ${q}."${LANGUAGE_UNIT_VALUES_RELATION}" unit WHERE`))!;
    expect(read.sql).toContain("unit.information_label");
    expect(read.params).toContain(original.profileId);
    expect(read.sql).not.toContain("evidence_set_id");
    expect(read.sql).not.toContain("information_label_id");
  });
});
