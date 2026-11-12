// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import {
  assertEvidenceTextReferenceMaintenance,
  evidenceTextReferenceSchemaStatements,
  EVIDENCE_TEXT_REFERENCE_CONSTRAINT,
  EVIDENCE_TEXT_REFERENCE_RECIPE
} from "../evidence-text-reference-schema.js";
import { schemaStatements, requiredHydrationColumns } from "../postgres-schema.js";
import type { PostgresStorageAdapter } from "../postgres.js";

it("verifies then removes both repeated evidence bodies and duplicate digests", () => {
  const statements = evidenceTextReferenceSchemaStatements('"fixture"'), sql = statements.join("\n");
  expect(sql).toContain("pg_catalog.sha256(pg_catalog.convert_to(text_content,''UTF8''))");
  expect(sql).toContain("content_hash<>''sha256_'' || pg_catalog.encode(text_sha256,''hex'')");
  expect(sql).toContain("DROP COLUMN IF EXISTS text_content");
  expect(sql).toContain("DROP COLUMN IF EXISTS text_sha256");
  expect(sql).toContain(EVIDENCE_TEXT_REFERENCE_CONSTRAINT);
  expect(sql).toContain(EVIDENCE_TEXT_REFERENCE_RECIPE);
  expect(sql).not.toMatch(/IMMUTABLE|GENERATED ALWAYS|SECURITY DEFINER/u);
  const verify = statements.findIndex(statement => statement.includes("scce_evidence_reference_verify"));
  const dropBody = statements.findIndex(statement => statement.includes("DROP COLUMN IF EXISTS text_content"));
  const dropDigest = statements.findIndex(statement => statement.includes("DROP COLUMN IF EXISTS text_sha256"));
  expect(verify).toBe(0); expect(dropBody).toBeGreaterThan(verify); expect(dropDigest).toBeGreaterThan(verify);
  const full = schemaStatements('"fixture"');
  expect(full.indexOf(statements[0]!)).toBeGreaterThan(full.findIndex(statement => statement.includes("CREATE TABLE IF NOT EXISTS") && statement.includes(".evidence_spans (")));
  expect(requiredHydrationColumns().evidence_spans).not.toContain("text_content");
  expect(requiredHydrationColumns().evidence_spans).not.toContain("text_sha256");
});

it("attests the validated range identity and absence of both redundant columns", async () => {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  let valid = true;
  const storage = { table: (name: string) => `"fixture"."${name}"`, query: async <T>(sql: string, params: unknown[]) => {
    calls.push({sql, params}); return [{valid}] as T[];
  }} as unknown as PostgresStorageAdapter;
  await expect(assertEvidenceTextReferenceMaintenance(storage)).resolves.toBeUndefined();
  expect(calls[0]!.params).toEqual(['"fixture"."evidence_spans"', EVIDENCE_TEXT_REFERENCE_CONSTRAINT, EVIDENCE_TEXT_REFERENCE_RECIPE]);
  expect(calls[0]!.sql).toContain("k.convalidated");
  expect(calls[0]!.sql).toContain("body.attname IN ('text_content','text_sha256')");
  valid = false;
  await expect(assertEvidenceTextReferenceMaintenance(storage)).rejects.toThrow(/incomplete/);
  storage.query = async () => { throw new Error("catalog unavailable"); };
  await expect(assertEvidenceTextReferenceMaintenance(storage)).rejects.toThrow("catalog unavailable");
});
