// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { REQUEST_SEED_FRAME_JSON_FIELDS, REQUEST_SEED_PATTERN_JSON_FIELDS, requestSeedLanguagePattern, type JsonValue } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

async function capture(view: "pattern" | "frame", seed = true) {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "allowlist", informationAccess: {
    tenantId: "fixture.tenant", principalId: "fixture.owner", compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: string[] = [];
  adapter.query = async <T>(sql: string): Promise<T[]> => { calls.push(sql); return []; };
  if (view === "pattern") await adapter.languageMemory.listLanguagePatterns({ ...(seed ? { view: "request_seed" as const } : {}), sourceSystem: "fixture", limit: 8 });
  else await adapter.languageMemory.listSemanticFrames({ ...(seed ? { view: "request_seed" as const } : {}), sourceSystem: "fixture", limit: 8 });
  return calls.at(-1)!;
}

it.each(["pattern", "frame"] as const)("projects %s values from typed JSONB columns before original-key masking, never enumerating discarded values", async kind => {
  const sql = await capture(kind);
  const fields = kind === "pattern" ? REQUEST_SEED_PATTERN_JSON_FIELDS : REQUEST_SEED_FRAME_JSON_FIELDS;
  const value = kind === "pattern" ? "pattern.pattern_json" : "frame.frame_json";
  const columns = /AS seed_record\(([^)]+)\)/u.exec(sql)?.[1]?.split(",");
  expect(columns).toEqual(fields.map(field => `"${field}" jsonb`));
  expect(sql).toContain(`jsonb_to_record(CASE WHEN jsonb_typeof(${value})='object' THEN ${value} ELSE '{}'::jsonb END)`);
  expect(sql).toContain(`jsonb_object_keys(CASE WHEN jsonb_typeof(${value})='object' THEN ${value} ELSE '{}'::jsonb END)`);
  expect(sql).toContain("seed_original_keys AS MATERIALIZED");
  expect(sql).toContain("seed_selected_fields AS MATERIALIZED");
  expect(sql).toContain("SELECT to_jsonb(seed_record) AS value");
  expect(sql).toContain("FROM seed_original_keys seed_key CROSS JOIN seed_selected_fields seed_selected");
  expect(sql).toContain("seed_selected.value->seed_key.key AS value");
  expect(sql).toContain("COALESCE(jsonb_object_agg(seed_field.key,seed_field.value),'{}'::jsonb)");
  expect(sql).not.toContain("jsonb_each(");
  expect(sql).not.toContain("jsonb_strip_nulls");
  expect(sql).not.toMatch(/seed_field\.value\s+IS\s+NOT\s+NULL/u);
});

const values: JsonValue[] = [null, false, true, 0, -3.25, "字\tİ ΟΣ", [null, false, 2, { "ψ": [] }], { "ψ": null, nested: [false, 3, "字"] }];
it.each(values.map((value, index) => [index, value] as const))("freezes selected JSON value %s and explicit null while keeping absent fields and large discarded bodies out", (_index, value) => {
  const source = { schema: "fixture.opaque", rules: value, anchor: null, surface: "字", discardedPrograms: ["source-body".repeat(100_000)],
    sourceObservations: [{ request: "request-body".repeat(100_000), events: [{ output: "output-body".repeat(100_000) }] }] };
  const projected = requestSeedLanguagePattern({ id: "fixture", profileId: "fixture.profile", patternKind: "semantic_role", support: 1,
    entropy: 0, evidenceIds: [], updatedAt: 1, patternJson: source });
  expect(projected.patternJson).toEqual({ schema: "fixture.opaque", rules: value, anchor: null, surface: "字" });
  expect(Object.hasOwn(projected.patternJson as object, "rules")).toBe(true);
  expect(Object.hasOwn(projected.patternJson as object, "anchor")).toBe(true);
  expect(Object.hasOwn(projected.patternJson as object, "profileId")).toBe(false);
});

it.each([null, false, 3, "字", [], [null]])("keeps malformed root %j empty under the existing object-only contract", root => {
  const projected = requestSeedLanguagePattern({ id: "fixture", profileId: "fixture.profile", patternKind: "semantic_role", support: 1,
    entropy: 0, evidenceIds: [], updatedAt: 1, patternJson: root });
  expect(projected.patternJson).toEqual({});
});

it.each(["pattern", "frame"] as const)("leaves full %s reads free of seed projection and masking", async kind => {
  const sql = await capture(kind, false);
  expect(sql).not.toContain("seed_original_keys");
  expect(sql).not.toContain("seed_selected_fields");
  expect(sql).not.toContain("AS seed_record(");
});
