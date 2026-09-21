// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  alignmentAlternativeSetsFromEventPayloads,
  type AlignmentAlternativeSet
} from "./alignment-alternatives.js";
import type { BlobStore } from "./storage.js";
import type { IdFactory } from "./ids.js";
import type { JsonValue } from "./types.js";
import {
  canonicalDigestHex,
  canonicalJsonByteChunks,
  createCanonicalLeafTokenCache,
  type CanonicalLeafTokenCache
} from "./canonical-json-digest.js";
import { createHasher } from "./primitives.js";

export const BOUNDED_ALIGNMENT_EVENT_SCHEMA =
  "scce.sparse_alignment_candidate_blob_event.v1" as const;
export const BOUNDED_ALIGNMENT_PART_SCHEMA =
  "scce.sparse_alignment_candidate_blob_part.v2" as const;
export const BOUNDED_ALIGNMENT_EVENT_SCHEMA_SHARED =
  "scce.sparse_alignment_candidate_blob_event.v2" as const;
export const BOUNDED_ALIGNMENT_PART_SCHEMA_SHARED =
  "scce.sparse_alignment_candidate_blob_part.v3" as const;
export const BOUNDED_ALIGNMENT_PART_MEDIA_TYPE = "application/json";
const SHARED_ALIGNMENT_SERIES_SCHEMA = "scce.sparse_alignment_shared_series.v1" as const;
const SHARED_ALIGNMENT_REFS_SCHEMA = "scce.sparse_alignment_shared_record_refs.v1" as const;

