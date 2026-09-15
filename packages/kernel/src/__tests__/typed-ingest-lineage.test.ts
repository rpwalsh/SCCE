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

describe("typed ingest source dependency identity", () => {
  it("carries source trust groups and explicit derivative ancestry into persisted candidate provenance", () => {
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
      uri: "fixture://republisher-copy",
      mediaType: "text/plain",
      text,
      metadata: toJsonValue({ stateMarkers: [{ marker: "observed" }] }),
      evidence: [evidence],
      observedAt: 100
    });
    const candidate = projection.semanticCandidates.find(row => row.kind === "state_marker");

    expect(candidate?.provenance.sourceIndependence.dependencyGroupIds).toEqual([
      "family.citation-chain",
      "family.republisher",
      "owner.lineage",
      "source-version:version.original"
    ]);
    expect(projection.graphNodes.some(node =>
      JSON.stringify(node.metadata).includes("source-version:version.original"))).toBe(true);
  });
});
