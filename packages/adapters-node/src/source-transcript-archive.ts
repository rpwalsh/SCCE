// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue, validateDeclaredTranscriptSource,
  type ContentHash, type InformationLabel, type ScceStorage, type SourceVersion, type TranscriptTurn } from "@scce/kernel";

export const SOURCE_TRANSCRIPT_ARCHIVE_SCHEMA = "scce.source_transcript_archive.v1";
const PAYLOAD_SCHEMA = "scce.compact_transcript_annotations.v1";
export const MAX_SOURCE_TRANSCRIPT_ARCHIVE_BYTES = 8 * 1024 * 1024;
export interface SourceTranscriptArchiveDescriptor {
  schema: typeof SOURCE_TRANSCRIPT_ARCHIVE_SCHEMA;
  sourceId: string;
  sourceVersionId: string;
  sourceUri: string;
  contentHash: string;
  textDigest: string;
  informationLabel: InformationLabel;
  authorship: string;
  archiveHash: ContentHash;
  archiveByteLength: number;
  turnCount: number;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (bytes: string | Uint8Array): ContentHash => `sha256_${createHasher().digestHex(bytes)}` as ContentHash;
const equal = (a: unknown, b: unknown) => canonicalStringify(toJsonValue(a)) === canonicalStringify(toJsonValue(b));

function owner(source: SourceVersion, text: string) {
  const authorship = record(source.metadata).authorship;
  if (typeof authorship !== "string" || !authorship || !source.informationLabel || text !== text.normalize("NFC")
    || Buffer.byteLength(text, "utf8") !== source.byteLength || hash(text) !== source.contentHash) throw Error("transcript archive source binding mismatch");
  return { sourceId: String(source.sourceId), sourceVersionId: String(source.sourceVersionId), sourceUri: source.canonicalUri,
    contentHash: String(source.contentHash), textDigest: createHasher().digestHex(text), informationLabel: source.informationLabel, authorship };
}

/** Speech and context bytes remain solely in the canonical source blob. */
export function prepareSourceTranscriptArchive(source: SourceVersion, text: string, turns: readonly TranscriptTurn[]) {
  const binding = owner(source, text), validated = validateDeclaredTranscriptSource({ schema: "scce.dialogue_transcript.v1", text, turns });
  const compact = validated.turns.map(turn => Object.fromEntries(Object.entries({ index: turn.index, speakerId: turn.speakerId,
    startCodePoint: turn.startCodePoint, endCodePoint: turn.endCodePoint, replyToTurnIndex: turn.replyToTurnIndex,
    commitmentScope: turn.commitmentScope, requestAuthority: turn.requestAuthority, sourceCategory: turn.sourceCategory,
    sourceRecordId: turn.sourceRecordId, sourceFamilyId: turn.sourceFamilyId,
    ...(turn.supportingSourceRanges ? { supportingSourceRanges: turn.supportingSourceRanges.map(range => ({
      startCodePoint: range.startCodePoint, endCodePoint: range.endCodePoint, ...(range.answerRange ? { answerRange: range.answerRange } : {}) })) } : {}) }).filter(([, value]) => value !== undefined)));
  const bytes = Buffer.from(canonicalStringify(toJsonValue({ schema: PAYLOAD_SCHEMA, owner: binding, turns: compact })), "utf8");
  if (bytes.length > MAX_SOURCE_TRANSCRIPT_ARCHIVE_BYTES) throw Error("transcript archive exceeds byte budget");
  const descriptor: SourceTranscriptArchiveDescriptor = { schema: SOURCE_TRANSCRIPT_ARCHIVE_SCHEMA, ...binding,
    archiveHash: hash(bytes), archiveByteLength: bytes.length, turnCount: validated.turns.length };
  const previous = record(source.metadata).transcriptArchive;
  if (previous !== undefined && !equal(previous, descriptor)) throw Error("transcript archive is append-only");
  return { bytes, descriptor, source: { ...source, metadata: toJsonValue({ ...record(source.metadata), transcriptArchive: descriptor }) } };
}

export async function readSourceTranscriptArchive(storage: Pick<ScceStorage, "blobs">, source: SourceVersion, text: string,
  options: { maxExpandedSurfaceBytes?: number } = {}): Promise<readonly TranscriptTurn[] | undefined> {
  const raw = record(source.metadata).transcriptArchive; if (raw === undefined) return undefined;
  const descriptor = record(structuredClone(raw)), binding = structuredClone(owner(source, text));
  const { schema: _schema, archiveHash: _hash, archiveByteLength: _length, turnCount: _count, ...descriptorOwner } = descriptor;
  if (descriptor.schema !== SOURCE_TRANSCRIPT_ARCHIVE_SCHEMA || !equal(descriptorOwner, binding)
    || typeof descriptor.archiveHash !== "string" || !/^sha256_[a-f0-9]{64}$/u.test(descriptor.archiveHash)
    || !Number.isSafeInteger(descriptor.archiveByteLength) || Number(descriptor.archiveByteLength) < 1
    || Number(descriptor.archiveByteLength) > MAX_SOURCE_TRANSCRIPT_ARCHIVE_BYTES
    || !Number.isSafeInteger(descriptor.turnCount) || Number(descriptor.turnCount) < 0) throw Error("transcript archive descriptor binding mismatch");
  const bytes = await storage.blobs.get(descriptor.archiveHash as ContentHash);
  if (bytes.byteLength !== descriptor.archiveByteLength || hash(bytes) !== descriptor.archiveHash) throw Error("transcript archive blob hash or length mismatch");
  const payload = record(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (payload.schema !== PAYLOAD_SCHEMA || !equal(payload.owner, binding) || !Array.isArray(payload.turns)
    || payload.turns.length !== descriptor.turnCount) throw Error("transcript archive payload binding mismatch");
  const points = [...text];
  const allowance = options.maxExpandedSurfaceBytes ?? MAX_SOURCE_TRANSCRIPT_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(allowance) || allowance < 0) throw Error("invalid transcript archive expansion allowance");
  const byteOffsets = [0];
  for (const point of points) byteOffsets.push(byteOffsets.at(-1)! + Buffer.byteLength(point, "utf8"));
  let expandedBytes = bytes.byteLength;
  if (expandedBytes > allowance) throw Error("transcript archive expanded surfaces exceed owner pool byte budget");
  const charge = (range: Record<string, unknown>) => {
    const start = range.startCodePoint, end = range.endCodePoint;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) > points.length || Number(end) <= Number(start)) throw Error("invalid transcript archive coordinates");
    expandedBytes += byteOffsets[Number(end)]! - byteOffsets[Number(start)]!;
    if (expandedBytes > allowance) throw Error("transcript archive expanded surfaces exceed owner pool byte budget");
  };
  for (const value of payload.turns) {
    const turn = record(value); charge(turn);
    if (Array.isArray(turn.supportingSourceRanges)) for (const range of turn.supportingSourceRanges) charge(record(range));
  }
  const turns = payload.turns.map(value => {
    const turn = record(value);
    if (Object.hasOwn(turn, "surface") || Array.isArray(turn.supportingSourceRanges)
      && turn.supportingSourceRanges.some(range => Object.hasOwn(record(range), "surface"))) throw Error("transcript archive contains duplicated surface bytes");
    return { ...turn, surface: points.slice(Number(turn.startCodePoint), Number(turn.endCodePoint)).join("") };
  });
  return validateDeclaredTranscriptSource({ schema: "scce.dialogue_transcript.v1", text, turns }).turns;
}

