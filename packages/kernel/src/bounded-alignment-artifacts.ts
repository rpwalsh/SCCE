// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  alignmentAlternativeSetsFromEventPayloads,
  type AlignmentAlternativeSet
} from "./alignment-alternatives.js";
import type { BlobStore } from "./storage.js";
import type { IdFactory } from "./ids.js";
import type { JsonValue } from "./types.js";
import { canonicalJsonByteChunks } from "./canonical-json-digest.js";

export const BOUNDED_ALIGNMENT_EVENT_SCHEMA =
  "scce.sparse_alignment_candidate_blob_event.v1" as const;
export const BOUNDED_ALIGNMENT_PART_SCHEMA =
  "scce.sparse_alignment_candidate_blob_part.v2" as const;
export const BOUNDED_ALIGNMENT_PART_MEDIA_TYPE = "application/json";

export interface BoundedAlignmentArtifactRef {
  schema: typeof BOUNDED_ALIGNMENT_PART_SCHEMA;
  artifactId: string;
  key: string;
  kind: "array" | "value";
  itemIndex: number;
  chunkIndex: number;
  chunkCount: number;
  totalItems: number;
  blobHash: string;
  byteLength: number;
  mediaType: typeof BOUNDED_ALIGNMENT_PART_MEDIA_TYPE;
  seriesIds?: string[];
}

export interface BoundedAlignmentEventPayload {
  schema: typeof BOUNDED_ALIGNMENT_EVENT_SCHEMA;
  sourceSchema: JsonValue;
  shardUri: JsonValue;
  payloadExternalized: true;
  externalizationReason: "canonical payload exceeded bounded inline representation";
  artifactGroupId: string;
  artifactParts: BoundedAlignmentArtifactRef[];
  emptyKeys: string[];
  artifactPartOffset: number;
  artifactPartCount: number;
  artifactTotalPartCount: number;
  retainedKeys: string[];
  payloadKeyCount: number;
}

export interface BuildBoundedAlignmentEventsInput {
  episodeId: string;
  payload: Record<string, unknown>;
  blobs: BlobStore;
  idFactory: Pick<IdFactory, "artifactId">;
  hashContent: (bytes: Uint8Array) => string;
  maxPartBytes?: number;
  maxPartsPerEvent?: number;
}

const DEFAULT_MAX_PART_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PARTS_PER_EVENT = 64;
const DEFAULT_MAX_READ_PARTS = 4096;
// A single learned alignment set may be hundreds of MB, so fragments stay
// small while each read is explicitly bounded and fail-closed at 384MB.
const DEFAULT_MAX_ASSEMBLED_ITEM_BYTES = 384 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_DECODED_BYTES = 384 * 1024 * 1024;

/**
 * Canonical JSON emitted as bounded UTF-8 fragments. Fragments are cut only
 * in the byte stream, so concatenation is exactly the original canonical JSON
 * representation even when a string contains multibyte characters.
 */
export function canonicalJsonFragments(value: unknown, maxBytes: number): Uint8Array[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("canonical JSON fragment bound must be positive");
  return [...canonicalJsonByteChunksBounded(value, maxBytes)];
}

/**
 * Canonicalize a value only when its UTF-8 representation fits the supplied
 * inline bound. Oversized values fail before a large string or JSON tree is
 * constructed by the caller, which can then use blob-backed events.
 */
export function boundedCanonicalJsonBytes(value: unknown, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("bounded JSON byte bound must be positive");
  const fragments: Uint8Array[] = [];
  let total = 0;
  for (const fragment of canonicalJsonByteChunks(value)) {
    total += fragment.byteLength;
    if (total > maxBytes) throw new RangeError(`bounded JSON value exceeds ${maxBytes} bytes`);
    fragments.push(fragment);
  }
  return Buffer.concat(fragments, total);
}

