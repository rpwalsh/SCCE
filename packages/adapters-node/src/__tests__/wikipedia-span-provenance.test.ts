// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { spanProvenanceMetadata, WIKI_PAGE_STRUCTURE_KEYS } from "../wikipedia.js";
import { stampEvidence } from "../wikipedia-v3-ingestor.js";

const page = {
  sourceSystem: "wikipedia",
  sourceKind: "wikimedia_dump",
  title: "Fixture",
  pageId: "1",
  revisionId: "2",
  corpus: "dump.bz2",
  links: [{ target: "Other", label: "other" }],
  structure: { coordinateSpace: "evidence-source-codepoints", headings: [{ title: "Lead", depth: 1 }] },
  originalStructure: { coordinateSpace: "original-source-codepoints", headings: [] },
  normalization: { transformId: "fixture", unexpandedTemplates: ["cvt"] }
};

describe("a wikipedia span carries the page's identity, not its structure", () => {
  it("keeps the identity keys and drops the structural ones", () => {
    const scoped = spanProvenanceMetadata(page);
    for (const key of WIKI_PAGE_STRUCTURE_KEYS) expect(scoped).not.toHaveProperty(key);
    expect(scoped.title).toBe("Fixture");
    expect(scoped.pageId).toBe("1");
    expect(scoped.sourceKind).toBe("wikimedia_dump");
  });

  it("stamps the identity at both provenance levels and the structure at neither", () => {
    const span = {
      id: "evidence.fixture",
      sourceId: "source.fixture",
      sourceVersionId: "version.fixture",
      chunkId: "chunk.fixture",
      contentHash: "sha256:fixture",
      mediaType: "text/x-wiki",
      byteStart: 0,
      byteEnd: 12,
      charStart: 0,
      charEnd: 12,
      text: "Fixture text",
      textPreview: "Fixture text",
      languageHints: {},
      scriptHints: {},
      trustVector: {},
      provenance: { uri: "wikipedia://fixture", section: "Lead", metadata: page },
      features: ["sym:fixture"],
      status: "proposed",
      alpha: 0.5,
      observedAt: 1
    } as any;
    const [stamped] = stampEvidence([span], page as any, { tenantId: "tenant.fixture" } as any);
    const provenance = stamped!.provenance as Record<string, any>;
    expect(provenance.uri).toBe("wikipedia://fixture");
    expect(provenance.section).toBe("Lead");
    expect(provenance.title).toBe("Fixture");
    expect(provenance.revisionId).toBe("2");
    expect(provenance.sourceSystem).toBe("wikipedia");
    expect(provenance.forceClass).toBe("direct_evidence");
    expect(provenance.metadata.title).toBe("Fixture");
    expect(provenance.metadata.pageId).toBe("1");
    for (const key of WIKI_PAGE_STRUCTURE_KEYS) {
      expect(provenance).not.toHaveProperty(key);
      expect(provenance.metadata).not.toHaveProperty(key);
    }
    expect(stamped!.status).toBe("promoted");
  });
});
