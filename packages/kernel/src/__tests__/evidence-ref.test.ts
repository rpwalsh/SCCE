// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  contentHashForBytes,
  createCorpusObjectManifest,
  createEvidenceRef,
  resolveEvidenceRefs
} from "../evidence-ref.js";
import type {
  AuthoritativeCorpusObjectManifestIndex,
  AuthoritativeEvidenceRefIndex,
  CorpusObjectManifest,
  CorpusObjectManifestId,
  CorpusObjectSliceReadRequest,
  CorpusObjectSliceReadResult,
  CorpusSliceReader,
  CorpusSliceRangeReadResult,
  EvidencePromotion,
  EvidenceRef,
  EvidenceRefInput,
  ImmutableInformationLabel
} from "../evidence-ref.js";
import { createHasher } from "../primitives.js";
import type {
  ContentHash,
  EvidenceId,
  InformationAccessContext,
  SourceVersionId
} from "../types.js";

const hasher = createHasher();
const encoder = new TextEncoder();
const access: InformationAccessContext = {
  tenantId: "tenant.alpha",
  principalId: "owner.alpha",
  compartments: ["project.red"],
  maximumExportClass: "restricted"
};
const label: ImmutableInformationLabel = {
  tenantId: "tenant.alpha",
  principals: ["owner.alpha"],
  compartments: ["project.red"],
  exportClass: "confidential",
  mergePolicy: "same_owner"
};

