import { describe, expect, it } from "vitest";
import { hybridRecall } from "../retrieval.js";
import { createHasher, featureSet } from "../primitives.js";
import type { EvidenceSpan, JsonValue } from "../types.js";

describe("hybridRecall document caching (plan item L5)", () => {
  it("produces identical scores across repeated calls with the same evidence (caching doesn't change results)", () => {
    const hasher = createHasher();
    const evidence = [
      span("evidence.pump", "Pump alpha pressure reading is stable at forty psi."),
      span("evidence.valve", "Valve beta position remains fully open during the cycle.")
    ];
    const first = hybridRecall({ query: "pump alpha pressure", evidence, hasher });
    const second = hybridRecall({ query: "pump alpha pressure", evidence, hasher });
    expect(second.recall).toEqual(first.recall);
  });

  it("scores distinct evidence with the same id prefix independently (no cross-content cache collision)", () => {
    const hasher = createHasher();
    const evidenceA = [span("evidence.shared", "Alpha reading is stable.")];
    const evidenceB = [span("evidence.shared", "Completely different beta content about valves.")];
    // Different content hash for the same evidence id -- must not reuse
    // evidenceA's cached tokenization/vector for evidenceB's own content.
    evidenceB[0]!.contentHash = "hash.different" as EvidenceSpan["contentHash"];
    const planA = hybridRecall({ query: "alpha reading", evidence: evidenceA, hasher });
    const planB = hybridRecall({ query: "alpha reading", evidence: evidenceB, hasher });
    expect(planA.recall[0]?.bm25).toBeGreaterThan(0);
    expect(planB.recall[0]?.bm25).toBe(0);
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
