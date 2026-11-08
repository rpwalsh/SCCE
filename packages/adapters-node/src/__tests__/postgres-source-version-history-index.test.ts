// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { schemaStatements } from "../postgres-schema.js";

it("indexes the exact logical-source and version order used by current-owner admission", () => {
  expect(schemaStatements('"fixture"').filter(sql => sql.includes("source_versions_history"))).toEqual([
    'CREATE INDEX IF NOT EXISTS idx_fixture_source_versions_history ON "fixture".source_versions(source_id,observed_at DESC,id DESC)'
  ]);
});