export interface BoundedAlignmentArtifactRef {
  schema: typeof BOUNDED_ALIGNMENT_PART_SCHEMA | typeof BOUNDED_ALIGNMENT_PART_SCHEMA_SHARED;
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
  schema: typeof BOUNDED_ALIGNMENT_EVENT_SCHEMA | typeof BOUNDED_ALIGNMENT_EVENT_SCHEMA_SHARED;
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
const SHARED_RECORD_MAX_COUNT = 2_000_000;
const SHARED_RECORD_MAX_BYTES = 384 * 1024 * 1024;
const SHARED_RECORD_MAX_REFERENCES = 8_000_000;
const SHARED_RECORD_MAX_DEPTH = 256;

type SharedRecordKind = "columnMarginals" | "rowMarginals" | "transportCells" | "transportShares";
type SharedRecordState = {
  records: Record<SharedRecordKind, JsonValue[]>;
  buckets: Record<SharedRecordKind, Map<string, Array<{ value: JsonValue; index: number }>>>;
  identities: Record<SharedRecordKind, WeakMap<object, number>>;
  leafTokenCache: CanonicalLeafTokenCache;
  uniqueBytes: number;
  references: number;
};
type SharedSeriesItem = { sourceIndex: number; value: JsonValue };
type SharedSeriesEnvelope = {
  schema: typeof SHARED_ALIGNMENT_SERIES_SCHEMA;
  key: "alignmentAlternativeSets" | "transportEvidenceAllocations";
  seriesIds: string[];
  records: Partial<Record<SharedRecordKind, JsonValue[]>>;
  items: SharedSeriesItem[];
};

function sharedRecordState(leafTokenCache: CanonicalLeafTokenCache): SharedRecordState {
  const kinds: SharedRecordKind[] = ["columnMarginals", "rowMarginals", "transportCells", "transportShares"];
  return {
    records: Object.fromEntries(kinds.map(kind => [kind, []])) as unknown as Record<SharedRecordKind, JsonValue[]>,
    buckets: Object.fromEntries(kinds.map(kind => [kind, new Map()])) as Record<SharedRecordKind, Map<string, Array<{ value: JsonValue; index: number }>>>,
    identities: Object.fromEntries(kinds.map(kind => [kind, new WeakMap()])) as Record<SharedRecordKind, WeakMap<object, number>>,
    leafTokenCache,
    uniqueBytes: 0,
    references: 0
  };
}

function sharedRecordIndex(state: SharedRecordState, kind: SharedRecordKind, value: unknown): number {
  if (!isRecord(value)) throw new Error(`shared alignment ${kind} record must be an object`);
  const identity = state.identities[kind].get(value);
  if (identity !== undefined) {
    reserveSharedReference(state, kind);
    return identity;
  }
  const frozenScalar = isFrozenScalarRecord(value);
  assertAcyclicJson(value);
  const normalized = value as JsonValue;
  const digest = sharedRecordHasher.digestChunks
    ? sharedRecordHasher.digestChunks(canonicalJsonByteChunks(normalized, state.leafTokenCache))
    : canonicalDigestHex(normalized, sharedRecordHasher);
  const bucket = state.buckets[kind].get(digest) ?? [];
  for (const candidate of bucket) {
    if (sameJson(candidate.value, normalized)) {
      if (frozenScalar) state.identities[kind].set(value, candidate.index);
      reserveSharedReference(state, kind);
      return candidate.index;
    }
  }
  const index = state.records[kind].length;
  if (index >= SHARED_RECORD_MAX_COUNT) throw new Error(`shared alignment ${kind} dictionary count exceeds bound`);
  let byteLength = 0;
  for (const chunk of canonicalJsonByteChunks(normalized, state.leafTokenCache)) byteLength += chunk.byteLength;
  if (byteLength > SHARED_RECORD_MAX_BYTES - state.uniqueBytes) {
    throw new Error(`shared alignment ${kind} dictionary bytes exceed bound`);
  }
  reserveSharedReference(state, kind, byteLength);
  state.uniqueBytes += byteLength;
  state.records[kind].push(normalized);
  bucket.push({ value: normalized, index });
  state.buckets[kind].set(digest, bucket);
  if (frozenScalar) state.identities[kind].set(value, index);
  return index;
}

function reserveSharedReference(state: SharedRecordState, kind: SharedRecordKind, additionalBytes = 0): void {
  const references = state.references + 1;
  if (references > SHARED_RECORD_MAX_REFERENCES
    || state.uniqueBytes + additionalBytes + references * 8 > SHARED_RECORD_MAX_BYTES) {
    throw new Error(`shared alignment ${kind} reference budget exceeds bound`);
  }
  state.references = references;
}

const sharedRecordHasher = createHasher();

function sharedRefs(state: SharedRecordState, kind: SharedRecordKind, values: unknown): JsonValue {
  if (!Array.isArray(values)) throw new Error(`shared alignment ${kind} value must be an array`);
  return { schema: SHARED_ALIGNMENT_REFS_SCHEMA, kind, refs: values.map(value => sharedRecordIndex(state, kind, value)) } as unknown as JsonValue;
}

function encodeAlternativeSet(value: unknown, state: SharedRecordState): JsonValue {
  if (!isRecord(value) || !Array.isArray(value.hypotheses)) throw new Error("alignment alternative set has invalid hypotheses");
  return {
    ...value,
    hypotheses: value.hypotheses.map(hypothesis => {
      if (!isRecord(hypothesis) || !isRecord(hypothesis.plan)) throw new Error("alignment hypothesis has invalid plan");
      const plan = hypothesis.plan;
      return {
        ...hypothesis,
        plan: {
          ...plan,
          cells: sharedRefs(state, "transportCells", plan.cells),
          rowMarginals: sharedRefs(state, "rowMarginals", plan.rowMarginals),
          columnMarginals: sharedRefs(state, "columnMarginals", plan.columnMarginals)
        }
      };
    })
  } as unknown as JsonValue;
}

function encodeTransportAllocation(value: unknown, state: SharedRecordState): JsonValue {
  if (!isRecord(value) || !Array.isArray(value.cells)) throw new Error("transport evidence allocation has invalid cells");
  const cellRefs = value.cells.map(cell => {
    if (!isRecord(cell) || !Array.isArray(cell.shares)) throw new Error("transport evidence cell has invalid shares");
    const sourceIdentity = state.identities.transportCells.get(cell);
    if (sourceIdentity !== undefined) {
      reserveSharedReference(state, "transportCells");
      return sourceIdentity;
    }
    const immutableSource = isFrozenJsonTree(cell);
    const encoded = {
      ...cell,
      shares: sharedRefs(state, "transportShares", cell.shares)
    };
    const index = sharedRecordIndex(state, "transportCells", encoded);
    if (immutableSource) state.identities.transportCells.set(cell, index);
    return index;
  });
  return {
    ...value,
    cells: { schema: SHARED_ALIGNMENT_REFS_SCHEMA, kind: "transportCells", refs: cellRefs }
  } as unknown as JsonValue;
}

function sharedSeriesEnvelope(key: SharedSeriesEnvelope["key"], seriesIds: string[], items: SharedSeriesItem[], state: SharedRecordState): JsonValue {
  return {
    schema: SHARED_ALIGNMENT_SERIES_SCHEMA,
    key,
    seriesIds: [...seriesIds].sort(),
    records: Object.fromEntries(Object.entries(state.records).filter(([, values]) => values.length > 0)),
    items
  } as unknown as JsonValue;
}

function isFrozenScalarRecord(value: object): value is Record<string, unknown> {
  try {
    if (!Object.isFrozen(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) return false;
      const field = descriptor.value;
      return field === null || field === undefined
        || typeof field === "string" || typeof field === "number" || typeof field === "boolean";
    });
  } catch {
    return false;
  }
}

