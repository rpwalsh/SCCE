// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterAll, expect, it } from "vitest";
import { LEXICAL_SENSE_SCHEMA, LEXICAL_SENSE_RECIPE, type EvidenceId, type InformationLabel, type LanguagePatternProjection, type LanguagePatternRecord } from "@scce/kernel";
import { createPostgresStorageAdapter } from "../postgres.js";

const label: InformationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const adapters: ReturnType<typeof createPostgresStorageAdapter>[] = [];
afterAll(async () => { await Promise.all(adapters.map(adapter => adapter.close())); });
function fixture() {
  const adapter = createPostgresStorageAdapter({ url: "postgres://unused:unused@127.0.0.1/unused", schema: "fixture",
    informationAccess: { tenantId: label.tenantId, principalId: "principal.fixture", compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  let transactions = 0;
  adapter.transaction = async () => { transactions++; return undefined as never; };
  adapter.query = async () => { throw Error("validation must not read or write the database"); };
  const projection: LanguagePatternProjection = { profileId: "profile", sourceId: "source" as never, sourceVersionId: "version" as never,
    sourceSystem: "workspace", patternSchema: LEXICAL_SENSE_SCHEMA, componentRecipe: LEXICAL_SENSE_RECIPE, informationLabel: label, patternIds: ["pattern"],
    sourceDependencies: [{ sourceId: "source" as never, sourceVersionId: "version" as never, evidenceIds: ["a", "a"] as EvidenceId[], contentHash: "sha256_source" as never },
      { sourceId: "raw-source" as never, sourceVersionId: "raw-version" as never, evidenceIds: ["b"] as EvidenceId[], contentHash: "sha256_raw" as never }] };
  const pattern: LanguagePatternRecord = { id: "pattern", profileId: "profile", patternKind: "semantic_role", support: 1, entropy: 0, evidenceIds: ["a", "a", "b"] as EvidenceId[],
    updatedAt: 1, informationLabel: label, patternJson: { schema: projection.patternSchema, sourceId: projection.sourceId, sourceVersionId: projection.sourceVersionId,
      sourceSystem: projection.sourceSystem, profileId: projection.profileId, componentRecipe: projection.componentRecipe,
      sourceContentHash: "sha256_source", lexiconId: "lexicon", language: "language" } };
  return { adapter, projection, pattern, transactions: () => transactions };
}

it.each(["duplicate-evidence", "declared-cross-owner-evidence", "unknown-evidence", "empty-evidence", "missing-primary-owner", "foreign-row-source", "foreign-row-version", "foreign-row-profile", "foreign-label"])("preserves exact publisher admission for %s", async kind => {
  const f = fixture();
  if (kind === "duplicate-evidence") f.pattern.evidenceIds = ["a", "a"] as EvidenceId[];
  if (kind === "declared-cross-owner-evidence") f.pattern.evidenceIds = ["a", "b"] as EvidenceId[];
  if (kind === "unknown-evidence") f.pattern.evidenceIds = ["foreign"] as EvidenceId[];
  if (kind === "empty-evidence") f.pattern.evidenceIds = [];
  if (kind === "missing-primary-owner") f.projection.sourceDependencies = f.projection.sourceDependencies!.slice(1);
  const metadata = f.pattern.patternJson as Record<string, unknown>;
  if (kind === "foreign-row-source") metadata.sourceId = "foreign";
  if (kind === "foreign-row-version") metadata.sourceVersionId = "foreign";
  if (kind === "foreign-row-profile") f.pattern.profileId = "foreign";
  if (kind === "foreign-label") f.projection.informationLabel = { ...label, tenantId: "foreign" };
  const publish = f.adapter.languageMemory.replaceLanguagePatternProjection!({ patterns: [f.pattern], projection: f.projection });
  if (["duplicate-evidence", "declared-cross-owner-evidence"].includes(kind)) {
    const legacyAllowed = f.pattern.evidenceIds.every(id => f.projection.sourceDependencies!.some(dependency => dependency.evidenceIds.includes(id)));
    expect(legacyAllowed).toBe(true);
    await publish; expect(f.transactions()).toBe(1);
  } else { await expect(publish).rejects.toThrow(); expect(f.transactions()).toBe(0); }
});

it("reads the allowed inventory twice total and never searches it again for each published evidence ID", async () => {
  const f = fixture(), allowed = Array.from({ length: 16384 }, (_, index) => `evidence.${index}` as EvidenceId);
  let indexReads = 0, includesCalls = 0;
  const watched = new Proxy(allowed, { get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/u.test(property)) indexReads++;
    if (property === "includes") return () => { includesCalls++; throw Error("quadratic dependency scan"); };
    return Reflect.get(target, property, receiver);
  } });
  f.projection.sourceDependencies = [{ ...f.projection.sourceDependencies![0]!, evidenceIds: watched }];
  const patterns = Array.from({ length: 2048 }, (_, index) => ({ ...f.pattern, id: `pattern.${index}`, evidenceIds: [allowed.at(-1)!, allowed.at(-1)!] }));
  f.projection.patternIds = patterns.map(row => row.id);
  await f.adapter.languageMemory.replaceLanguagePatternProjection!({ patterns, projection: f.projection });
  expect(f.transactions()).toBe(1);
  expect(includesCalls).toBe(0);
  expect(indexReads).toBe(2 * allowed.length);
});
