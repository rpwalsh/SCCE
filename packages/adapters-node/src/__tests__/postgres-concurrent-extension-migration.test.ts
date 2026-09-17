// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { isDuplicateExtensionError, schemaStatements } from "../postgres.js";

// Measured: two migrations running against different schemas of the same database both issue
// CREATE EXTENSION IF NOT EXISTS pg_trgm. IF NOT EXISTS is not race-safe -- both pass the check, the loser
// fails pg_extension_name_index, and because migrate() runs one transaction the whole migration rolled back
// after 1,077 seconds with zero columns added.

describe("a database-wide extension is not a per-schema race", () => {
  it("treats a concurrent create of the same extension as already-present, not as a failure", () => {
    expect(isDuplicateExtensionError({ code: "23505", constraint: "pg_extension_name_index" })).toBe(true);
    expect(isDuplicateExtensionError({ code: "23505", message: 'duplicate key value violates unique constraint "pg_extension_name_index"' })).toBe(true);
    expect(isDuplicateExtensionError({ code: "42710" })).toBe(true);
  });

  it("does not swallow an unrelated failure, so a real migration error still rolls the migration back", () => {
    expect(isDuplicateExtensionError({ code: "23505", constraint: "storage_meta_pkey" })).toBe(false);
    expect(isDuplicateExtensionError({ code: "42P01", message: "relation does not exist" })).toBe(false);
    expect(isDuplicateExtensionError(undefined)).toBe(false);
    expect(isDuplicateExtensionError(new Error("boom"))).toBe(false);
  });

  it("still declares the extensions the schema needs, so tolerance is not silence", () => {
    const joined = schemaStatements("fixture").join("\n");
    expect(joined).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(joined).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  });
});