function isFrozenJsonTree(value: unknown, active = new WeakSet<object>(), depth = 0): value is JsonValue {
  if (value === null || typeof value !== "object") return true;
  if (depth > SHARED_RECORD_MAX_DEPTH) return false;
  if (active.has(value)) return false;
  try {
    if (!Object.isFrozen(value)) return false;
  } catch {
    return false;
  }
  active.add(value);
  let result = false;
  try {
    const keys = Object.keys(value);
    result = (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)
      && keys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(descriptor && "value" in descriptor && isFrozenJsonTree(descriptor.value, active, depth + 1));
      });
  } catch {
    result = false;
  }
  active.delete(value);
  return result;
}

type SharedSourceGroup = { seriesIds: string[]; items: SharedSeriesItem[] };
type SharedSourceGroups = Map<string, Map<string, SharedSourceGroup>>;

function sharedSourceGroups(payload: Record<string, unknown>): SharedSourceGroups {
  const output: SharedSourceGroups = new Map();
  const sets = Array.isArray(payload.alignmentAlternativeSets) ? payload.alignmentAlternativeSets : [];
  if (sets.length) {
    const grouped = new Map<string, SharedSourceGroup>();
    for (const [sourceIndex, value] of sets.entries()) {
      if (!isRecord(value) || typeof value.seriesId !== "string") throw new Error("alignment alternative set has no seriesId");
      const group = grouped.get(value.seriesId) ?? { seriesIds: [value.seriesId], items: [] };
      group.items.push({ sourceIndex, value: value as JsonValue });
      grouped.set(value.seriesId, group);
    }
    output.set("alignmentAlternativeSets", grouped);
  }
  const allocations = Array.isArray(payload.transportEvidenceAllocations) ? payload.transportEvidenceAllocations : [];
  if (allocations.length && sets.length) {
    const seriesByPlanId = new Map<string, Set<string>>();
    const seriesByAllocationId = new Map<string, Set<string>>();
    for (const value of sets) {
      if (!isRecord(value) || typeof value.seriesId !== "string" || !Array.isArray(value.hypotheses)) continue;
      for (const hypothesis of value.hypotheses) {
        if (!isRecord(hypothesis)) continue;
        if (typeof hypothesis.evidenceAllocationId === "string") {
          const series = seriesByAllocationId.get(hypothesis.evidenceAllocationId) ?? new Set<string>();
          series.add(value.seriesId);
          seriesByAllocationId.set(hypothesis.evidenceAllocationId, series);
        }
        if (isRecord(hypothesis.plan) && typeof hypothesis.plan.id === "string") {
          const series = seriesByPlanId.get(hypothesis.plan.id) ?? new Set<string>();
          series.add(value.seriesId);
          seriesByPlanId.set(hypothesis.plan.id, series);
        }
      }
    }
    const grouped = new Map<string, SharedSourceGroup>();
    for (const [sourceIndex, value] of allocations.entries()) {
      if (!isRecord(value)) throw new Error("transport evidence allocation must be an object");
      const byAllocationId = typeof value.id === "string" ? seriesByAllocationId.get(value.id) : undefined;
      const byPlanId = typeof value.transportPlanId === "string" ? seriesByPlanId.get(value.transportPlanId) : undefined;
      const candidates = new Set([...(byAllocationId ?? []), ...(byPlanId ?? [])]);
      if (byAllocationId && byPlanId && [...byAllocationId].some(seriesId => !byPlanId.has(seriesId))) {
        throw new Error(`transport evidence allocation ${String(value.id)} has conflicting series identity`);
      }
      if (!candidates.size) {
        throw new Error(`transport evidence allocation ${String(value.id)} has no matching alternative series`);
      }
      if (candidates.size > 1) {
        throw new Error(`transport evidence allocation ${String(value.id)} maps to multiple alternative series`);
      }
      const seriesIds = [...candidates].sort();
      const groupKey = seriesIds.join("\u0000");
      const group = grouped.get(groupKey) ?? { seriesIds, items: [] };
      group.items.push({ sourceIndex, value: value as JsonValue });
      grouped.set(groupKey, group);
    }
    output.set("transportEvidenceAllocations", grouped);
  }
  return output;
}

