// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { assertEvidenceTextDigestMaintenance, evidenceTextDigestSchemaStatements, EVIDENCE_TEXT_DIGEST_BODY, EVIDENCE_TEXT_DIGEST_RECIPE } from "../evidence-text-digest.js";
import { schemaStatements, requiredHydrationColumns } from "../postgres-schema.js";
import type { PostgresStorageAdapter } from "../postgres.js";

it("maintains actual UTF8 body digests on every body or digest write without falsely declaring convert_to immutable",()=>{
  const statements=evidenceTextDigestSchemaStatements('"fixture"'),sql=statements.join("\n");
  expect(sql).toContain("NEW.text_sha256 := pg_catalog.sha256(pg_catalog.convert_to(NEW.text_content,'UTF8'))");
  expect(sql).toContain("BEFORE INSERT OR UPDATE OF text_content,text_sha256");
  expect(sql).toContain("ENABLE ALWAYS TRIGGER scce_evidence_text_sha256");
  expect(sql).not.toMatch(/IMMUTABLE|GENERATED ALWAYS|SECURITY DEFINER/u);
  expect(sql).toContain("a.atttypid<>'bytea'::regtype OR a.attgenerated<>''");
  expect(sql).toContain("Incompatible existing evidence text digest column");
  expect(sql).toContain(EVIDENCE_TEXT_DIGEST_RECIPE);
  const backfill=statements.findIndex(statement=>statement.startsWith("UPDATE"));
  expect(backfill).toBeGreaterThan(statements.findIndex(statement=>statement.includes("ENABLE ALWAYS")));
  expect(statements[backfill]).toBe('UPDATE "fixture".evidence_spans SET text_sha256=NULL WHERE text_sha256 IS NULL');
  expect(statements[backfill+1]).toContain("SET NOT NULL");
  const full=schemaStatements('"fixture"');
  expect(full.indexOf(statements[0]!)).toBeGreaterThan(full.findIndex(statement=>statement.includes("CREATE TABLE IF NOT EXISTS")&&statement.includes(".evidence_spans (")));
  expect(requiredHydrationColumns().evidence_spans).toContain("text_sha256");
});

it("trusts metadata only when the exact canonical trigger, body, column recipe and ALWAYS state are attested",async()=>{
  const calls:Array<{sql:string;params:unknown[]}>=[];
  let valid=true;
  const storage={table:(name:string)=>`"fixture"."${name}"`,query:async<T>(sql:string,params:unknown[])=>{calls.push({sql,params});return [{valid}] as T[];}} as unknown as PostgresStorageAdapter;
  await expect(assertEvidenceTextDigestMaintenance(storage)).resolves.toBeUndefined();
  expect(calls[0]!.params).toEqual(['"fixture"."evidence_spans"',EVIDENCE_TEXT_DIGEST_BODY,EVIDENCE_TEXT_DIGEST_RECIPE]);
  expect(calls[0]!.sql).toContain("t.tgenabled='A' AND t.tgtype=23");
  expect(calls[0]!.sql).toContain("p.prosrc=$2");
  expect(calls[0]!.sql).toContain("t.tgqual IS NULL AND t.tgnargs=0");
  expect(calls[0]!.sql).toContain("p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND NOT p.prosecdef");
  expect(calls[0]!.sql).not.toContain("text_content FROM");
  valid=false;
  await expect(assertEvidenceTextDigestMaintenance(storage)).rejects.toThrow(/missing or disabled/);
  storage.query=async()=>{throw new Error("catalog unavailable");};
  await expect(assertEvidenceTextDigestMaintenance(storage)).rejects.toThrow("catalog unavailable");
});