describe("EvidenceRef", () => {
  it("resolves an exact Unicode UTF-8 slice through one immutable source manifest", async () => {
    const objectText = "before\u{1f642} caf\u00e9 \u03a9after";
    const sliceText = "\u{1f642} caf\u00e9 \u03a9";
    const objectBytes = encoder.encode(objectText);
    const byteStart = encoder.encode("before").byteLength;
    const sliceBytes = encoder.encode(sliceText);
    const source = corpusObject(objectBytes);
    const ref = source.ref(byteStart, byteStart + sliceBytes.byteLength);
    const memory = memoryReader([source]);

    const result = await resolve([ref], [source.manifest], memory.reader);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices[0]?.text).toBe(sliceText);
    expect([...result.slices[0]!.bytes]).toEqual([...sliceBytes]);
    expect(result.logicalBytes).toBe(sliceBytes.byteLength);
    expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.isFrozen(ref.promotion)).toBe(true);
    expect(Object.isFrozen(source.manifest)).toBe(true);
    expect(Object.isFrozen(source.manifest.informationLabel)).toBe(true);
    expect(Object.isFrozen(source.manifest.informationLabel.principals)).toBe(true);
  });

  it("stores N compact refs against one manifest without repeating source metadata and opens the object once", async () => {
    const objectBytes = encoder.encode("one|two|three");
    const source = corpusObject(objectBytes);
    const refs = [
      source.ref(0, 3, { evidenceId: "evidence.one" as EvidenceId }),
      source.ref(4, 7, { evidenceId: "evidence.two" as EvidenceId }),
      source.ref(0, 3, { evidenceId: "evidence.one-again" as EvidenceId })
    ];
    const memory = memoryReader([source], results => results.map(result => ({
      ...result,
      slices: [...result.slices].reverse()
    })));
    let manifestReads = 0;
    const manifestIndex: AuthoritativeCorpusObjectManifestIndex = {
      get(manifestId) {
        manifestReads += 1;
        return manifestId === source.manifest.manifestId ? source.manifest : undefined;
      }
    };

    const result = await resolve(refs, [source.manifest], memory.reader, { manifestIndex });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices.map(slice => slice.ref.evidenceId)).toEqual([
      "evidence.one",
      "evidence.two",
      "evidence.one-again"
    ]);
    expect(result.slices.map(slice => slice.text)).toEqual(["one", "two", "one"]);
    expect(result.objectReads).toBe(1);
    expect(result.physicalReads).toBe(2);
    expect(manifestReads).toBe(1);
    expect(memory.batches[0]).toHaveLength(1);
    expect(memory.batches[0]?.[0]?.slices).toHaveLength(2);
    for (const ref of refs) {
      expect(Object.keys(ref)).toEqual([
        "schema",
        "evidenceId",
        "manifestId",
        "byteStart",
        "byteEnd",
        "sliceContentHash",
        "promotion"
      ]);
      const serialized = JSON.stringify(ref);
      for (const sourceField of [
        "sourceVersionId",
        "objectContentHash",
        "objectByteLength",
        "informationLabel",
        "temporalRevision"
      ]) {
        expect(serialized).not.toContain(`\"${sourceField}\"`);
      }
    }
  });

  it("enforces ref, aggregate-byte, and manifest object bounds before corpus reads", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const first = source.ref(0, 3, { evidenceId: "evidence.first" as EvidenceId });
    const duplicate = source.ref(0, 3, { evidenceId: "evidence.duplicate" as EvidenceId });
    const beyondObject = createEvidenceRef({
      ...inputFromRef(first),
      evidenceId: "evidence.out-of-bounds" as EvidenceId,
      byteEnd: source.bytes.byteLength + 1
    });
    const memory = memoryReader([source]);

    const tooMany = await resolve(
      [first, duplicate],
      [source.manifest],
      memory.reader,
      { limits: { maxRefs: 1, maxBytes: 100 } }
    );
    const tooLarge = await resolve(
      [first, duplicate],
      [source.manifest],
      memory.reader,
      { limits: { maxRefs: 2, maxBytes: 5 } }
    );
    const outside = await resolve([beyondObject], [source.manifest], memory.reader);

    for (const result of [tooMany, tooLarge, outside]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failures.map(item => item.reason)).toContain("bounds_exceeded");
    }
    expect(memory.calls).toBe(0);
  });

  it("fails an oversized ref batch before consulting authoritative indexes", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const first = source.ref(0, 3, { evidenceId: "evidence.first.fast" as EvidenceId });
    const second = source.ref(3, 6, { evidenceId: "evidence.second.fast" as EvidenceId });
    let referenceLookups = 0;
    let manifestLookups = 0;
    const memory = memoryReader([source]);
    const result = await resolveEvidenceRefs({
      refs: [first, second],
      referenceIndex: { get() { referenceLookups += 1; return first; } },
      manifestIndex: { get() { manifestLookups += 1; return source.manifest; } },
      reader: memory.reader,
      hasher,
      access,
      currentRevisions: new Map([[source.manifest.sourceVersionId, source.manifest.temporalRevision]]),
      limits: { maxRefs: 1, maxBytes: 1_024 }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toEqual([expect.objectContaining({
      reason: "bounds_exceeded",
      field: "refs"
    })]);
    expect({ referenceLookups, manifestLookups, reads: memory.calls }).toEqual({
      referenceLookups: 0,
      manifestLookups: 0,
      reads: 0
    });
  });

  it("rejects forged compact ref identity, range, hash, and promotion against authority", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const authorities = ["manifest", "range", "hash", "promotion"].map(name =>
      source.ref(0, 3, { evidenceId: `evidence.${name}` as EvidenceId })
    );
    const requested = [
      createEvidenceRef(inputFromRef(authorities[0]!, {
        manifestId: "manifest.forged" as CorpusObjectManifestId
      })),
      createEvidenceRef(inputFromRef(authorities[1]!, { byteStart: 1 })),
      createEvidenceRef(inputFromRef(authorities[2]!, {
        sliceContentHash: `sha256_${"2".repeat(64)}` as ContentHash
      })),
      createEvidenceRef(inputFromRef(authorities[3]!, {
        promotion: { state: "pending" }
      }))
    ];
    const memory = memoryReader([source]);

    const result = await resolveAgainst(
      requested,
      authorities,
      [source.manifest],
      memory.reader
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.filter(item => item.reason === "mismatch").map(item => item.field)).toEqual(
        expect.arrayContaining(["manifestId", "byteStart", "sliceContentHash", "promotion.state"])
      );
    }
    expect(memory.calls).toBe(0);
  });

  it("fails closed for absent or malformed authoritative refs and manifests", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const ref = source.ref(0, 3);
    const memory = memoryReader([source]);
    const malformedRef = Object.freeze({ ...ref, text: "embedded source" }) as unknown as EvidenceRef;
    const malformedManifest = Object.freeze({
      ...source.manifest,
      corpusBytes: source.bytes
    }) as unknown as CorpusObjectManifest;

    const missingRef = await resolve([ref], [source.manifest], memory.reader, {
      referenceIndex: new Map()
    });
    const badRef = await resolve([ref], [source.manifest], memory.reader, {
      referenceIndex: new Map([[ref.evidenceId, malformedRef]])
    });
    const missingManifest = await resolve([ref], [], memory.reader);
    const badManifest = await resolve([ref], [source.manifest], memory.reader, {
      manifestIndex: new Map([[source.manifest.manifestId, malformedManifest]])
    });

    for (const result of [missingRef, badRef, missingManifest, badManifest]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failures.map(item => item.reason)).toContain("untrusted");
    }
    expect(memory.calls).toBe(0);
  });

  it("rejects embedded content and source-level metadata in compact ref inputs", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const authoritative = source.ref(0, 3);
    expect(() => createEvidenceRef({
      ...inputFromRef(authoritative),
      text: "must not be embedded"
    } as unknown as EvidenceRefInput)).toThrow(/unexpected field text/);
    expect(() => createEvidenceRef({
      ...inputFromRef(authoritative),
      objectContentHash: source.manifest.objectContentHash
    } as unknown as EvidenceRefInput)).toThrow(/unexpected field objectContentHash/);

    const requested = Object.freeze({ ...authoritative, corpusBytes: source.bytes }) as unknown as EvidenceRef;
    const memory = memoryReader([source]);
    const result = await resolveAgainst(
      [requested],
      [authoritative],
      [source.manifest],
      memory.reader
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.map(item => item.reason)).toContain("invalid_ref");
    expect(memory.calls).toBe(0);
  });

  it.each([
    ["manifestId", "manifest.other"],
    ["sourceVersionId", "source-version.other"],
    ["objectContentHash", `sha256_${"0".repeat(64)}`],
    ["objectByteLength", 99],
    ["temporalRevision", "revision.other"]
  ] as const)("rejects tampered object echo %s atomically", async (field, value) => {
    const source = corpusObject(encoder.encode("abcdef"));
    const ref = source.ref(0, 3);
    const memory = memoryReader([source], results => results.map(result => ({
      ...result,
      [field]: value
    }) as CorpusObjectSliceReadResult));

    const result = await resolve([ref], [source.manifest], memory.reader);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: "tampered", field })
      ]));
      expect(result).not.toHaveProperty("slices");
    }
  });

  it.each([
    ["byteStart", 1],
    ["byteEnd", 2]
  ] as const)("rejects tampered slice echo %s atomically", async (field, value) => {
    const source = corpusObject(encoder.encode("abcdef"));
    const ref = source.ref(0, 3);
    const memory = memoryReader([source], results => results.map(result => ({
      ...result,
      slices: result.slices.map(slice => ({ ...slice, [field]: value }) as CorpusSliceRangeReadResult)
    })));

    const result = await resolve([ref], [source.manifest], memory.reader);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "tampered", field })
    ]));
  });

  it("rejects byte tampering atomically without exposing valid batch members", async () => {
    const source = corpusObject(encoder.encode("first|second"));
    const refs = [
      source.ref(0, 5, { evidenceId: "evidence.first" as EvidenceId }),
      source.ref(6, 12, { evidenceId: "evidence.second" as EvidenceId })
    ];
    const memory = memoryReader([source], results => results.map(result => ({
      ...result,
      slices: result.slices.map((slice, index) => index === 0
        ? slice
        : { ...slice, bytes: encoder.encode("tamper") })
    })));

    const result = await resolve(refs, [source.manifest], memory.reader);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.map(item => item.reason)).toContain("tampered");
      expect(result).not.toHaveProperty("slices");
    }
  });

  it("checks every duplicate-range hash while retaining one physical range read", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const valid = source.ref(0, 3, { evidenceId: "evidence.valid" as EvidenceId });
    const conflicting = createEvidenceRef(inputFromRef(valid, {
      evidenceId: "evidence.conflicting" as EvidenceId,
      sliceContentHash: `sha256_${"0".repeat(64)}` as ContentHash
    }));
    const memory = memoryReader([source]);

    const result = await resolve([valid, conflicting], [source.manifest], memory.reader);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: "tampered",
        field: "sliceContentHash",
        evidenceId: "evidence.conflicting"
      })
    ]));
    expect(memory.batches[0]?.[0]?.slices).toHaveLength(1);
  });

  it("rejects missing and extra object or slice results as atomic cardinality failures", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const ref = source.ref(0, 3);
    const missingObject = memoryReader([source], () => []);
    const extraObject = memoryReader([source], results => [
      ...results,
      { ...results[0]!, requestKey: "object.extra" }
    ]);
    const missingSlice = memoryReader([source], results => results.map(result => ({ ...result, slices: [] })));
    const extraSlice = memoryReader([source], results => results.map(result => ({
      ...result,
      slices: [...result.slices, { ...result.slices[0]!, requestKey: "slice.extra" }]
    })));

    for (const memory of [missingObject, extraObject, missingSlice, extraSlice]) {
      const result = await resolve([ref], [source.manifest], memory.reader);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failures.map(item => item.reason)).toEqual(
        expect.arrayContaining([expect.stringMatching(/missing|extra/)])
      );
    }
  });

  it("returns typed atomic failures for null and primitive reader results", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const ref = source.ref(0, 3);
    const reader: CorpusSliceReader = {
      async readObjectSlices() {
        return [null, 7] as unknown as readonly CorpusObjectSliceReadResult[];
      }
    };

    const result = await resolve([ref], [source.manifest], reader);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "tampered", field: "reader.result" })
    ]));
  });

  it("rejects stale, revoked, pending, and manifest-inaccessible evidence before reads", async () => {
    const source = corpusObject(encoder.encode("abcdef"));
    const privateSource = corpusObject(encoder.encode("secret"), {
      manifestId: "manifest.private" as CorpusObjectManifestId,
      sourceVersionId: "source-version.private" as SourceVersionId,
      informationLabel: { ...label, principals: ["owner.other"] }
    });
    const promoted = source.ref(0, 3);
    const revoked = source.ref(0, 3, {
      evidenceId: "evidence.revoked" as EvidenceId,
      promotion: {
        state: "revoked",
        promotedRevision: "revision.1",
        revokedRevision: "revision.2"
      }
    });
    const pending = source.ref(0, 3, {
      evidenceId: "evidence.pending" as EvidenceId,
      promotion: { state: "pending" }
    });
    const inaccessible = privateSource.ref(0, 3, { evidenceId: "evidence.private" as EvidenceId });
    const memory = memoryReader([source, privateSource]);

    const stale = await resolve([promoted], [source.manifest], memory.reader, {
      currentRevisions: new Map([[source.manifest.sourceVersionId, "revision.new"]])
    });
    const admission = await resolve(
      [revoked, pending, inaccessible],
      [source.manifest, privateSource.manifest],
      memory.reader
    );

    expect(stale.ok).toBe(false);
    expect(admission.ok).toBe(false);
    if (!stale.ok) expect(stale.failures.map(item => item.reason)).toContain("stale");
    if (!admission.ok) expect(admission.failures.map(item => item.reason)).toEqual(
      expect.arrayContaining(["revoked", "not_promoted", "inaccessible"])
    );
    expect(memory.calls).toBe(0);
  });

  it("rejects a hash-bound slice that is not complete valid UTF-8", async () => {
    const source = corpusObject(new Uint8Array([0xf0, 0x9f, 0x99]));
    const ref = source.ref(0, source.bytes.byteLength);
    const memory = memoryReader([source]);

    const result = await resolve([ref], [source.manifest], memory.reader);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "tampered", field: "bytes.utf8" })
    ]));
  });
});

