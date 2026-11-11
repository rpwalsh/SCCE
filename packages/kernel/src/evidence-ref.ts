// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  informationLabelAllowsRead,
  normalizeInformationLabel
} from "./information-flow.js";
import type {
  Brand,
  ContentHash,
  EvidenceId,
  Hasher,
  InformationAccessContext,
  InformationExportClass,
  InformationLabel,
  InformationMergePolicy,
  SourceVersionId
} from "./types.js";

export type CorpusObjectManifestId = Brand<string, "CorpusObjectManifestId">;

export interface ImmutableInformationLabel {
  readonly tenantId: string;
  readonly principals: readonly string[];
  readonly compartments: readonly string[];
  readonly exportClass: InformationExportClass;
  readonly mergePolicy: InformationMergePolicy;
}

export type EvidencePromotion =
  | { readonly state: "pending" }
  | { readonly state: "promoted"; readonly promotedRevision: string }
  | {
    readonly state: "revoked";
    readonly promotedRevision: string;
    readonly revokedRevision: string;
  };

/** Source-level facts stored once for every immutable corpus object/version. */
export interface CorpusObjectManifest {
  readonly schema: "scce.corpus_object_manifest.v1";
  readonly manifestId: CorpusObjectManifestId;
  readonly sourceVersionId: SourceVersionId;
  readonly objectContentHash: ContentHash;
  readonly objectByteLength: number;
  readonly informationLabel: ImmutableInformationLabel;
  readonly temporalRevision: string;
}

export interface CorpusObjectManifestInput {
  readonly manifestId: CorpusObjectManifestId;
  readonly sourceVersionId: SourceVersionId;
  readonly objectContentHash: ContentHash;
  readonly objectByteLength: number;
  readonly informationLabel: ImmutableInformationLabel;
  readonly temporalRevision: string;
}

/** Compact durable identity for one exact UTF-8 byte slice. */
export interface EvidenceRef {
  readonly schema: "scce.evidence_ref.v2";
  readonly evidenceId: EvidenceId;
  readonly manifestId: CorpusObjectManifestId;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly sliceContentHash: ContentHash;
  readonly promotion: EvidencePromotion;
}

export interface EvidenceRefInput {
  readonly evidenceId: EvidenceId;
  readonly manifestId: CorpusObjectManifestId;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly sliceContentHash: ContentHash;
  readonly promotion: EvidencePromotion;
}

