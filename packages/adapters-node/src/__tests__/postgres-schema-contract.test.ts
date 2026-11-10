// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA, CONTEXTUAL_QA_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_SOURCE_SYSTEM,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type InformationAccessContext } from "@scce/kernel";
import * as postgres from "../postgres.js";
import * as schema from "../postgres-schema.js";

// Captured from the canonical adapter before extraction; hashes cover every SQL byte and statement order.
const fixtures: Array<{ q: string; access?: InformationAccessContext; statementCount: number; sha256: string }> = [
  {
    "q": "fixture",
    "statementCount": 242,
    "sha256": "20a7ff330a6f02ecbb4c75194141aced85e17dd929a6a493df245f898202659f"
  },
  {
    "q": "fixture",
    "access": {
      "tenantId": "fixture.tenant",
      "principalId": "fixture.owner",
      "compartments": [],
      "maximumExportClass": "restricted"
    },
    "statementCount": 243,
    "sha256": "82f779c46efa06f2e6ebaa170c176193a870e898939ab11f39b0b55efadb3009"
  },
  {
    "q": "fixture",
    "access": {
      "tenantId": "  \uff34enant'\u65e5  ",
      "principalId": " Owner'\ud83e\uddea ",
      "compartments": [
        " \uff33cope ",
        "Scope",
        " secret' ",
        ""
      ],
      "maximumExportClass": "restricted",
      "explicitMergeAuthority": true
    },
    "statementCount": 243,
    "sha256": "9229b20f2fcc606e535d3be1264950ec89ed5d4394a7598c650fc46fbed5c319"
  },
  {
    "q": "\"fixture\"",
    "statementCount": 242,
    "sha256": "1851f98d5973a8594876f3ac7d4e6db1e3b481fc9f6befa4c58068297e0c7d2a"
  },
  {
    "q": "\"fixture\"",
    "access": {
      "tenantId": "fixture.tenant",
      "principalId": "fixture.owner",
      "compartments": [],
      "maximumExportClass": "restricted"
    },
    "statementCount": 243,
    "sha256": "f49ab55c76322d2320134ba48bf264155ae1489b5b6660847540b6d7d19d0e8d"
  },
  {
    "q": "\"fixture\"",
    "access": {
      "tenantId": "  \uff34enant'\u65e5  ",
      "principalId": " Owner'\ud83e\uddea ",
      "compartments": [
        " \uff33cope ",
        "Scope",
        " secret' ",
        ""
      ],
      "maximumExportClass": "restricted",
      "explicitMergeAuthority": true
    },
    "statementCount": 243,
    "sha256": "941a938a2fd28f10f4dcf8d3d618e67d23345e2c714a5c7482db561cf047531b"
  }
];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const schema32HydrationColumns = {
  segmentation_consolidation_runs: ["run_id", "scope_id", "state", "run_json", "snapshot_json", "inference_json", "information_label", "created_at"],
  segmentation_consolidation_rows: ["run_id", "collection", "order_key", "row_json"],
  segmentation_consolidation_active: ["scope_id", "run_id", "header_json", "activated_at"],
  creative_event_templates: ["id", "kind", "value_json"],
  creative_event_lexemes: ["id", "kind", "value_json"],
  creative_event_witnesses: ["id", "kind", "value_json", "information_label"],
  creative_event_occurrences: ["id", "kind", "value_json", "information_label"]
};
const pageHydrationColumns = {
  creative_event_lexical_pages: ["id", "kind", "member_ids", "value_json"],
  construction_source_decision_pages: ["id", "owner_key", "kind", "value_json", "information_label"]
};
function pageAdditions(statements: readonly string[], q: string): string[] {
  const expected = [
    `CREATE TABLE IF NOT EXISTS ${q}.creative_event_lexical_pages (id BYTEA PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='lexical_forms_page'),member_ids BYTEA[] NOT NULL,value_json JSONB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_creative_lexical_members ON ${q}.creative_event_lexical_pages USING GIN(member_ids) WITH (fastupdate=off)`,
    `CREATE TABLE IF NOT EXISTS ${q}.construction_source_decision_pages (id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='construction_source_decisions'),value_json JSONB NOT NULL,information_label JSONB NOT NULL)`
  ];
  const found = statements.filter(sql => Object.keys(pageHydrationColumns).some(name => sql.includes(`${q}.${name} `)));
  expect(found).toEqual(expected);
  return found;
}
function schema32Additions(statements: readonly string[], q: string): string[] {
  const digestStatements = new Set([
    `DROP TRIGGER IF EXISTS scce_evidence_text_sha256 ON ${q}.evidence_spans`,
    `CREATE TRIGGER scce_evidence_text_sha256 BEFORE INSERT OR UPDATE OF text_content,text_sha256 ON ${q}.evidence_spans FOR EACH ROW EXECUTE FUNCTION ${q}.scce_sync_evidence_text_sha256()`,
    `ALTER TABLE ${q}.evidence_spans ENABLE ALWAYS TRIGGER scce_evidence_text_sha256`,
    `UPDATE ${q}.evidence_spans SET text_sha256=NULL WHERE text_sha256 IS NULL`,
    `ALTER TABLE ${q}.evidence_spans ALTER COLUMN text_sha256 SET NOT NULL`
  ]);
  const additions = statements.filter(sql => Object.keys(schema32HydrationColumns).some(name => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${q}.${name} (`))
    || sql.startsWith("DO $scce_evidence_digest_column$ BEGIN\n")
    || sql.startsWith(`CREATE OR REPLACE FUNCTION ${q}.scce_sync_evidence_text_sha256() RETURNS trigger `)
    || digestStatements.has(sql));
  expect(additions).toHaveLength(14);
  // Pin only schema32 additions; all prior SQL keeps its original ordered byte goldens.
  expect(digest(additions.map(sql => sql.replaceAll(q, "SCHEMA")))).toBe("f59a433f31992cfd640e220564ba62ced6a22fb96dc13356250c70d91a91a4ae");
  return additions;
}

describe("Postgres schema contract extraction", () => {
  it.each(fixtures)("preserves exact ordered prior DDL apart from explicit lookup upgrades and schema32 additions for $q with access $access", fixture => {
    const statements = schema.schemaStatements(fixture.q, fixture.access);
    const schema32 = schema32Additions(statements, fixture.q);
    const pages = pageAdditions(statements, fixture.q);
    const key = fixture.q.replaceAll('"', "");
    const addedColumn = `ALTER TABLE ${fixture.q}.semantic_frames ADD COLUMN IF NOT EXISTS normalized_surface_hash TEXT`;
    const retiredIndex = `DROP INDEX IF EXISTS ${fixture.q}.idx_${key}_semantic_frames_surface_rank`;
    const hashIndex = `CREATE INDEX IF NOT EXISTS idx_${key}_semantic_frames_normalized_surface_hash_rank ON ${fixture.q}.semantic_frames(normalized_surface_hash,alpha DESC,created_at DESC,id ASC)`;
    const oldIndex = `CREATE INDEX IF NOT EXISTS idx_${key}_semantic_frames_surface_rank ON ${fixture.q}.semantic_frames((frame_json->>'surface'),alpha DESC,created_at DESC,id ASC)`;
    const historyIndex = `CREATE INDEX IF NOT EXISTS idx_${key}_source_versions_history ON ${fixture.q}.source_versions(source_id,observed_at DESC,id DESC)`;
    const computationIndex = `CREATE INDEX IF NOT EXISTS idx_${key}_source_computation_binding_lookup ON ${fixture.q}.language_patterns(source_system,(pattern_json->>'bindingId'),support DESC,updated_at DESC,id) WHERE pattern_json->>'schema'='${SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA}'`;
    const contextualQaIndex = `CREATE INDEX IF NOT EXISTS idx_${key}_contextual_qa_request_lookup ON ${fixture.q}.language_patterns USING GIN ((pattern_json->'contextualQaRequestFeatures')) WHERE pattern_kind='semantic_role' AND pattern_json->>'schema'='${LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA}' AND pattern_json->>'componentRecipe'='${CONTEXTUAL_QA_CONSTRUCTION_RECIPE}' AND source_system='${CONTEXTUAL_QA_SOURCE_SYSTEM}'`;
    const headerStatements = statements.filter(sql => sql.startsWith(`ALTER TABLE ${fixture.q}.language_patterns`) && sql.includes("pattern_schema"));
    expect(headerStatements).toHaveLength(1);
    expect(statements).toContain(addedColumn);
    expect(statements).toContain(retiredIndex);
    expect(statements).toContain(hashIndex);
    expect(statements).not.toContain(oldIndex);
    expect(statements).toContain(historyIndex);
    expect(statements).toContain(computationIndex);
    expect(statements).toContain(contextualQaIndex);
    expect(statements).toHaveLength(fixture.statementCount + 6 + schema32.length + pages.length);
    const prior = statements.filter(sql => sql !== addedColumn && sql !== retiredIndex && sql !== historyIndex && sql !== computationIndex && sql !== contextualQaIndex && !headerStatements.includes(sql) && !schema32.includes(sql) && !pages.includes(sql)).map(sql => sql === hashIndex ? oldIndex : sql);
    expect(digest(prior)).toBe(fixture.sha256);
    expect(postgres.schemaStatements(fixture.q, fixture.access)).toEqual(statements);
  });

  it("preserves the fresh-schema indexes and required hydration column contract", () => {
    const columns = schema.requiredHydrationColumns();
    expect(columns.semantic_frames).toContain("normalized_surface_hash");
    expect(columns.evidence_spans).toContain("text_sha256");
    const priorColumns = { ...columns };
    for (const [name, expected] of Object.entries({ ...schema32HydrationColumns, ...pageHydrationColumns })) {
      expect(columns[name]).toEqual(expected);
      delete priorColumns[name];
    }
    const headers = ["pattern_schema", "component_recipe", "source_compilation_id", "owned_source_version_id", "pattern_language", "has_source_compilation", "has_source_version", "decoded_jsonb_bytes"];
    expect(digest({ ...priorColumns, evidence_spans: columns.evidence_spans!.filter(column => column !== "text_sha256"),
      semantic_frames: columns.semantic_frames!.filter(column => column !== "normalized_surface_hash"),
      language_patterns: columns.language_patterns!.filter(column => !headers.includes(column)) })).toBe("6cb43753bb07de0a5bdb96e1b27459d8861bf292b5f9ba6f9b31b50770df0f22");
    expect(digest(schema.freshSchemaIndexStatements("fixture"))).toBe("b9869ea350648b3a938f9f7e210ce2f01c038626a72cdf7f663dd276fb4f4ffd");
    expect(digest(schema.freshSchemaIndexStatements("\"fixture\""))).toBe("99d5d211dbddc3ac3eb50d88e2d08a178e1115a04b7068a75cf9c78ca2f5b8f5");
  });

  it("keeps existing schema APIs available from the adapter export", () => {
    const names = ["schemaStatements", "isDuplicateExtensionError", "DEFERRED_INDEX_META_KEY",
      "DEFERRED_INDEX_RESTORE_SORT_MEMORY", "DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS", "BULK_LOAD_DEFERRABLE_TABLES"] as const;
    for (const name of names) expect(postgres[name]).toBe(schema[name]);
  });
});