interface ManifestOverrides {
  readonly manifestId?: CorpusObjectManifestId;
  readonly sourceVersionId?: SourceVersionId;
  readonly objectContentHash?: ContentHash;
  readonly objectByteLength?: number;
  readonly informationLabel?: ImmutableInformationLabel;
  readonly temporalRevision?: string;
}

interface EvidenceOverrides {
  readonly evidenceId?: EvidenceId;
  readonly promotion?: EvidencePromotion;
}

interface CorpusObjectFixture {
  readonly bytes: Uint8Array;
  readonly manifest: CorpusObjectManifest;
  ref(byteStart: number, byteEnd: number, overrides?: EvidenceOverrides): EvidenceRef;
}

function corpusObject(bytes: Uint8Array, overrides: ManifestOverrides = {}): CorpusObjectFixture {
  const manifest = createCorpusObjectManifest({
    manifestId: overrides.manifestId ?? "manifest.default" as CorpusObjectManifestId,
    sourceVersionId: overrides.sourceVersionId ?? "source-version.1" as SourceVersionId,
    objectContentHash: overrides.objectContentHash ?? contentHashForBytes(bytes, hasher),
    objectByteLength: overrides.objectByteLength ?? bytes.byteLength,
    informationLabel: overrides.informationLabel ?? label,
    temporalRevision: overrides.temporalRevision ?? "revision.1"
  });
  return {
    bytes,
    manifest,
    ref(byteStart, byteEnd, refOverrides = {}) {
      return createEvidenceRef({
        evidenceId: refOverrides.evidenceId ?? "evidence.default" as EvidenceId,
        manifestId: manifest.manifestId,
        byteStart,
        byteEnd,
        sliceContentHash: contentHashForBytes(bytes.slice(byteStart, byteEnd), hasher),
        promotion: refOverrides.promotion ?? {
          state: "promoted",
          promotedRevision: manifest.temporalRevision
        }
      });
    }
  };
}