export interface CorpusSliceRangeReadRequest {
  readonly requestKey: string;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface CorpusSliceRangeReadResult extends CorpusSliceRangeReadRequest {
  readonly bytes: Uint8Array;
}

/** One request owns all distinct ranges needed from one immutable object. */
export interface CorpusObjectSliceReadRequest {
  readonly requestKey: string;
  readonly manifestId: CorpusObjectManifestId;
  readonly sourceVersionId: SourceVersionId;
  readonly objectContentHash: ContentHash;
  readonly objectByteLength: number;
  readonly temporalRevision: string;
  readonly slices: readonly CorpusSliceRangeReadRequest[];
}

export interface CorpusObjectSliceReadResult
  extends Omit<CorpusObjectSliceReadRequest, "slices"> {
  readonly slices: readonly CorpusSliceRangeReadResult[];
}

/**
 * Corpus byte-range I/O. Authoritative ref and manifest indexes are separate
 * storage-facing metadata ports; requests are grouped so each object is opened once.
 */
export interface CorpusSliceReader {
  readObjectSlices(
    requests: readonly CorpusObjectSliceReadRequest[]
  ): Promise<readonly CorpusObjectSliceReadResult[]>;
}

export interface AuthoritativeEvidenceRefIndex {
  get(evidenceId: EvidenceId): EvidenceRef | undefined;
}

export interface AuthoritativeCorpusObjectManifestIndex {
  get(manifestId: CorpusObjectManifestId): CorpusObjectManifest | undefined;
}

export interface EvidenceResolveLimits {
  /** Logical references requested, including duplicate physical slices. */
  readonly maxRefs: number;
  /** Logical output bytes requested, including duplicate physical slices. */
  readonly maxBytes: number;
}

export interface ResolveEvidenceRefsInput {
  readonly refs: readonly EvidenceRef[];
  /** Required trust anchors. Caller-supplied refs and reader echoes are never authoritative. */
  readonly referenceIndex: AuthoritativeEvidenceRefIndex;
  readonly manifestIndex: AuthoritativeCorpusObjectManifestIndex;
  readonly reader: CorpusSliceReader;
  readonly hasher: Hasher;
  readonly access: InformationAccessContext;
  readonly currentRevisions: ReadonlyMap<SourceVersionId, string>;
  readonly limits: EvidenceResolveLimits;
}

export type EvidenceResolveFailureReason =
  | "bounds_exceeded"
  | "invalid_ref"
  | "untrusted"
  | "mismatch"
  | "not_promoted"
  | "revoked"
  | "stale"
  | "inaccessible"
  | "missing"
  | "extra"
  | "tampered"
  | "reader_failed";

export interface EvidenceResolveFailure {
  readonly reason: EvidenceResolveFailureReason;
  readonly field: string;
  readonly message: string;
  readonly evidenceId?: EvidenceId;
  readonly requestKey?: string;
}

export interface ResolvedEvidenceSlice {
  readonly ref: EvidenceRef;
  /** A defensive copy of the exact verified bytes. */
  readonly bytes: Uint8Array;
  /** Fatal UTF-8 decoding of `bytes`; byte offsets remain authoritative. */
  readonly text: string;
}

export type ResolveEvidenceRefsResult =
  | {
    readonly ok: true;
    readonly slices: readonly ResolvedEvidenceSlice[];
    readonly logicalBytes: number;
    /** Distinct byte ranges read after slice deduplication. */
    readonly physicalReads: number;
    /** Distinct immutable objects opened after manifest grouping. */
    readonly objectReads: number;
  }
  | { readonly ok: false; readonly failures: readonly EvidenceResolveFailure[] };

interface CanonicalRef {
  readonly ref: EvidenceRef;
  readonly manifest: CorpusObjectManifest;
}

interface PreparedRef extends CanonicalRef {
  readonly objectRequestKey: string;
  readonly sliceRequestKey: string;
}

interface VerifiedPhysicalSlice {
  readonly bytes: Uint8Array;
  readonly text: string;
}

type ManifestLookup =
  | { readonly ok: true; readonly manifest: CorpusObjectManifest }
  | { readonly ok: false; readonly field: string; readonly message: string };

const MANIFEST_INPUT_FIELDS = [
  "manifestId",
  "sourceVersionId",
  "objectContentHash",
  "objectByteLength",
  "informationLabel",
  "temporalRevision"
] as const;
const MANIFEST_FIELDS = ["schema", ...MANIFEST_INPUT_FIELDS] as const;
const EVIDENCE_REF_INPUT_FIELDS = [
  "evidenceId",
  "manifestId",
  "byteStart",
  "byteEnd",
  "sliceContentHash",
  "promotion"
] as const;
const EVIDENCE_REF_FIELDS = ["schema", ...EVIDENCE_REF_INPUT_FIELDS] as const;
const INFORMATION_LABEL_FIELDS = [
  "tenantId",
  "principals",
  "compartments",
  "exportClass",
  "mergePolicy"
] as const;
const CORPUS_OBJECT_RESULT_FIELDS = [
  "requestKey",
  "manifestId",
  "sourceVersionId",
  "objectContentHash",
  "objectByteLength",
  "temporalRevision",
  "slices"
] as const;
const CORPUS_SLICE_RESULT_FIELDS = ["requestKey", "byteStart", "byteEnd", "bytes"] as const;

export function contentHashForBytes(bytes: Uint8Array, hasher: Hasher): ContentHash {
  const digest = hasher.digestHex(bytes).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("hasher must return a 64-character hexadecimal SHA-256 digest");
  }
  return `sha256_${digest}` as ContentHash;
}

export function createCorpusObjectManifest(
  input: CorpusObjectManifestInput
): CorpusObjectManifest {
  assertExactFields(input, MANIFEST_INPUT_FIELDS, "CorpusObjectManifest input");
  return buildCorpusObjectManifest(input);
}

