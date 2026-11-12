// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import type { BlobStore, ContentHash, EvidenceSpan, SourceVersion } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { commitLanguageCorpusTraining, normalizeCorpusTrainingText, prepareLanguageCorpusTraining, type LanguageCorpusTrainingInput } from "../language-corpus-trainer.js";
import { blobContentHash } from "../postgres.js";

function fixture() {
  const evidence: EvidenceSpan[] = [], versions: SourceVersion[] = [];
  const { storage } = storageFixtureForEvaluation({ evidence, clockNow: () => 1700000000000 });
  const material = new Map<ContentHash, Buffer>();
  const ranges = new Map<ContentHash, Parameters<NonNullable<BlobStore["putRanges"]>>[0][number]>();
  const order: string[] = [];
  const put = vi.fn(async (bytes: Uint8Array, _mediaType: string) => {
    const hash = blobContentHash(bytes); material.set(hash, Buffer.from(bytes)); order.push(`material:${hash}`); return hash;
  });
  const putBatch = vi.fn(async (items: Parameters<NonNullable<BlobStore["putBatch"]>>[0]) => {
    return Promise.all(items.map(item => put(item.content, item.mediaType)));
  });
  const putRanges = vi.fn<NonNullable<BlobStore["putRanges"]>>(async (items, parent) => {
    expect(material.get(parent.contentHash)).toEqual(Buffer.from(parent.bytes));
    for (const item of items) {
      expect(item.parentHash).toBe(parent.contentHash);
      expect(blobContentHash(parent.bytes.subarray(item.byteStart, item.byteEnd))).toBe(item.contentHash);
      ranges.set(item.contentHash, item); order.push(`range:${item.contentHash}`);
    }
  });
  const read = async (hash: ContentHash): Promise<Buffer> => {
    const bytes = material.get(hash); if (bytes) return Buffer.from(bytes);
    const range = ranges.get(hash); if (!range) throw Error("fixture blob is absent");
    return (await read(range.parentHash)).subarray(range.byteStart, range.byteEnd);
  };
  storage.blobs = { put, putBatch, putRanges, get: read, exists: async hash => material.has(hash) || ranges.has(hash) };
  storage.evidence.putSourceVersion = async source => { versions.push(source); };
  storage.evidence.putEvidenceSpan = async span => { evidence.push(span); };
  storage.evidence.sourceVersionsForEvidence = async ids => {
    const sourceIds = new Set(evidence.filter(span => ids.includes(span.id)).map(span => span.sourceVersionId));
    return versions.filter(source => sourceIds.has(source.sourceVersionId));
  };
  const text = "Cafe\u0301 東京 🦉 observes Ω.\r\n".repeat(24);
  const input: LanguageCorpusTrainingInput = { storage, sourceSystem: "gutenberg", sourceUri: "fixture://range-corpus/normalized",
    streamUri: "fixture:range-corpus", text, languageOnly: true, createdAt: 1700000000000, maxEvidenceChunkBytes: 128,
    ngramMaxOrder: 2, ngramMaxCountersPerOrder: 32, ngramVocabularyLimit: 64, skipNgramObservationPersistence: true,
    originalSource: { bytes: Buffer.from(`Original source\n${text}`, "utf8"), sourceUri: "fixture://range-corpus/original", transformId: "fixture.exact-text.v1" } };
  const commit = async () => commitLanguageCorpusTraining(input, await prepareLanguageCorpusTraining(input));
  return { input, commit, evidence, versions, material, ranges, order, put, putBatch, putRanges, read };
}

describe("generic corpus chunk blob publication", () => {
  it("publishes exact UTF-8 chunk ranges of the already stored normalized parent, preserving source and evidence identities", async () => {
    const f = fixture(), report = await f.commit();
    expect(f.evidence.length).toBeGreaterThan(1);
    expect(f.putRanges).toHaveBeenCalledTimes(1);
    expect(f.putBatch).not.toHaveBeenCalled();
    expect(f.put).toHaveBeenCalledTimes(2);
    const normalized = Buffer.from(normalizeCorpusTrainingText(f.input.text), "utf8"), parentHash = blobContentHash(normalized);
    const parent = f.versions.find(source => source.sourceVersionId === report.sourceVersionId)!;
    expect(parent.contentHash).toBe(parentHash);
    expect(f.putRanges.mock.calls[0]![1]).toEqual({ contentHash: parentHash, bytes: normalized });
    expect(f.ranges.size).toBeGreaterThan(0);
    for (const span of f.evidence) {
      const range = f.putRanges.mock.calls[0]![0].find(item => item.byteStart === span.byteStart && item.byteEnd === span.byteEnd);
      expect(range).toMatchObject({ contentHash: span.contentHash, parentHash, byteStart: span.byteStart, byteEnd: span.byteEnd });
      expect(await f.read(span.contentHash)).toEqual(Buffer.from(span.text, "utf8"));
      expect(f.order.indexOf(`material:${parentHash}`)).toBeLessThan(f.order.indexOf(`range:${span.contentHash}`));
    }
  });

  it("propagates a range-publication failure without copying chunks through another path", async () => {
    const f = fixture(); f.putRanges.mockRejectedValueOnce(Error("range publication failed"));
    await expect(f.commit()).rejects.toThrow("range publication failed");
    expect(f.put).toHaveBeenCalledTimes(2);
    expect(f.putBatch).not.toHaveBeenCalled();
    expect(f.evidence).toEqual([]);
  });
});
