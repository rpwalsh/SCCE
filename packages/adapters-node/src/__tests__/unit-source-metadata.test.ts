// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { createHasher, type LanguageUnitRecord, type SourceVersion } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { sourceMetadataBoundOwner, unitSourceMetadataNormalizer, languageUnitMetadataMergeSql } from "../unit-source-metadata.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });

function fixture(value: unknown = { transcript: "owned metadata ".repeat(1200) }) {
  const source: SourceVersion = {
    sourceId: "source:owned" as SourceVersion["sourceId"], sourceVersionId: "version:owned" as SourceVersion["sourceVersionId"],
    namespace: "fixture", canonicalUri: "fixture://unit-owner", contentHash: "sha256:source" as SourceVersion["contentHash"], mediaType: "text/plain",
    observedAt: 1, byteLength: 20, sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1,
      freshness: 1, independenceGroup: "fixture:owned", accessScope: "owner_private", licenseStatus: "owner_authorized" },
    informationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["unit"], exportClass: "restricted", mergePolicy: "isolated" },
    metadata: { sourceMetadata: value } as SourceVersion["metadata"]
  };
  const unit: LanguageUnitRecord = { id: "unit:owned", profileId: "profile:owned", sourceVersionId: source.sourceVersionId,
    script: "script:Latn", unitKind: "symbol", text: "alpha", features: ["sym:alpha"], competenceVector: [1], alpha: 0.8,
    evidenceIds: ["evidence:owned" as LanguageUnitRecord["evidenceIds"][number]], informationLabel: source.informationLabel,
    metadata: { sourceMetadata: value, sourceCompilationId: "compilation:current", count: 12 } as LanguageUnitRecord["metadata"] };
  return { source, unit, owner: sourceMetadataBoundOwner(source, createHasher()) };
}

it.each(["wrong_hash", "wrong_version", "wrong_acl", "different_value", "missing_compilation", "small_value"])("keeps inline data for %s", reason => {
  const { owner, unit } = fixture(reason === "small_value" ? { tiny: true } : undefined);
  const metadata = owner.metadata as Record<string, unknown>;
  if (reason === "wrong_hash") (metadata.sourceMetadataBinding as Record<string, unknown>).valueHash = "sha256:incorrect";
  if (reason === "wrong_version") unit.sourceVersionId = "version:foreign" as LanguageUnitRecord["sourceVersionId"];
  if (reason === "wrong_acl") unit.informationLabel = { ...unit.informationLabel!, principals: ["foreign"] };
  if (reason === "different_value") unit.metadata = { ...(unit.metadata as object), sourceMetadata: { changed: true } };
  if (reason === "missing_compilation") unit.metadata = { sourceMetadata: (unit.metadata as Record<string, unknown>).sourceMetadata } as LanguageUnitRecord["metadata"];
  expect(unitSourceMetadataNormalizer(owner, createHasher())(unit)).toBe(unit);
});

it("snapshots the verified binding and never mutates source or unit metadata", () => {
  const { owner, unit } = fixture();
  const before = JSON.stringify(unit);
  const normalize = unitSourceMetadataNormalizer(owner, createHasher());
  const valueHash = (owner.metadata as Record<string, any>).sourceMetadataBinding.valueHash;
  (owner.metadata as Record<string, any>).sourceMetadataBinding.valueHash = "mutated after verification";
  const normalized = normalize(unit);
  expect(normalized).not.toBe(unit);
  expect((normalized.metadata as Record<string, any>).sourceMetadataRef.valueHash).toBe(valueHash);
  expect(JSON.stringify(unit)).toBe(before);
  expect(normalized).toEqual({ ...unit, metadata: { count: 12, sourceCompilationId: "compilation:current",
    sourceMetadataRef: { schema: "scce.source_metadata_ref.v1", sourceVersionId: "version:owned", valueHash, sourceCompilationId: "compilation:current" } } });
});

it("uses guarded canonical equality for source binding and unit conflict removal", async () => {
  const { owner, unit } = fixture();
  const normalized = unitSourceMetadataNormalizer(owner, createHasher())(unit);
  const adapter = createPostgresStorageAdapter({ url: "postgres://offline.invalid/no_database", schema: "unit_provenance",
    informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["unit"], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => []);
  const mutate = vi.fn(async (_sql: string, _params?: unknown[]) => true);
  Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
  Object.defineProperty(adapter, "query", { value: query });
  Object.defineProperty(adapter, "mutateLanguageMemory", { value: mutate });
  await adapter.evidence.putSourceVersion(owner);
  const sourceSql = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO") && sql.includes("source_versions"))![0];
  for (const guard of ["stored.source_id=EXCLUDED.source_id", "stored.content_hash=EXCLUDED.content_hash", "stored.information_label=EXCLUDED.information_label",
    "stored.metadata_json->'sourceMetadata'=EXCLUDED.metadata_json->'sourceMetadata'", "stored.metadata_json->'sourceMetadataBinding'=EXCLUDED.metadata_json->'sourceMetadataBinding'"]) expect(sourceSql).toContain(guard);
  // This legacy maintenance expression is tested directly: the fixture above is
  // deliberately not a canonical source-compilation holder.
  const sql = languageUnitMetadataMergeSql('"unit_provenance"."source_versions"');
  for (const guard of ["lu.source_version_id=EXCLUDED.source_version_id", "lu.information_label=EXCLUDED.information_label",
    "canonical.information_label=EXCLUDED.information_label", "canonical.metadata_json->'sourceMetadata'=lu.metadata_json->'sourceMetadata'",
    "lu.metadata_json->>'sourceCompilationId'=EXCLUDED.metadata_json->>'sourceCompilationId'",
    "canonical.metadata_json->'sourceMetadataBinding'->>'valueHash'=EXCLUDED.metadata_json->'sourceMetadataRef'->>'valueHash'"]) expect(sql).toContain(guard);
  expect(sql).toContain("THEN (lu.metadata_json-'sourceMetadata') || EXCLUDED.metadata_json");
  expect(normalized.text).toBe(unit.text);
  expect(normalized.features).toEqual(unit.features);
});