export function createEvidenceRef(input: EvidenceRefInput): EvidenceRef {
  assertExactFields(input, EVIDENCE_REF_INPUT_FIELDS, "EvidenceRef input");
  return buildEvidenceRef(input);
}

function canonicalizeCorpusObjectManifest(candidate: CorpusObjectManifest): CorpusObjectManifest {
  assertExactFields(candidate, MANIFEST_FIELDS, "CorpusObjectManifest");
  if (candidate.schema !== "scce.corpus_object_manifest.v1") {
    throw new Error("unsupported CorpusObjectManifest schema");
  }
  return buildCorpusObjectManifest(candidate);
}

function buildCorpusObjectManifest(input: CorpusObjectManifestInput): CorpusObjectManifest {
  assertExactFields(input.informationLabel, INFORMATION_LABEL_FIELDS, "informationLabel");
  const normalizedLabel = normalizeInformationLabel(mutableLabel(input.informationLabel));
  const informationLabel: ImmutableInformationLabel = Object.freeze({
    ...normalizedLabel,
    principals: Object.freeze([...normalizedLabel.principals]),
    compartments: Object.freeze([...normalizedLabel.compartments])
  });
  return Object.freeze({
    schema: "scce.corpus_object_manifest.v1" as const,
    manifestId: requiredIdentity(input.manifestId, "manifestId") as CorpusObjectManifestId,
    sourceVersionId: requiredIdentity(input.sourceVersionId, "sourceVersionId") as SourceVersionId,
    objectContentHash: canonicalContentHash(input.objectContentHash, "objectContentHash"),
    objectByteLength: nonNegativeSafeInteger(input.objectByteLength, "objectByteLength"),
    informationLabel,
    temporalRevision: requiredIdentity(input.temporalRevision, "temporalRevision")
  });
}

function canonicalizeEvidenceRef(candidate: EvidenceRef): EvidenceRef {
  assertExactFields(candidate, EVIDENCE_REF_FIELDS, "EvidenceRef");
  if (candidate.schema !== "scce.evidence_ref.v2") {
    throw new Error("unsupported EvidenceRef schema");
  }
  return buildEvidenceRef(candidate);
}

function buildEvidenceRef(input: EvidenceRefInput): EvidenceRef {
  const byteStart = nonNegativeSafeInteger(input.byteStart, "byteStart");
  const byteEnd = nonNegativeSafeInteger(input.byteEnd, "byteEnd");
  if (byteEnd <= byteStart) throw new Error("evidence byte range must be non-empty");
  return Object.freeze({
    schema: "scce.evidence_ref.v2" as const,
    evidenceId: requiredIdentity(input.evidenceId, "evidenceId") as EvidenceId,
    manifestId: requiredIdentity(input.manifestId, "manifestId") as CorpusObjectManifestId,
    byteStart,
    byteEnd,
    sliceContentHash: canonicalContentHash(input.sliceContentHash, "sliceContentHash"),
    promotion: freezePromotion(input.promotion)
  });
}

