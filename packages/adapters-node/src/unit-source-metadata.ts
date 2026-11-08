// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, toJsonValue, type Hasher, type LanguageUnitRecord, type SourceVersion } from "@scce/kernel";

export const SOURCE_METADATA_BINDING_SCHEMA = "scce.source_metadata_binding.v1";
export const UNIT_SOURCE_METADATA_REF_SCHEMA = "scce.source_metadata_ref.v1";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function sourceMetadataBoundOwner(source: SourceVersion, hasher: Hasher): SourceVersion {
  const metadata = record(source.metadata);
  if (!Object.hasOwn(metadata, "sourceMetadata")) return source;
  const binding = { schema: SOURCE_METADATA_BINDING_SCHEMA, sourceVersionId: source.sourceVersionId,
    valueHash: `sha256_${hasher.digestHex(canonicalStringify(toJsonValue(metadata.sourceMetadata)))}` };
  return { ...source, metadata: toJsonValue({ ...metadata, sourceMetadataBinding: binding }) };
}

/** Only an exact canonical owner can replace an inline value; compilation and all semantic unit data stay intact. */
export function unitSourceMetadataNormalizer(source: SourceVersion, hasher: Hasher): (unit: LanguageUnitRecord) => LanguageUnitRecord {
  const metadata = record(source.metadata), binding = record(metadata.sourceMetadataBinding);
  const sourceVersionId = source.sourceVersionId, valueHash = binding.valueHash;
  const value = canonicalStringify(toJsonValue(metadata.sourceMetadata));
  const label = canonicalStringify(toJsonValue(source.informationLabel ?? null));
  const valid = Object.hasOwn(metadata, "sourceMetadata") && binding.schema === SOURCE_METADATA_BINDING_SCHEMA
    && binding.sourceVersionId === sourceVersionId && valueHash === `sha256_${hasher.digestHex(value)}`;
  const inlineBytes = Buffer.byteLength(canonicalStringify(toJsonValue({ sourceMetadata: metadata.sourceMetadata })));
  return unit => {
    const row = record(unit.metadata), compilationId = row.sourceCompilationId;
    if (!valid || unit.sourceVersionId !== sourceVersionId || typeof compilationId !== "string" || !compilationId
      || canonicalStringify(toJsonValue(unit.informationLabel ?? null)) !== label || !Object.hasOwn(row, "sourceMetadata")
      || canonicalStringify(toJsonValue(row.sourceMetadata)) !== value) return unit;
    const reference = { schema: UNIT_SOURCE_METADATA_REF_SCHEMA, sourceVersionId,
      valueHash, sourceCompilationId: compilationId };
    if (Buffer.byteLength(canonicalStringify(toJsonValue({ sourceMetadataRef: reference }))) >= inlineBytes) return unit;
    const { sourceMetadata: _inline, ...retained } = row;
    return { ...unit, metadata: toJsonValue({ ...retained, sourceMetadataRef: reference }) };
  };
}

export function languageUnitMetadataMergeSql(sourceVersionsTable: string): string {
  return `CASE WHEN lu.metadata_json ? 'sourceMetadata' AND NOT (EXCLUDED.metadata_json ? 'sourceMetadata')
    AND lu.source_version_id=EXCLUDED.source_version_id AND lu.information_label=EXCLUDED.information_label
    AND EXCLUDED.metadata_json->'sourceMetadataRef'->>'schema'='${UNIT_SOURCE_METADATA_REF_SCHEMA}'
    AND EXCLUDED.metadata_json->'sourceMetadataRef'->>'sourceVersionId'=EXCLUDED.source_version_id
    AND NULLIF(EXCLUDED.metadata_json->>'sourceCompilationId','') IS NOT NULL
    AND lu.metadata_json->>'sourceCompilationId'=EXCLUDED.metadata_json->>'sourceCompilationId'
    AND EXCLUDED.metadata_json->'sourceMetadataRef'->>'sourceCompilationId'=EXCLUDED.metadata_json->>'sourceCompilationId'
    AND EXISTS (SELECT 1 FROM ${sourceVersionsTable} canonical WHERE canonical.id=EXCLUDED.source_version_id
      AND canonical.information_label=EXCLUDED.information_label
      AND canonical.metadata_json->'sourceMetadata'=lu.metadata_json->'sourceMetadata'
      AND canonical.metadata_json->'sourceMetadataBinding'->>'schema'='${SOURCE_METADATA_BINDING_SCHEMA}'
      AND canonical.metadata_json->'sourceMetadataBinding'->>'sourceVersionId'=canonical.id
      AND canonical.metadata_json->'sourceMetadataBinding'->>'valueHash'=EXCLUDED.metadata_json->'sourceMetadataRef'->>'valueHash')
    THEN (lu.metadata_json-'sourceMetadata') || EXCLUDED.metadata_json ELSE lu.metadata_json || EXCLUDED.metadata_json END`;
}
