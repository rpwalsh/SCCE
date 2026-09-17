// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { languagePatternSourceSystemExpression, schemaStatements } from "../postgres.js";

// Measured live: listLanguagePatterns' candidate_pool sequential-scans 5.4GB to evaluate pattern_json->>'sourceSystem'
// when query.sourceSystem is set, detoasting the whole table to read a field its own index already carries as a
// leading key. Forcing that index measured 18.9s -> 1.9s. Same contract as source_kind (3af27d4): the scope key
// becomes a stored generated column so the planner can choose the cheap index without being forced.

const OLD_LANGUAGE_PATTERN_SOURCE_SYSTEM_EXPRESSION = "pattern_json->>'sourceSystem'";

describe("language_patterns.source_system is a stored column, not a per-row pattern_json detoast", () => {
  const statements = schemaStatements("fixture");
  const joined = statements.join("\n");

  it("declares the column as the exact expression the scope filter used to evaluate", () => {
    const column = statements.find(sql => sql.includes("ALTER TABLE") && sql.includes("language_patterns") && sql.includes("source_system TEXT GENERATED ALWAYS AS"));
    expect(column).toBeDefined();
    expect(column).toContain(`(${OLD_LANGUAGE_PATTERN_SOURCE_SYSTEM_EXPRESSION}) STORED`);
  });

  it("reads the stored column in the scope-filter expression and never touches pattern_json there", () => {
    const expression = languagePatternSourceSystemExpression("pattern");
    expect(expression).toBe("pattern.source_system");
    expect(expression).not.toContain("pattern_json");
  });

  it("indexes the stored column with the scope-key, support DESC, updated_at DESC shape the JSON-expression index already has", () => {
    expect(joined).toMatch(/idx_fixture_language_patterns_source_system_stored_rank ON "?fixture"?\.language_patterns\s*\(source_system, support DESC, updated_at DESC\)/u);
  });
});