/** Resolves a batch atomically while preserving logical caller order. */
export async function resolveEvidenceRefs(
  input: ResolveEvidenceRefsInput
): Promise<ResolveEvidenceRefsResult> {
  const failures: EvidenceResolveFailure[] = [];
  const maxRefs = validLimit(input.limits.maxRefs, "limits.maxRefs", failures);
  const maxBytes = validLimit(input.limits.maxBytes, "limits.maxBytes", failures);
  if (input.refs.length > maxRefs) {
    failures.push(failure(
      "bounds_exceeded",
      "refs",
      `evidence batch has ${input.refs.length} refs; maximum is ${maxRefs}`
    ));
  }
  // Reference and manifest indexes are storage-facing authority ports. A batch that is already outside its
  // execution contract must not turn maxRefs into a reporting-only limit and still perform O(input) lookups.
  if (failures.length) return failed(failures);

  const manifestCache = new Map<CorpusObjectManifestId, ManifestLookup>();
  const canonicalRefs: CanonicalRef[] = [];
  let logicalBytes = 0;
  for (const candidate of input.refs) {
    let requestedRef: EvidenceRef;
    try {
      requestedRef = canonicalizeEvidenceRef(candidate);
    } catch (error) {
      failures.push(failure("invalid_ref", "ref", errorMessage(error), safeEvidenceId(candidate)));
      continue;
    }

    let authorityCandidate: EvidenceRef | undefined;
    try {
      authorityCandidate = input.referenceIndex.get(requestedRef.evidenceId);
    } catch (error) {
      failures.push(failure(
        "untrusted",
        "referenceIndex",
        `authoritative reference lookup failed: ${errorMessage(error)}`,
        requestedRef.evidenceId
      ));
      continue;
    }
    if (!authorityCandidate) {
      failures.push(failure(
        "untrusted",
        "evidenceId",
        "evidenceId is absent from the authoritative reference index",
        requestedRef.evidenceId
      ));
      continue;
    }

    let ref: EvidenceRef;
    try {
      ref = canonicalizeEvidenceRef(authorityCandidate);
    } catch (error) {
      failures.push(failure(
        "untrusted",
        "referenceIndex",
        `authoritative EvidenceRef is invalid: ${errorMessage(error)}`,
        requestedRef.evidenceId
      ));
      continue;
    }
    if (ref.evidenceId !== requestedRef.evidenceId) {
      failures.push(failure(
        "untrusted",
        "referenceIndex.evidenceId",
        "authoritative index key does not match its EvidenceRef evidenceId",
        requestedRef.evidenceId
      ));
      continue;
    }
    const mismatchFields = evidenceRefMismatchFields(requestedRef, ref);
    if (mismatchFields.length) {
      for (const field of mismatchFields) {
        failures.push(failure(
          "mismatch",
          field,
          `requested ${field} does not match the authoritative EvidenceRef`,
          requestedRef.evidenceId
        ));
      }
      continue;
    }

    const manifestLookup = authoritativeManifest(ref.manifestId, input.manifestIndex, manifestCache);
    if (!manifestLookup.ok) {
      failures.push(failure(
        "untrusted",
        manifestLookup.field,
        manifestLookup.message,
        ref.evidenceId
      ));
      continue;
    }
    const manifest = manifestLookup.manifest;
    const sliceLength = ref.byteEnd - ref.byteStart;
    logicalBytes += sliceLength;
    if (!Number.isSafeInteger(logicalBytes)) {
      failures.push(failure(
        "bounds_exceeded",
        "bytes",
        "evidence batch logical byte count exceeds safe integer range",
        ref.evidenceId
      ));
    }
    if (ref.byteEnd > manifest.objectByteLength) {
      failures.push(failure(
        "bounds_exceeded",
        "byteEnd",
        `evidence byte range ends at ${ref.byteEnd}; object length is ${manifest.objectByteLength}`,
        ref.evidenceId
      ));
    }

    if (ref.promotion.state === "pending") {
      failures.push(failure("not_promoted", "promotion.state", "evidence has not been promoted", ref.evidenceId));
    } else if (ref.promotion.state === "revoked") {
      failures.push(failure(
        "revoked",
        "promotion.state",
        `evidence was revoked at revision ${ref.promotion.revokedRevision}`,
        ref.evidenceId
      ));
    }

    let currentRevision: string | undefined;
    try {
      currentRevision = input.currentRevisions.get(manifest.sourceVersionId);
    } catch (error) {
      failures.push(failure(
        "stale",
        "temporalRevision",
        `authoritative revision lookup failed: ${errorMessage(error)}`,
        ref.evidenceId
      ));
      continue;
    }
    if (currentRevision === undefined || currentRevision !== manifest.temporalRevision) {
      failures.push(failure(
        "stale",
        "temporalRevision",
        currentRevision === undefined
          ? "no authoritative current revision exists for this source version"
          : `manifest revision ${manifest.temporalRevision} is not current revision ${currentRevision}`,
        ref.evidenceId
      ));
    }

    let accessAllowed = false;
    try {
      accessAllowed = informationLabelAllowsRead(mutableLabel(manifest.informationLabel), input.access);
    } catch {
      accessAllowed = false;
    }
    if (!accessAllowed) {
      failures.push(failure(
        "inaccessible",
        "informationLabel",
        "information-flow policy denies access to this evidence object",
        ref.evidenceId
      ));
    }
    canonicalRefs.push({ ref, manifest });
  }

  if (logicalBytes > maxBytes) {
    failures.push(failure(
      "bounds_exceeded",
      "bytes",
      `evidence batch requests ${logicalBytes} logical bytes; maximum is ${maxBytes}`
    ));
  }
  if (failures.length) return failed(failures);
  if (!canonicalRefs.length) {
    return Object.freeze({
      ok: true as const,
      slices: Object.freeze([]),
      logicalBytes: 0,
      physicalReads: 0,
      objectReads: 0
    });
  }

  const grouped = new Map<CorpusObjectManifestId, {
    readonly manifest: CorpusObjectManifest;
    readonly objectRequestKey: string;
    readonly slices: CorpusSliceRangeReadRequest[];
    readonly sliceByRange: Map<string, CorpusSliceRangeReadRequest>;
  }>();
  const prepared: PreparedRef[] = [];
  let physicalReads = 0;
  for (const item of canonicalRefs) {
    let objectGroup = grouped.get(item.manifest.manifestId);
    if (!objectGroup) {
      objectGroup = {
        manifest: item.manifest,
        objectRequestKey: `object.${grouped.size}`,
        slices: [],
        sliceByRange: new Map()
      };
      grouped.set(item.manifest.manifestId, objectGroup);
    }
    const rangeKey = JSON.stringify([item.ref.byteStart, item.ref.byteEnd]);
    let sliceRequest = objectGroup.sliceByRange.get(rangeKey);
    if (!sliceRequest) {
      sliceRequest = Object.freeze({
        requestKey: `slice.${physicalReads}`,
        byteStart: item.ref.byteStart,
        byteEnd: item.ref.byteEnd
      });
      physicalReads += 1;
      objectGroup.sliceByRange.set(rangeKey, sliceRequest);
      objectGroup.slices.push(sliceRequest);
    }
    prepared.push({
      ...item,
      objectRequestKey: objectGroup.objectRequestKey,
      sliceRequestKey: sliceRequest.requestKey
    });
  }

  const requests: CorpusObjectSliceReadRequest[] = [...grouped.values()].map(group => Object.freeze({
    requestKey: group.objectRequestKey,
    manifestId: group.manifest.manifestId,
    sourceVersionId: group.manifest.sourceVersionId,
    objectContentHash: group.manifest.objectContentHash,
    objectByteLength: group.manifest.objectByteLength,
    temporalRevision: group.manifest.temporalRevision,
    slices: Object.freeze([...group.slices])
  }));

  let results: readonly unknown[];
  try {
    results = await input.reader.readObjectSlices(Object.freeze([...requests]));
  } catch (error) {
    return failed([failure("reader_failed", "reader", errorMessage(error))]);
  }
  if (!Array.isArray(results)) {
    return failed([failure("reader_failed", "reader", "CorpusSliceReader returned a non-array result")]);
  }

  const requestsByKey = new Map(requests.map(request => [request.requestKey, request]));
  const preparedByPhysicalKey = new Map<string, PreparedRef[]>();
  for (const item of prepared) {
    const key = physicalResultKey(item.objectRequestKey, item.sliceRequestKey);
    const group = preparedByPhysicalKey.get(key);
    if (group) group.push(item);
    else preparedByPhysicalKey.set(key, [item]);
  }
  const objectResultKeys = new Set<string>();
  const sliceResultKeys = new Set<string>();
  const verified = new Map<string, VerifiedPhysicalSlice>();
  for (const rawResult of results) {
    let result: CorpusObjectSliceReadResult;
    try {
      result = materializeCorpusObjectResult(rawResult);
    } catch (error) {
      failures.push(failure("tampered", "reader.result", errorMessage(error)));
      continue;
    }
    const objectRequest = requestsByKey.get(result.requestKey);
    if (!objectRequest || objectResultKeys.has(result.requestKey)) {
      failures.push(failure(
        "extra",
        "requestKey",
        !objectRequest
          ? `reader returned unknown object request key ${result.requestKey || "<empty>"}`
          : `reader returned object request key ${result.requestKey} more than once`,
        undefined,
        result.requestKey || undefined
      ));
      continue;
    }
    objectResultKeys.add(result.requestKey);
    verifyEchoedObjectIdentity(objectRequest, result, failures);
    if (!Array.isArray(result.slices)) {
      failures.push(failure("tampered", "slices", "reader object result slices are not an array", undefined, result.requestKey));
      continue;
    }
    const requestedSlices = new Map(objectRequest.slices.map(slice => [slice.requestKey, slice]));
    for (const rawSlice of result.slices as readonly unknown[]) {
      let slice: CorpusSliceRangeReadResult;
      try {
        slice = materializeCorpusSliceResult(rawSlice);
      } catch (error) {
        failures.push(failure("tampered", "reader.slice", errorMessage(error), undefined, result.requestKey));
        continue;
      }
      const physicalKey = physicalResultKey(result.requestKey, slice.requestKey);
      const requestedSlice = requestedSlices.get(slice.requestKey);
      if (!requestedSlice || sliceResultKeys.has(physicalKey)) {
        failures.push(failure(
          "extra",
          "requestKey",
          !requestedSlice
            ? `reader returned unknown slice request key ${slice.requestKey || "<empty>"}`
            : `reader returned slice request key ${slice.requestKey} more than once`,
          undefined,
          slice.requestKey || undefined
        ));
        continue;
      }
      sliceResultKeys.add(physicalKey);
      verifyEchoedSliceIdentity(requestedSlice, slice, failures, result.requestKey);
      if (!(slice.bytes instanceof Uint8Array)) {
        failures.push(failure("tampered", "bytes", "reader result bytes are not a Uint8Array", undefined, slice.requestKey));
        continue;
      }
      const expectedLength = requestedSlice.byteEnd - requestedSlice.byteStart;
      if (slice.bytes.byteLength !== expectedLength) {
        failures.push(failure(
          "tampered",
          "bytes.length",
          `reader returned ${slice.bytes.byteLength} bytes; expected ${expectedLength}`,
          undefined,
          slice.requestKey
        ));
        continue;
      }
      let actualHash: ContentHash;
      try {
        actualHash = contentHashForBytes(slice.bytes, input.hasher);
      } catch (error) {
        failures.push(failure("tampered", "sliceContentHash", errorMessage(error), undefined, slice.requestKey));
        continue;
      }
      let everyHashMatches = true;
      for (const item of preparedByPhysicalKey.get(physicalKey) ?? []) {
        if (actualHash === item.ref.sliceContentHash) continue;
        everyHashMatches = false;
        failures.push(failure(
          "tampered",
          "sliceContentHash",
          `resolved bytes hash ${actualHash} does not match ${item.ref.sliceContentHash}`,
          item.ref.evidenceId,
          slice.requestKey
        ));
      }
      if (!everyHashMatches) continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(slice.bytes);
      } catch {
        failures.push(failure(
          "tampered",
          "bytes.utf8",
          "resolved slice is not valid complete UTF-8",
          undefined,
          slice.requestKey
        ));
        continue;
      }
      verified.set(physicalKey, { bytes: slice.bytes.slice(), text });
    }
  }

  for (const request of requests) {
    if (!objectResultKeys.has(request.requestKey)) {
      failures.push(failure(
        "missing",
        "requestKey",
        `reader omitted object request key ${request.requestKey}`,
        undefined,
        request.requestKey
      ));
      continue;
    }
    for (const slice of request.slices) {
      const key = physicalResultKey(request.requestKey, slice.requestKey);
      if (!sliceResultKeys.has(key)) {
        failures.push(failure(
          "missing",
          "requestKey",
          `reader omitted slice request key ${slice.requestKey}`,
          undefined,
          slice.requestKey
        ));
      }
    }
  }
  if (failures.length) return failed(failures);

  const slices = prepared.map(item => {
    const physical = verified.get(physicalResultKey(item.objectRequestKey, item.sliceRequestKey))!;
    return Object.freeze({ ref: item.ref, bytes: physical.bytes.slice(), text: physical.text });
  });
  return Object.freeze({
    ok: true as const,
    slices: Object.freeze(slices),
    logicalBytes,
    physicalReads,
    objectReads: requests.length
  });
}

