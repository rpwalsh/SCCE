// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { BOUNDARY_FEATURE_ORDER, compileBoundaryStatistics, mergeBoundaryStatistics, type BoundaryFeatureVector, type BoundarySufficientStatistics } from "../boundary-estimator.js";
import { mergePagedBoundaryStatistics } from "../paged-boundary-statistics.js";
import type { BoundaryStatisticsCursor } from "../corpus-segmentation-cursor.js";
import { fixtureSegmentationScratch } from "./fixtures/corpus-segmentation-scratch.js";
import { createHasher } from "../primitives.js";

const hasher = createHasher();
function cursor(statistics: BoundarySufficientStatistics): BoundaryStatisticsCursor {
  const { rows, sourceDocumentIds, ...header } = statistics;
  return { header: { ...header, rowCount: rows.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(sourceDocumentIds)), count: sourceDocumentIds.length } },
    async *rows() { for (const row of rows) yield [row]; }, async *sourceDocuments() { for (const id of sourceDocumentIds) yield [id]; } };
}
function sample(id: string, seed: number) {
  return compileBoundaryStatistics({ populationId: "population.owned", sourceDocumentIds: [id], hasher,
    observations: Array.from({ length: 11 }, (_, index) => ({ sourceDocumentId: id, signalId: `owned.${seed}.${index}`,
      features: Object.fromEntries(BOUNDARY_FEATURE_ORDER.map((key, feature) => [key, ((index + feature * 3) % 11) / 11])) as unknown as BoundaryFeatureVector,
      positiveMass: (seed % 7) / 4, negativeMass: (index % 5) / 3, supervision: "independent_anchor" as const, signalKind: "external_anchor" as const })) });
}

it.each([1, 3, 7])("merges complete owned window statistics with exact legacy IDs on %i-row spill pages", async pageRows => {
  const sources = [sample("owner.\u00e9", 1), sample("owner.e\u0301", 2), sample("owner.\u00e9", 3), sample("owner.\u732b", 4)];
  const expected = mergeBoundaryStatistics(sources, hasher, "population.merged");
  const scratch = fixtureSegmentationScratch(pageRows);
  await scratch.putMany("otherRun", [{ orderKey: "0", value: "untouched" }]);
  const merged = await mergePagedBoundaryStatistics({ sources: async function*() { for (const source of sources) yield cursor(source); },
    scratch, populationId: "population.merged", collectionPrefix: "thisRun.merge", hasher });
  const rows = []; for await (const page of merged.rows()) rows.push(...page);
  const ids = []; for await (const page of merged.sourceDocuments()) ids.push(...page);
  const { rowCount, sourceInventory, ...header } = merged.header;
  expect({ ...header, rows, sourceDocumentIds: ids }).toEqual(expected);
  expect(rowCount).toBe(expected.rows.length);
  expect(sourceInventory.count).toBe(expected.sourceDocumentIds.length);
  expect(await scratch.count("otherRun")).toBe(1);
});

it("refuses missing window rows without activating a prefix result", async () => {
  const source = cursor(sample("owner", 1)); source.header.rowCount++;
  await expect(mergePagedBoundaryStatistics({ sources: async function*() { yield source; }, scratch: fixtureSegmentationScratch(2),
    populationId: "population.merged", collectionPrefix: "failedRun" })).rejects.toThrow("inventory changed");
});
