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
  it.each(fixtures)("preserves exact ordered DDL for $q with access $access", fixture => {
    const statements = schema.schemaStatements(fixture.q, fixture.access);
    expect(statements).toHaveLength(fixture.statementCount);
    expect(digest(statements)).toBe(fixture.sha256);
    expect(postgres.schemaStatements(fixture.q, fixture.access)).toEqual(statements);
  });

  it("preserves the fresh-schema indexes and required hydration column contract", () => {
    expect(digest(schema.requiredHydrationColumns())).toBe("6cb43753bb07de0a5bdb96e1b27459d8861bf292b5f9ba6f9b31b50770df0f22");
    expect(digest(schema.freshSchemaIndexStatements("fixture"))).toBe("b9869ea350648b3a938f9f7e210ce2f01c038626a72cdf7f663dd276fb4f4ffd");
    expect(digest(schema.freshSchemaIndexStatements("\"fixture\""))).toBe("99d5d211dbddc3ac3eb50d88e2d08a178e1115a04b7068a75cf9c78ca2f5b8f5");
  });

  it("keeps existing schema APIs available from the adapter export", () => {
    const names = ["schemaStatements", "isDuplicateExtensionError", "DEFERRED_INDEX_META_KEY",
      "DEFERRED_INDEX_RESTORE_SORT_MEMORY", "DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS", "BULK_LOAD_DEFERRABLE_TABLES"] as const;
    for (const name of names) expect(postgres[name]).toBe(schema[name]);
  });
});
