// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { createHasher, type LanguageUnitRecord, type ScceStorage, type SourceVersion } from "@scce/kernel";
import { compactUnitSourceMetadata, UnitMetadataMaintenanceError } from "../unit-metadata-maintenance.js";
import { sourceMetadataBoundOwner } from "../unit-source-metadata.js";

const label = { tenantId: "fixture", principals: ["owner"], compartments: ["unit"], exportClass: "restricted", mergePolicy: "isolated" } as const;
function records(id: string, repeats = 1200) {
  const informationLabel = { ...label, principals: [...label.principals], compartments: [...label.compartments] };
  const value = { transcript: "owned metadata ".repeat(repeats) };
  const source: SourceVersion = { sourceId: `source:${id}` as SourceVersion["sourceId"], sourceVersionId: `version:${id}` as SourceVersion["sourceVersionId"],
    namespace: "fixture", canonicalUri: `fixture://${id}`, contentHash: `sha256:${id}` as SourceVersion["contentHash"], mediaType: "text/plain", observedAt: 1, byteLength: 12,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "owner_private", licenseStatus: "owner_authorized" },
    informationLabel, metadata: { sourceMetadata: value } };
  const unit: LanguageUnitRecord = { id, profileId: `profile:${id}`, sourceVersionId: source.sourceVersionId, script: "script:Latn", unitKind: "symbol", text: "alpha",
    features: ["sym:alpha"], competenceVector: [1], alpha: 0.8, evidenceIds: [`evidence:${id}` as LanguageUnitRecord["evidenceIds"][number]], informationLabel,
    metadata: { count: 12, sourceMetadata: value, sourceCompilationId: "compilation:current" } };
  return { source, unit };
}

function fixture(input = [records("a"), records("b"), records("c")]) {
  const state = { units: new Map(input.map(row => [row.unit.id, structuredClone(row.unit)])), sources: new Map(input.map(row => [String(row.source.sourceVersionId), structuredClone(row.source)])), revision: 0 };
  let active = false, failWrite = false, failRead = false, mismatchAfterWrite = false, aliasOwner = false;
  const pages = vi.fn(async ({ afterId = "", limit, maxTotalJsonBytes }: { afterId?: string; limit: number; maxTotalJsonBytes: number }) => {
    expect(active).toBe(true);
    const candidates = [...state.units.values()].filter(unit => unit.id > afterId && unit.informationLabel?.principals.includes("owner")
      && Object.hasOwn(unit.metadata as object, "sourceMetadata")).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
    const units: LanguageUnitRecord[] = [], oversized: Array<{ id: string; byteLength: number }> = [];
    let cursor = afterId, bytes = 0, processed = 0;
    for (const unit of candidates) {
      const size = Buffer.byteLength(JSON.stringify(unit));
      if (size <= maxTotalJsonBytes && bytes + size > maxTotalJsonBytes) break;
      cursor = unit.id; processed++;
      if (size > maxTotalJsonBytes) oversized.push({ id: unit.id, byteLength: size });
      else { bytes += size; units.push(structuredClone(unit)); }
    }
    return { units, oversized, decodedBytes: bytes, nextAfterId: cursor || undefined, hasMore: processed < candidates.length || candidates.length === limit };
  });
  const sourceWrites = vi.fn(async (source: SourceVersion) => { expect(active).toBe(true); state.sources.set(String(source.sourceVersionId), structuredClone(source)); });
  const ownerReads = vi.fn(async (ids: readonly LanguageUnitRecord["evidenceIds"][number][]) => {
    expect(active).toBe(true);
    if (failRead) throw new Error("injected canonical read failure");
    const keys = new Set([...state.units.values()].filter(unit => unit.evidenceIds.some(id => ids.includes(id))).map(unit => String(unit.sourceVersionId)));
    const owners = [...state.sources.values()].filter(source => keys.has(String(source.sourceVersionId)) && source.informationLabel?.principals.includes("owner"))
      .map(source => mismatchAfterWrite && sourceWrites.mock.calls.length ? { ...source, metadata: { ...(source.metadata as object), sourceMetadata: { changed: true } } } : structuredClone(source));
    return aliasOwner && owners[0] ? [...owners, { ...owners[0], sourceId: "foreign:alias" as SourceVersion["sourceId"] }] : owners;
  });
  const unitWrites = vi.fn(async (units: readonly LanguageUnitRecord[]) => {
    expect(active).toBe(true);
    for (const unit of units) state.units.set(unit.id, structuredClone(unit));
    state.revision++;
    if (failWrite) throw new Error("injected canonical unit write failure");
  });
  const storage = { transaction: async <T>(operation: () => Promise<T>) => {
    expect(active).toBe(false); const before = structuredClone(state); active = true;
    try { return await operation(); } catch (error) { Object.assign(state, before); throw error; } finally { active = false; }
  }, languageMemory: { listUnitSourceMetadataPage: pages, putLanguageUnits: unitWrites },
  evidence: { sourceVersionsForEvidence: ownerReads, putSourceVersion: sourceWrites } } as unknown as ScceStorage;
  return { state, storage, pages, sourceWrites, ownerReads, unitWrites,
    failWrite: () => { failWrite = true; }, failRead: () => { failRead = true; }, mismatch: () => { mismatchAfterWrite = true; }, alias: () => { aliasOwner = true; } };
}