function* canonicalJsonByteChunksBounded(value: unknown, maxBytes: number): Iterable<Uint8Array> {
  let buffer = Buffer.allocUnsafe(maxBytes);
  let used = 0;
  for (const source of canonicalJsonByteChunks(value)) {
    for (let offset = 0; offset < source.byteLength;) {
      const length = Math.min(maxBytes - used, source.byteLength - offset);
      buffer.set(source.subarray(offset, offset + length), used);
      used += length;
      offset += length;
      if (used === maxBytes) {
        yield buffer;
        buffer = Buffer.allocUnsafe(maxBytes);
        used = 0;
      }
    }
  }
  if (used) yield buffer.subarray(0, used);
}

export async function buildBoundedAlignmentEvents(
  input: BuildBoundedAlignmentEventsInput
): Promise<BoundedAlignmentEventPayload[]> {
  const maxPartBytes = positive(input.maxPartBytes, DEFAULT_MAX_PART_BYTES);
  const maxPartsPerEvent = positive(input.maxPartsPerEvent, DEFAULT_MAX_PARTS_PER_EVENT);
  const keys = Object.keys(input.payload).sort();
  const emptyKeys: string[] = [];
  const references: BoundedAlignmentArtifactRef[] = [];
  const storeItem = async (inputItem: {
    key: string;
    kind: "array" | "value";
    itemIndex: number;
    totalItems: number;
    value: unknown;
    seriesIds?: string[];
  }): Promise<void> => {
    const itemReferences: Array<Omit<BoundedAlignmentArtifactRef, "artifactId" | "chunkCount">> = [];
    let chunkIndex = 0;
    for (const bytes of canonicalJsonByteChunksBounded(inputItem.value, maxPartBytes)) {
      const blobHash = input.hashContent(bytes);
      const storedHash = String(await input.blobs.put(bytes, BOUNDED_ALIGNMENT_PART_MEDIA_TYPE));
      if (storedHash !== blobHash) throw new Error(`blob hash mismatch while storing ${inputItem.key}[${inputItem.itemIndex}:${chunkIndex}]`);
      itemReferences.push({
        schema: BOUNDED_ALIGNMENT_PART_SCHEMA,
        key: inputItem.key,
        kind: inputItem.kind,
        itemIndex: inputItem.itemIndex,
        chunkIndex,
        totalItems: inputItem.totalItems,
        blobHash,
        byteLength: bytes.byteLength,
        mediaType: BOUNDED_ALIGNMENT_PART_MEDIA_TYPE,
        ...(inputItem.seriesIds ? { seriesIds: inputItem.seriesIds } : {})
      });
      chunkIndex += 1;
    }
    if (!chunkIndex) throw new Error(`canonical JSON produced no fragments for ${inputItem.key}[${inputItem.itemIndex}]`);
    for (const reference of itemReferences) {
      const chunkCount = itemReferences.length;
      references.push({
        ...reference,
        chunkCount,
        artifactId: String(input.idFactory.artifactId({
          schema: BOUNDED_ALIGNMENT_PART_SCHEMA,
          episodeId: input.episodeId,
          key: reference.key,
          itemIndex: reference.itemIndex,
          chunkIndex: reference.chunkIndex,
          chunkCount,
          totalItems: reference.totalItems,
          blobHash: reference.blobHash,
          byteLength: reference.byteLength
        }))
      });
    }
  };
  for (const key of keys) {
    const value = input.payload[key];
    if (Array.isArray(value)) {
      if (!value.length) {
        emptyKeys.push(key);
        continue;
      }
      for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
        const item = value[itemIndex];
        await storeItem({
          key,
          kind: "array",
          itemIndex,
          totalItems: value.length,
          seriesIds: key === "alignmentAlternativeSets" ? seriesIdsFor([item]) : undefined,
          value: item
        });
      }
    } else {
      await storeItem({
        key,
        kind: "value",
        itemIndex: 0,
        totalItems: 1,
        value
      });
    }
  }
  const artifactGroupId = String(input.idFactory.artifactId({
    schema: BOUNDED_ALIGNMENT_EVENT_SCHEMA,
    episodeId: input.episodeId,
    shardUri: input.payload.shardUri ?? null,
    partHashes: references.map(reference => reference.blobHash)
  }));
  const events: BoundedAlignmentEventPayload[] = [];
  for (let offset = 0; offset < references.length; offset += maxPartsPerEvent) {
    const parts = references.slice(offset, offset + maxPartsPerEvent);
    events.push(eventFor(input.payload, keys, emptyKeys, artifactGroupId, parts, offset, references.length));
  }
  if (!events.length) events.push(eventFor(input.payload, keys, emptyKeys, artifactGroupId, [], 0, 0));
  return events;
}

