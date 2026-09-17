// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { evidenceSourceKindExpression, schemaStatements } from "../postgres.js";

// Measured live: with source kind read from provenance_json, one two-feature anchor search costs 780-1,600 ms because
// every ranked candidate detoasts ~58 KB of provenance to evaluate a COALESCE; the same search reads in 82 ms without it.
// The kind is a scalar identity residue, so it lives in a stored column the ranking reads like any other.

describe("source kind is a stored column, not a per-row provenance detoast", () => {
  const statements = schemaStatements("fixture");
  const joined = statements.join("\n");

  it("declares the column as the exact COALESCE the code used to evaluate, so column and code stay one contract", () => {
    const column = statements.find(sql => sql.includes("source_kind TEXT GENERATED ALWAYS AS"));
    expect(column).toBeDefined();
    expect(column).toContain("COALESCE(provenance_json->>'sourceKind', provenance_json->'metadata'->>'sourceKind', '')");
    expect(column).toContain("STORED");
  });

  it("reads the stored column in the ranking expression and never touches provenance_json there", () => {
    const expression = evidenceSourceKindExpression("evidence");
    expect(expression).toBe("evidence.source_kind");
    expect(expression).not.toContain("provenance_json");
  });

  it("indexes the column and gives the title match a trigram index, on every schema including a fresh one", () => {
    expect(joined).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(joined).toMatch(/CREATE INDEX IF NOT EXISTS idx_fixture_evidence_source_kind ON "?fixture"?\.evidence_spans\s*\(source_kind\)/u);
    expect(joined).toMatch(/idx_fixture_evidence_source_name_trgm ON "?fixture"?\.evidence_spans USING gin\s*\(source_name gin_trgm_ops\)/u);
  });
});