/** Only the new descriptor can be appended; all existing metadata stays unchanged. */
export function sourceTranscriptArchiveAppendSql(blobsTable: string, sourcesTable: string): string {
  return `CASE WHEN stored.source_id=EXCLUDED.source_id AND stored.content_hash=EXCLUDED.content_hash
    AND stored.information_label=EXCLUDED.information_label
    AND EXCLUDED.metadata_json->'transcriptArchive'->>'schema'='${SOURCE_TRANSCRIPT_ARCHIVE_SCHEMA}'
    AND EXCLUDED.metadata_json->'transcriptArchive'->>'sourceId'=stored.source_id
    AND EXCLUDED.metadata_json->'transcriptArchive'->>'sourceVersionId'=stored.id
    AND EXCLUDED.metadata_json->'transcriptArchive'->>'contentHash'=stored.content_hash
    AND EXCLUDED.metadata_json->'transcriptArchive'->>'textDigest'=substring(stored.content_hash FROM 8)
    AND EXCLUDED.metadata_json->'transcriptArchive'->'informationLabel'=stored.information_label
    AND EXCLUDED.metadata_json->'transcriptArchive'->>'authorship'=stored.metadata_json->>'authorship'
    AND (NOT (stored.metadata_json ? 'transcriptArchive') OR stored.metadata_json->'transcriptArchive'=EXCLUDED.metadata_json->'transcriptArchive')
    AND EXISTS (SELECT 1 FROM ${sourcesTable} archive_owner WHERE archive_owner.id=stored.source_id
      AND archive_owner.canonical_uri=EXCLUDED.metadata_json->'transcriptArchive'->>'sourceUri')
    AND EXISTS (SELECT 1 FROM ${blobsTable} archive_blob WHERE archive_blob.content_hash=EXCLUDED.metadata_json->'transcriptArchive'->>'archiveHash'
      AND to_jsonb(archive_blob.byte_length)=EXCLUDED.metadata_json->'transcriptArchive'->'archiveByteLength')
    THEN jsonb_build_object('transcriptArchive', EXCLUDED.metadata_json->'transcriptArchive') ELSE '{}'::jsonb END`;
}