function eventFor(
  payload: Record<string, unknown>,
  keys: string[],
  emptyKeys: string[],
  artifactGroupId: string,
  parts: BoundedAlignmentArtifactRef[],
  offset: number,
  total: number
): BoundedAlignmentEventPayload {
  return {
    schema: BOUNDED_ALIGNMENT_EVENT_SCHEMA,
    sourceSchema: (payload.schema ?? null) as JsonValue,
    shardUri: (payload.shardUri ?? null) as JsonValue,
    payloadExternalized: true,
    externalizationReason: "canonical payload exceeded bounded inline representation",
    artifactGroupId,
    artifactParts: parts,
    emptyKeys,
    artifactPartOffset: offset,
    artifactPartCount: parts.length,
    artifactTotalPartCount: total,
    retainedKeys: keys,
    payloadKeyCount: keys.length
  };
}

export async function appendBoundedAlignmentEvents(
  append: (payload: JsonValue) => Promise<void>,
  events: readonly BoundedAlignmentEventPayload[]
): Promise<void> {
  for (const event of events) await append(event as unknown as JsonValue);
}

export async function readBoundedAlignmentPayload(
  payloads: readonly JsonValue[],
  blobs: BlobStore,
  hashContent: (bytes: Uint8Array) => string,
  options: { key?: string; seriesId?: string; maxParts?: number; maxAssembledItemBytes?: number; maxTotalDecodedBytes?: number } = {}
): Promise<Record<string, JsonValue | JsonValue[]>> {
  const maxParts = positive(options.maxParts, DEFAULT_MAX_READ_PARTS);
  const maxAssembledItemBytes = positive(options.maxAssembledItemBytes, DEFAULT_MAX_ASSEMBLED_ITEM_BYTES);
  const decodedBudget = { used: 0, max: positive(options.maxTotalDecodedBytes, DEFAULT_MAX_TOTAL_DECODED_BYTES) };
  const externalEvents = payloads.flatMap(payload => {
    if (!isRecord(payload) || payload.schema !== BOUNDED_ALIGNMENT_EVENT_SCHEMA) return [];
    if (!Array.isArray(payload.artifactParts)) throw new Error("invalid bounded alignment event envelope");
    if (typeof payload.artifactGroupId !== "string") throw new Error("invalid bounded alignment event envelope");
    const offset = payload.artifactPartOffset;
    const count = payload.artifactPartCount;
    const total = payload.artifactTotalPartCount;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
      || typeof count !== "number" || !Number.isSafeInteger(count) || count !== payload.artifactParts.length
      || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
      || offset + count > total) throw new Error("invalid bounded alignment event part range");
    return [{ payload, groupId: payload.artifactGroupId, parts: payload.artifactParts as JsonValue[], offset, count, total }];
  });
  const selectedGroups = new Set(externalEvents
    .filter(event => event.parts.some(reference => referenceMatchesOptions(reference, options)))
    .map(event => event.groupId));
  const envelopeGroups = new Map<string, { expected: number; actual: number; ranges: Array<[number, number]> }>();
  for (const event of externalEvents) {
    if (!selectedGroups.has(event.groupId) && (options.key || options.seriesId)) continue;
    const group = envelopeGroups.get(event.groupId) ?? { expected: event.total, actual: 0, ranges: [] };
    if (group.expected !== event.total) throw new Error("bounded alignment event group total mismatch");
    group.actual += event.count;
    group.ranges.push([event.offset, event.offset + event.count]);
    envelopeGroups.set(event.groupId, group);
  }
  for (const group of envelopeGroups.values()) {
    if (group.actual !== group.expected) throw new Error("bounded alignment event group is incomplete");
    const ranges = group.ranges.sort(([left], [right]) => left - right);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index]![0] < ranges[index - 1]![1]) throw new Error("bounded alignment event parts overlap");
    }
  }
  const refs = externalEvents.flatMap(event => event.parts
    .filter(reference => referenceMatchesOptions(reference, options))
    .map(reference => ({ groupId: event.groupId, reference: reference as unknown as BoundedAlignmentArtifactRef })));
  if (refs.length > maxParts) throw new Error("bounded alignment artifact read part budget exceeded");
  const grouped = new Map<string, Map<string, BoundedAlignmentArtifactRef[]>>();
  for (const { groupId, reference } of refs) {
    const byKey = grouped.get(groupId) ?? new Map<string, BoundedAlignmentArtifactRef[]>();
    const rows = byKey.get(reference.key) ?? [];
    if (rows.some(row => row.itemIndex === reference.itemIndex && row.chunkIndex === reference.chunkIndex)) {
      throw new Error("duplicate bounded alignment artifact fragment");
    }
    rows.push(reference);
    byKey.set(reference.key, rows);
    grouped.set(groupId, byKey);
  }
  const output: Record<string, JsonValue | JsonValue[]> = {};
  for (const byKey of grouped.values()) {
    for (const [key, rows] of byKey) {
      const value = await assembleKey(key, rows, blobs, hashContent, maxAssembledItemBytes, decodedBudget, Boolean(options.seriesId));
      const previous = output[key];
      if (Array.isArray(value) && Array.isArray(previous)) output[key] = [...previous, ...value];
      else output[key] = value;
    }
  }
  for (const payload of payloads) {
    if (isRecord(payload) && Array.isArray(payload.emptyKeys)) {
      for (const key of payload.emptyKeys) {
        if (typeof key === "string" && !(key in output) && (!options.key || options.key === key)) output[key] = [];
      }
    }
  }
  return output;
}

