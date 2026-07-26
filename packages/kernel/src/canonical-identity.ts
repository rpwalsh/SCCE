import {
  canonicalNormalizationContract,
  type NormalizationContract
} from "./normalization-contract.js";
import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export const CANONICAL_IDENTITY_SCHEMA = "scce.canonical_identity.v1" as const;

export const CANONICAL_IDENTITY_FIELDS = {
  source: ["namespace", "canonicalUri"],
  document: ["sourceVersionId", "contentHash", "logicalPath"],
  evidence_span: ["sourceVersionId", "byteStart", "byteEnd", "contentHash"],
  surface_occurrence: ["evidenceId", "byteStart", "byteEnd", "exactSurfaceHash"],
  normalized_surface_form: ["normalizationContractId", "normalizedSurface"],
  mention: ["surfaceOccurrenceId", "mentionKind"],
  canonical_entity: ["authorityNamespace", "authorityKey"],
  unresolved_entity: ["mentionIds", "evidenceIds"],
  relation_hypothesis: ["relationSeedId", "participantIncidences", "qualifierHash", "temporalHash", "evidenceIds"],
  admitted_relation: ["relationHypothesisId", "admissionModelId", "admissionSnapshotId"],
  construction: ["profileId", "roleSignature", "sourceExampleIds"],
  model_snapshot: ["corpusManifestId", "codeCommit", "normalizationContractId", "configurationHash", "randomSeed", "componentIds"]
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
