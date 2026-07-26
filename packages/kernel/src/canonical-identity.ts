import {
  canonicalNormalizationContract,
  type NormalizationContract
} from "./normalization-contract.js";
import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export const CANONICAL_IDENTITY_SCHEMA = "scce.canonical_identity.v2" as const;

export const CANONICAL_IDENTITY_FIELDS = {
  source: ["namespace", "canonicalUri"],
  document: ["sourceVersionId", "contentHash", "logicalPath"],
  evidence_span: ["sourceVersionId", "byteStart", "byteEnd", "contentHash"],
  surface_occurrence: ["sourceVersionId", "documentId", "byteStart", "byteEnd", "exactSurfaceHash"],
  normalized_surface_form: ["normalizationContractId", "normalizedSurface"],
  surface_form_class: ["normalizationContractId", "normalizedSurfaceFormId", "unicodeScriptId"],
  mention: ["surfaceOccurrenceId", "mentionKind"],
  canonical_entity: ["authorityNamespace", "authorityKey"],
  unresolved_entity: ["mentionIds", "evidenceIds"],
  relation_hypothesis: ["relationSeedId", "participantIncidences", "qualifierHash", "temporalHash", "evidenceIds"],
  admitted_relation: ["relationHypothesisId", "admissionModelId", "admissionSnapshotId"],
  construction: ["profileId", "roleSignature", "sourceExampleIds"],
  model_snapshot: ["corpusManifestId", "codeCommit", "normalizationContractId", "configurationHash", "randomSeed", "componentIds"],
  alignment_target_index: ["typedIncidenceGraphId", "normalizationContractId", "maxTargetsPerPosting", "targetIds"]
} as const;

export type CanonicalIdentityKind = keyof typeof CANONICAL_IDENTITY_FIELDS;

export interface CanonicalIdentity {
  schema: typeof CANONICAL_IDENTITY_SCHEMA;
  kind: CanonicalIdentityKind;
  id: string;
  normalizationContractId: string;
  fields: JsonValue;
}

export function createCanonicalIdentity(input: {
  kind: CanonicalIdentityKind;
  fields: JsonValue;
  normalizationContract?: NormalizationContract;
  hasher?: Hasher;
}): CanonicalIdentity {
  const hasher = input.hasher ?? createHasher();
  const normalizationContract = input.normalizationContract ?? canonicalNormalizationContract(hasher);
  const fields = canonicalIdentityFields(input.kind, input.fields, normalizationContract);
  const canonical = {
    schema: CANONICAL_IDENTITY_SCHEMA,
    kind: input.kind,
    normalizationContractId: normalizationContract.id,
    fields
  };
  return {
    ...canonical,
    id: `${input.kind}.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 48)}`
  };
}

export interface CanonicalIdentityAuditRecord {
  identity: CanonicalIdentity;
  recordId?: string;
}

export interface CanonicalIdentityAudit {
  valid: boolean;
  checked: number;
  issues: string[];
}

/**
 * Release/build boundary audit. Production snapshots must retain the complete
 * canonical identity material; a string with a familiar prefix is not enough.
 */
export function auditCanonicalIdentities(
  records: readonly CanonicalIdentityAuditRecord[],
  hasher: Hasher = createHasher()
): CanonicalIdentityAudit {
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (const record of records) {
    const identity = record.identity;
    let rebuilt: CanonicalIdentity;
    try {
      rebuilt = createCanonicalIdentity({
        kind: identity.kind,
        fields: identity.fields,
        normalizationContract: canonicalNormalizationContract(hasher),
        hasher
      });
    } catch (error) {
      issues.push(`${record.recordId ?? identity.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (rebuilt.schema !== identity.schema || rebuilt.id !== identity.id) {
      issues.push(`${record.recordId ?? identity.id}: identity does not match canonical material`);
      continue;
    }
    const bytes = canonicalStringify(identity);
    const prior = seen.get(identity.id);
    if (prior !== undefined && prior !== bytes) {
      issues.push(`${identity.id}: conflicting duplicate canonical identity`);
    } else {
      seen.set(identity.id, bytes);
    }
  }
  return { valid: issues.length === 0, checked: records.length, issues };
}

export function assertCanonicalIdentityAudit(
  records: readonly CanonicalIdentityAuditRecord[],
  hasher: Hasher = createHasher()
): void {
  const audit = auditCanonicalIdentities(records, hasher);
  if (!audit.valid) throw new Error(`canonical identity audit failed: ${audit.issues.join("; ")}`);
}

function canonicalIdentityFields(
  kind: CanonicalIdentityKind,
  raw: JsonValue,
  normalizationContract: NormalizationContract
): JsonValue {
  const value = record(raw);
  const required = CANONICAL_IDENTITY_FIELDS[kind];
  const fields: Record<string, JsonValue> = {};
  for (const key of required) {
    if (!(key in value) && key === "normalizationContractId") {
      fields[key] = normalizationContract.id;
      continue;
    }
    if (!(key in value)) throw new Error(`${kind} identity requires ${key}`);
    fields[key] = normalizeIdentityValue(value[key]!, normalizationContract);
  }
  if (kind === "source") {
    fields.namespace = String(fields.namespace).trim();
    fields.canonicalUri = String(fields.canonicalUri).trim().replace(/\\/gu, "/");
  }
  return fields;
}

function normalizeIdentityValue(
  value: JsonValue,
  normalizationContract: NormalizationContract
): JsonValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(item => normalizeIdentityValue(item, normalizationContract)).sort(compareJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeIdentityValue(child, normalizationContract)]));
  }
  return value;
}

function record(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("canonical identity fields must be an object");
  }
  return value;
}

function compareJson(left: JsonValue, right: JsonValue): number {
  return canonicalStringify(left).localeCompare(canonicalStringify(right));
}
