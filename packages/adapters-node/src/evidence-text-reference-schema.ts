// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { PostgresStorageAdapter } from "./postgres.js";

/** Evidence text is the content-addressed range of its authorized canonical source; no second body or digest is retained. */
export const EVIDENCE_TEXT_REFERENCE_RECIPE = "scce.evidence_text_reference.v2";
export const EVIDENCE_TEXT_REFERENCE_CONSTRAINT = "scce_evidence_text_reference";

export function evidenceTextReferenceSchemaStatements(q: string): string[] {
  return [
    // A pre-normalization table may still contain the old body and/or duplicate digest. Prove that each agrees
    // with content_hash before dropping either column; a disagreement aborts the schema transaction.
    `DO $scce_evidence_reference_verify$ DECLARE invalid boolean := false; BEGIN
      IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='${q}.evidence_spans'::regclass AND attname='text_content' AND NOT attisdropped) THEN
        EXECUTE 'SELECT EXISTS(SELECT 1 FROM ${q}.evidence_spans
          WHERE content_hash<>''sha256_'' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(text_content,''UTF8'')),''hex''))'
          INTO invalid;
        IF invalid THEN RAISE EXCEPTION 'Evidence text body differs from its canonical content identity'; END IF;
      END IF;
      IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='${q}.evidence_spans'::regclass AND attname='text_sha256' AND NOT attisdropped) THEN
        EXECUTE 'SELECT EXISTS(SELECT 1 FROM ${q}.evidence_spans
          WHERE text_sha256 IS NULL OR pg_catalog.octet_length(text_sha256)<>32
             OR content_hash<>''sha256_'' || pg_catalog.encode(text_sha256,''hex''))'
          INTO invalid;
        IF invalid THEN RAISE EXCEPTION 'Evidence text digest differs from its canonical content identity'; END IF;
      END IF;
    END $scce_evidence_reference_verify$`,
    `DROP TRIGGER IF EXISTS scce_evidence_text_sha256 ON ${q}.evidence_spans`,
    `DROP FUNCTION IF EXISTS ${q}.scce_sync_evidence_text_sha256()`,
    `ALTER TABLE ${q}.evidence_spans DROP COLUMN IF EXISTS text_content`,
    `ALTER TABLE ${q}.evidence_spans DROP COLUMN IF EXISTS text_sha256`,
    `DO $scce_evidence_reference_constraint$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='${q}.evidence_spans'::regclass
        AND conname='${EVIDENCE_TEXT_REFERENCE_CONSTRAINT}')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid='${q}.evidence_spans'::regclass
          AND k.conname='${EVIDENCE_TEXT_REFERENCE_CONSTRAINT}' AND k.contype='c' AND k.convalidated
          AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%content_hash ~%sha256_%'
          AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%byte_end >= byte_start%'
          AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%char_end >= char_start%') THEN
        RAISE EXCEPTION 'Incompatible existing evidence text reference constraint';
      ELSIF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='${q}.evidence_spans'::regclass
        AND conname='${EVIDENCE_TEXT_REFERENCE_CONSTRAINT}') THEN
        ALTER TABLE ${q}.evidence_spans ADD CONSTRAINT ${EVIDENCE_TEXT_REFERENCE_CONSTRAINT}
          CHECK (content_hash ~ '^sha256_[0-9a-f]{64}$' AND byte_start>=0 AND byte_end>=byte_start
            AND char_start>=0 AND char_end>=char_start);
      END IF;
    END $scce_evidence_reference_constraint$`,
    `COMMENT ON CONSTRAINT ${EVIDENCE_TEXT_REFERENCE_CONSTRAINT} ON ${q}.evidence_spans
      IS '${EVIDENCE_TEXT_REFERENCE_RECIPE}'`
  ];
}

/** Refuse compilation against a table retaining either duplicate body or duplicate digest. */
export async function assertEvidenceTextReferenceMaintenance(storage: PostgresStorageAdapter): Promise<void> {
  const rows = await storage.query<{ valid: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid AND k.conname=$2 AND k.convalidated
    WHERE c.oid=$1::regclass AND k.contype='c'
      AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%content_hash ~%sha256_%'
      AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%byte_end >= byte_start%'
      AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%char_end >= char_start%'
      AND pg_catalog.obj_description(k.oid,'pg_constraint')=$3
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute body
        WHERE body.attrelid=c.oid AND body.attname IN ('text_content','text_sha256') AND NOT body.attisdropped)
  ) AS valid`, [storage.table("evidence_spans"), EVIDENCE_TEXT_REFERENCE_CONSTRAINT, EVIDENCE_TEXT_REFERENCE_RECIPE]);
  if (rows[0]?.valid !== true) {
    throw new Error("Canonical evidence text reference storage is incomplete; migrate before corpus segmentation");
  }
}
