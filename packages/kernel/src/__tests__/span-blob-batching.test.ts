// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { putSpanBlobs } from "../evidence.js";

// Every ingest path wrote one blob per evidence span in a loop: one database round trip per span, on the path
// where page.transaction already spends 77% of its wall time off-CPU. Blobs are content addressed and the
// single-row write resolves conflicts by doing nothing, so a batch is the same operation without the waiting.
//
// What matters is that batching changed nothing else: the same content is written, repeats collapse, and an
// adapter without the batch form still works through the loop.

function recordingBlobs(withBatch: boolean) {
  const singles: { text: string; mediaType: string }[] = [];
  const batches: { text: string; mediaType: string }[][] = [];
  const store: {
    put(content: Uint8Array, mediaType: string): Promise<string>;
    putBatch?(items: readonly { content: Uint8Array; mediaType: string }[]): Promise<string[]>;
  } = {
    async put(content, mediaType) {
      singles.push({ text: Buffer.from(content).toString("utf8"), mediaType });
      return "hash";
    }
  };
  if (withBatch) {
    store.putBatch = async items => {
      batches.push(items.map(item => ({ text: Buffer.from(item.content).toString("utf8"), mediaType: item.mediaType })));
      return items.map(() => "hash");
    };
  }
  return { store, singles, batches };
}

const spans = (...texts: string[]) => texts.map(text => ({ text }));

describe("span blobs are written in one call where the store offers it", () => {
  it("sends every span's own bytes in a single batch", async () => {
    const blobs = recordingBlobs(true);
    await putSpanBlobs(blobs.store, spans("alpha", "beta", "gamma"), "text/plain");
    expect(blobs.batches).toHaveLength(1);
    expect(blobs.batches[0]!.map(item => item.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(blobs.batches[0]!.every(item => item.mediaType === "text/plain")).toBe(true);
    // Nothing fell through to the per-span path.
    expect(blobs.singles).toEqual([]);
  });

  it("falls back to the loop for an adapter without the batch form", async () => {
    const blobs = recordingBlobs(false);
    await putSpanBlobs(blobs.store, spans("alpha", "beta"), "text/plain");
    expect(blobs.batches).toEqual([]);
    expect(blobs.singles.map(item => item.text)).toEqual(["alpha", "beta"]);
  });

  it("writes nothing at all when there are no spans", async () => {
    const withBatch = recordingBlobs(true);
    await putSpanBlobs(withBatch.store, [], "text/plain");
    expect(withBatch.batches).toEqual([]);
    expect(withBatch.singles).toEqual([]);

    const withoutBatch = recordingBlobs(false);
    await putSpanBlobs(withoutBatch.store, [], "text/plain");
    expect(withoutBatch.singles).toEqual([]);
  });

  it("passes repeated text through, because the store dedupes by content hash", async () => {
    // A page's spans routinely repeat a boilerplate line. The batch statement dedupes by hash before writing,
    // since the same hash twice in one INSERT is a self-conflict Postgres rejects rather than ignores -- but
    // the caller's list is handed over intact so the dedupe is the store's business, not the caller's.
    const blobs = recordingBlobs(true);
    await putSpanBlobs(blobs.store, spans("same", "same", "different"), "text/plain");
    expect(blobs.batches[0]!.map(item => item.text)).toEqual(["same", "same", "different"]);
  });
});
