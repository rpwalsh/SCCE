// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ContentHash, EvidenceSpan } from "@scce/kernel";
import {
  CANONICAL_EVIDENCE_SPAN_TEXT_SCHEMA,
  createCanonicalEvidenceSpanTextHydrator,
  encodeCanonicalEvidenceSpanText,
  hydrateCanonicalEvidenceSpanText,
  type CanonicalEvidenceSpanSource,
  type CanonicalEvidenceSpanTextRecord
} from "../canonical-evidence-span-text.js";
import type { CanonicalBlobHost } from "../canonical-evidence-text.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const hash = (bytes: Uint8Array) => `sha256_${sha(bytes).toString("hex")}` as ContentHash;
function fixture(text = " \t雪🧭 e\u0301 العربية हिन्दी עברית\u0000\r\n", prefix = "🌱前置\r\n", suffix = "\r\n後置") {
  const chunk = Buffer.from(text), bytes = Buffer.from(prefix + text + suffix);
  const span: EvidenceSpan = {
    id: "evidence.exact" as EvidenceSpan["id"], sourceId: "source.exact" as EvidenceSpan["sourceId"],
    sourceVersionId: "version.exact" as EvidenceSpan["sourceVersionId"], chunkId: "chunk.exact" as EvidenceSpan["chunkId"],
    contentHash: hash(chunk), mediaType: "text/plain; charset=utf-8", byteStart: Buffer.byteLength(prefix), byteEnd: Buffer.byteLength(prefix) + chunk.length,
    charStart: [...prefix].length, charEnd: [...prefix].length + [...text].length,
    text, textPreview: "producer-specific\tpreview\r\n雪🧭", languageHints: { und: 1 }, scriptHints: { mixed: true },
    trustVector: { identity: 1, producer: "exact" }, provenance: { source: { uri: "fixture://雪", control: "\u0000" } },
    features: ["sym:雪", "sym:🧭", "sym:雪"], status: "promoted", alpha: 0.875, observedAt: 1234,
    informationLabel: { tenantId: "owner", principals: ["principal"], compartments: ["corpus"], exportClass: "restricted", mergePolicy: "isolated" },
    sourceIdentity: { title: "雪🧭", identity: "fixture://雪", sourceKind: "text" }, retrievalWindow: "view\t雪"
  };
  const source: CanonicalEvidenceSpanSource = { sourceId: span.sourceId, sourceVersionId: span.sourceVersionId, contentHash: hash(bytes), byteLength: bytes.length };
  const read = vi.fn(async (id: string): Promise<Uint8Array> => {
    if (id !== source.contentHash) throw new Error("unexpected source identity");
    return bytes;
  });
  return { span, source, bytes, chunk, read };
}

