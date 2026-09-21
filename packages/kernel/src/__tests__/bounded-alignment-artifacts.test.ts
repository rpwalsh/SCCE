// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildBoundedAlignmentEvents,
  canonicalJsonFragments,
  readBoundedAlignmentPayload
} from "../bounded-alignment-artifacts.js";
import { canonicalStringify, createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { BlobStore, ContentHash, JsonValue } from "../index.js";

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  readonly gets: string[] = [];
  inFlight = 0;
  maxInFlight = 0;

  async put(content: Uint8Array): Promise<ContentHash> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      const hash = `sha256_${createHash("sha256").update(content).digest("hex")}` as ContentHash;
      this.values.set(hash, new Uint8Array(content));
      return hash;
    } finally {
      this.inFlight -= 1;
    }
  }

  async get(hash: ContentHash): Promise<Uint8Array> {
    this.gets.push(String(hash));
    const value = this.values.get(hash);
    if (!value) throw new Error(`missing blob ${hash}`);
    return new Uint8Array(value);
  }

  async exists(hash: ContentHash): Promise<boolean> {
    return this.values.has(hash);
  }
}

describe("bounded alignment artifact codec", () => {
  it("matches canonical JSON while fragmenting multibyte values", () => {
    const value = { z: "emoji 😀".repeat(20), a: [undefined, 0, -0, "x"] };
    const fragments = canonicalJsonFragments(value, 7);
    expect(Buffer.concat(fragments).toString("utf8")).toBe(canonicalStringify(value));
    expect(fragments.every(fragment => fragment.byteLength <= 7)).toBe(true);
  });

  it("round-trips nested oversized items and empty arrays without loading other keys", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const payload = {
      diagnostic: [{ id: "one", text: "😀".repeat(300) }, { id: "two", text: "x".repeat(300) }],
      empty: [],
      scalar: "preserved"
    };
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload,
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 17,
      maxPartsPerEvent: 2
    });
    const diagnosticRefs = events.flatMap(event => event.artifactParts).filter(part => part.key === "diagnostic");
    expect(diagnosticRefs.some(part => part.chunkCount > 1)).toBe(true);
    expect(blobs.maxInFlight).toBe(1);
    const restored = await readBoundedAlignmentPayload(
      events as unknown as JsonValue[],
      blobs,
      bytes => String(ids.contentHash(bytes)),
      { key: "diagnostic", maxAssembledItemBytes: 2_000 }
    );
    expect(restored.diagnostic).toEqual(payload.diagnostic);
    const all = await readBoundedAlignmentPayload(
      events as unknown as JsonValue[],
      blobs,
      bytes => String(ids.contentHash(bytes)),
      { maxAssembledItemBytes: 2_000 }
    );
    expect(all).toEqual(payload);
    await expect(readBoundedAlignmentPayload(
      events as unknown as JsonValue[],
      blobs,
      bytes => String(ids.contentHash(bytes)),
      { maxAssembledItemBytes: 2_000, maxTotalDecodedBytes: 100 }
    )).rejects.toThrow(/total decoded byte budget/);
  });

  it("keeps minimal and heterogeneous alternative sets on the legacy v1 writer", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const minimal = { id: "set.minimal", seriesId: "series.minimal", supportId: "support.minimal", hypotheses: [{ plan: { id: "plan.minimal", anchors: [], iterations: [] } }] };
    const typed = {
      id: "set.typed",
      seriesId: "series.typed",
      supportId: "support.typed",
      hypotheses: [{
        plan: { id: "plan.typed", cells: [], rowMarginals: [], columnMarginals: [], anchors: [], iterations: [] },
        evidenceAllocationId: null
      }]
    };
    const minimalEvents = await buildBoundedAlignmentEvents({
      episodeId: "episode.shared.legacy-minimal",
      payload: { alignmentAlternativeSets: [minimal] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes))
    });
    expect(minimalEvents[0]!.schema).toBe("scce.sparse_alignment_candidate_blob_event.v1");
    const mixedEvents = await buildBoundedAlignmentEvents({
      episodeId: "episode.shared.legacy-mixed",
      payload: { alignmentAlternativeSets: [typed, minimal] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes))
    });
    expect(mixedEvents[0]!.schema).toBe("scce.sparse_alignment_candidate_blob_event.v1");
    const restored = await readBoundedAlignmentPayload(mixedEvents as unknown as JsonValue[], blobs, bytes => String(ids.contentHash(bytes)));
    expect(canonicalStringify(restored.alignmentAlternativeSets)).toBe(canonicalStringify([typed, minimal]));
  });

  it("fails closed for a missing fragment and an assembled-item budget", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload: { diagnostic: [{ text: "x".repeat(100) }] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 10
    });
    const ref = events[0]!.artifactParts[0]!;
    blobs.values.delete(ref.blobHash);
    await expect(readBoundedAlignmentPayload(events as unknown as JsonValue[], blobs, bytes => String(ids.contentHash(bytes))))
      .rejects.toThrow(/missing blob/);
    const blobs2 = new MemoryBlobs();
    const events2 = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload: { diagnostic: [{ text: "x".repeat(100) }] },
      blobs: blobs2,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 10
    });
    await expect(readBoundedAlignmentPayload(events2 as unknown as JsonValue[], blobs2, bytes => String(ids.contentHash(bytes)), { maxAssembledItemBytes: 20 }))
      .rejects.toThrow(/assembled byte budget/);
  });

  it("detects a historical event window that cuts an artifact group", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload: { diagnostic: [{ text: "x".repeat(100) }] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 10,
      maxPartsPerEvent: 1
    });
    expect(events.length).toBeGreaterThan(1);
    await expect(readBoundedAlignmentPayload(events.slice(0, -1) as unknown as JsonValue[], blobs, bytes => String(ids.contentHash(bytes))))
      .rejects.toThrow(/event group is incomplete/);
  });

  it("keeps complete groups distinct when histories share item indexes", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const input = {
      blobs,
      idFactory: ids,
      hashContent: (bytes: Uint8Array) => String(ids.contentHash(bytes)),
      maxPartBytes: 32
    };
    const first = await buildBoundedAlignmentEvents({ episodeId: "episode.one", payload: { diagnostic: [{ id: "one" }] }, ...input });
    const second = await buildBoundedAlignmentEvents({ episodeId: "episode.two", payload: { diagnostic: [{ id: "two" }] }, ...input });
    const restored = await readBoundedAlignmentPayload(
      [...first, ...second] as unknown as JsonValue[],
      blobs,
      bytes => String(ids.contentHash(bytes))
    );
    expect(restored.diagnostic).toEqual([{ id: "one" }, { id: "two" }]);
  });

  it("round-trips transport allocation bodies referenced by their durable IDs", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const allocation = {
      schema: "scce.transport_evidence_allocation.v1",
      id: "transport_evidence.fixture",
      allocationPolicyId: "scce.transport_evidence.shared_exact_bootstrap.v1",
      transportPlanId: "transport.fixture",
      supportId: "support.fixture",
      status: "conserved",
      cells: [{
        candidateId: "candidate.fixture",
        surfaceUnitId: "surface.fixture",
        graphTargetId: "target.fixture",
        transportMass: 1,
        status: "conserved",
        sourceCoordinates: {
          byteStart: 4,
          byteEnd: 9,
          utf16Start: 4,
          utf16End: 9,
          codePointStart: 4,
          codePointEnd: 9,
          graphemeStart: 4,
          graphemeEnd: 9
        },
        shares: [{
          evidenceId: "evidence.fixture",
          basis: "shared_exact_evidence",
          conditionalProbability: 1,
          allocatedMass: 1
        }],
        conditionalProbabilitySum: 1,
        allocatedMass: 1,
        conservationResidual: 0
      }],
      totalTransportMass: 1,
      totalAllocatedMass: 1,
      conservationResidual: 0,
      unresolvedCandidateIds: [],
      audit: {
        allocator: "kernel.transport_evidence.normalized_conditional.v1",
        conservationResidual: 0
      }
    };
    const payload = {
      transportEvidenceAllocationIds: [allocation.id],
      transportEvidenceAllocations: [allocation]
    };
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload,
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 31
    });
    const restored = await readBoundedAlignmentPayload(
      events as unknown as JsonValue[],
      blobs,
      bytes => String(ids.contentHash(bytes))
    );
    const allocations = restored.transportEvidenceAllocations as JsonValue[];
    const restoredAllocation = allocations.find(value =>
      Boolean(value && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, JsonValue>).id === allocation.id));
    expect(restoredAllocation).toEqual(allocation);
    expect((restored.transportEvidenceAllocationIds as JsonValue[])[0]).toBe(allocation.id);
    expect((restoredAllocation as Record<string, JsonValue>).cells).toEqual(allocation.cells);
  });

  it("rejects malformed envelopes, overlapping ranges, and inconsistent fragment metadata", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const input = {
      episodeId: "episode.fixture",
      payload: { diagnostic: [{ text: "x".repeat(100) }] },
      blobs,
      idFactory: ids,
      hashContent: (bytes: Uint8Array) => String(ids.contentHash(bytes)),
      maxPartBytes: 10,
      maxPartsPerEvent: 1
    };
    const events = await buildBoundedAlignmentEvents(input);
    const malformed = structuredClone(events) as unknown as JsonValue[];
    (malformed[0] as Record<string, unknown>).artifactParts = {};
    await expect(readBoundedAlignmentPayload(malformed, blobs, input.hashContent)).rejects.toThrow(/invalid bounded alignment event envelope/);
    const overlap = structuredClone(events) as unknown as JsonValue[];
    (overlap[1] as Record<string, unknown>).artifactPartOffset = 0;
    await expect(readBoundedAlignmentPayload(overlap, blobs, input.hashContent)).rejects.toThrow(/overlap/);
    const inconsistent = structuredClone(events) as unknown as JsonValue[];
    const secondReference = ((inconsistent[1] as Record<string, unknown>).artifactParts as JsonValue[])[0] as Record<string, unknown>;
    secondReference.kind = "value";
    await expect(readBoundedAlignmentPayload(inconsistent, blobs, input.hashContent)).rejects.toThrow(/incomplete/);
  });

  it("round-trips shared transport records by series and preserves the old JSON shape", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const row = { surfaceUnitId: "surface.1", nullType: "none", nullCost: 0.1, targetMass: 1, transportedMass: 1, surfaceNullMass: 0, overflowMass: 0, residual: 0 };
    const column = { graphTargetId: "target.1", implicitType: "none", implicitCost: 0.2, targetMass: 1, transportedMass: 1, graphImplicitMass: 0, overflowMass: 0, residual: 0 };
    const cell = { candidateId: "candidate.1", surfaceUnitId: "surface.1", graphTargetId: "target.1", transportMass: 1, featureCost: 0.3, structuralCost: 0.4, orderingCost: 0.5, crossDocumentCost: 0.6 };
    const share = { evidenceId: "evidence.1", basis: "shared_exact_evidence", conditionalProbability: 1, allocatedMass: 1 };
    const plan = (id: string) => ({ schema: "scce.sparse_fused_transport.v1", id, supportId: "support.1", targetIndexId: "target-index.1", cells: [cell, cell], rowMarginals: [row, row], columnMarginals: [column, column], iterations: [], audit: { source: "fixture" } });
    const set = (seriesId: string, id: string) => ({ schema: "scce.alignment_alternative_set.v1", id, seriesId, revision: 1, supportId: "support.1", targetIndexId: "target-index.1", temperature: 1, maximumRetainedAlternatives: 2, posteriorScope: "retained_candidate_set_only", exactGlobalPosteriorClaimed: false, predecessorSetIds: [], hypotheses: [{ rank: 0, plan: plan(`${id}.plan`), objectiveValue: 1, restrictedGibbsWeight: 1, evidenceAllocationId: `allocation.${seriesId}`, predecessorPlanIds: [] }], omittedSearchBranchCount: 0, audit: { source: "fixture" } });
    const allocation = (id: string) => ({ schema: "scce.transport_evidence_allocation.v1", id, supportId: "support.1", cells: [{ ...cell, shares: [share, share] }], totalTransportMass: 1, totalAllocatedMass: 1, conservationResidual: 0, unresolvedCandidateIds: [], audit: { source: "fixture" } });
    const payload = {
      schema: "scce.sparse_alignment_candidate_batch.v1",
      shardUri: "fixture://shared",
      alignmentAlternativeSets: [set("series.a", "set.a"), set("series.b", "set.b"), set("series.a", "set.a2")],
      transportEvidenceAllocations: [allocation("allocation.series.a"), allocation("allocation.series.b")]
    };
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.shared.fixture",
      payload,
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 97,
      maxPartsPerEvent: 2
    });
    expect(events[0]!.schema).toBe("scce.sparse_alignment_candidate_blob_event.v2");
    const restored = await readBoundedAlignmentPayload(events as unknown as JsonValue[], blobs, bytes => String(ids.contentHash(bytes)));
    expect(canonicalStringify(restored)).toBe(canonicalStringify(payload));
    expect(Object.isFrozen((restored.alignmentAlternativeSets as JsonValue[])[0])).toBe(false);
    const restoredPlan = (((restored.alignmentAlternativeSets as JsonValue[])[0] as Record<string, JsonValue>).hypotheses as JsonValue[])[0] as Record<string, JsonValue>;
    const restoredCells = ((restoredPlan.plan as Record<string, JsonValue>).cells as JsonValue[]);
    expect(Object.isFrozen(restoredCells[0])).toBe(true);
    expect(restoredCells[0]).toBe(restoredCells[1]);

    blobs.gets.length = 0;
    const selected = await readBoundedAlignmentPayload(events as unknown as JsonValue[], blobs, bytes => String(ids.contentHash(bytes)), { key: "alignmentAlternativeSets", seriesId: "series.a" });
    expect(canonicalStringify(selected.alignmentAlternativeSets)).toBe(canonicalStringify([payload.alignmentAlternativeSets[0], payload.alignmentAlternativeSets[2]]));
    const seriesA = new Set(events.flatMap(event => event.artifactParts).filter(part => part.key === "alignmentAlternativeSets" && part.seriesIds?.includes("series.a")).map(part => part.blobHash));
    const seriesB = new Set(events.flatMap(event => event.artifactParts).filter(part => part.key === "alignmentAlternativeSets" && part.seriesIds?.includes("series.b")).map(part => part.blobHash));
    expect(blobs.gets.every(hash => seriesA.has(hash))).toBe(true);
    expect(seriesB.size).toBeGreaterThan(0);

    const selectedAllocations = await readBoundedAlignmentPayload(
      events as unknown as JsonValue[],
      blobs,
      bytes => String(ids.contentHash(bytes)),
      { key: "transportEvidenceAllocations", seriesId: "series.a" }
    );
    expect(canonicalStringify(selectedAllocations.transportEvidenceAllocations)).toBe(
      canonicalStringify([payload.transportEvidenceAllocations[0]])
    );

    const missingSeriesMetadata = structuredClone(events) as unknown as JsonValue[];
    const firstSharedPart = ((missingSeriesMetadata[0] as Record<string, unknown>).artifactParts as JsonValue[])
      .find(part => (part as Record<string, unknown>).key === "alignmentAlternativeSets") as Record<string, unknown>;
    delete firstSharedPart.seriesIds;
    await expect(readBoundedAlignmentPayload(missingSeriesMetadata, blobs, bytes => String(ids.contentHash(bytes))))
      .rejects.toThrow(/series metadata is invalid/);

    const wrongSeriesMetadata = structuredClone(events) as unknown as JsonValue[];
    const wrongPart = ((wrongSeriesMetadata[0] as Record<string, unknown>).artifactParts as JsonValue[])
      .find(part => (part as Record<string, unknown>).key === "alignmentAlternativeSets") as Record<string, unknown>;
    wrongPart.seriesIds = ["series.wrong"];
    await expect(readBoundedAlignmentPayload(wrongSeriesMetadata, blobs, bytes => String(ids.contentHash(bytes))))
      .rejects.toThrow(/series metadata is inconsistent/);
  });

  it("allows empty shared references with omitted dictionaries", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const payload = {
      alignmentAlternativeSets: [{
        id: "set.empty",
        seriesId: "series.empty",
        supportId: "support.empty",
        hypotheses: [{ plan: { id: "plan.empty", cells: [], rowMarginals: [], columnMarginals: [] }, evidenceAllocationId: "allocation.empty" }]
      }],
      transportEvidenceAllocations: [{
        id: "allocation.empty",
        transportPlanId: "plan.empty",
        supportId: "support.empty",
        cells: []
      }]
    };
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.shared.empty",
      payload,
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 128
    });
    const restored = await readBoundedAlignmentPayload(events as unknown as JsonValue[], blobs, bytes => String(ids.contentHash(bytes)));
    expect(canonicalStringify(restored)).toBe(canonicalStringify(payload));
  });

  it("rejects accessor records before invoking their getters", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const cell: Record<string, unknown> = {};
    Object.defineProperty(cell, "candidateId", { enumerable: true, get: () => { throw new Error("getter invoked"); } });
    Object.freeze(cell);
    await expect(buildBoundedAlignmentEvents({
      episodeId: "episode.shared.accessor",
      payload: { alignmentAlternativeSets: [{ id: "set", seriesId: "series", supportId: "support", hypotheses: [{ plan: { id: "plan", cells: [cell], rowMarginals: [], columnMarginals: [] }, evidenceAllocationId: null }] }] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes))
    })).rejects.toThrow(/contains an accessor/);
  });

  it("rejects allocation series mappings that are missing or ambiguous", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const build = (sets: JsonValue[]) => buildBoundedAlignmentEvents({
      episodeId: "episode.shared.mapping",
      payload: {
        alignmentAlternativeSets: sets,
        transportEvidenceAllocations: [{ id: "allocation", transportPlanId: "unknown-plan", supportId: "support", cells: [] }]
      },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes))
    });
    const set = (seriesId: string, evidenceAllocationId: string | null) => ({
      id: `set.${seriesId}`,
      seriesId,
      supportId: "support",
      hypotheses: [{ plan: { id: `plan.${seriesId}`, cells: [], rowMarginals: [], columnMarginals: [] }, evidenceAllocationId }]
    });
    await expect(build([set("series", null) as JsonValue])).rejects.toThrow(/no matching alternative series/);
    await expect(build([set("series.a", "allocation") as JsonValue, set("series.b", "allocation") as JsonValue])).rejects.toThrow(/multiple alternative series/);
  });

  it("fails closed for a shared reference with a wrong type", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.shared.malformed",
      payload: { alignmentAlternativeSets: [{ schema: "scce.alignment_alternative_set.v1", id: "set", seriesId: "series", supportId: "support", hypotheses: [{ plan: { cells: [], rowMarginals: [], columnMarginals: [] } }] }] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 64
    });
    const malformed = structuredClone(events) as unknown as JsonValue[];
    const part = (((malformed[0] as Record<string, JsonValue>).artifactParts as JsonValue[])[0] as Record<string, JsonValue>);
    part.chunkIndex = "wrong" as unknown as JsonValue;
    await expect(readBoundedAlignmentPayload(malformed, blobs, bytes => String(ids.contentHash(bytes)))).rejects.toThrow(/invalid bounded alignment artifact reference/);
  });

  it("fails closed when a shared reference key names the wrong dictionary kind", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.shared.kind-mismatch",
      payload: { alignmentAlternativeSets: [{ schema: "scce.alignment_alternative_set.v1", id: "set", seriesId: "series", supportId: "support", hypotheses: [{ plan: { cells: [{ candidateId: "c" }], rowMarginals: [], columnMarginals: [] } }] }] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 1024 * 1024
    });
    const malformed = structuredClone(events) as unknown as JsonValue[];
    const part = ((malformed[0] as Record<string, unknown>).artifactParts as JsonValue[])[0] as Record<string, unknown>;
    const original = blobs.values.get(String(part.blobHash));
    expect(original).toBeDefined();
    const wrapper = JSON.parse(Buffer.from(original!).toString("utf8")) as Record<string, unknown>;
    const items = wrapper.items as Array<Record<string, unknown>>;
    const item = items[0]!.value as Record<string, unknown>;
    const hypotheses = item.hypotheses as Array<Record<string, unknown>>;
    const plan = hypotheses[0]!.plan as Record<string, unknown>;
    const refs = plan.cells as Record<string, unknown>;
    refs.kind = "rowMarginals";
    const replacement = Buffer.from(canonicalStringify(wrapper), "utf8");
    const replacementHash = `sha256_${createHash("sha256").update(replacement).digest("hex")}`;
    blobs.values.set(replacementHash, replacement);
    part.blobHash = replacementHash;
    part.byteLength = replacement.byteLength;
    await expect(readBoundedAlignmentPayload(malformed, blobs, bytes => String(ids.contentHash(bytes)))).rejects.toThrow(/shared alignment transportCells references are malformed/);
  });

  it("does not fall back to legacy decoding for a malformed shared wrapper", async () => {
    const blobs = new MemoryBlobs();
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher: createHasher(), deterministicReplay: true });
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.shared.wrapper",
      payload: { alignmentAlternativeSets: [{ id: "set", seriesId: "series", supportId: "support", hypotheses: [{ plan: { id: "plan", cells: [], rowMarginals: [], columnMarginals: [] }, evidenceAllocationId: null }] }] },
      blobs,
      idFactory: ids,
      hashContent: bytes => String(ids.contentHash(bytes)),
      maxPartBytes: 1024 * 1024
    });
    const malformed = structuredClone(events) as unknown as JsonValue[];
    const part = ((malformed[0] as Record<string, unknown>).artifactParts as JsonValue[])[0] as Record<string, unknown>;
    const original = blobs.values.get(String(part.blobHash));
    const wrapper = JSON.parse(Buffer.from(original!).toString("utf8")) as Record<string, unknown>;
    wrapper.schema = "scce.sparse_alignment_shared_series.invalid";
    const replacement = Buffer.from(canonicalStringify(wrapper), "utf8");
    const replacementHash = `sha256_${createHash("sha256").update(replacement).digest("hex")}`;
    blobs.values.set(replacementHash, replacement);
    part.blobHash = replacementHash;
    part.byteLength = replacement.byteLength;
    await expect(readBoundedAlignmentPayload(malformed, blobs, bytes => String(ids.contentHash(bytes)))).rejects.toThrow(/shared alignment artifact wrapper series metadata is inconsistent/);

    const wrongItemSeries = structuredClone(events) as unknown as JsonValue[];
    const itemPart = ((wrongItemSeries[0] as Record<string, unknown>).artifactParts as JsonValue[])[0] as Record<string, unknown>;
    const itemOriginal = blobs.values.get(String(itemPart.blobHash));
    const itemWrapper = JSON.parse(Buffer.from(itemOriginal!).toString("utf8")) as Record<string, unknown>;
    const itemValue = ((itemWrapper.items as Array<Record<string, unknown>>)[0]!.value) as Record<string, unknown>;
    itemValue.seriesId = "series.wrong";
    const itemReplacement = Buffer.from(canonicalStringify(itemWrapper), "utf8");
    const itemReplacementHash = `sha256_${createHash("sha256").update(itemReplacement).digest("hex")}`;
    blobs.values.set(itemReplacementHash, itemReplacement);
    itemPart.blobHash = itemReplacementHash;
    itemPart.byteLength = itemReplacement.byteLength;
    await expect(readBoundedAlignmentPayload(wrongItemSeries, blobs, bytes => String(ids.contentHash(bytes))))
      .rejects.toThrow(/shared alignment set item series identity is malformed/);
  });
});
