// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { blobContentHash } from "./postgres.js";
import {
  appendBoundedAlignmentEvents,
  boundedCanonicalJsonBytes,
  buildBoundedAlignmentEvents as buildKernelBoundedAlignmentEvents,
  canonicalJsonByteChunks,
  readAlignmentAlternativeSetsFromBoundedPayloads as readKernelAlignmentAlternativeSets,
  readBoundedAlignmentPayload as readKernelBoundedAlignmentPayload,
  type BoundedAlignmentEventPayload,
  type BuildBoundedAlignmentEventsInput
} from "@scce/kernel";
import type { BlobStore, JsonValue } from "@scce/kernel";

export {
  appendBoundedAlignmentEvents,
  boundedCanonicalJsonBytes,
  canonicalJsonByteChunks,
  type BoundedAlignmentArtifactRef,
  type BoundedAlignmentEventPayload
} from "@scce/kernel";
export type { BuildBoundedAlignmentEventsInput } from "@scce/kernel";

export async function buildBoundedAlignmentEvents(
  input: Omit<BuildBoundedAlignmentEventsInput, "hashContent">
): Promise<BoundedAlignmentEventPayload[]> {
  return buildKernelBoundedAlignmentEvents({
    ...input,
    hashContent: bytes => String(blobContentHash(bytes))
  });
}

export async function readBoundedAlignmentPayload(
  payloads: readonly JsonValue[],
  blobs: BlobStore,
  options: { key?: string; seriesId?: string; maxParts?: number; maxAssembledItemBytes?: number; maxTotalDecodedBytes?: number } = {}
): Promise<Record<string, JsonValue | JsonValue[]>> {
  return readKernelBoundedAlignmentPayload(payloads, blobs, bytes => String(blobContentHash(bytes)), options);
}

export async function readAlignmentAlternativeSetsFromBoundedPayloads(
  payloads: readonly JsonValue[],
  seriesId: string,
  blobs: BlobStore,
  options: { maxParts?: number; maxAssembledItemBytes?: number; maxTotalDecodedBytes?: number } = {}
) {
  return readKernelAlignmentAlternativeSets(payloads, seriesId, blobs, bytes => String(blobContentHash(bytes)), options);
}
