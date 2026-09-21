// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { blobContentHash } from "../postgres.js";
import {
  buildBoundedAlignmentEvents,
  readAlignmentAlternativeSetsFromBoundedPayloads,
  readBoundedAlignmentPayload
} from "../alignment-event-artifacts.js";
import type { BlobStore, ContentHash, IdFactory, JsonValue } from "@scce/kernel";
import { canonicalStringify } from "@scce/kernel";
import { boundedCanonicalJsonBytes } from "../alignment-event-artifacts.js";

class MemoryBlobs implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  readonly reads: string[] = [];

  async put(content: Uint8Array, _mediaType: string): Promise<ContentHash> {
    const hash = String(blobContentHash(content));
    this.values.set(hash, new Uint8Array(content));
    return hash as ContentHash;
  }

  async get(hash: string): Promise<Uint8Array> {
    this.reads.push(hash);
    const value = this.values.get(hash);
    if (!value) throw new Error(`missing blob ${hash}`);
    return new Uint8Array(value);
  }

  async exists(hash: string): Promise<boolean> {
    return this.values.has(hash);
  }
}

function ids(): Pick<IdFactory, "artifactId"> {
  return { artifactId: (payload: unknown) => `artifact.${JSON.stringify(payload)}` as never };
}

function alternative(seriesId: string, id: string, evidenceId: string) {
  return {
    schema: "scce.alignment_alternative_set.v1",
    id,
    seriesId,
    supportId: `support.${id}`,
    targetIndexId: `target.${id}`,
    revision: 1,
    hypotheses: [{
      id: `hypothesis.${id}`,
      plan: {
        id: `plan.${id}`,
        anchors: [{ sourceId: "source", targetId: "target", weight: 1 }],
        iterations: [{ iteration: 0, objective: 0.1, residualMass: 0 }]
      },
      evidenceAllocationIds: [`allocation.${id}`],
      predecessorPlanIds: [],
      evidenceIds: [evidenceId]
    }],
    retainedHypothesisCount: 1,
    omittedSearchBranchCount: 0,
    attemptedBranchCount: 1,
    totalBranchCount: 1,
    branchSearchBudget: 1,
    posteriorScope: "retained_candidate_set_only",
    exactGlobalPosteriorClaimed: false
  };
}

describe("bounded alignment event artifacts", () => {
  it("uses the canonical numeric-key order for inline preflight", () => {
    const value = Object.assign(Object.create({ inherited: "ignored" }), { "10": "ten", "2": "two", text: "ok" });
    expect(Buffer.from(boundedCanonicalJsonBytes(value, 1024)).toString("utf8")).toBe(canonicalStringify(value));
  });

  it("round-trips complete arrays and scalars while filtering series before blob reads", async () => {
    const blobs = new MemoryBlobs();
    const target = alternative("series.target", "set.target", "evidence.target");
    const other = alternative("series.other", "set.other", "evidence.other");
    const payload = {
      schema: "scce.sparse_alignment_candidate_batch.v1",
      shardUri: "wiki://fixture",
      alignmentAlternativeSets: [target, other],
      diagnosticAllocations: [{ id: "allocation.target", predecessorPlanIds: ["plan.previous"], values: [1, 2, 3] }],
      evidenceCount: 2
    };
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload,
      blobs,
      idFactory: ids(),
      maxPartBytes: 4_096,
      maxPartsPerEvent: 1
    });
    expect(events.length).toBeGreaterThan(1);
    const eventPayloads = events as unknown as JsonValue[];
    const targetSets = await readAlignmentAlternativeSetsFromBoundedPayloads(
      eventPayloads,
      "series.target",
      blobs,
      { maxAssembledItemBytes: 4_096 }
    );
    expect(targetSets.map(set => set.id)).toEqual(["set.target"]);
    expect(blobs.reads).toHaveLength(1);
    const all = await readBoundedAlignmentPayload(eventPayloads, blobs, { maxAssembledItemBytes: 4_096 });
    expect(all.evidenceCount).toBe(2);
    expect(all.diagnosticAllocations).toEqual(payload.diagnosticAllocations);
    expect(all.alignmentAlternativeSets).toEqual(payload.alignmentAlternativeSets);
  });

  it("rejects a tampered or missing content-addressed part", async () => {
    const blobs = new MemoryBlobs();
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload: { alignmentAlternativeSets: [alternative("series.target", "set.target", "evidence.target")] },
      blobs,
      idFactory: ids(),
      maxPartBytes: 4_096
    });
    const reference = events[0]!.artifactParts[0]!;
    blobs.values.set(reference.blobHash, new TextEncoder().encode("x".repeat(reference.byteLength)));
    await expect(readBoundedAlignmentPayload(events as unknown as JsonValue[], blobs, { maxAssembledItemBytes: 4_096 }))
      .rejects.toThrow(/hash mismatch/);
    blobs.values.delete(reference.blobHash);
    await expect(readBoundedAlignmentPayload(events as unknown as JsonValue[], blobs, { maxAssembledItemBytes: 4_096 }))
      .rejects.toThrow(/missing blob/);
  });

  it("fragments a large item and refuses an undersized assembled budget", async () => {
    const blobs = new MemoryBlobs();
    const events = await buildBoundedAlignmentEvents({
      episodeId: "episode.fixture",
      payload: { alignmentAlternativeSets: [{ seriesId: "series.target", huge: "x".repeat(2_000) }] },
      blobs,
      idFactory: ids(),
      maxPartBytes: 128
    });
    expect(events.flatMap(event => event.artifactParts).some(part => part.chunkCount > 1)).toBe(true);
    await expect(readBoundedAlignmentPayload(events as unknown as JsonValue[], blobs, { maxAssembledItemBytes: 512 }))
      .rejects.toThrow(/assembled byte budget/);
  });
});