async function assembleKey(
  key: string,
  rows: BoundedAlignmentArtifactRef[],
  blobs: BlobStore,
  hashContent: (bytes: Uint8Array) => string,
  maxBytes: number,
  decodedBudget: { used: number; max: number },
  allowPartialItems: boolean
): Promise<JsonValue | JsonValue[]> {
  const byItem = new Map<number, BoundedAlignmentArtifactRef[]>();
  for (const row of rows) {
    const itemRows = byItem.get(row.itemIndex) ?? [];
    itemRows.push(row);
    byItem.set(row.itemIndex, itemRows);
  }
  const values: JsonValue[] = [];
  for (const [, itemRows] of [...byItem.entries()].sort(([left], [right]) => left - right)) {
    const ordered = itemRows.sort((left, right) => left.chunkIndex - right.chunkIndex);
    const first = ordered[0]!;
    for (const reference of ordered) validateReferenceMetadata(reference, maxBytes);
    if (ordered.length !== first.chunkCount || ordered.some((row, index) => row.chunkIndex !== index
      || row.chunkCount !== first.chunkCount || row.kind !== first.kind || row.totalItems !== first.totalItems)) {
      throw new Error(`bounded alignment artifact fragments are incomplete for ${key}[${first.itemIndex}]`);
    }
    const byteLength = ordered.reduce((sum, row) => sum + row.byteLength, 0);
    if (byteLength > maxBytes) throw new Error(`bounded alignment artifact item exceeds assembled byte budget for ${key}[${first.itemIndex}]`);
    if (decodedBudget.used + byteLength > decodedBudget.max) throw new Error(`bounded alignment artifact total decoded byte budget exceeded at ${key}[${first.itemIndex}]`);
    decodedBudget.used += byteLength;
    const assembled = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    for (const reference of ordered) {
      const bytes = await readFragment(blobs, reference, hashContent, maxBytes);
      assembled.set(bytes, offset);
      offset += bytes.byteLength;
    }
    values.push(JSON.parse(assembled.toString("utf8")) as JsonValue);
  }
  const first = rows[0]!;
  if (first.kind === "value") {
    if (values.length !== 1 || first.totalItems !== 1) throw new Error(`invalid scalar bounded alignment artifact for ${key}`);
    return values[0]!;
  }
  if (!allowPartialItems && values.length !== first.totalItems) throw new Error(`bounded alignment artifact items are incomplete for ${key}`);
  return values;
}

