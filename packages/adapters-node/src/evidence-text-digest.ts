// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { PostgresStorageAdapter } from "./postgres.js";
export const EVIDENCE_TEXT_DIGEST_RECIPE="scce.evidence_text_sha256.v1";
export const EVIDENCE_TEXT_DIGEST_BODY=`BEGIN
  NEW.text_sha256 := pg_catalog.sha256(pg_catalog.convert_to(NEW.text_content,'UTF8'));
  RETURN NEW;
END;`;
/** convert_to is STABLE in PG16, so this uses an honest trigger rather than declaring a fake immutable wrapper. */
export function evidenceTextDigestSchemaStatements(q:string):string[]{return [
  `DO $scce_evidence_digest_column$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='${q}.evidence_spans'::regclass AND attname='text_sha256' AND NOT attisdropped) THEN
      IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='${q}.evidence_spans'::regclass AND a.attname='text_sha256' AND NOT a.attisdropped
        AND (a.atttypid<>'bytea'::regtype OR a.attgenerated<>'' OR pg_catalog.col_description(a.attrelid,a.attnum) IS DISTINCT FROM '${EVIDENCE_TEXT_DIGEST_RECIPE}')) THEN
        RAISE EXCEPTION 'Incompatible existing evidence text digest column';
      END IF;
    ELSE
      ALTER TABLE ${q}.evidence_spans ADD COLUMN text_sha256 BYTEA;
      COMMENT ON COLUMN ${q}.evidence_spans.text_sha256 IS '${EVIDENCE_TEXT_DIGEST_RECIPE}';
    END IF;
  END $scce_evidence_digest_column$`,
  `CREATE OR REPLACE FUNCTION ${q}.scce_sync_evidence_text_sha256() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $scce_evidence_digest_function$${EVIDENCE_TEXT_DIGEST_BODY}$scce_evidence_digest_function$`,
  `DROP TRIGGER IF EXISTS scce_evidence_text_sha256 ON ${q}.evidence_spans`,
  `CREATE TRIGGER scce_evidence_text_sha256 BEFORE INSERT OR UPDATE OF text_content,text_sha256 ON ${q}.evidence_spans FOR EACH ROW EXECUTE FUNCTION ${q}.scce_sync_evidence_text_sha256()`,
  `ALTER TABLE ${q}.evidence_spans ENABLE ALWAYS TRIGGER scce_evidence_text_sha256`,
  // The trigger computes the actual value once; a disabled trigger cannot let NULL pass the final constraint.
  `UPDATE ${q}.evidence_spans SET text_sha256=NULL WHERE text_sha256 IS NULL`,
  `ALTER TABLE ${q}.evidence_spans ALTER COLUMN text_sha256 SET NOT NULL`
];}
/** Metadata may be trusted only while the exact canonical write-maintenance mechanism is installed and enabled. */
export async function assertEvidenceTextDigestMaintenance(storage:PostgresStorageAdapter):Promise<void>{
  const rows=await storage.query<{valid:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='text_sha256' AND NOT a.attisdropped
      JOIN pg_catalog.pg_attribute body ON body.attrelid=c.oid AND body.attname='text_content' AND NOT body.attisdropped
    WHERE t.tgrelid=$1::regclass AND t.tgname='scce_evidence_text_sha256' AND NOT t.tgisinternal
      AND t.tgenabled='A' AND t.tgtype=23 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text=body.attnum::text || ' ' || a.attnum::text
      AND p.pronamespace=c.relnamespace AND p.proname='scce_sync_evidence_text_sha256' AND p.prosrc=$2
      AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND NOT p.prosecdef
      AND a.atttypid='bytea'::regtype AND a.attgenerated='' AND a.attnotnull
      AND pg_catalog.col_description(c.oid,a.attnum)=$3) AS valid`,[storage.table("evidence_spans"),EVIDENCE_TEXT_DIGEST_BODY,EVIDENCE_TEXT_DIGEST_RECIPE]);
  if(rows[0]?.valid!==true)throw new Error("Canonical evidence text digest maintenance is missing or disabled; migrate schema32 before corpus segmentation");
}