function authoritativeManifest(
  manifestId: CorpusObjectManifestId,
  index: AuthoritativeCorpusObjectManifestIndex,
  cache: Map<CorpusObjectManifestId, ManifestLookup>
): ManifestLookup {
  const cached = cache.get(manifestId);
  if (cached) return cached;
  let lookup: ManifestLookup;
  try {
    const candidate = index.get(manifestId);
    if (!candidate) {
      lookup = {
        ok: false,
        field: "manifestId",
        message: "manifestId is absent from the authoritative manifest index"
      };
    } else {
      const manifest = canonicalizeCorpusObjectManifest(candidate);
      lookup = manifest.manifestId === manifestId
        ? { ok: true, manifest }
        : {
          ok: false,
          field: "manifestIndex.manifestId",
          message: "authoritative manifest index key does not match its manifestId"
        };
    }
  } catch (error) {
    lookup = {
      ok: false,
      field: "manifestIndex",
      message: `authoritative manifest lookup failed: ${errorMessage(error)}`
    };
  }
  cache.set(manifestId, lookup);
  return lookup;
}

function verifyEchoedObjectIdentity(
  request: CorpusObjectSliceReadRequest,
  result: CorpusObjectSliceReadResult,
  failures: EvidenceResolveFailure[]
): void {
  const comparisons: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["manifestId", result.manifestId, request.manifestId],
    ["sourceVersionId", result.sourceVersionId, request.sourceVersionId],
    ["objectContentHash", result.objectContentHash, request.objectContentHash],
    ["objectByteLength", result.objectByteLength, request.objectByteLength],
    ["temporalRevision", result.temporalRevision, request.temporalRevision]
  ];
  for (const [field, actual, expected] of comparisons) {
    if (actual !== expected) {
      failures.push(failure(
        "tampered",
        field,
        `reader echoed ${field}=${String(actual)}; expected ${String(expected)}`,
        undefined,
        request.requestKey
      ));
    }
  }
}

