// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { PostgresStorageAdapter } from "./postgres.js";
type OwnershipStorage = Pick<PostgresStorageAdapter, "table" | "informationAccessPredicate">;
export interface ProfileOwnershipLifecycle { lifecycle?: "current" | "historical" }

/** The same current, accessible parent evidence owns publication and every pooled-profile read. */
export function pooledProfileOwnershipSql(storage: OwnershipStorage, params: unknown[], profileId: string, sourceVersionId: string, binding: string, options: ProfileOwnershipLifecycle = {}): string {
  const access = (alias: string) => { const predicate = storage.informationAccessPredicate(alias, params.length + 1); params.push(...predicate.params); return predicate.sql; };
  const versionAccess = access("pooled_parent"), evidenceAccess = access("pooled_evidence");
  const current = options.lifecycle !== "historical";
  const newerVersionAccess = current ? access("pooled_newer") : "", newerEvidenceAccess = current ? access("pooled_newer_evidence") : "";
  const array = (field: string) => `CASE WHEN jsonb_typeof(${binding}->'${field}')='array' THEN ${binding}->'${field}' ELSE '[]'::jsonb END`;
  return `(${binding}->>'schema'='scce.pooled_language_profile_ownership.v1'
    AND ${binding}->>'profileId'=${profileId} AND ${binding}->>'sourceVersionId'=${sourceVersionId}
    AND LENGTH(${binding}->>'profileDigest')=64 AND LENGTH(${binding}->>'id')=64
    AND jsonb_array_length(${array("parents")})>0 AND jsonb_array_length(${array("evidence")})>0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${array("parents")}) declared_parent(id)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${array("evidence")}) owned(value)
        WHERE owned.value->>'sourceVersionId'=declared_parent.id))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${array("evidence")}) owned(value)
      WHERE NOT EXISTS (SELECT 1 FROM ${storage.table("source_versions")} pooled_parent
        JOIN ${storage.table("evidence_spans")} pooled_evidence ON pooled_evidence.source_version_id=pooled_parent.id
          AND pooled_evidence.source_id=pooled_parent.source_id
        WHERE pooled_parent.id=owned.value->>'sourceVersionId' AND pooled_parent.source_id=owned.value->>'sourceId'
          AND pooled_parent.id IN (SELECT jsonb_array_elements_text(${array("parents")}))
          AND pooled_evidence.id=owned.value->>'id' AND pooled_evidence.content_hash=owned.value->>'contentHash'
          AND pooled_evidence.byte_start::text=owned.value->>'byteStart' AND pooled_evidence.byte_end::text=owned.value->>'byteEnd'
          AND pooled_evidence.char_start::text=owned.value->>'charStart' AND pooled_evidence.char_end::text=owned.value->>'charEnd'
          ${current ? "AND pooled_evidence.status='promoted'" : ""} AND ${versionAccess} AND ${evidenceAccess}
          ${current ? `AND NOT EXISTS (SELECT 1 FROM ${storage.table("source_versions")} pooled_newer
            WHERE pooled_newer.source_id=pooled_parent.source_id AND (pooled_newer.observed_at,pooled_newer.id)>(pooled_parent.observed_at,pooled_parent.id)
              AND ${newerVersionAccess} AND EXISTS (SELECT 1 FROM ${storage.table("evidence_spans")} pooled_newer_evidence
                WHERE pooled_newer_evidence.source_version_id=pooled_newer.id AND pooled_newer_evidence.source_id=pooled_newer.source_id
                  AND pooled_newer_evidence.status='promoted' AND ${newerEvidenceAccess}))` : ""})) )`;
}

export function profileSourceOwnershipSql(storage: OwnershipStorage, params: unknown[], alias: string, options: ProfileOwnershipLifecycle = {}): string {
  const access = storage.informationAccessPredicate("sv", params.length + 1); params.push(...access.params);
  return `((NOT (${alias}.profile_json ? 'pooledSourceBinding') AND EXISTS (SELECT 1 FROM ${storage.table("source_versions")} sv JOIN ${storage.table("sources")} s ON s.id=sv.source_id
    WHERE sv.id=${alias}.source_version_id AND ${access.sql}))
    OR ${pooledProfileOwnershipSql(storage, params, `${alias}.id`, `${alias}.source_version_id`, `(${alias}.profile_json->'pooledSourceBinding')`, options)})`;
}
