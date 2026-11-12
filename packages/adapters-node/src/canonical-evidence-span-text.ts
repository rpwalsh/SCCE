// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import type { EvidenceSpan, SourceVersion } from "@scce/kernel";
import { createCanonicalBlobReader, type CanonicalBlobHost } from "./canonical-evidence-text.js";

/** Version the storage contract once in schema metadata, rather than repeating it on each evidence row. */
export const CANONICAL_EVIDENCE_SPAN_TEXT_SCHEMA = "scce.canonical_evidence_span_text.v1" as const;

/** All logical metadata remains; the full text body is represented by its existing content hash and source range. */
export type CanonicalEvidenceSpanTextRecord = Omit<EvidenceSpan, "text">;
export type CanonicalEvidenceSpanSource = Pick<SourceVersion, "sourceId" | "sourceVersionId" | "contentHash" | "byteLength">;
export type CanonicalEvidenceBlobReader = (hash: string) => Promise<Uint8Array>;
export interface CanonicalEvidenceSpanTextLimits {
  maxSpanBytes?: number;
  maxSourceBytes?: number;
}

const DEFAULT_MAX_SPAN_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 192 * 1024 * 1024;
const HASH = /^sha256_[0-9a-f]{64}$/u;
const REQUIRED_FIELDS = ["id", "sourceId", "sourceVersionId", "chunkId", "contentHash", "mediaType", "byteStart", "byteEnd",
  "charStart", "charEnd", "textPreview", "languageHints", "scriptHints", "trustVector", "provenance", "features", "status", "alpha", "observedAt"];
const OPTIONAL_FIELDS = ["retrievalWindow", "sourceIdentity", "informationLabel"];