function inputFromRef(ref: EvidenceRef, overrides: Partial<EvidenceRefInput> = {}): EvidenceRefInput {
  return {
    evidenceId: overrides.evidenceId ?? ref.evidenceId,
    manifestId: overrides.manifestId ?? ref.manifestId,
    byteStart: overrides.byteStart ?? ref.byteStart,
    byteEnd: overrides.byteEnd ?? ref.byteEnd,
    sliceContentHash: overrides.sliceContentHash ?? ref.sliceContentHash,
    promotion: overrides.promotion ?? ref.promotion
  };
}

interface MemoryReaderState {
  readonly reader: CorpusSliceReader;
  readonly batches: CorpusObjectSliceReadRequest[][];
  readonly calls: number;
}

function memoryReader(
  sources: readonly CorpusObjectFixture[],
  transform: (results: CorpusObjectSliceReadResult[]) => readonly CorpusObjectSliceReadResult[] = results => results
): MemoryReaderState {
  const bytesByManifest = new Map(sources.map(source => [source.manifest.manifestId, source.bytes]));
  const state: { calls: number; batches: CorpusObjectSliceReadRequest[][] } = { calls: 0, batches: [] };
  const reader: CorpusSliceReader = {
    async readObjectSlices(requests) {
      state.calls += 1;
      state.batches.push([...requests]);
      const results = requests.map(request => {
        const bytes = bytesByManifest.get(request.manifestId);
        if (!bytes) throw new Error(`missing fixture bytes for ${request.manifestId}`);
        return {
          ...request,
          slices: request.slices.map(slice => ({
            ...slice,
            bytes: bytes.slice(slice.byteStart, slice.byteEnd)
          }))
        };
      });
      return transform(results);
    }
  };
  return {
    reader,
    batches: state.batches,
    get calls() {
      return state.calls;
    }
  };
}

