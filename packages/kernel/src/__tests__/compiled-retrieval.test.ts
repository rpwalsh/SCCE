import { describe, expect, it } from "vitest";
import { createHasher, featureSet } from "../primitives.js";
import { hybridRecall } from "../retrieval.js";
import { createSemanticMemoryIndex } from "../semantic-memory-index.js";
import type { EvidenceSpan } from "../types.js";

function evidence(id: number, text: string, alpha = 0.2): EvidenceSpan {
  return {
    id: `evidence:${id}` as EvidenceSpan["id"],
    sourceVersionId: `source-version:${id}` as EvidenceSpan["sourceVersionId"],
    sourceId: `source:${id}` as EvidenceSpan["sourceId"],
    chunkId: `chunk:${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${id}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: Buffer.byteLength(text),
    charStart: 0,
    charEnd: text.length,
    textPreview: text,
    text,
    features: featureSet(text, 64),
    alpha,
    status: "promoted",
    observedAt: 1,
    languageHints: {},
    scriptHints: {},
    trustVector: {},
    provenance: {}
  };
}

describe("compiled retrieval", () => {
  it("reuses one compiled slice and scores a bounded query-local candidate set", () => {
    const hasher = createHasher();
    const documents = Array.from({ length: 2_000 }, (_, index) =>
      evidence(index, `ordinary archive record ${index}`)
    );
    documents.push(evidence(2_001, "needle pressure calibration procedure", 0.9));
    documents.push(evidence(2_002, "needle pressure failure report", 0.8));

    const memory = createSemanticMemoryIndex({ hasher });
    const firstSlice = memory.buildSlice({ evidence: documents });
    const secondSlice = memory.buildSlice({ evidence: documents });
    expect(secondSlice).toBe(firstSlice);

    const result = memory.search({
      query: { text: "needle pressure", limit: 12 },
      slice: firstSlice
    });
    const diagnostics = result.diagnostics as Record<string, unknown>;
    expect(diagnostics.sliceSchema).toBe("scce.compiled_memory_slice.v1");
    expect(Number(diagnostics.indexedVectors)).toBe(2_002);
    expect(Number(diagnostics.candidateVectors)).toBeLessThan(200);
    expect(result.selectedEvidenceIds.map(String)).toContain("evidence:2001");

    const roleRecall = hybridRecall({
      query: "needle pressure",
      index: firstSlice.corpusIndex,
      hasher,
      limit: 12
    });
    const audit = roleRecall.audit as Record<string, unknown>;
    expect(audit.indexSchema).toBe("scce.compiled_corpus_index.v1");
    expect(Number(audit.indexedDocuments)).toBe(2_002);
    expect(Number(audit.candidateDocuments)).toBeLessThan(200);
    expect(roleRecall.recall.map(item => item.evidenceId)).toContain("evidence:2001");
  });
});