function bounds(input: CanonicalEvidenceSpanTextLimits): { maxSpanBytes: number; maxSourceBytes: number } {
  const result = { maxSpanBytes: input.maxSpanBytes ?? DEFAULT_MAX_SPAN_BYTES, maxSourceBytes: input.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES };
  if (!Object.values(result).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("invalid canonical evidence byte budget");
  return result;
}
function sha256(bytes: Uint8Array): Buffer { return createHash("sha256").update(bytes).digest(); }
function contentHash(bytes: Uint8Array): string { return `sha256_${sha256(bytes).toString("hex")}`; }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validateFields(value: unknown, stored: boolean, maxSpanBytes: number): asserts value is EvidenceSpan | CanonicalEvidenceSpanTextRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid canonical evidence record");
  const row = value as Record<string, unknown>, expected = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS, ...(stored ? [] : ["text"])]);
  if (Object.keys(row).some(key => !expected.has(key)) || [...REQUIRED_FIELDS, ...(stored ? [] : ["text"])].some(key => !Object.hasOwn(row, key))) {
    throw new Error("invalid canonical evidence record fields");
  }
  if (["id", "sourceId", "sourceVersionId", "chunkId", "mediaType"].some(key => typeof row[key] !== "string" || row[key] === "")
    || typeof row.contentHash !== "string" || !HASH.test(row.contentHash)
    || typeof row.textPreview !== "string" || row.textPreview.length > 700
    || !Array.isArray(row.features) || row.features.some(feature => typeof feature !== "string")
    || row.status !== "promoted" && row.status !== "quarantined"
    || typeof row.alpha !== "number" || !Number.isFinite(row.alpha)
    || typeof row.observedAt !== "number" || !Number.isFinite(row.observedAt)) throw new Error("invalid canonical evidence metadata");
  if (![row.byteStart, row.byteEnd, row.charStart, row.charEnd].every(integer)
    || Number(row.byteEnd) < Number(row.byteStart) || Number(row.charEnd) < Number(row.charStart)
    || Number(row.byteEnd) - Number(row.byteStart) > maxSpanBytes) throw new Error("invalid or excessive canonical evidence range");
}
function utf8(bytes: Uint8Array): string {
  // ignoreBOM=true preserves U+FEFF as literal source content. Fatal decoding never substitutes U+FFFD for bad bytes.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function codePoints(text: string): number { let count = 0; for (const _char of text) count++; return count; }
function prefixCodePoints(bytes: Uint8Array, end: number): number {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let count = 0;
  // Count source coordinates without materializing a whole-article prefix string.
  for (let offset = 0; offset < end; offset += 64 * 1024) count += codePoints(decoder.decode(bytes.subarray(offset, Math.min(end, offset + 64 * 1024)), { stream: true }));
  return count + codePoints(decoder.decode());
}

/** Pure write preparation. The caller publishes its canonical source/chunk blobs before the referencing evidence row. */
export function encodeCanonicalEvidenceSpanText(span: EvidenceSpan, limits: CanonicalEvidenceSpanTextLimits = {}): CanonicalEvidenceSpanTextRecord {
  const { maxSpanBytes } = bounds(limits);
  validateFields(span, false, maxSpanBytes);
  if (typeof span.text !== "string") throw new Error("canonical evidence text must be a string");
  if (Buffer.byteLength(span.text, "utf8") > maxSpanBytes) throw new Error("canonical evidence text exceeds its byte budget");
  const bytes = Buffer.from(span.text, "utf8");
  if (utf8(bytes) !== span.text) throw new Error("canonical evidence text contains an unpaired surrogate");
  if (bytes.length !== span.byteEnd - span.byteStart || codePoints(span.text) !== span.charEnd - span.charStart) throw new Error("canonical evidence text does not match its coordinates");
  if (contentHash(bytes) !== span.contentHash) throw new Error("canonical evidence text does not match its content identity");
  const { text: _text, ...metadata } = structuredClone(span);
  return metadata;
}

/**
 * The caller must select and authorize BOTH the evidence and its source version before calling this function.
 * Reading the source's own canonical bytes proves the citation coordinates as well as the chunk hash; reading
 * only the chunk blob would not detect a valid chunk address attached to the wrong offset of the same source.
 */
export async function hydrateCanonicalEvidenceSpanText(
  stored: CanonicalEvidenceSpanTextRecord,
  source: CanonicalEvidenceSpanSource,
  readBlob: CanonicalEvidenceBlobReader,
  limits: CanonicalEvidenceSpanTextLimits = {}
): Promise<EvidenceSpan> {
  const { maxSpanBytes, maxSourceBytes } = bounds(limits);
  validateFields(stored, true, maxSpanBytes);
  const row = structuredClone(stored), owner = structuredClone(source);
  if (!owner || owner.sourceId !== row.sourceId || owner.sourceVersionId !== row.sourceVersionId
    || typeof owner.contentHash !== "string" || !HASH.test(owner.contentHash)
    || !integer(owner.byteLength) || owner.byteLength > maxSourceBytes || row.byteEnd > owner.byteLength) {
    throw new Error("canonical evidence source ownership or byte bound mismatch");
  }
  const bytes = await readBlob(owner.contentHash);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== owner.byteLength || contentHash(bytes) !== owner.contentHash) {
    throw new Error("canonical evidence source bytes failed length/hash verification");
  }
  const selected = bytes.subarray(row.byteStart, row.byteEnd);
  if (contentHash(selected) !== row.contentHash) throw new Error("canonical evidence source range failed content identity verification");
  const text = utf8(selected);
  if (prefixCodePoints(bytes, row.byteStart) !== row.charStart || codePoints(text) !== row.charEnd - row.charStart) {
    throw new Error("canonical evidence source character coordinates differ");
  }
  return { ...row, text };
}

/** One invocation-owned canonical reader; its existing archive/range validation and bounded parent cache are reused. */
export function createCanonicalEvidenceSpanTextHydrator(host: CanonicalBlobHost, limits: CanonicalEvidenceSpanTextLimits = {}) {
  const read = createCanonicalBlobReader(host), fixedLimits = { ...bounds(limits) };
  return (row: CanonicalEvidenceSpanTextRecord, source: CanonicalEvidenceSpanSource): Promise<EvidenceSpan> =>
    hydrateCanonicalEvidenceSpanText(row, source, read, fixedLimits);
}