function verifyEchoedSliceIdentity(
  request: CorpusSliceRangeReadRequest,
  result: CorpusSliceRangeReadResult,
  failures: EvidenceResolveFailure[],
  objectRequestKey: string
): void {
  for (const [field, actual, expected] of [
    ["byteStart", result.byteStart, request.byteStart],
    ["byteEnd", result.byteEnd, request.byteEnd]
  ] as const) {
    if (actual !== expected) {
      failures.push(failure(
        "tampered",
        field,
        `reader echoed ${field}=${String(actual)}; expected ${String(expected)}`,
        undefined,
        `${objectRequestKey}/${request.requestKey}`
      ));
    }
  }
}

function evidenceRefMismatchFields(requested: EvidenceRef, authoritative: EvidenceRef): string[] {
  const fields: string[] = [];
  for (const [field, actual, expected] of [
    ["schema", requested.schema, authoritative.schema],
    ["evidenceId", requested.evidenceId, authoritative.evidenceId],
    ["manifestId", requested.manifestId, authoritative.manifestId],
    ["byteStart", requested.byteStart, authoritative.byteStart],
    ["byteEnd", requested.byteEnd, authoritative.byteEnd],
    ["sliceContentHash", requested.sliceContentHash, authoritative.sliceContentHash],
    ["promotion.state", requested.promotion.state, authoritative.promotion.state]
  ] as const) {
    if (actual !== expected) fields.push(field);
  }
  if (
    requested.promotion.state !== "pending"
    && authoritative.promotion.state !== "pending"
    && requested.promotion.promotedRevision !== authoritative.promotion.promotedRevision
  ) {
    fields.push("promotion.promotedRevision");
  }
  if (
    requested.promotion.state === "revoked"
    && authoritative.promotion.state === "revoked"
    && requested.promotion.revokedRevision !== authoritative.promotion.revokedRevision
  ) {
    fields.push("promotion.revokedRevision");
  }
  return fields;
}

