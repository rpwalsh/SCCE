import { describe, expect, it } from "vitest";
import { hybridRecall } from "../retrieval.js";
import { createHasher, featureSet } from "../primitives.js";
import type { EvidenceSpan, JsonValue } from "../types.js";

describe("hybridRecall benchmark (plan item L6)", () => {
  it("a repeated query against a large fixed evidence pool is far cheaper than the first cold call", () => {
    const hasher = createHasher();
    const evidence = Array.from({ length: 1500 }, (_, index) =>
      span(`evidence.doc${index}`, `Document ${index} covers pump alpha pressure telemetry and valve beta cycle status for unit ${index % 37}.`));

    const coldStart = process.hrtime.bigint();
    const first = hybridRecall({ query: "pump alpha pressure telemetry", evidence, hasher });
    const coldMs = Number(process.hrtime.bigint() - coldStart) / 1_000_000;

    const warmStart = process.hrtime.bigint();
    const second = hybridRecall({ query: "pump alpha pressure telemetry", evidence, hasher });
    const warmMs = Number(process.hrtime.bigint() - warmStart) / 1_000_000;

    expect(second.recall).toEqual(first.recall);
    // The per-document tokenization/vectorization cache (plan item L5)
    // should make a repeated call against the same evidence pool at least
    // an order of magnitude cheaper than the cold call that had to
    // process all 1500 documents for the first time -- proving retrieval
    // cost across repeated turns doesn't keep re-scaling with total
    // supplied document count the way it did before L5.
    expect(warmMs).toBeLessThan(coldMs / 5);
  });
});

function span(id: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: `source.${id}` as EvidenceSpan["sourceId"],
    sourceVersionId: `source-version.${id}` as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk.${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash.${id}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: text.length,
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text,
    languageHints: {} as JsonValue,
    scriptHints: {} as JsonValue,
    trustVector: { trust: 0.8 } as unknown as JsonValue,
    provenance: {} as JsonValue,
    features: featureSet(text, 128),
    status: "promoted",
    alpha: 0.7,
    observedAt: 1
  };
}
