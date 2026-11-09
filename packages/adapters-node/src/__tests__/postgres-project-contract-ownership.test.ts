// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { createHasher, type LanguagePatternProjection, type LanguagePatternRecord } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
import { SOURCE_OWNED_PROJECT_PROJECTION_PREFIX } from "../source-owned-project-projection.js";
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });
const label = { tenantId: "project-owner", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
function fixture(rootId = "root.first") {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: { tenantId: label.tenantId, principalId: "owner", compartments: [], maximumExportClass: "restricted" } }); adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = []; let current = true;
  adapter.transaction = async operation => operation();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params });
    if (sql.includes("SELECT TRUE AS source_owner_valid")) return [{ source_owner_valid: true }] as T[];
    if (sql.includes("SELECT TRUE AS project_contract_scope_valid")) return current ? [{ project_contract_scope_valid: true }] as T[] : [];
    return [];
  };
  const inputDigest = createHasher().digestHex("canonical project input"), componentRecipe = SOURCE_OWNED_PROJECT_PROJECTION_PREFIX + createHasher().digestHex(rootId);
  const projection: LanguagePatternProjection = { profileId: "target.profile", sourceId: "target.owner" as never, sourceVersionId: "target.version" as never, sourceSystem: "oss_code",
    patternSchema: "scce.source_owned_test_contract.v1", componentRecipe, patternIds: ["owned.pattern"], informationLabel: label,
    sourceContractRoot: { checkpointId: "root.receipt", sourceId: rootId as never, sourceVersionId: "test.version" as never, inputDigest,snapshotCheckpointId:"project.snapshot",snapshotHash:"physical.snapshot",scopeIdentity:inputDigest },
    sourceDependencies: [
      { sourceId: "target.owner" as never, sourceVersionId: "target.version" as never, contentHash: "target.hash" as never, originalSourceVersionId: "target.original" as never, originalContentHash: "target.raw.hash" as never, evidenceIds: ["target.evidence" as never] },
      { sourceId: rootId as never, sourceVersionId: "test.version" as never, contentHash: "test.hash" as never, originalSourceVersionId: "test.original" as never, originalContentHash: "test.raw.hash" as never, evidenceIds: ["test.evidence" as never] }
    ] };
  const pattern: LanguagePatternRecord = { id: "owned.pattern", profileId: projection.profileId, patternKind: "source_code_assertion_contract", support: 2, entropy: 0, evidenceIds: ["target.evidence" as never], updatedAt: 1, informationLabel: label,
    patternJson: { schema: projection.patternSchema, componentRecipe, sourceVersionId: projection.sourceVersionId, sourceSystem: "oss_code", sourceContractClosure: { digest: inputDigest }, cases: [] } };
  return { adapter, calls, projection, pattern, revoke: () => { current = false; } };
}
it("locks and rechecks every original/projected owner and promoted witness before publishing an exact root component", async () => {
  const f = fixture(); await f.adapter.languageMemory.replaceLanguagePatternProjection!({ projection: f.projection, patterns: [f.pattern] });
  const versionLock = f.calls.find(call => call.sql.includes("locked_version.id"))!, evidenceLock = f.calls.find(call => call.sql.includes("locked_evidence.id"))!;
  expect(versionLock.params[0]).toEqual(["target.original", "target.version", "test.original", "test.version"]);
  expect(evidenceLock.params[0]).toEqual(["target.evidence", "test.evidence"]); expect(versionLock.sql).toContain("FOR SHARE"); expect(evidenceLock.sql).toContain("FOR SHARE");
  const guard = f.calls.find(call => call.sql.includes("project_contract_scope_valid"))!;
  for (const field of ["project_root.status='complete'", "project_root.phase='stored'", "project_snapshot.status='complete'", "project_snapshot.metadata_json->>'recipe'=project_root.metadata_json->>'closureRecipe'", "originalContentHash", "originalSourceVersionId", "project_evidence.status='promoted'", "project_dependency.information_label", "project_original.information_label", "project_evidence.information_label"]) expect(guard.sql).toContain(field);
  expect(guard.sql).not.toContain("observed_at");
  const write = f.calls.find(call => call.sql.includes("AS metadata(key,value_json"))!;
  expect(f.calls.indexOf(guard)).toBeLessThan(f.calls.indexOf(write));
  expect(JSON.parse(String(write.params[1]))).toMatchObject({ sourceContractRoot: f.projection.sourceContractRoot, sourceDependencies: f.projection.sourceDependencies });
});
it("does not publish when the locked dependency/root recheck refuses stale or revoked evidence", async () => {
  const f = fixture(); f.revoke();
  await expect(f.adapter.languageMemory.replaceLanguagePatternProjection!({ projection: f.projection, patterns: [f.pattern] })).rejects.toThrow(/stale, revoked or foreign/u);
  expect(f.calls.some(call => /INSERT INTO .*language_patterns/u.test(call.sql))).toBe(false);
  expect(f.calls.some(call => call.sql.includes("AS metadata(key,value_json"))).toBe(false);
});
it.each(["root", "digest", "original", "evidence", "recipe"])("rejects malformed %s ownership before writes", async damage => {
  const f = fixture();
  if (damage === "root") f.projection.sourceContractRoot!.sourceId = "foreign" as never;
  if (damage === "digest") (f.pattern.patternJson as Record<string, unknown>).sourceContractClosure = { digest: "changed" };
  if (damage === "original") f.projection.sourceDependencies = f.projection.sourceDependencies!.map(row => ({ ...row, originalContentHash: undefined }));
  if (damage === "evidence") f.projection.sourceDependencies = f.projection.sourceDependencies!.map(row => ({ ...row, evidenceIds: [] }));
  if (damage === "recipe") f.projection.componentRecipe += "invalid";
  await expect(f.adapter.languageMemory.replaceLanguagePatternProjection!({ projection: f.projection, patterns: [f.pattern] })).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("uses distinct canonical keys for two test owners of the same target and filters stale roots before row limits", async () => {
  const first = fixture(), second = fixture("root.second");
  for (const f of [first, second]) await f.adapter.languageMemory.replaceLanguagePatternProjection!({ projection: f.projection, patterns: [f.pattern] });
  const key = (f: ReturnType<typeof fixture>) => f.calls.find(call => call.sql.includes("AS metadata(key,value_json"))!.params[0];
  expect(key(first)).not.toBe(key(second));
  first.calls.length = 0;
  await first.adapter.languageMemory.listLanguagePatterns({ patternSchemas: [first.projection.patternSchema], patternKind: "source_code_assertion_contract", limit: 4 });
  const read = first.calls.at(-1)!.sql;
  expect(read).toContain(SOURCE_OWNED_PROJECT_PROJECTION_PREFIX); expect(read).toContain("project_root.status='complete'");
  expect(read.indexOf("project_evidence.status='promoted'")).toBeLessThan(read.indexOf("ranked_pool AS"));
  expect(read).toMatch(/componentRecipe'\s*=\$\d+/u);
});
