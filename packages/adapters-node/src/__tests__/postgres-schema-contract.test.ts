// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InformationAccessContext } from "@scce/kernel";
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

describe("Postgres schema contract extraction", () => {
  it.each(fixtures)("preserves exact ordered prior DDL apart from the explicit surface-key upgrade for $q with access $access", fixture => {
    const statements = schema.schemaStatements(fixture.q, fixture.access);
    const key = fixture.q.replaceAll('"', "");
    const addedColumn = `ALTER TABLE ${fixture.q}.semantic_frames ADD COLUMN IF NOT EXISTS normalized_surface_hash TEXT`;
    const retiredIndex = `DROP INDEX IF EXISTS ${fixture.q}.idx_${key}_semantic_frames_surface_rank`;
    const hashIndex = `CREATE INDEX IF NOT EXISTS idx_${key}_semantic_frames_normalized_surface_hash_rank ON ${fixture.q}.semantic_frames(normalized_surface_hash,alpha DESC,created_at DESC,id ASC)`;
    const oldIndex = `CREATE INDEX IF NOT EXISTS idx_${key}_semantic_frames_surface_rank ON ${fixture.q}.semantic_frames((frame_json->>'surface'),alpha DESC,created_at DESC,id ASC)`;
    const headerStatements = statements.filter(sql => sql.startsWith(`ALTER TABLE ${fixture.q}.language_patterns`) && sql.includes("pattern_schema"));
    expect(headerStatements).toHaveLength(1);
    expect(statements).toContain(addedColumn);
    expect(statements).toContain(retiredIndex);
    expect(statements).toContain(hashIndex);
    expect(statements).not.toContain(oldIndex);
    expect(statements).toHaveLength(fixture.statementCount + 3);
    const prior = statements.filter(sql => sql !== addedColumn && sql !== retiredIndex && !headerStatements.includes(sql)).map(sql => sql === hashIndex ? oldIndex : sql);
    expect(digest(prior)).toBe(fixture.sha256);
    expect(postgres.schemaStatements(fixture.q, fixture.access)).toEqual(statements);
  });

  it("preserves the fresh-schema indexes and required hydration column contract", () => {
    const columns = schema.requiredHydrationColumns();
    expect(columns.semantic_frames).toContain("normalized_surface_hash");
    const headers = ["pattern_schema", "component_recipe", "source_compilation_id", "owned_source_version_id", "pattern_language", "has_source_compilation", "has_source_version", "decoded_jsonb_bytes"];
    expect(digest({ ...columns, semantic_frames: columns.semantic_frames!.filter(column => column !== "normalized_surface_hash"),
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
