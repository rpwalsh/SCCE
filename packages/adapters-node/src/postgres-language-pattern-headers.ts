// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA } from "./durable-join-program-storage.js";

export const LANGUAGE_PATTERN_SELECTION_HEADERS = ["pattern_schema", "component_recipe", "source_compilation_id", "owned_source_version_id",
  "pattern_language", "has_source_compilation", "has_source_version", "decoded_jsonb_bytes"] as const;

/** Generated columns derive once per write; candidate scans never expand program bodies. */
export function languagePatternSelectionHeaderStatement(q: string): string {
  const ledger = `pattern_json->'${DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY}'`;
  return `ALTER TABLE ${q}.language_patterns
    ADD COLUMN IF NOT EXISTS pattern_schema TEXT GENERATED ALWAYS AS (pattern_json->>'schema') STORED,
    ADD COLUMN IF NOT EXISTS component_recipe TEXT GENERATED ALWAYS AS (pattern_json->>'componentRecipe') STORED,
    ADD COLUMN IF NOT EXISTS source_compilation_id TEXT GENERATED ALWAYS AS (pattern_json->>'sourceCompilationId') STORED,
    ADD COLUMN IF NOT EXISTS owned_source_version_id TEXT GENERATED ALWAYS AS (pattern_json->>'sourceVersionId') STORED,
    ADD COLUMN IF NOT EXISTS pattern_language TEXT GENERATED ALWAYS AS (pattern_json->>'language') STORED,
    ADD COLUMN IF NOT EXISTS has_source_compilation BOOLEAN GENERATED ALWAYS AS (pattern_json ? 'sourceCompilationId') STORED,
    ADD COLUMN IF NOT EXISTS has_source_version BOOLEAN GENERATED ALWAYS AS (pattern_json ? 'sourceVersionId') STORED,
    ADD COLUMN IF NOT EXISTS decoded_jsonb_bytes NUMERIC GENERATED ALWAYS AS (CASE
      WHEN ${ledger}->>'schema'='${DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA}'
        AND jsonb_typeof(pattern_json#>'{${DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY},decodedJsonbBytes}')='number'
      THEN (${ledger}->>'decodedJsonbBytes')::numeric ELSE NULL END) STORED`;
}
