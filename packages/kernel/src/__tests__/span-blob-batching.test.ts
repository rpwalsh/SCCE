// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { putSpanBlobs } from "../evidence.js";
import type { BlobStore } from "../storage.js";
import type { ContentHash } from "../types.js";

const hash = (bytes: Uint8Array): ContentHash => `sha256_${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
function fixture(texts: string[]) {
  const bytes = Buffer.from(texts.join(""), "utf8"), parent = { contentHash: hash(bytes), bytes };
  let offset = 0;
  const spans = texts.map(text => { const body = Buffer.from(text, "utf8"), byteStart = offset; offset += body.length;
    return { text, contentHash: hash(body), byteStart, byteEnd: offset }; });
  const calls: Array<{ items: Parameters<BlobStore["putRanges"]>[0]; parent: Parameters<BlobStore["putRanges"]>[1] }> = [];
  const store: Pick<BlobStore, "putRanges"> = { putRanges: async (items, canonical) => { calls.push({ items, parent: canonical }); } };
  return { bytes, parent, spans, calls, store };
}

describe("span blobs use one canonical range representation", () => {
  it("publishes every exact span range in one call without a body-copy path", async () => {
    const f = fixture(["alpha", "βeta", "gamma"]);
    await putSpanBlobs(f.store, f.spans, "text/plain", f.parent);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.parent).toBe(f.parent);
    expect(f.calls[0]!.items).toHaveLength(3);
    for (const [index, item] of f.calls[0]!.items.entries()) {
      expect(item.parentHash).toBe(f.parent.contentHash);
      expect(item.contentHash).toBe(f.spans[index]!.contentHash);
      expect(f.bytes.subarray(item.byteStart, item.byteEnd).toString("utf8")).toBe(f.spans[index]!.text);
    }
  });

  it("writes nothing when there are no spans", async () => {
    const f = fixture([]);
    await putSpanBlobs(f.store, [], "text/plain", f.parent);
    expect(f.calls).toEqual([]);
  });

  it("fails before storage when text is not the declared canonical range", async () => {
    const f = fixture(["same", "different"]);
    await expect(putSpanBlobs(f.store, [{ ...f.spans[0]!, text: "changed" }], "text/plain", f.parent))
      .rejects.toThrow("not an exact range");
    expect(f.calls).toEqual([]);
  });

  it("passes repeated range identities intact for store-level content-addressed deduplication", async () => {
    const f = fixture(["same", "same"]), duplicate = { ...f.spans[1]!, contentHash: f.spans[0]!.contentHash };
    await putSpanBlobs(f.store, [f.spans[0]!, duplicate], "text/plain", f.parent);
    expect(f.calls[0]!.items.map(item => item.contentHash)).toEqual([f.spans[0]!.contentHash, f.spans[0]!.contentHash]);
  });
});
