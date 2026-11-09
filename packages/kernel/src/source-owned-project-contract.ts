// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import { createCanonicalIdentity } from "./canonical-identity.js";
import { CORPUS_SOURCE_SYSTEM_IDS } from "./corpus-registry.js";
export const SOURCE_OWNED_PROJECT_PROJECTION_PREFIX = "scce.source_owned_project_contract_projection.v1:";
export const SOURCE_OWNED_PROJECT_CONTRACT_CLOSURE_SCHEMA = "scce.source_owned_project_contract_closure.v1";
export interface SourceOwnedProjectContractClosure {
  readonly schema: typeof SOURCE_OWNED_PROJECT_CONTRACT_CLOSURE_SCHEMA;
  readonly recipe: string; readonly digest: string; readonly testPath: string; readonly testSourceId: string; readonly testSourceVersionId: string;readonly testHash:string;
  readonly configPath: string; readonly configHash: string; readonly compilerVersion: string; readonly rootCheckpointId: string; readonly snapshotCheckpointId: string; readonly snapshotHash: string;readonly scopeIdentity:string;
}
export function isSourceOwnedProjectProjection(recipe: string): boolean { return recipe.startsWith(SOURCE_OWNED_PROJECT_PROJECTION_PREFIX) && /^[a-f0-9]{64}$/u.test(recipe.slice(SOURCE_OWNED_PROJECT_PROJECTION_PREFIX.length)); }
export function ownedProjectContractClosure(value: unknown, family: string, componentRecipe: unknown): SourceOwnedProjectContractClosure | undefined {
  if(!value||typeof value!=="object"||Array.isArray(value))return undefined;
  const row=value as Record<string,unknown>,hash=createHasher();
  if(row.schema!==SOURCE_OWNED_PROJECT_CONTRACT_CLOSURE_SCHEMA||typeof row.recipe!=="string"||!row.recipe.startsWith("scce.oss_owned_project_closure.v1:")
    ||typeof row.digest!=="string"||!/^[a-f0-9]{64}$/u.test(row.digest)||typeof row.snapshotHash!=="string"||!row.snapshotHash||typeof row.scopeIdentity!=="string"||!/^[a-f0-9]{64}$/u.test(row.scopeIdentity)
    ||typeof row.testHash!=="string"||!/^(?:sha256[:_])?[a-f0-9]{64}$/u.test(row.testHash)
    ||typeof row.configHash!=="string"||!/^(?:sha256[:_])?[a-f0-9]{64}$/u.test(row.configHash)||typeof row.compilerVersion!=="string"||!row.compilerVersion
    ||typeof row.testSourceId!=="string"||typeof row.testSourceVersionId!=="string"||!/^source_version_[a-f0-9]{56}$/u.test(row.testSourceVersionId)||!relative(row.testPath)||!relative(row.configPath))return undefined;
  const sourceId=createCanonicalIdentity({kind:"source",fields:{namespace:`corpus:${CORPUS_SOURCE_SYSTEM_IDS.ossCode}`,canonicalUri:`${family}#path=${encodeURIComponent(row.testPath)}`}}).id;
  if(row.testSourceId!==sourceId||componentRecipe!==`${SOURCE_OWNED_PROJECT_PROJECTION_PREFIX}${hash.digestHex(sourceId)}`
    ||row.rootCheckpointId!==`oss.contract.root.${hash.digestHex(canonicalStringify([family,row.testPath]))}`||row.snapshotCheckpointId!==`oss.contract.snapshot.${hash.digestHex(family)}`)return undefined;
  return row as unknown as SourceOwnedProjectContractClosure;
}
function relative(value: unknown): value is string {return typeof value==="string"&&!!value&&!value.includes("\\")&&!value.includes("\u0000")&&!value.startsWith("/")&&!/^[A-Za-z]:/u.test(value)&&value.split("/").every(part=>part!==""&&part!=="."&&part!=="..");}