function canUseSharedAlternativeEncoding(payload: Record<string, unknown>): boolean {
  const sets = payload.alignmentAlternativeSets;
  if (!Array.isArray(sets) || !sets.length) return false;
  return sets.every(value => isRecord(value)
    && typeof value.seriesId === "string"
    && Array.isArray(value.hypotheses)
    && value.hypotheses.every(hypothesis => isRecord(hypothesis)
      && isRecord(hypothesis.plan)
      && Array.isArray(hypothesis.plan.cells)
      && Array.isArray(hypothesis.plan.rowMarginals)
      && Array.isArray(hypothesis.plan.columnMarginals)));
}

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

function* canonicalJsonByteChunksBounded(
  value: unknown,
  maxBytes: number,
  leafTokenCache?: CanonicalLeafTokenCache
): Iterable<Uint8Array> {
  let buffer = Buffer.allocUnsafe(maxBytes);
  let used = 0;
  for (const source of canonicalJsonByteChunks(value, leafTokenCache)) {
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
  const shared = canUseSharedAlternativeEncoding(input.payload)
    ? sharedSourceGroups(input.payload)
    : new Map<string, Map<string, SharedSourceGroup>>();
  const sharedEvent = shared.size > 0;
  const eventSchema = sharedEvent ? BOUNDED_ALIGNMENT_EVENT_SCHEMA_SHARED : BOUNDED_ALIGNMENT_EVENT_SCHEMA;
  const partSchema = sharedEvent ? BOUNDED_ALIGNMENT_PART_SCHEMA_SHARED : BOUNDED_ALIGNMENT_PART_SCHEMA;
  const emptyKeys: string[] = [];
  const references: BoundedAlignmentArtifactRef[] = [];
  const leafTokenCache = createCanonicalLeafTokenCache();
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
    for (const bytes of canonicalJsonByteChunksBounded(inputItem.value, maxPartBytes, leafTokenCache)) {
      const blobHash = input.hashContent(bytes);
      const storedHash = String(await input.blobs.put(bytes, BOUNDED_ALIGNMENT_PART_MEDIA_TYPE));
      if (storedHash !== blobHash) throw new Error(`blob hash mismatch while storing ${inputItem.key}[${inputItem.itemIndex}:${chunkIndex}]`);
      itemReferences.push({
        schema: partSchema,
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
          schema: partSchema,
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
    const sharedValues = shared.get(key);
    if (sharedValues) {
      const groups = [...sharedValues.values()].sort((left, right) => {
        const leftId = left.seriesIds.join("\u0000");
        const rightId = right.seriesIds.join("\u0000");
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
      for (let itemIndex = 0; itemIndex < groups.length; itemIndex += 1) {
        const group = groups[itemIndex]!;
        const state = sharedRecordState(leafTokenCache);
        const encodedItems = group.items.map(item => ({
          sourceIndex: item.sourceIndex,
          value: key === "alignmentAlternativeSets"
            ? encodeAlternativeSet(item.value, state)
            : encodeTransportAllocation(item.value, state)
        }));
        const envelope = sharedSeriesEnvelope(
          key as SharedSeriesEnvelope["key"],
          group.seriesIds,
          encodedItems,
          state
        ) as unknown as Record<string, unknown>;
        await storeItem({
          key,
          kind: "array",
          itemIndex,
          totalItems: groups.length,
          seriesIds: Array.isArray(envelope.seriesIds) ? envelope.seriesIds as string[] : undefined,
          value: envelope
        });
      }
      continue;
    }
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
    schema: eventSchema,
    episodeId: input.episodeId,
    shardUri: input.payload.shardUri ?? null,
    partHashes: references.map(reference => reference.blobHash)
  }));
  const events: BoundedAlignmentEventPayload[] = [];
  for (let offset = 0; offset < references.length; offset += maxPartsPerEvent) {
    const parts = references.slice(offset, offset + maxPartsPerEvent);
    events.push(eventFor(input.payload, keys, emptyKeys, artifactGroupId, parts, offset, references.length, eventSchema));
  }
  if (!events.length) events.push(eventFor(input.payload, keys, emptyKeys, artifactGroupId, [], 0, 0, eventSchema));
  return events;
}

function eventFor(
  payload: Record<string, unknown>,
  keys: string[],
  emptyKeys: string[],
  artifactGroupId: string,
  parts: BoundedAlignmentArtifactRef[],
  offset: number,
  total: number,
  eventSchema: typeof BOUNDED_ALIGNMENT_EVENT_SCHEMA | typeof BOUNDED_ALIGNMENT_EVENT_SCHEMA_SHARED
): BoundedAlignmentEventPayload {
  return {
    schema: eventSchema,
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
  const sharedDecodeBudget = { used: 0, max: SHARED_RECORD_MAX_REFERENCES };
  const externalEvents = payloads.flatMap(payload => {
    if (!isRecord(payload) || (payload.schema !== BOUNDED_ALIGNMENT_EVENT_SCHEMA && payload.schema !== BOUNDED_ALIGNMENT_EVENT_SCHEMA_SHARED)) return [];
    const shared = payload.schema === BOUNDED_ALIGNMENT_EVENT_SCHEMA_SHARED;
    if (!Array.isArray(payload.artifactParts)) throw new Error("invalid bounded alignment event envelope");
    if (typeof payload.artifactGroupId !== "string") throw new Error("invalid bounded alignment event envelope");
    const offset = payload.artifactPartOffset;
    const count = payload.artifactPartCount;
    const total = payload.artifactTotalPartCount;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
      || typeof count !== "number" || !Number.isSafeInteger(count) || count !== payload.artifactParts.length
      || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
      || offset + count > total) throw new Error("invalid bounded alignment event part range");
    return [{ payload, groupId: payload.artifactGroupId, parts: payload.artifactParts as JsonValue[], offset, count, total, shared }];
  });
  const selectedGroups = new Set(externalEvents
    .filter(event => event.parts.some(reference => referenceMatchesOptions(reference, options)))
    .map(event => event.groupId));
  const envelopeGroups = new Map<string, { expected: number; actual: number; ranges: Array<[number, number]>; shared: boolean }>();
  for (const event of externalEvents) {
    if (!selectedGroups.has(event.groupId) && (options.key || options.seriesId)) continue;
    const group = envelopeGroups.get(event.groupId) ?? { expected: event.total, actual: 0, ranges: [], shared: event.shared };
    if (group.expected !== event.total) throw new Error("bounded alignment event group total mismatch");
    if (group.shared !== event.shared) throw new Error("bounded alignment event group encoding mismatch");
    for (const reference of event.parts) {
      const typedReference = reference as unknown as BoundedAlignmentArtifactRef;
      validateReferenceMetadata(
        typedReference,
        maxAssembledItemBytes,
        event.shared,
        event.shared && isSharedAlignmentKey(typedReference.key)
      );
    }
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
      const value = await assembleKey(
        key,
        rows,
        blobs,
        hashContent,
        maxAssembledItemBytes,
        decodedBudget,
        Boolean(options.seriesId),
        rows.some(row => row.schema === BOUNDED_ALIGNMENT_PART_SCHEMA_SHARED)
      );
      const decoded = decodeSharedValues(
        key,
        value,
        Boolean(options.seriesId),
        sharedDecodeBudget,
        rows.some(row => row.schema === BOUNDED_ALIGNMENT_PART_SCHEMA_SHARED)
      );
      const previous = output[key];
      if (Array.isArray(decoded) && Array.isArray(previous)) output[key] = [...previous, ...decoded];
      else output[key] = decoded;
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
  allowPartialItems: boolean,
  sharedEncoding: boolean
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
    for (const reference of ordered) validateReferenceMetadata(
      reference,
      maxBytes,
      sharedEncoding,
      sharedEncoding && isSharedAlignmentKey(key)
    );
    if (ordered.length !== first.chunkCount || ordered.some((row, index) => row.chunkIndex !== index
      || row.chunkCount !== first.chunkCount || row.kind !== first.kind || row.totalItems !== first.totalItems)) {
      throw new Error(`bounded alignment artifact fragments are incomplete for ${key}[${first.itemIndex}]`);
    }
    if (sharedEncoding && isSharedAlignmentKey(key)) {
      const seriesIds = first.seriesIds;
      if (!isSingleSeriesIdList(seriesIds)
        || ordered.some(reference => !isSingleSeriesIdList(reference.seriesIds)
          || reference.seriesIds![0] !== seriesIds[0])) {
        throw new Error(`shared alignment artifact series metadata is inconsistent for ${key}[${first.itemIndex}]`);
      }
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
    const parsed = JSON.parse(assembled.toString("utf8")) as JsonValue;
    if (sharedEncoding && isSharedAlignmentKey(key)) {
      if (!isRecord(parsed) || parsed.schema !== SHARED_ALIGNMENT_SERIES_SCHEMA
        || !isSingleSeriesIdList(parsed.seriesIds)
        || parsed.seriesIds[0] !== first.seriesIds![0]) {
        throw new Error(`shared alignment artifact wrapper series metadata is inconsistent for ${key}[${first.itemIndex}]`);
      }
    }
    values.push(parsed);
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
  if (options.seriesId && (reference.key === "alignmentAlternativeSets" || reference.key === "transportEvidenceAllocations") && reference.seriesIds !== undefined) {
    if (!Array.isArray(reference.seriesIds) || !(reference.seriesIds as unknown[]).every(id => typeof id === "string")) {
      throw new Error("alignment artifact series metadata is invalid");
    }
    if (!(reference.seriesIds as unknown[]).includes(options.seriesId)) return false;
  }
  return true;
}

function isSharedAlignmentKey(key: string): key is "alignmentAlternativeSets" | "transportEvidenceAllocations" {
  return key === "alignmentAlternativeSets" || key === "transportEvidenceAllocations";
}

function isSingleSeriesIdList(value: unknown): value is [string] {
  return Array.isArray(value) && value.length === 1 && typeof value[0] === "string" && value[0].length > 0;
}

function decodeSharedValues(
  key: string,
  value: JsonValue | JsonValue[],
  allowSourceIndexGaps = false,
  budget: { used: number; max: number },
  expectShared = false
): JsonValue | JsonValue[] {
  if ((key !== "alignmentAlternativeSets" && key !== "transportEvidenceAllocations") || !Array.isArray(value)) return value;
  const wrappers = value.filter(isSharedSeriesEnvelope);
  if (!wrappers.length) {
    if (expectShared) throw new Error("shared alignment artifact wrapper is missing");
    return value;
  }
  if (wrappers.length !== value.length || wrappers.some(wrapper => wrapper.key !== key)) {
    throw new Error("shared alignment artifact key/encoding mismatch");
  }
  const sourceIndexes = wrappers.flatMap(wrapper => wrapper.items.map(item => item.sourceIndex));
  if (sourceIndexes.length > budget.max - budget.used) throw new Error("shared alignment decoded reference budget exceeded");
  const sortedSourceIndexes = [...sourceIndexes].sort((left, right) => left - right);
  for (let index = 1; index < sortedSourceIndexes.length; index += 1) {
    if (sortedSourceIndexes[index] === sortedSourceIndexes[index - 1]) throw new Error("shared alignment artifact item indexes are incomplete");
  }
  if (!allowSourceIndexGaps && sortedSourceIndexes.some((sourceIndex, index) => sourceIndex !== index)) {
    throw new Error("shared alignment artifact item indexes are incomplete");
  }
  budget.used += sourceIndexes.length;
  const items = wrappers.flatMap(wrapper => {
    const cache = sharedDecodeCache(budget);
    return wrapper.items.map(item => ({ sourceIndex: item.sourceIndex, value: decodeSharedItem(wrapper, item.value, cache) }));
  });
  items.sort((left, right) => left.sourceIndex - right.sourceIndex);
  for (let index = 1; index < items.length; index += 1) {
    if (items[index]!.sourceIndex <= items[index - 1]!.sourceIndex) throw new Error("shared alignment artifact item indexes are incomplete");
  }
  if (!allowSourceIndexGaps && items.some((item, index) => item.sourceIndex !== index)) {
    throw new Error("shared alignment artifact item indexes are incomplete");
  }
  return items.map(item => item.value);
}

type SharedDecodeCache = {
  records: Record<SharedRecordKind, Map<number, JsonValue>>;
  cells: WeakMap<object, JsonValue>;
  budget: { used: number; max: number };
};

function sharedDecodeCache(budget: { used: number; max: number }): SharedDecodeCache {
  const kinds: SharedRecordKind[] = ["columnMarginals", "rowMarginals", "transportCells", "transportShares"];
  return {
    records: Object.fromEntries(kinds.map(kind => [kind, new Map()])) as Record<SharedRecordKind, Map<number, JsonValue>>,
    cells: new WeakMap(),
    budget
  };
}

function decodeSharedItem(wrapper: SharedSeriesEnvelope, value: JsonValue, cache: SharedDecodeCache): JsonValue {
  if (wrapper.key === "alignmentAlternativeSets") {
    if (!isRecord(value) || !Array.isArray(value.hypotheses) || value.seriesId !== wrapper.seriesIds[0]) {
      throw new Error("shared alignment set item series identity is malformed");
    }
    return {
      ...value,
      hypotheses: value.hypotheses.map(hypothesis => {
        if (!isRecord(hypothesis) || !isRecord(hypothesis.plan)) throw new Error("shared alignment hypothesis is malformed");
        return { ...hypothesis, plan: decodeSharedPlan(hypothesis.plan, wrapper.records, cache) };
      })
    } as unknown as JsonValue;
  }
  if (!isRecord(value)) throw new Error("shared transport allocation item is malformed");
  const cells = resolveSharedRefs(value.cells, "transportCells", wrapper.records, cache).map(cell => {
    if (!isRecord(cell)) throw new Error("shared transport cell is malformed");
    const cached = cache.cells.get(cell);
    if (cached) return cached;
    const decoded = Object.freeze({
      ...cell,
      shares: Object.freeze(resolveSharedRefs(cell.shares, "transportShares", wrapper.records, cache))
    }) as unknown as JsonValue;
    cache.cells.set(cell, decoded);
    return decoded;
  });
  return { ...value, cells } as unknown as JsonValue;
}

function decodeSharedPlan(plan: Record<string, unknown>, records: SharedSeriesEnvelope["records"], cache: SharedDecodeCache): JsonValue {
  return {
    ...plan,
    cells: resolveSharedRefs(plan.cells, "transportCells", records, cache),
    rowMarginals: resolveSharedRefs(plan.rowMarginals, "rowMarginals", records, cache),
    columnMarginals: resolveSharedRefs(plan.columnMarginals, "columnMarginals", records, cache)
  } as unknown as JsonValue;
}

function resolveSharedRefs(
  value: unknown,
  kind: SharedRecordKind,
  records: SharedSeriesEnvelope["records"],
  cache: SharedDecodeCache
): JsonValue[] {
  if (!isRecord(value) || value.schema !== SHARED_ALIGNMENT_REFS_SCHEMA || value.kind !== kind || !Array.isArray(value.refs)) {
    throw new Error(`shared alignment ${kind} references are malformed`);
  }
  const dictionary = records[kind];
  if (!Array.isArray(dictionary)) {
    if (value.refs.length === 0) return [];
    throw new Error(`shared alignment ${kind} dictionary is malformed`);
  }
  if (dictionary.length > SHARED_RECORD_MAX_COUNT) throw new Error(`shared alignment ${kind} dictionary is malformed`);
  if (value.refs.length > SHARED_RECORD_MAX_REFERENCES) throw new Error(`shared alignment ${kind} reference count exceeds bound`);
  if (value.refs.length > cache.budget.max - cache.budget.used) throw new Error("shared alignment decoded reference budget exceeded");
  cache.budget.used += value.refs.length;
  const output = value.refs.map(ref => {
    if (!Number.isSafeInteger(ref) || ref < 0 || ref >= dictionary.length) throw new Error(`shared alignment ${kind} reference is out of range`);
    const cached = cache.records[kind].get(ref);
    if (cached !== undefined) return cached;
    if (cache.budget.used >= cache.budget.max) throw new Error("shared alignment decoded reference budget exceeded");
    const decoded = freezeSharedRecord(dictionary[ref]!);
    cache.records[kind].set(ref, decoded);
    cache.budget.used += 1;
    return decoded;
  });
  return output;
}

function isSharedSeriesEnvelope(value: unknown): value is SharedSeriesEnvelope {
  if (!isRecord(value) || value.schema !== SHARED_ALIGNMENT_SERIES_SCHEMA) return false;
  if ((value.key !== "alignmentAlternativeSets" && value.key !== "transportEvidenceAllocations")
    || !isSingleSeriesIdList(value.seriesIds)
    || !isRecord(value.records) || !Array.isArray(value.items)) throw new Error("shared alignment series envelope is malformed");
  const kinds: SharedRecordKind[] = ["columnMarginals", "rowMarginals", "transportCells", "transportShares"];
  for (const [kind, dictionary] of Object.entries(value.records)) {
    if (!kinds.includes(kind as SharedRecordKind) || !Array.isArray(dictionary) || dictionary.length > SHARED_RECORD_MAX_COUNT) {
      throw new Error("shared alignment record dictionary is malformed");
    }
    for (const record of dictionary) {
      if (!isRecord(record)) throw new Error("shared alignment dictionary record is malformed");
      assertAcyclicJson(record);
    }
  }
  if (value.items.length > SHARED_RECORD_MAX_COUNT) throw new Error("shared alignment item count exceeds bound");
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) throw new Error("shared alignment item wrapper is malformed");
    const sourceIndex = rawItem.sourceIndex;
    if (!Number.isSafeInteger(sourceIndex) || (sourceIndex as number) < 0
      || (sourceIndex as number) >= SHARED_RECORD_MAX_COUNT || !("value" in rawItem)) {
      throw new Error("shared alignment item wrapper is malformed");
    }
  }
  return true;
}

function freezeSharedRecord(value: JsonValue, depth = 0): JsonValue {
  if (depth > SHARED_RECORD_MAX_DEPTH) throw new Error("shared alignment record depth exceeds bound");
  if (Array.isArray(value)) {
    for (const child of value) freezeSharedRecord(child, depth + 1);
    return Object.freeze(value) as unknown as JsonValue;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) freezeSharedRecord(child as JsonValue, depth + 1);
    return Object.freeze(value) as unknown as JsonValue;
  }
  return value;
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

function validateReferenceMetadata(
  reference: BoundedAlignmentArtifactRef,
  maxBytes: number,
  shared?: boolean,
  requireSeriesMetadata = false
): void {
  const schemaValid = shared === undefined
    ? reference?.schema === BOUNDED_ALIGNMENT_PART_SCHEMA || reference?.schema === BOUNDED_ALIGNMENT_PART_SCHEMA_SHARED
    : reference?.schema === (shared ? BOUNDED_ALIGNMENT_PART_SCHEMA_SHARED : BOUNDED_ALIGNMENT_PART_SCHEMA);
  if (!isRecord(reference) || !schemaValid
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
  if (requireSeriesMetadata && !isSingleSeriesIdList(reference.seriesIds)) {
    throw new Error("shared alignment artifact series metadata is invalid");
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

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
  }
  return false;
}

function assertAcyclicJson(value: unknown, active = new Set<object>(), depth = 0): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("shared alignment record contains a non-finite number");
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "bigint" || typeof value === "symbol") throw new Error("shared alignment record is not JSON-safe");
    return;
  }
  if (depth > SHARED_RECORD_MAX_DEPTH) throw new Error("shared alignment record depth exceeds bound");
  if (active.has(value)) throw new Error("shared alignment record contains a cycle");
  active.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("shared alignment record contains an accessor");
    assertAcyclicJson(descriptor.value, active, depth + 1);
  }
  active.delete(value);
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
