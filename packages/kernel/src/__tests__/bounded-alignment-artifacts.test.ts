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
});