function referenceMatchesOptions(
  reference: unknown,
  options: { key?: string; seriesId?: string }
): boolean {
  if (!isRecord(reference) || typeof reference.key !== "string") return false;
  if (options.key && reference.key !== options.key) return false;
  if (options.seriesId && reference.key === "alignmentAlternativeSets") {
    if (!Array.isArray(reference.seriesIds) || !(reference.seriesIds as unknown[]).every(id => typeof id === "string")) {
      throw new Error("alignment artifact series metadata is invalid");
    }
    if (!(reference.seriesIds as unknown[]).includes(options.seriesId)) return false;
  }
  return true;
}

async function readFragment(
  blobs: BlobStore,
  reference: BoundedAlignmentArtifactRef,
  hashContent: (bytes: Uint8Array) => string,
  maxBytes: number
): Promise<Uint8Array> {
  validateReferenceMetadata(reference, maxBytes);
  const bytes = await blobs.get(reference.blobHash as Parameters<BlobStore["get"]>[0]);
  if (bytes.byteLength !== reference.byteLength) throw new Error(`alignment artifact size mismatch: ${reference.blobHash}`);
  if (hashContent(bytes) !== reference.blobHash) throw new Error(`alignment artifact hash mismatch: ${reference.blobHash}`);
  return bytes;
}

function validateReferenceMetadata(reference: BoundedAlignmentArtifactRef, maxBytes: number): void {
  if (!isRecord(reference) || reference.schema !== BOUNDED_ALIGNMENT_PART_SCHEMA
    || typeof reference.artifactId !== "string" || typeof reference.key !== "string"
    || (reference.kind !== "array" && reference.kind !== "value")
    || !Number.isSafeInteger(reference.itemIndex) || reference.itemIndex < 0
    || !Number.isSafeInteger(reference.chunkIndex) || reference.chunkIndex < 0
    || !Number.isSafeInteger(reference.chunkCount) || reference.chunkCount < 1 || reference.chunkIndex >= reference.chunkCount
    || !Number.isSafeInteger(reference.totalItems) || reference.totalItems < 1 || reference.itemIndex >= reference.totalItems
    || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0 || reference.byteLength > maxBytes
    || typeof reference.blobHash !== "string" || reference.mediaType !== BOUNDED_ALIGNMENT_PART_MEDIA_TYPE) {
    throw new Error("invalid bounded alignment artifact reference");
  }
}

export async function readAlignmentAlternativeSetsFromBoundedPayloads(
  payloads: readonly JsonValue[],
  seriesId: string,
  blobs: BlobStore,
  hashContent: (bytes: Uint8Array) => string,
  options: { maxParts?: number; maxAssembledItemBytes?: number; maxTotalDecodedBytes?: number } = {}
): Promise<AlignmentAlternativeSet[]> {
  const inline = alignmentAlternativeSetsFromEventPayloads(payloads, seriesId);
  const bounded = await readBoundedAlignmentPayload(payloads, blobs, hashContent, {
    ...options,
    key: "alignmentAlternativeSets",
    seriesId
  });
  const external = alignmentAlternativeSetsFromEventPayloads([
    { alignmentAlternativeSets: Array.isArray(bounded.alignmentAlternativeSets) ? bounded.alignmentAlternativeSets : [] } as JsonValue
  ], seriesId);
  const byId = new Map([...inline, ...external].map(set => [set.id, set]));
  return [...byId.values()].sort((left, right) => left.revision - right.revision || left.id.localeCompare(right.id));
}

function seriesIdsFor(items: readonly unknown[]): string[] {
  return [...new Set(items.flatMap(item => isRecord(item) && typeof item.seriesId === "string" ? [item.seriesId] : []))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
