// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createTypedIngestProjector,
  toJsonValue,
  type EvidenceSpan,
  type SourceId,
  type SourceVersionId
} from "../index.js";

// The graph upsert unions evidence ids on conflict, which is right for a node one page mentions and
// pathological for a node EVERY page mentions. Measured on scce5 after 34,592 pages, the two
// observation_store nodes held 34,592 evidence ids and 2,297 kB each, so every page re-sorted 34,592 elements,
// rewrote 2.3MB and re-indexed it in a 288MB GIN -- twice. Writing 21 nodes cost 3,420ms while the very next
// call wrote 231 nodes in 1,478ms, and the cost grew with the corpus because the array did.
//
// A store node is a routing target named after a store, not something the corpus said. The evidence linkage
// belongs on the edge, and is still there.

describe("store identity nodes do not accumulate the corpus", () => {
  it("leaves the store node without evidence ids and keeps them on the routing edge", () => {
    const hasher = createHasher();
    const ids = createIdFactory({
      clock: createClock({ fixedTime: 100, stepMs: 1 }),
      hasher,
      deterministicReplay: true,
      namespace: "typed-ingest-lineage"
    });
    const parent = "version.original" as SourceVersionId;
    const sourceVersionId = "version.derivative" as SourceVersionId;
    const text = "opaque source surface";
    const bytes = Buffer.from(text, "utf8");
    const contentHash = ids.contentHash(bytes);
    const evidence: EvidenceSpan = {
      id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
      sourceId: "source.republisher" as SourceId,
      sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: bytes.length,
      charStart: 0,
      charEnd: text.length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: {
        sourceTrust: {
          independenceGroup: "owner.lineage"
        }
      },
      provenance: {
        sourceFamilyId: "family.republisher",
        dependencyFamilyId: "family.citation-chain",
        sourceVersionDerivation: {
          kind: "extracted-text",
          transformId: "fixture.republisher-copy",
          derivedFromSourceVersionId: parent,
          originalCoordinateSpace: "extracted-text-utf8",
          redactionMap: []
        }
      },
      features: ["surface"],
      status: "promoted",
      alpha: 0.8,
      observedAt: 100
    };

    const projection = createTypedIngestProjector({ idFactory: ids, hasher }).project({
      sourceId: evidence.sourceId,
      sourceVersionId,
      uri: "fixture://store-node",
      mediaType: "text/plain",
      text,
      metadata: toJsonValue({ stateMarkers: [{ marker: "observed" }] }),
      evidence: [evidence],
      observedAt: 100
    });

    const storeNodes = projection.graphNodes.filter(node =>
      typeof node.representation === "object"
      && node.representation !== null
      && !Array.isArray(node.representation)
      && "store" in (node.representation as Record<string, unknown>));
    expect(storeNodes.length).toBeGreaterThan(0);
    for (const node of storeNodes) {
      // The array every page used to grow.
      expect(node.evidenceIds).toEqual([]);
    }

    // The linkage is not lost: the edge into the store still names this page's evidence.
    const storeIds = new Set(storeNodes.map(node => String(node.id)));
    const routingEdges = projection.graphEdges.filter(edge => storeIds.has(String(edge.target)));
    expect(routingEdges.length).toBeGreaterThan(0);
    expect(routingEdges.some(edge => edge.evidenceIds.map(String).includes(String(evidence.id)))).toBe(true);

    // Nodes that ARE something the corpus said still carry their evidence.
    const contentNodes = projection.graphNodes.filter(node => !storeIds.has(String(node.id)));
    expect(contentNodes.some(node => node.evidenceIds.length > 0)).toBe(true);
  });
});
