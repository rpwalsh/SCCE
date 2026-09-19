// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  forgetFittedPopulation,
  loadFittedPopulation,
  normalizeInformationLabel,
  type EvidenceSpan,
  type InformationLabel,
  type ScceStorage,
  type SegmentationPopulationModelRecord,
  type SegmentationPopulationModelStore
} from "@scce/kernel";
import { consolidateCorpus } from "../corpus-consolidation-run.js";

// The consolidation pass against a storage adapter: it must read the WHOLE corpus by cursor, label the model it
// persists from the spans it was derived from, and leave the loader reading the new model afterwards.

function label(tenantId: string, exportClass: "public" | "internal" | "confidential"): InformationLabel {
  return normalizeInformationLabel({
    tenantId,
    principals: ["owner"],
    compartments: [],
    exportClass,
    mergePolicy: "same_owner"
  });
}

function span(
  index: number,
  tenantId: string,
  exportClass: "public" | "internal" | "confidential" = "internal"
): EvidenceSpan {
  return {
    id: `evidence_span.${String(index).padStart(6, "0")}` as EvidenceSpan["id"],
    sourceId: `source.family_${index % 3}` as EvidenceSpan["sourceId"],
    sourceVersionId: `source_version.${index}` as EvidenceSpan["sourceVersionId"],
    text: `Document ${index} states a measured quantity, and repeats enough structure across the corpus `
      + `that recurrence and compression have something to read from it.`,
    charStart: 0,
    charEnd: 140,
    status: "promoted",
    alpha: 1,
    observedAt: 1,
    informationLabel: label(tenantId, exportClass)
  } as unknown as EvidenceSpan;
}

interface Recorded {
  storage: ScceStorage;
  store: SegmentationPopulationModelStore;
  put: SegmentationPopulationModelRecord[];
  pages: Array<{ limit: number; afterId?: string }>;
}

function storageOver(spans: readonly EvidenceSpan[], existing?: SegmentationPopulationModelRecord): Recorded {
  const put: SegmentationPopulationModelRecord[] = [];
  const pages: Array<{ limit: number; afterId?: string }> = [];
  const store: SegmentationPopulationModelStore = {
    async putModel(record) { put.push(record); },
    async readById(id) { return put.find(row => row.id === id) ?? existing; },
    async listRecent() { return put.length ? [put[put.length - 1]!] : existing ? [existing] : []; }
  };
  const storage = {
    segmentationPopulations: store,
    evidence: {
      async listPromotedEvidenceSpans(query: { limit: number; afterId?: string }) {
        pages.push({ limit: query.limit, ...(query.afterId ? { afterId: query.afterId } : {}) });
        const start = query.afterId
          ? spans.findIndex(row => String(row.id) === query.afterId) + 1
          : 0;
        return spans.slice(start, start + query.limit);
      }
    }
  } as unknown as ScceStorage;
  return { storage, store, put, pages };
}

