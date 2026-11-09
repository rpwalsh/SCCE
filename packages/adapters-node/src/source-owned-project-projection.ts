// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export { SOURCE_OWNED_PROJECT_PROJECTION_PREFIX, isSourceOwnedProjectProjection } from "@scce/kernel";
export function projectContractDependencyEligibilitySql(storage: {
  table(name: string): string;
  informationAccessPredicate(alias: string, offset: number): { sql: string; params: unknown[] };
}, params: unknown[], allowPendingRoot = false): string {
  const access = (alias: string) => { const predicate = storage.informationAccessPredicate(alias, params.length + 1); params.push(...predicate.params); return predicate.sql; };
  const profileAccess = access("project_profile"), sourceAccess = access("project_source"), dependencyAccess = access("project_dependency"), originalAccess = access("project_original"), evidenceAccess = access("project_evidence");
  return `EXISTS (SELECT 1 FROM ${storage.table("language_profiles")} project_profile JOIN ${storage.table("source_versions")} project_source ON project_source.id=project_profile.source_version_id
    WHERE project_profile.id=active_projection.value_json->>'profileId' AND project_source.id=active_projection.value_json->>'sourceVersionId'
      AND project_source.source_id=active_projection.value_json->>'sourceId' AND ${profileAccess} AND ${sourceAccess})
    AND EXISTS (SELECT 1 FROM ${storage.table("ingestion_checkpoints")} project_root
      JOIN ${storage.table("ingestion_checkpoints")} project_snapshot ON project_snapshot.id=project_root.metadata_json->>'snapshotCheckpointId'
      WHERE project_root.id=active_projection.value_json->'sourceContractRoot'->>'checkpointId'
        AND (${allowPendingRoot ? "(project_root.status='pending' AND project_root.phase='extracting') OR " : ""}(project_root.status='complete' AND project_root.phase='stored'))
        AND project_root.metadata_json->>'schema'='scce.oss_owned_contract_root.v1'
        AND project_root.metadata_json->>'inputDigest'=active_projection.value_json->'sourceContractRoot'->>'inputDigest'
        AND project_root.metadata_json->>'sourceId'=active_projection.value_json->'sourceContractRoot'->>'sourceId'
        AND project_root.metadata_json->>'sourceVersionId'=active_projection.value_json->'sourceContractRoot'->>'sourceVersionId'
        AND project_root.metadata_json->>'componentRecipe'=active_projection.value_json->>'componentRecipe'
        AND project_root.metadata_json->>'snapshotCheckpointId'=active_projection.value_json->'sourceContractRoot'->>'snapshotCheckpointId'
        AND project_root.metadata_json->>'snapshotHash'=active_projection.value_json->'sourceContractRoot'->>'snapshotHash'
        AND project_root.metadata_json->>'scopeIdentity'=active_projection.value_json->'sourceContractRoot'->>'scopeIdentity'
        AND project_root.metadata_json->'informationLabel'=active_projection.value_json->'informationLabel'
        AND project_snapshot.id=active_projection.value_json->'sourceContractRoot'->>'snapshotCheckpointId'
        AND project_snapshot.status='complete' AND project_snapshot.phase='stored'
        AND project_snapshot.metadata_json->>'schema'='scce.oss_owned_contract_snapshot.v1'
        AND project_snapshot.metadata_json->>'snapshotHash'=active_projection.value_json->'sourceContractRoot'->>'snapshotHash'
        AND project_snapshot.metadata_json->>'identity'=active_projection.value_json->'sourceContractRoot'->>'scopeIdentity'
        AND project_snapshot.metadata_json->>'recipe'=project_root.metadata_json->>'closureRecipe'
        AND project_snapshot.metadata_json->'informationLabel'=active_projection.value_json->'informationLabel')
    AND jsonb_typeof(active_projection.value_json->'sourceDependencies')='array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(active_projection.value_json->'sourceDependencies')='array' THEN active_projection.value_json->'sourceDependencies' ELSE '[]'::jsonb END)>0
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(active_projection.value_json->'sourceDependencies')='array' THEN active_projection.value_json->'sourceDependencies' ELSE '[]'::jsonb END) root_dependency(value)
      WHERE root_dependency.value->>'sourceId'=active_projection.value_json->'sourceContractRoot'->>'sourceId'
        AND root_dependency.value->>'sourceVersionId'=active_projection.value_json->'sourceContractRoot'->>'sourceVersionId')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(active_projection.value_json->'sourceDependencies')='array' THEN active_projection.value_json->'sourceDependencies' ELSE '[]'::jsonb END) dependency(value)
      LEFT JOIN ${storage.table("source_versions")} project_dependency ON project_dependency.id=dependency.value->>'sourceVersionId'
        AND project_dependency.source_id=dependency.value->>'sourceId' AND project_dependency.content_hash=dependency.value->>'contentHash'
        AND project_dependency.metadata_json->'_scceSourceVersion'->>'role'='evidence-derivative'
        AND project_dependency.metadata_json->'_scceSourceVersion'->'derivation'->>'derivedFromSourceVersionId'=dependency.value->>'originalSourceVersionId' AND project_dependency.information_label=active_projection.value_json->'informationLabel' AND ${dependencyAccess}
      LEFT JOIN ${storage.table("source_versions")} project_original ON project_original.id=dependency.value->>'originalSourceVersionId'
        AND project_original.source_id=dependency.value->>'sourceId' AND project_original.content_hash=dependency.value->>'originalContentHash'
        AND project_original.metadata_json->'_scceSourceVersion'->>'role'='original' AND project_original.information_label=active_projection.value_json->'informationLabel' AND ${originalAccess}
      WHERE project_dependency.id IS NULL OR project_original.id IS NULL
        OR jsonb_typeof(dependency.value->'evidenceIds') IS DISTINCT FROM 'array' OR jsonb_array_length(CASE WHEN jsonb_typeof(dependency.value->'evidenceIds')='array' THEN dependency.value->'evidenceIds' ELSE '[]'::jsonb END)=0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(dependency.value->'evidenceIds')='array' THEN dependency.value->'evidenceIds' ELSE '[]'::jsonb END) requested(id)
          LEFT JOIN ${storage.table("evidence_spans")} project_evidence ON project_evidence.id=requested.id
            AND project_evidence.source_version_id=project_dependency.id AND project_evidence.source_id=project_dependency.source_id
            AND project_evidence.status='promoted' AND project_evidence.information_label=active_projection.value_json->'informationLabel' AND ${evidenceAccess} WHERE project_evidence.id IS NULL))`;
}