it("pages accessible units, preserves semantic data, and repeats with no writes", async () => {
  const foreign = records("foreign"); foreign.unit.informationLabel!.principals = ["foreign"]; foreign.source.informationLabel!.principals = ["foreign"];
  const f = fixture([records("a"), records("b"), records("c"), foreign]);
  const original = structuredClone(f.state.units);
  const result = await compactUnitSourceMetadata(f.storage, { batchSize: 2, maxBatches: 10, maxBatchBytes: 100_000 });
  expect(result).toMatchObject({ scanned: 3, compacted: 3, complete: true, sourceWrites: 3, ownerReads: 4, lastCommittedAfterId: "c" });
  expect(result.savedMetadataBytes).toBeGreaterThan(40_000);
  expect(f.unitWrites).toHaveBeenCalledTimes(2);
  for (const [id, unit] of f.state.units) {
    if (id === "foreign") expect(unit).toEqual(original.get(id));
    else {
      const { metadata: before, ...data } = original.get(id)!;
      const { metadata: after, ...actual } = unit;
      expect(actual).toEqual(data);
      expect(after).toMatchObject({ count: 12, sourceCompilationId: (before as Record<string, unknown>).sourceCompilationId });
      expect(after).not.toHaveProperty("sourceMetadata");
    }
  }
  const again = await compactUnitSourceMetadata(f.storage, { batchSize: 2 });
  expect(again).toMatchObject({ scanned: 0, compacted: 0, sourceWrites: 0, ownerReads: 0, complete: true });
  expect(f.unitWrites).toHaveBeenCalledTimes(2);
});

it("reports oversized units and resumes deferred rows without losing the cursor", async () => {
  const f = fixture([records("a", 20_000), records("b"), records("c")]);
  const budget = Buffer.byteLength(JSON.stringify(f.state.units.get("b"))) + 1;
  const first = await compactUnitSourceMetadata(f.storage, { batchSize: 3, maxBatches: 1, maxBatchBytes: budget });
  expect(first).toMatchObject({ scanned: 2, compacted: 1, oversized: 1, lastCommittedAfterId: "b", complete: false });
  const second = await compactUnitSourceMetadata(f.storage, { batchSize: 3, maxBatches: 1, maxBatchBytes: budget, afterId: first.lastCommittedAfterId });
  expect(second).toMatchObject({ scanned: 1, compacted: 1, oversized: 0, lastCommittedAfterId: "c", complete: true });
  expect(f.state.units.get("a")!.metadata).toHaveProperty("sourceMetadata");
});

it("verifies an already bound canonical owner without rewriting it for each unit page", async () => {
  const first = records("a");
  const second = { source: first.source, unit: { ...structuredClone(first.unit), id: "b" } };
  const f = fixture([first, second]);
  const result = await compactUnitSourceMetadata(f.storage, { batchSize: 1, maxBatches: 3 });
  expect(result).toMatchObject({ compacted: 2, sourceWrites: 1, ownerReads: 4, complete: true });
  expect(f.sourceWrites).toHaveBeenCalledTimes(1);
  const already = records("c");
  already.source = sourceMetadataBoundOwner(already.source, createHasher());
  const bound = fixture([already]);
  expect(await compactUnitSourceMetadata(bound.storage)).toMatchObject({ compacted: 1, sourceWrites: 0, ownerReads: 2, complete: true });
  expect(bound.sourceWrites).not.toHaveBeenCalled();
  expect(bound.unitWrites).toHaveBeenCalledTimes(1);
});

it("does not write references after a canonical owner changes or becomes inaccessible", async () => {
  const f = fixture([records("a")]); f.mismatch();
  const result = await compactUnitSourceMetadata(f.storage);
  expect(result).toMatchObject({ compacted: 0, mismatchedOwners: 1 });
  expect(f.unitWrites).not.toHaveBeenCalled();
  const hidden = fixture([records("b")]); hidden.state.sources.get("version:b")!.informationLabel!.principals = ["foreign"];
  expect(await compactUnitSourceMetadata(hidden.storage)).toMatchObject({ compacted: 0, missingOwners: 1, sourceWrites: 0 });
});

it("rolls back source bindings, unit writes and revisions and reports only the last committed cursor", async () => {
  const f = fixture();
  const first = await compactUnitSourceMetadata(f.storage, { batchSize: 1, maxBatches: 1 });
  const before = structuredClone(f.state); f.failWrite();
  let failure: unknown;
  try { await compactUnitSourceMetadata(f.storage, { batchSize: 1, afterId: first.lastCommittedAfterId }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(UnitMetadataMaintenanceError);
  expect((failure as UnitMetadataMaintenanceError).report).toMatchObject({ batches: 0, compacted: 0, sourceWrites: 0, lastCommittedAfterId: "a", complete: false });
  expect(f.state).toEqual(before);
  const broken = fixture(); broken.failRead();
  await expect(compactUnitSourceMetadata(broken.storage)).rejects.toMatchObject({ cause: { message: "injected canonical read failure" } });
  expect(broken.unitWrites).not.toHaveBeenCalled();
});

it("reports ambiguous source version aliases without publishing a reference", async () => {
  const f = fixture([records("a")]); f.alias();
  expect(await compactUnitSourceMetadata(f.storage)).toMatchObject({ scanned: 1, compacted: 0, mismatchedOwners: 1, sourceWrites: 0, complete: true });
  expect(f.unitWrites).not.toHaveBeenCalled();
  expect(f.state.units.get("a")!.metadata).toHaveProperty("sourceMetadata");
});
