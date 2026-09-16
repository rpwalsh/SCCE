// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { citedSpansForSurface, evidenceCitation, formatCitationSuffix } from "../evidence-citation.js";
import { tidySurfaceText } from "../surface-linguistics.js";
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

describe("an answer is named by the span it was taken from", () => {
  const snapshot = {
    ...spanWithProvenance({ uri: "packages/kernel/src/task-resumption-turn-request.ts", metadata: { title: "task resumption turn request" } }),
    id: "evidence_span.task_resumption",
    text: "/** Task resumption. * The real per-turn sync (items 217-218). Nothing here writes on a read. */"
  } as EvidenceSpan;
  const other = { ...spanWithProvenance({ metadata: { title: "closed class words" } }), id: "evidence_span.closed_class", text: "Continuation counts decide the closed class." } as EvidenceSpan;

  it("names the referenced span when the realizer supplied refs", () => {
    expect(citedSpansForSurface([snapshot, other], ["evidence_span.closed_class"], "anything at all here", tidySurfaceText).map(span => String(span.id)))
      .toEqual(["evidence_span.closed_class"]);
  });

  // Live 2026-09-16: this exact surface shipped uncited, realized off the dialogue plan with evidenceRefs 0.
  it("names the span whose own text carries the surface when the realizer supplied none", () => {
    expect(citedSpansForSurface([snapshot, other], [], "* The real per-turn sync (items 217-218).", tidySurfaceText).map(span => String(span.id)))
      .toEqual(["evidence_span.task_resumption"]);
  });

  it("names nothing for a surface no admitted span carries", () => {
    expect(citedSpansForSurface([snapshot, other], [], "Paris is the capital of France.", tidySurfaceText)).toEqual([]);
  });

  it("names nothing for a surface too short to identify a source", () => {
    expect(citedSpansForSurface([snapshot, other], [], "Task resumption.", tidySurfaceText)).toEqual([]);
  });
});
