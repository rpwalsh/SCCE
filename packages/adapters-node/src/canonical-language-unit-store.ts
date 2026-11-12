// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * Physical language-unit storage is normalized without changing the logical
 * LanguageUnitRecord shape. Evidence populations and information labels are
 * immutable values shared by reference; language_unit_values reconstructs the
 * former inline row for every reader.
 */
export const LANGUAGE_UNIT_VALUES_RELATION = "language_unit_values";
export const LANGUAGE_UNIT_EVIDENCE_SET_RELATION = "language_unit_evidence_sets";
export const LANGUAGE_UNIT_INFORMATION_LABEL_RELATION = "language_unit_information_labels";

export function canonicalLanguageUnitSchemaStatements(q: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION} (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,evidence_ids TEXT[] NOT NULL,UNIQUE(evidence_ids))`,
    `CREATE TABLE IF NOT EXISTS ${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION} (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,information_label JSONB NOT NULL,UNIQUE(information_label))`,
    `ALTER TABLE ${q}.language_units ADD COLUMN IF NOT EXISTS evidence_set_id BIGINT`,
    `ALTER TABLE ${q}.language_units ADD COLUMN IF NOT EXISTS information_label_id BIGINT`,
    `DO $scce_language_unit_normalization$
    DECLARE
      target_table regclass := '${q}.language_units'::regclass;
      has_inline_evidence boolean;
      has_inline_label boolean;
    BEGIN
      SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=target_table AND attname='evidence_ids' AND NOT attisdropped),
             EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=target_table AND attname='information_label' AND NOT attisdropped)
        INTO has_inline_evidence,has_inline_label;
      IF has_inline_evidence IS DISTINCT FROM has_inline_label THEN
        RAISE EXCEPTION 'Incomplete language-unit normalization source columns';
      END IF;
      IF has_inline_evidence THEN
        INSERT INTO ${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION}(evidence_ids)
          SELECT DISTINCT evidence_ids FROM ${q}.language_units ON CONFLICT(evidence_ids) DO NOTHING;
        INSERT INTO ${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION}(information_label)
          SELECT DISTINCT information_label FROM ${q}.language_units ON CONFLICT(information_label) DO NOTHING;
        UPDATE ${q}.language_units unit
          SET evidence_set_id=evidence_set.id,information_label_id=label.id
          FROM ${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION} evidence_set,
               ${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION} label
          WHERE evidence_set.evidence_ids=unit.evidence_ids
            AND label.information_label=unit.information_label
            AND (unit.evidence_set_id IS DISTINCT FROM evidence_set.id OR unit.information_label_id IS DISTINCT FROM label.id);
        IF EXISTS(
          SELECT 1 FROM ${q}.language_units unit
          LEFT JOIN ${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION} evidence_set ON evidence_set.id=unit.evidence_set_id
          LEFT JOIN ${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION} label ON label.id=unit.information_label_id
          WHERE evidence_set.evidence_ids IS DISTINCT FROM unit.evidence_ids
             OR label.information_label IS DISTINCT FROM unit.information_label
        ) THEN
          RAISE EXCEPTION 'Language-unit normalization changed a logical row';
        END IF;
        ALTER TABLE ${q}.language_units DROP COLUMN evidence_ids;
        ALTER TABLE ${q}.language_units DROP COLUMN information_label;
      END IF;
      IF EXISTS(SELECT 1 FROM ${q}.language_units WHERE evidence_set_id IS NULL OR information_label_id IS NULL) THEN
        RAISE EXCEPTION 'Language-unit normalization left an unresolved reference';
      END IF;
      ALTER TABLE ${q}.language_units ALTER COLUMN evidence_set_id SET NOT NULL;
      ALTER TABLE ${q}.language_units ALTER COLUMN information_label_id SET NOT NULL;
      IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=target_table AND conname='scce_language_units_evidence_set_fk') THEN
        ALTER TABLE ${q}.language_units ADD CONSTRAINT scce_language_units_evidence_set_fk
          FOREIGN KEY(evidence_set_id) REFERENCES ${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION}(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=target_table AND conname='scce_language_units_information_label_fk') THEN
        ALTER TABLE ${q}.language_units ADD CONSTRAINT scce_language_units_information_label_fk
          FOREIGN KEY(information_label_id) REFERENCES ${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION}(id) ON DELETE RESTRICT;
      END IF;
    END
    $scce_language_unit_normalization$`,
    `CREATE OR REPLACE VIEW ${q}.${LANGUAGE_UNIT_VALUES_RELATION} AS
      SELECT unit.id,unit.profile_id,unit.source_version_id,unit.script,unit.unit_kind,unit.unit_text,
             unit.features,unit.competence_vector,unit.alpha,evidence_set.evidence_ids,unit.metadata_json,label.information_label
      FROM ${q}.language_units unit
      JOIN ${q}.${LANGUAGE_UNIT_EVIDENCE_SET_RELATION} evidence_set ON evidence_set.id=unit.evidence_set_id
      JOIN ${q}.${LANGUAGE_UNIT_INFORMATION_LABEL_RELATION} label ON label.id=unit.information_label_id`
  ];
}
