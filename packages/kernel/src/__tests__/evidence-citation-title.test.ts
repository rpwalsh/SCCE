// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { evidenceCitation, formatCitationSuffix } from "../evidence-citation.js";
import type { EvidenceSpan } from "../types.js";

function spanWithProvenance(provenance: Record<string, unknown>): EvidenceSpan {
  return {
    id: "evidence_span.fixture",
    sourceId: "source.fixture",
    sourceVersionId: "source_version.fixture",
    chunkId: "chunk.fixture",
    contentHash: "sha256_fixture",
    mediaType: "text/plain; charset=utf-8",
    byteStart: 0,
    byteEnd: 8,
    charStart: 0,
    charEnd: 8,
    text: "fixture.",
    textPreview: "fixture.",
    languageHints: ["en"],
    scriptHints: ["Latn"],
    trustVector: { reliability: 1, corroboration: 1, recency: 1 },
    provenance,
    status: "promoted",
    alpha: 1,
    observedAt: new Date(1000).toISOString()
  } as unknown as EvidenceSpan;
}

describe("a span the kernel treats as titled is cited by that title", () => {
  // Two ingestors, two spellings: the Wikipedia dump writes provenance.title, the repository ingestor writes
  // provenance.metadata.title. evidenceTitle reads both; this read only the first, so every answer drawn from the
  // repository corpus shipped with no source named at all (live 2026-09-16: source_title 'program planner').
  it("reads the title an ingestor recorded under metadata", () => {
    const span = spanWithProvenance({ uri: "packages/kernel/src/program-planner.ts", metadata: { title: "program planner" } });

    expect(evidenceCitation(span)).toEqual({ title: "program planner" });
    expect(formatCitationSuffix([evidenceCitation(span)!])).toContain("program planner");
  });

  it("still prefers the top-level title and its reconstructed link", () => {
    const span = spanWithProvenance({
      title: "File manager",
      sourceKind: "wikimedia_dump",
      corpus: "enwiki-latest-pages-articles-multistream",
      metadata: { title: "something else" }
    });

    expect(evidenceCitation(span)).toEqual({ title: "File manager", url: "https://en.wikipedia.org/wiki/File_manager" });
  });

  it("fabricates nothing for a span that carries no title in either place", () => {
    expect(evidenceCitation(spanWithProvenance({ uri: "packages/kernel/src/untitled.ts", metadata: {} }))).toBeUndefined();
  });
});
