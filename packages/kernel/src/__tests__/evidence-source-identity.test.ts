// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { evidenceSourceIdentity, resolveEvidenceSourceIdentity } from "../evidence-source-identity.js";
import { evidenceCitation } from "../evidence-citation.js";
import type { EvidenceSpan, JsonValue } from "../types.js";

function span(provenance: JsonValue, sourceIdentity?: { title: string; identity: string; sourceKind: string }): EvidenceSpan {
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
    features: [],
    status: "promoted",
    alpha: 1,
    observedAt: new Date(1000).toISOString(),
    ...(sourceIdentity ? { sourceIdentity } : {})
  } as unknown as EvidenceSpan;
}

const WIKI_PROVENANCE = {
  title: "File manager",
  identity: "file manager",
  sourceKind: "wikimedia_dump",
  corpus: "enwiki-latest-pages-articles-multistream",
  uri: "wikipedia://enwiki/File_manager"
} as unknown as JsonValue;

const REPOSITORY_PROVENANCE = {
  uri: "packages/kernel/src/program-planner.ts",
  metadata: { title: "program planner", identity: "program planner", sourceKind: "developer_intelligence" }
} as unknown as JsonValue;

/**
 * One resolver for what a span's source IS. Two ingestors write title, identity and source kind in two places, and
 * four readers each re-derived the pair -- three of them reading only one half. The schema already states the rule
 * once, in the `source_title` generated column; this is the same rule on this side of the read boundary.
 */
describe("source identity is resolved once", () => {
  it("reads both spellings of every field", () => {
    expect(resolveEvidenceSourceIdentity(WIKI_PROVENANCE))
      .toEqual({ title: "File manager", identity: "file manager", sourceKind: "wikimedia_dump" });
    expect(resolveEvidenceSourceIdentity(REPOSITORY_PROVENANCE))
      .toEqual({ title: "program planner", identity: "program planner", sourceKind: "developer_intelligence" });
  });

  it("prefers the top-level spelling when an ingestor wrote both", () => {
    const both = { title: "top", metadata: { title: "nested" } } as unknown as JsonValue;

    expect(resolveEvidenceSourceIdentity(both).title).toBe("top");
  });

  it("resolves nothing from a span with no provenance rather than guessing", () => {
    expect(resolveEvidenceSourceIdentity(undefined)).toEqual({ title: "", identity: "", sourceKind: "" });
  });

  it("uses the field the read boundary set, and falls back to provenance for a span built in memory", () => {
    const resolved = { title: "carried", identity: "carried identity", sourceKind: "carried kind" };

    expect(evidenceSourceIdentity(span(REPOSITORY_PROVENANCE, resolved))).toEqual(resolved);
    expect(evidenceSourceIdentity(span(REPOSITORY_PROVENANCE)).title).toBe("program planner");
  });

  // The wikimedia citation, including its reconstructed link, is unchanged by the refactor.
  it("leaves the wikimedia citation byte-identical", () => {
    expect(evidenceCitation(span(WIKI_PROVENANCE)))
      .toEqual({ title: "File manager", url: "https://en.wikipedia.org/wiki/File_manager" });
  });
});