interface ResolveOverrides {
  readonly limits?: { readonly maxRefs: number; readonly maxBytes: number };
  readonly currentRevisions?: ReadonlyMap<SourceVersionId, string>;
  readonly referenceIndex?: AuthoritativeEvidenceRefIndex;
  readonly manifestIndex?: AuthoritativeCorpusObjectManifestIndex;
}

function resolve(
  refs: readonly EvidenceRef[],
  manifests: readonly CorpusObjectManifest[],
  reader: CorpusSliceReader,
  overrides: ResolveOverrides = {}
) {
  return resolveEvidenceRefs({
    refs,
    referenceIndex: overrides.referenceIndex ?? new Map(refs.map(ref => [ref.evidenceId, ref])),
    manifestIndex: overrides.manifestIndex ?? new Map(manifests.map(manifest => [manifest.manifestId, manifest])),
    reader,
    hasher,
    access,
    currentRevisions: overrides.currentRevisions ?? new Map(
      manifests.map(manifest => [manifest.sourceVersionId, manifest.temporalRevision])
    ),
    limits: overrides.limits ?? { maxRefs: 32, maxBytes: 1_024 }
  });
}

function resolveAgainst(
  refs: readonly EvidenceRef[],
  authoritativeRefs: readonly EvidenceRef[],
  manifests: readonly CorpusObjectManifest[],
  reader: CorpusSliceReader
) {
  return resolveEvidenceRefs({
    refs,
    referenceIndex: new Map(authoritativeRefs.map(ref => [ref.evidenceId, ref])),
    manifestIndex: new Map(manifests.map(manifest => [manifest.manifestId, manifest])),
    reader,
    hasher,
    access,
    currentRevisions: new Map(manifests.map(manifest => [manifest.sourceVersionId, manifest.temporalRevision])),
    limits: { maxRefs: 32, maxBytes: 1_024 }
  });
}

