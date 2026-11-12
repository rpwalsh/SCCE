// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { POSTGRES_REQUIRED_TABLES, createHasher, createSourceTextReplayBindingSet, type InformationLabel,
  type SourceTextReplayBinding } from "@scce/kernel";
import { requiredHydrationColumns, schemaStatements } from "../postgres-schema.js";
import { SOURCE_TEXT_REPLAY_BINDING_SET_PAYLOAD_SCHEMA, SOURCE_TEXT_REPLAY_BINDING_SET_RELATION,
  decodeSourceTextReplayBindingSetRow, encodeSourceTextReplayBindingSetRow,
  sourceTextReplayBindingSetSchemaStatements } from "../source-text-replay-binding-set-store.js";

const hasher = createHasher();
const label: InformationLabel = { tenantId: "tenant", principals: ["owner"], compartments: ["brain"], exportClass: "restricted", mergePolicy: "isolated" };
const binding = (id: string, trust: number, windowed: boolean): SourceTextReplayBinding => ({ id,
  sourceVersionId: `version.${id}` as never, sourceFamilyId: `family.${id}`, evidenceIds: [`evidence.${id}` as never], trust,
  ownerDocumentId: windowed ? `owner.${id}` : id, startUtf16: windowed ? 2 : 0, endUtf16: 12, windowed,
  textDigest: hasher.digestHex(`text.${id}`), ownerTextDigest: hasher.digestHex(`owner-text.${id}`) });
function fixture() {
  const bindingSet = createSourceTextReplayBindingSet({ modelId: "model.1", profileId: "profile.1",
    manifestPatternId: "manifest.1", manifestDigest: "a".repeat(64), bindings: [binding("a", 0.8, true), binding("b", 0.6, false)] }, hasher);
  const row = encodeSourceTextReplayBindingSetRow({ bindingSet, informationLabel: label, createdAt: 123, hasher });
  return { bindingSet, row };
}

describe("source replay binding-set physical storage", () => {
  it("stores one minimal payload and reconstructs the exact logical set", () => {
    const f = fixture(), json = JSON.stringify(f.row.bindingJson);
    expect(f.row.bindingJson.schema).toBe(SOURCE_TEXT_REPLAY_BINDING_SET_PAYLOAD_SCHEMA);
    expect(json).not.toContain("evidence.a");
    expect(json).not.toContain("family.a");
    expect(json).not.toContain("owner.a");
    expect(decodeSourceTextReplayBindingSetRow(structuredClone(f.row), hasher)).toEqual(f.bindingSet);
  });

  it.each(["id", "digest", "payload", "document"])("rejects %s corruption", mutation => {
    const row: any = structuredClone(fixture().row);
    if (mutation === "id") row.id = `${row.id.slice(0, -1)}0`;
    if (mutation === "digest") row.bindingDigest = "b".repeat(64);
    if (mutation === "payload") row.bindingJson.extra = true;
    if (mutation === "document") row.bindingJson.documents[0].trust = 0.1;
    expect(() => decodeSourceTextReplayBindingSetRow(row, hasher)).toThrow();
  });

  it("is a required access-labeled PostgreSQL relation with strict content identity", () => {
    const statements = sourceTextReplayBindingSetSchemaStatements('"brain"').join("\n");
    expect(statements).toContain(`CREATE TABLE IF NOT EXISTS "brain".${SOURCE_TEXT_REPLAY_BINDING_SET_RELATION}`);
    expect(statements).toContain("manifest_pattern_id TEXT NOT NULL REFERENCES \"brain\".language_patterns(id) ON DELETE RESTRICT");
    expect(statements).toContain("information_label JSONB NOT NULL");
    expect(statements).toContain("id='source_text_replay_bindings_' || binding_digest");
    expect(statements).toContain("binding_json - 'schema' - 'documents' - 'expectedDocumentsDigest'='{}'::jsonb");
    expect(POSTGRES_REQUIRED_TABLES).toContain(SOURCE_TEXT_REPLAY_BINDING_SET_RELATION);
    expect(requiredHydrationColumns()[SOURCE_TEXT_REPLAY_BINDING_SET_RELATION]).toEqual([
      "id", "model_id", "profile_id", "manifest_pattern_id", "manifest_digest", "binding_json", "binding_digest", "information_label", "created_at"
    ]);
    expect(schemaStatements('"brain"').join("\n")).toContain(SOURCE_TEXT_REPLAY_BINDING_SET_RELATION);
  });
});