function materializeCorpusObjectResult(value: unknown): CorpusObjectSliceReadResult {
  assertExactFields(value, CORPUS_OBJECT_RESULT_FIELDS, "CorpusObjectSliceReadResult");
  const result = value as unknown as CorpusObjectSliceReadResult;
  return {
    requestKey: result.requestKey,
    manifestId: result.manifestId,
    sourceVersionId: result.sourceVersionId,
    objectContentHash: result.objectContentHash,
    objectByteLength: result.objectByteLength,
    temporalRevision: result.temporalRevision,
    slices: result.slices
  };
}

function materializeCorpusSliceResult(value: unknown): CorpusSliceRangeReadResult {
  assertExactFields(value, CORPUS_SLICE_RESULT_FIELDS, "CorpusSliceRangeReadResult");
  const result = value as unknown as CorpusSliceRangeReadResult;
  return {
    requestKey: result.requestKey,
    byteStart: result.byteStart,
    byteEnd: result.byteEnd,
    bytes: result.bytes
  };
}

function physicalResultKey(objectRequestKey: string, sliceRequestKey: string): string {
  return `${objectRequestKey}\u0000${sliceRequestKey}`;
}

function canonicalContentHash(value: ContentHash, field: string): ContentHash {
  const match = /^(?:sha256_)?([0-9a-f]{64})$/i.exec(String(value));
  if (!match) throw new Error(`${field} must be a SHA-256 content hash`);
  return `sha256_${match[1]!.toLowerCase()}` as ContentHash;
}