describe("canonical evidence-span full-text references", () => {
  it("stores no full-text field, retains the existing preview, and reconstructs every logical field exactly", async () => {
    const f = fixture(), original = structuredClone(f.span), stored = encodeCanonicalEvidenceSpanText(f.span);
    expect(CANONICAL_EVIDENCE_SPAN_TEXT_SCHEMA).toBe("scce.canonical_evidence_span_text.v1");
    expect(stored).not.toHaveProperty("text"); expect(stored).not.toHaveProperty("text_content");
    expect(stored).not.toHaveProperty("textSha256");
    expect(stored.textPreview).toBe(f.span.textPreview);
    expect(stored.contentHash).toBe(f.span.contentHash);
    expect(await hydrateCanonicalEvidenceSpanText(stored, f.source, f.read)).toEqual(original);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.source.contentHash);
    expect(f.span).toEqual(original);
  });

  it.each(["", "\ufeffliteral BOM\r\n", "\uFFFD is literal source material", "\t\r\n  ", "a".repeat(700)])("preserves exact valid text %j", async text => {
    const f = fixture(text, "", "suffix");
    expect((await hydrateCanonicalEvidenceSpanText(encodeCanonicalEvidenceSpanText(f.span), f.source, f.read)).text).toBe(text);
  });

  it("retains a producer-specific 700-unit preview without applying formatting rules", async () => {
    const f = fixture(); f.span.textPreview = "\t" + "x".repeat(697) + "\r\n";
    expect((await hydrateCanonicalEvidenceSpanText(encodeCanonicalEvidenceSpanText(f.span), f.source, f.read)).textPreview).toBe(f.span.textPreview);
  });

  it("uses byte coordinates and absolute codepoint coordinates independently of UTF-16 length", async () => {
    const f = fixture("🧭e\u0301", "雪🌱", "");
    expect(f.span.byteStart).not.toBe(f.span.charStart);
    expect(f.span.text.length).not.toBe(f.span.charEnd - f.span.charStart);
    expect(await hydrateCanonicalEvidenceSpanText(encodeCanonicalEvidenceSpanText(f.span), f.source, f.read)).toEqual(f.span);
  });

  it("counts a long Unicode prefix in bounded decoder chunks, including a split four-byte scalar", async () => {
    const prefix = "a".repeat(65535) + "🧭\ufeff雪";
    const f = fixture("e\u0301", prefix, "");
    expect(await hydrateCanonicalEvidenceSpanText(encodeCanonicalEvidenceSpanText(f.span), f.source, f.read)).toEqual(f.span);
  });

  it("handles byte-array views without reading unrelated backing-buffer bytes", async () => {
    const f = fixture(), backing = Buffer.concat([Buffer.from([255]), f.bytes, Buffer.from([128])]);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 1, f.bytes.length);
    expect(await hydrateCanonicalEvidenceSpanText(encodeCanonicalEvidenceSpanText(f.span), f.source, async () => view)).toEqual(f.span);
  });

  it("snapshots input metadata, content identity and ownership before an asynchronous source read", async () => {
    const f = fixture(), original = structuredClone(f.span), stored = encodeCanonicalEvidenceSpanText(f.span);
    let release!: (value: Uint8Array) => void;
    const pending = hydrateCanonicalEvidenceSpanText(stored, f.source, () => new Promise(resolve => { release = resolve; }));
    stored.contentHash = hash(Buffer.from("changed")); stored.features.push("changed"); stored.textPreview = "changed";
    f.source.byteLength = 0; f.span.features.push("caller changed");
    release(f.bytes);
    expect(await pending).toEqual(original);
  });

  it.each(["sourceId", "sourceVersionId", "byteLength", "contentHash"] as const)("rejects an invalid source %s before I/O", async field => {
    const f = fixture(), stored = encodeCanonicalEvidenceSpanText(f.span), source = { ...f.source };
    if (field === "byteLength") source.byteLength = f.span.byteEnd - 1;
    else if (field === "contentHash") source.contentHash = "sha256_bad" as ContentHash;
    else source[field] = "foreign" as never;
    await expect(hydrateCanonicalEvidenceSpanText(stored, source, f.read)).rejects.toThrow("source ownership or byte bound mismatch");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["body", "length"])("rejects corrupted canonical source %s even with a matching chunk reference", async mutation => {
    const f = fixture(), stored = encodeCanonicalEvidenceSpanText(f.span);
    const corrupted = mutation === "body" ? Buffer.from(f.bytes) : f.bytes.subarray(0, f.bytes.length - 1);
    if (mutation === "body") corrupted[0] = corrupted[0]! ^ 1;
    await expect(hydrateCanonicalEvidenceSpanText(stored, f.source, async () => corrupted)).rejects.toThrow("source bytes failed length/hash verification");
  });

  it("rejects a valid chunk hash attached to the wrong offset within its actual source", async () => {
    const f = fixture("alpha", "start|", "|other"), stored = encodeCanonicalEvidenceSpanText(f.span);
    stored.byteStart++; stored.byteEnd++;
    await expect(hydrateCanonicalEvidenceSpanText(stored, f.source, f.read)).rejects.toThrow("source range failed content identity verification");
  });

  it("rejects incorrect absolute codepoint coordinates even when local length and content identity agree", async () => {
    const f = fixture(), stored = encodeCanonicalEvidenceSpanText(f.span); stored.charStart++; stored.charEnd++;
    await expect(hydrateCanonicalEvidenceSpanText(stored, f.source, f.read)).rejects.toThrow("source character coordinates differ");
  });

  it.each([Buffer.from([255]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82]), Buffer.from([0xed, 0xa0, 0x80])])("refuses invalid UTF-8 bytes %j rather than replacing them", async bad => {
    const f = fixture("a", "", ""), stored = encodeCanonicalEvidenceSpanText(f.span);
    stored.contentHash = hash(bad); stored.byteEnd = bad.length;
    const source = { ...f.source, contentHash: hash(bad), byteLength: bad.length };
    await expect(hydrateCanonicalEvidenceSpanText(stored, source, async () => bad)).rejects.toThrow();
  });

  it("refuses a binary prefix with no valid source-codepoint coordinates", async () => {
    const f = fixture("a", "", ""), bytes = Buffer.from([255, 97]), stored = encodeCanonicalEvidenceSpanText(f.span);
    stored.byteStart = 1; stored.byteEnd = 2; stored.charStart = 1; stored.charEnd = 2;
    await expect(hydrateCanonicalEvidenceSpanText(stored, { ...f.source, contentHash: hash(bytes), byteLength: 2 }, async () => bytes)).rejects.toThrow();
  });

  it.each(["negative", "fractional", "unsafe", "reversed", "content identity", "inline body", "unknown field"])("rejects malformed stored %s before I/O", async mutation => {
    const f = fixture(), stored = encodeCanonicalEvidenceSpanText(f.span);
    if (mutation === "negative") stored.byteStart = -1;
    if (mutation === "fractional") stored.byteEnd += 0.5;
    if (mutation === "unsafe") stored.charEnd = Number.MAX_SAFE_INTEGER + 1;
    if (mutation === "reversed") stored.charEnd = stored.charStart - 1;
    if (mutation === "content identity") stored.contentHash = "sha256_bad" as ContentHash;
    if (mutation === "inline body") Object.assign(stored, { text: f.span.text });
    if (mutation === "unknown field") Object.assign(stored, { text_content: f.span.text });
    await expect(hydrateCanonicalEvidenceSpanText(stored, f.source, f.read)).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["hash", "byte coordinates", "char coordinates", "unpaired surrogate", "preview"])("rejects an unrepresentable logical %s during pure encoding", mutation => {
    const f = fixture();
    if (mutation === "hash") f.span.contentHash = hash(Buffer.from("other"));
    if (mutation === "byte coordinates") f.span.byteEnd++;
    if (mutation === "char coordinates") f.span.charEnd++;
    if (mutation === "unpaired surrogate") f.span.text = "\uD800";
    if (mutation === "preview") f.span.textPreview = "x".repeat(701);
    expect(() => encodeCanonicalEvidenceSpanText(f.span)).toThrow();
  });

  it("enforces source/span bounds before allocating decoded text or requesting canonical bytes", async () => {
    const f = fixture(), stored = encodeCanonicalEvidenceSpanText(f.span);
    expect(() => encodeCanonicalEvidenceSpanText(f.span, {maxSpanBytes: 1})).toThrow();
    await expect(hydrateCanonicalEvidenceSpanText(stored, f.source, f.read, {maxSourceBytes: 1})).rejects.toThrow();
    await expect(hydrateCanonicalEvidenceSpanText(stored, f.source, f.read, {maxSpanBytes: 1})).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    for (const value of [-1, NaN, 0.5, Infinity]) expect(() => encodeCanonicalEvidenceSpanText(f.span, {maxSpanBytes: value})).toThrow("byte budget");
  });

  it("propagates canonical-byte unavailability without emitting text or changing the reference", async () => {
    const f = fixture(), stored = encodeCanonicalEvidenceSpanText(f.span), snapshot = structuredClone(stored), unavailable = new Error("retained archive unavailable");
    await expect(hydrateCanonicalEvidenceSpanText(stored, f.source, async () => { throw unavailable; })).rejects.toBe(unavailable);
    expect(stored).toEqual(snapshot);
  });

  it("uses the actual canonical blob reader for a range-backed source representation", async () => {
    const f = fixture("雪🧭", "prefix|", "|suffix"), archiveBytes = Buffer.concat([Buffer.from("external:"), f.bytes, Buffer.from("tail")]);
    const parentHash = hash(archiveBytes), offset = Buffer.byteLength("external:"), queried: string[] = [];
    const host: CanonicalBlobHost = { table: name => `"fixture"."${name}"`, async query<T>(_sql: string, params: unknown[] = []): Promise<T[]> {
      const id = String(params[0]); queried.push(id);
      const row = id === f.source.contentHash
        ? {content: Buffer.alloc(0), byte_length: String(f.bytes.length), range_parent_hash: parentHash, range_start: String(offset), range_end: String(offset + f.bytes.length), archive_reference: null, archive: null}
        : id === parentHash ? {content: archiveBytes, byte_length: String(archiveBytes.length), range_parent_hash: null, range_start: null, range_end: null, archive_reference: null, archive: null} : undefined;
      return (row ? [row] : []) as T[];
    } };
    const hydrate = createCanonicalEvidenceSpanTextHydrator(host);
    const stored: CanonicalEvidenceSpanTextRecord = encodeCanonicalEvidenceSpanText(f.span);
    expect(await hydrate(stored, f.source)).toEqual(f.span);
    expect(queried).toEqual([f.source.contentHash, parentHash]);
    expect(await hydrate(stored, f.source)).toEqual(f.span);
    expect(queried.filter(id => id === parentHash)).toHaveLength(1);
  });
});
