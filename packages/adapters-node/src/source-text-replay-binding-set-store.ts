// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  SOURCE_TEXT_REPLAY_BINDING_SET_SCHEMA,
  sourceTextReplayBindingSetDigest,
  sourceTextReplayBindingSetId,
  validateSourceTextReplayBindingSet,
  type Hasher,
  type InformationLabel,
  type JsonValue,
  type SourceTextReplayBindingSet,
  type SourceTextReplayBindingSetDocument
} from "@scce/kernel";

export const SOURCE_TEXT_REPLAY_BINDING_SET_RELATION = "source_text_replay_binding_sets" as const;
export const SOURCE_TEXT_REPLAY_BINDING_SET_PAYLOAD_SCHEMA = "scce.source_text_replay_binding_set_payload.v1" as const;

export interface SourceTextReplayBindingSetPayload {
  schema: typeof SOURCE_TEXT_REPLAY_BINDING_SET_PAYLOAD_SCHEMA;
  documents: SourceTextReplayBindingSetDocument[];
  expectedDocumentsDigest: string;
}

export interface SourceTextReplayBindingSetPhysicalRow {
  id: string;
  modelId: string;
  profileId: string;
  manifestPatternId: string;
  manifestDigest: string;
  bindingJson: SourceTextReplayBindingSetPayload;
  bindingDigest: string;
  informationLabel: InformationLabel;
  createdAt: number;
}

export function sourceTextReplayBindingSetSchemaStatements(q: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${q}.${SOURCE_TEXT_REPLAY_BINDING_SET_RELATION} (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      profile_id TEXT NOT NULL REFERENCES ${q}.language_profiles(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      manifest_pattern_id TEXT NOT NULL REFERENCES ${q}.language_patterns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
      binding_json JSONB NOT NULL CHECK (
        jsonb_typeof(binding_json)='object'
        AND binding_json->>'schema'='${SOURCE_TEXT_REPLAY_BINDING_SET_PAYLOAD_SCHEMA}'
        AND jsonb_typeof(binding_json->'documents')='array'
        AND binding_json->>'expectedDocumentsDigest' ~ '^[a-f0-9]{64}$'
        AND binding_json - 'schema' - 'documents' - 'expectedDocumentsDigest'='{}'::jsonb
      ),
      binding_digest TEXT NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
      information_label JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT scce_source_text_replay_binding_set_id CHECK (id='source_text_replay_bindings_' || binding_digest),
      CONSTRAINT scce_source_text_replay_binding_set_scope_unique UNIQUE(model_id,profile_id,manifest_pattern_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${q.replace(/[^A-Za-z0-9_]/gu, "")}_source_text_replay_binding_scope
      ON ${q}.${SOURCE_TEXT_REPLAY_BINDING_SET_RELATION}(model_id,profile_id)`
  ];
}

export function encodeSourceTextReplayBindingSetRow(input: {
  bindingSet: SourceTextReplayBindingSet;
  informationLabel: InformationLabel;
  createdAt: number;
  hasher: Hasher;
}): SourceTextReplayBindingSetPhysicalRow {
  const bindingSet = validateSourceTextReplayBindingSet(input.bindingSet);
  if (!Number.isFinite(input.createdAt)) throw new Error("invalid source replay binding-set creation time");
  const bindingDigest = sourceTextReplayBindingSetDigest(bindingSet, input.hasher);
  return {
    id: sourceTextReplayBindingSetId(bindingSet, input.hasher),
    modelId: bindingSet.modelId,
    profileId: bindingSet.profileId,
    manifestPatternId: bindingSet.manifestPatternId,
    manifestDigest: bindingSet.manifestDigest,
    bindingJson: { schema: SOURCE_TEXT_REPLAY_BINDING_SET_PAYLOAD_SCHEMA,
      documents: structuredClone(bindingSet.documents), expectedDocumentsDigest: bindingSet.expectedDocumentsDigest },
    bindingDigest,
    informationLabel: structuredClone(input.informationLabel),
    createdAt: input.createdAt
  };
}

export function decodeSourceTextReplayBindingSetRow(row: SourceTextReplayBindingSetPhysicalRow, hasher: Hasher): SourceTextReplayBindingSet {
  const payload = row.bindingJson as unknown as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).sort().join(",") !== "documents,expectedDocumentsDigest,schema"
    || payload.schema !== SOURCE_TEXT_REPLAY_BINDING_SET_PAYLOAD_SCHEMA) throw new Error("invalid source replay binding-set payload");
  const value = validateSourceTextReplayBindingSet({
    schema: SOURCE_TEXT_REPLAY_BINDING_SET_SCHEMA,
    modelId: row.modelId,
    profileId: row.profileId,
    manifestPatternId: row.manifestPatternId,
    manifestDigest: row.manifestDigest,
    documents: payload.documents,
    expectedDocumentsDigest: payload.expectedDocumentsDigest
  });
  const digest = sourceTextReplayBindingSetDigest(value, hasher);
  if (row.bindingDigest !== digest || row.id !== sourceTextReplayBindingSetId(value, hasher)) {
    throw new Error("source replay binding-set content identity changed");
  }
  return value;
}

/** JSONB-bound payload without converting typed labels into an unvalidated alternative shape. */
export function sourceTextReplayBindingSetPayloadJson(row: SourceTextReplayBindingSetPhysicalRow): JsonValue {
  return structuredClone(row.bindingJson) as unknown as JsonValue;
}