function freezePromotion(promotion: EvidencePromotion): EvidencePromotion {
  if (!isPlainRecord(promotion)) throw new Error("promotion must be a plain object");
  if (promotion.state === "pending") {
    assertExactFields(promotion, ["state"], "promotion");
    return Object.freeze({ state: "pending" as const });
  }
  if (promotion.state === "promoted") {
    assertExactFields(promotion, ["state", "promotedRevision"], "promotion");
    return Object.freeze({
      state: "promoted" as const,
      promotedRevision: requiredIdentity(promotion.promotedRevision, "promotion.promotedRevision")
    });
  }
  if (promotion.state === "revoked") {
    assertExactFields(promotion, ["state", "promotedRevision", "revokedRevision"], "promotion");
    return Object.freeze({
      state: "revoked" as const,
      promotedRevision: requiredIdentity(promotion.promotedRevision, "promotion.promotedRevision"),
      revokedRevision: requiredIdentity(promotion.revokedRevision, "promotion.revokedRevision")
    });
  }
  throw new Error("promotion.state must be pending, promoted, or revoked");
}

function mutableLabel(label: ImmutableInformationLabel): InformationLabel {
  return {
    tenantId: label.tenantId,
    principals: [...label.principals],
    compartments: [...label.compartments],
    exportClass: label.exportClass,
    mergePolicy: label.mergePolicy
  };
}

function assertExactFields(
  value: unknown,
  expectedFields: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object`);
  const expected = new Set(expectedFields);
  const ownKeys = Reflect.ownKeys(value);
  const unexpected = ownKeys.filter(key => typeof key !== "string" || !expected.has(key));
  if (unexpected.length) throw new Error(`${label} has unexpected field ${String(unexpected[0])}`);
  const missing = expectedFields.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length) throw new Error(`${label} is missing required field ${missing[0]}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function validLimit(value: number, field: string, failures: EvidenceResolveFailure[]): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    failures.push(failure("bounds_exceeded", field, `${field} must be a non-negative safe integer`));
    return 0;
  }
  return value;
}

function failure(
  reason: EvidenceResolveFailureReason,
  field: string,
  message: string,
  evidenceId?: EvidenceId,
  requestKey?: string
): EvidenceResolveFailure {
  return Object.freeze({
    reason,
    field,
    message,
    ...(evidenceId === undefined ? {} : { evidenceId }),
    ...(requestKey === undefined ? {} : { requestKey })
  });
}

function failed(failures: readonly EvidenceResolveFailure[]): ResolveEvidenceRefsResult {
  return Object.freeze({ ok: false as const, failures: Object.freeze([...failures]) });
}

function safeEvidenceId(candidate: EvidenceRef): EvidenceId | undefined {
  try {
    return typeof candidate?.evidenceId === "string" && candidate.evidenceId
      ? candidate.evidenceId
      : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
