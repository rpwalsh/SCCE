// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { BOUNDARY_FEATURE_ORDER, compileBoundaryStatistics, type BoundaryFeatureVector } from "../boundary-estimator.js";
import type { BoundaryStatisticsCursor, CorpusSegmentationScratch } from "../corpus-segmentation-cursor.js";
import { mergePagedBoundaryStatistics } from "../paged-boundary-statistics.js";
import { fixtureSegmentationScratch } from "./fixtures/corpus-segmentation-scratch.js";
import { createHasher } from "../primitives.js";

const hasher = createHasher();
function source(id: string): BoundaryStatisticsCursor {
  const { rows, sourceDocumentIds, ...header } = compileBoundaryStatistics({ populationId: "population.source", sourceDocumentIds: [id], hasher,
    observations: [0, 1, 2].map(index => ({ sourceDocumentId: id, signalId: `signal.${index}`,
      features: Object.fromEntries(BOUNDARY_FEATURE_ORDER.map((key, ordinal) => [key, ((ordinal + index) % 3) / 3])) as unknown as BoundaryFeatureVector,
      positiveMass: index + 1, negativeMass: 1, supervision: "independent_anchor" as const, signalKind: "external_anchor" as const })) });
  return { header: { ...header, rowCount: rows.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(sourceDocumentIds)), count: sourceDocumentIds.length } },
    async *rows() { for (const row of rows) yield [row]; }, async *sourceDocuments() { yield sourceDocumentIds; } };
}
const input = (scratch: CorpusSegmentationScratch) => ({ scratch, populationId: "population.merged", collectionPrefix: "owned.merge", hasher,
  sources: async function* () { yield source("owner.e\u0301"); yield source("owner.\u00e9.\ud83e\udded"); } });
async function materialize(cursor: BoundaryStatisticsCursor) {
  const rows = [], documents = [];
  for await (const page of cursor.rows()) rows.push(...page);
  for await (const page of cursor.sourceDocuments()) documents.push(...page);
  return { header: cursor.header, rows, documents };
}

it("leases once, retains exact Unicode statistics and IDs through cursor reads, and never recursively acquires", async () => {
  const expected = await mergePagedBoundaryStatistics(input(fixtureSegmentationScratch(2)));
  const leased = fixtureSegmentationScratch(1), recursive = vi.fn(() => { throw Error("recursive factory"); });
  leased.boundaryMergeScratch = recursive;
  const dispose = vi.fn(async () => {}), factory = vi.fn(() => ({ scratch: leased, dispose }));
  const outer = fixtureSegmentationScratch(3); outer.boundaryMergeScratch = factory;
  await outer.putMany("unrelated.assignment", [{ orderKey: "0", value: { population: 1 } }]);
  const actual = await mergePagedBoundaryStatistics(input(outer));
  expect(factory).toHaveBeenCalledTimes(1); expect(recursive).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  expect(await materialize(actual)).toEqual(await materialize(expected));
  expect(await outer.count(actual.storage!.rowsCollection)).toBe(0);
  expect(await leased.count(actual.storage!.rowsCollection)).toBeGreaterThan(0);
  await actual.dispose!(); await actual.dispose!();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(await leased.count(actual.storage!.rowsCollection)).toBe(0);
  expect(await leased.count(actual.storage!.sourceDocumentsCollection)).toBe(0);
  expect(await outer.count("unrelated.assignment")).toBe(1);
});

it("cleans the acquired lease on a partial-source failure and preserves that exact error", async () => {
  const primary = Error("source changed"), leased = fixtureSegmentationScratch(1), collections = new Set<string>();
  const put = leased.putMany; leased.putMany = async (collection, rows) => { collections.add(collection); await put(collection, rows); };
  const dispose = vi.fn(async () => { for (const collection of collections) await leased.deleteCollection(collection); });
  const outer = fixtureSegmentationScratch(2); outer.boundaryMergeScratch = () => ({ scratch: leased, dispose });
  await expect(mergePagedBoundaryStatistics({ ...input(outer), sources: async function* () { yield source("owner"); throw primary; } })).rejects.toBe(primary);
  expect(dispose).toHaveBeenCalledTimes(1); expect(collections.size).toBeGreaterThan(0);
  for (const collection of collections) expect(await leased.count(collection)).toBe(0);
});

it("attempts both owned collection cleanup and lease cleanup, preserving every failure and idempotence", async () => {
  const leased = fixtureSegmentationScratch(2), remove = leased.deleteCollection, collectionFailure = Error("collection cleanup"), leaseFailure = Error("lease cleanup");
  const deleted: string[] = []; let failing = false;
  leased.deleteCollection = async collection => { deleted.push(collection); if (failing && collection.endsWith(".rows")) throw collectionFailure; await remove(collection); };
  const dispose = vi.fn(async () => { throw leaseFailure; });
  const outer = fixtureSegmentationScratch(2); outer.boundaryMergeScratch = () => ({ scratch: leased, dispose });
  const actual = await mergePagedBoundaryStatistics(input(outer)); failing = true;
  const cleanup = actual.dispose!();
  await expect(cleanup).rejects.toMatchObject({ errors: [collectionFailure, leaseFailure] });
  expect(actual.dispose!()).toBe(cleanup);
  expect(deleted).toContain(actual.storage!.sourceDocumentsCollection);
  expect(await leased.count(actual.storage!.sourceDocumentsCollection)).toBe(0);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("retains both a merge failure and a failed lease cleanup", async () => {
  const primary = Error("source failure"), cleanup = Error("cleanup failure");
  const outer = fixtureSegmentationScratch(2); outer.boundaryMergeScratch = () => ({ scratch: fixtureSegmentationScratch(2), dispose: async () => { throw cleanup; } });
  await expect(mergePagedBoundaryStatistics({ ...input(outer), sources: async function* () { throw primary; } })).rejects.toMatchObject({ errors: [primary, cleanup] });
});