describe("consolidating a real corpus", () => {
  it("reads every span by cursor, not one page", async () => {
    const spans = Array.from({ length: 23 }, (_, index) => span(index, "tenant_a"));
    const recorded = storageOver(spans);
    const result = await consolidateCorpus({ storage: recorded.storage, pageSize: 5 });

    expect(result.spansRead).toBe(spans.length);
    expect(result.documentCount).toBe(spans.length);
    // Five pages of five, then a short page that ends the read.
    expect(recorded.pages.length).toBe(5);
    expect(recorded.pages[0]!.afterId).toBeUndefined();
    // Keyset, so every page after the first resumes from the last id seen rather than an offset.
    for (let index = 1; index < recorded.pages.length; index += 1) {
      expect(recorded.pages[index]!.afterId).toBe(String(spans[index * 5 - 1]!.id));
    }
  });

  it("persists the fitted model and reports what it fitted", async () => {
    const spans = Array.from({ length: 12 }, (_, index) => span(index, "tenant_a"));
    const recorded = storageOver(spans);
    const result = await consolidateCorpus({ storage: recorded.storage, pageSize: 50 });

    expect(result.persisted).toBe(true);
    expect(recorded.put.length).toBe(1);
    const record = recorded.put[0]!;
    expect(record.id).toBe(result.modelId);
    expect(record.model.populations.length).toBeGreaterThan(0);
    // Traceable to the pass that made it, so a consolidated fit is distinguishable from a shard's.
    expect(record.trainingPlanId.startsWith("corpus_consolidation.")).toBe(true);
    expect(record.sourceVersionIds.length).toBe(spans.length);
  });

  it("labels the model as restrictively as its most restrictive contributor", async () => {
    const spans = [
      ...Array.from({ length: 6 }, (_, index) => span(index, "tenant_a", "public")),
      ...Array.from({ length: 6 }, (_, index) => span(index + 6, "tenant_a", "confidential"))
    ];
    const recorded = storageOver(spans);
    await consolidateCorpus({ storage: recorded.storage, pageSize: 50 });
    // A model fitted partly from confidential spans is confidential. Taking the looser class would launder it.
    expect(recorded.put[0]!.informationLabel.exportClass).toBe("confidential");
  });

  it("refuses to fit one model across tenants rather than merging them", async () => {
    // The join denies this, and consolidation must surface the denial rather than fit a cross-tenant model.
    const spans = [
      ...Array.from({ length: 6 }, (_, index) => span(index, "tenant_a")),
      ...Array.from({ length: 6 }, (_, index) => span(index + 6, "tenant_b"))
    ];
    const recorded = storageOver(spans);
    await expect(consolidateCorpus({ storage: recorded.storage, pageSize: 50 }))
      .rejects.toThrow(/cross-tenant/);
    expect(recorded.put.length).toBe(0);
  });

  it("refuses a corpus it cannot derive a label for", async () => {
    const spans = Array.from({ length: 6 }, (_, index) => {
      const row = span(index, "tenant_a") as Record<string, unknown>;
      delete row.informationLabel;
      return row as unknown as EvidenceSpan;
    });
    const recorded = storageOver(spans);
    await expect(consolidateCorpus({ storage: recorded.storage, pageSize: 50 }))
      .rejects.toThrow(/will not label a model/);
  });

  it("refuses an empty corpus instead of fitting nothing", async () => {
    const recorded = storageOver([]);
    await expect(consolidateCorpus({ storage: recorded.storage }))
      .rejects.toThrow(/no promoted evidence spans/);
  });

  it("leaves the loader reading the model it just wrote", async () => {
    const spans = Array.from({ length: 10 }, (_, index) => span(index, "tenant_a"));
    const recorded = storageOver(spans);
    // Warm the cache first, the way an ingest run would have.
    expect(await loadFittedPopulation(recorded.store)).toBeUndefined();
    const result = await consolidateCorpus({ storage: recorded.storage, pageSize: 50 });
    // Without the invalidation this would still be the cached `undefined` from before the fit.
    expect((await loadFittedPopulation(recorded.store))?.id).toBe(result.modelId);
  });
});

describe("the ingest side of the split", () => {
  it("caches the population per store, so a shard pays no repeat read", async () => {
    let reads = 0;
    const store: SegmentationPopulationModelStore = {
      async putModel() { /* not used */ },
      async readById() { return undefined; },
      async listRecent() {
        reads += 1;
        return [];
      }
    };
    forgetFittedPopulation(store);
    await loadFittedPopulation(store);
    await loadFittedPopulation(store);
    await loadFittedPopulation(store);
    expect(reads).toBe(1);
    forgetFittedPopulation(store);
    await loadFittedPopulation(store);
    expect(reads).toBe(2);
  });

  it("treats a store that throws as a brain without a fit, never as an ingest failure", async () => {
    const store: SegmentationPopulationModelStore = {
      async putModel() { /* not used */ },
      async readById() { return undefined; },
      async listRecent() { throw new Error("no such table"); }
    };
    await expect(loadFittedPopulation(store)).resolves.toBeUndefined();
  });

  it("has nothing to load when the brain carries no population store at all", async () => {
    await expect(loadFittedPopulation(undefined)).resolves.toBeUndefined();
  });
});
