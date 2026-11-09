// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { createClock, createHasher, createIdFactory, toJsonValue, type ContentHash, type ScceStorage, type SourceVersion, type TranscriptTurn } from "@scce/kernel";
import { prepareSourceTranscriptArchive, readSourceTranscriptArchive, SOURCE_TRANSCRIPT_ARCHIVE_SCHEMA } from "../source-transcript-archive.js";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });
function fixture() {
  const question = "\u27e1 \u65b0\u6e2f\ud83e\udded?", answer = "907", context = "\ud83e\udded \u65b0\u6e2f\ud83e\udded z\u00f4r 907. 907.";
  const text = `${question}\n${answer}\n${context}`, hasher = createHasher(), hash = (bytes: string | Uint8Array) => `sha256_${hasher.digestHex(bytes)}` as ContentHash;
  const ids = createIdFactory({ clock: createClock({ fixedTime: 1, stepMs: 1 }), hasher, namespace: "archive", deterministicReplay: true });
  const label = { tenantId: "archive", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
  const start = [...question].length + 1, contextStart = start + [...answer].length + 1, answerStart = contextStart + [...context.slice(0, context.indexOf(answer))].length;
  const turns: TranscriptTurn[] = [{ index: 0, speakerId: "human.question", surface: question, sourceRecordId: "qa.original", sourceFamilyId: "article.original",
    startCodePoint: 0, endCodePoint: [...question].length }, { index: 1, speakerId: "human.reply", surface: answer, sourceRecordId: "qa.original", sourceFamilyId: "article.original",
    startCodePoint: start, endCodePoint: start + [...answer].length, replyToTurnIndex: 0, commitmentScope: "external",
    supportingSourceRanges: [{ startCodePoint: contextStart, endCodePoint: [...text].length, surface: context,
      answerRange: { startCodePoint: answerStart, endCodePoint: answerStart + [...answer].length } }] }];
  const source: SourceVersion = { sourceId: ids.sourceId("archive", "fixture://archive/human.json"), sourceVersionId: ids.sourceVersionId("archive.human"), canonicalUri: "fixture://archive/human.json", namespace: "archive",
    contentHash: hash(text), byteLength: Buffer.byteLength(text), mediaType: "text/plain", observedAt: 1,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "archive", accessScope: "owner_private", licenseStatus: "owner_authorized" },
    informationLabel: label, metadata: { authorship: "human_authored", sourceMetadata: { dataset: "human fixture" }, sourceMetadataBinding: { valueHash: "unchanged" } } };
  const blobs = new Map<ContentHash, Uint8Array>();
  const storage: Pick<ScceStorage, "blobs"> = { blobs: { put: async bytes => { const key = hash(bytes); blobs.set(key, bytes); return key; },
    get: async key => { const bytes = blobs.get(key); if (!bytes) throw Error("missing archive blob"); return bytes; }, exists: async key => blobs.has(key) } };
  return { source, text, turns, storage, blobs, hash, ids };
}
it("archives only source-owned coordinates once and restores exact Unicode human ranges from canonical bytes", async () => {
  const f = fixture(), prepared = prepareSourceTranscriptArchive(f.source, f.text, f.turns);
  expect(prepared.descriptor.schema).toBe(SOURCE_TRANSCRIPT_ARCHIVE_SCHEMA);
  expect(prepared.source.metadata).toMatchObject(f.source.metadata as object);
  expect(await f.storage.blobs.put(prepared.bytes, "application/json")).toBe(prepared.descriptor.archiveHash);
  const raw = JSON.parse(Buffer.from(prepared.bytes).toString("utf8"));
  expect(raw).not.toHaveProperty("text"); expect(raw.turns.every((turn: object) => !Object.hasOwn(turn, "surface"))).toBe(true);
  expect(raw.turns[1].supportingSourceRanges[0]).not.toHaveProperty("surface");
  expect(Buffer.from(prepared.bytes).toString("utf8")).not.toContain(f.turns[1]!.supportingSourceRanges![0]!.surface);
  expect(await readSourceTranscriptArchive(f.storage, prepared.source, f.text)).toEqual(f.turns);
  await expect(readSourceTranscriptArchive(f.storage, prepared.source, f.text, { maxExpandedSurfaceBytes: prepared.bytes.length })).rejects.toThrow("expanded surfaces exceed owner pool byte budget");
  expect(prepareSourceTranscriptArchive(prepared.source, f.text, f.turns).bytes).toEqual(prepared.bytes);
  expect(f.blobs.size).toBe(1);
});
it("refuses foreign/stale owners, altered bytes, labels, authorship, blobs and declared answer ranges", async () => {
  const f = fixture(), prepared = prepareSourceTranscriptArchive(f.source, f.text, f.turns);
  await f.storage.blobs.put(prepared.bytes, "application/json");
  for (const source of [{ ...prepared.source, sourceId: f.ids.sourceId("foreign", "fixture://foreign") }, { ...prepared.source, sourceVersionId: f.ids.sourceVersionId("stale") },
    { ...prepared.source, canonicalUri: "fixture://foreign" }, { ...prepared.source, informationLabel: { ...f.source.informationLabel!, principals: ["foreign"] } },
    { ...prepared.source, metadata: { ...(prepared.source.metadata as object), authorship: "system_generated" } }]) {
    await expect(readSourceTranscriptArchive(f.storage, source, f.text)).rejects.toThrow("binding mismatch");
  }
  await expect(readSourceTranscriptArchive(f.storage, prepared.source, f.text.replace("907", "908"))).rejects.toThrow("source binding mismatch");
  f.blobs.set(prepared.descriptor.archiveHash, Buffer.from("changed"));
  await expect(readSourceTranscriptArchive(f.storage, prepared.source, f.text)).rejects.toThrow("blob hash or length mismatch");
  const malformed = JSON.parse(Buffer.from(prepared.bytes).toString("utf8"));
  malformed.turns[1].supportingSourceRanges[0].answerRange.startCodePoint--;
  const bytes = Buffer.from(JSON.stringify(malformed)), key = await f.storage.blobs.put(bytes, "application/json");
  const altered = { ...prepared.source, metadata: toJsonValue({ ...(prepared.source.metadata as object), transcriptArchive: { ...prepared.descriptor, archiveHash: key, archiveByteLength: bytes.length } }) };
  await expect(readSourceTranscriptArchive(f.storage, altered, f.text)).rejects.toThrow("invalid declared transcript answer");
  const changed = structuredClone(f.turns); changed[0]!.sourceRecordId = "different-original";
  expect(() => prepareSourceTranscriptArchive(prepared.source, f.text, changed)).toThrow("append-only");
  expect(await readSourceTranscriptArchive(f.storage, f.source, f.text)).toBeUndefined();
});
it("publishes only an append-only exact-owner metadata sibling while preserving existing metadata guards", async () => {
  const f = fixture(), prepared = prepareSourceTranscriptArchive(f.source, f.text, f.turns);
  const adapter = createPostgresStorageAdapter({ url: "postgres://offline.invalid/no_database", schema: "archive_guard",
    informationAccess: { tenantId: "archive", principalId: "owner", compartments: [], maximumExportClass: "restricted" } }); adapters.push(adapter);
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => []);
  Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
  Object.defineProperty(adapter, "query", { value: query });
  await adapter.evidence.putSourceVersion(prepared.source);
  const [sql, params] = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO") && sql.includes("source_versions"))!;
  for (const guard of ["stored.source_id=EXCLUDED.source_id", "stored.content_hash=EXCLUDED.content_hash", "stored.information_label=EXCLUDED.information_label",
    "->>'sourceId'=stored.source_id", "->>'sourceVersionId'=stored.id", "->>'contentHash'=stored.content_hash", "->>'textDigest'=substring(stored.content_hash FROM 8)",
    "->'informationLabel'=stored.information_label", "->>'authorship'=stored.metadata_json->>'authorship'", "stored.metadata_json->'transcriptArchive'=EXCLUDED.metadata_json->'transcriptArchive'",
    "archive_owner.canonical_uri=", "archive_blob.content_hash=", "to_jsonb(archive_blob.byte_length)=", "stored.metadata_json->'sourceMetadata'=EXCLUDED.metadata_json->'sourceMetadata'"]) expect(sql).toContain(guard);
  expect(sql).toContain("THEN jsonb_build_object('transcriptArchive', EXCLUDED.metadata_json->'transcriptArchive') ELSE '{}'::jsonb END");
  const metadata = JSON.parse(String(params![7]));
  expect(metadata.sourceMetadata).toEqual((f.source.metadata as Record<string, unknown>).sourceMetadata);
  expect(metadata.sourceMetadataBinding).toEqual((f.source.metadata as Record<string, unknown>).sourceMetadataBinding);
});
