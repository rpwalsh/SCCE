// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORPUS_ARCHIVE_KEY_PREFIX, corpusArchiveIdentity, createCanonicalBlobReader,
  type CanonicalBlobHost } from "../canonical-evidence-text.js";
import { readWikipediaArchiveBlob } from "../wikipedia.js";

// Archive parsing/file identity has its own boundary. These tests exercise the
// blob host's representation, descriptor identity and exact decoded byte checks.
vi.mock("../wikipedia.js", () => ({ readWikipediaArchiveBlob: vi.fn() }));
const archiveRead = vi.mocked(readWikipediaArchiveBlob);
const hash = (bytes: Uint8Array | string): string => `sha256_${createHash("sha256").update(bytes).digest("hex")}`;
interface Row {
  content: Buffer; byte_length: string; range_parent_hash: string | null; range_start: string | null; range_end: string | null;
  archive_reference: { archiveId: string; page: unknown } | null; archive: unknown;
}
function fixture() {
  const rows = new Map<string, Row>(), calls: string[] = [], receipts = new Map<string, unknown>();
  const host: CanonicalBlobHost = {
    table: name => `"fixture"."${name}"`,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes('FROM "fixture"."storage_meta" WHERE key=')) {
        const value = receipts.get(String(params[0]));
        return (value === undefined ? [] : [{ value_json: value }]) as T[];
      }
      if (sql.includes('INSERT INTO "fixture"."storage_meta"')) {
        receipts.set(String(params[0]), JSON.parse(String(params[1])));
        return [];
      }
      expect(sql).toContain('FROM "fixture"."blobs" blob');
      expect(sql).toContain('LEFT JOIN "fixture"."storage_meta" archive');
      expect(params[1]).toBe(CORPUS_ARCHIVE_KEY_PREFIX);
      const id = String(params[0]); calls.push(id);
      return (rows.has(id) ? [rows.get(id)!] : []) as unknown as T[];
    }
  };
  const material = (bytes: Buffer): string => {
    const id = hash(bytes); rows.set(id, { content: bytes, byte_length: String(bytes.length), range_parent_hash: null,
      range_start: null, range_end: null, archive_reference: null, archive: null }); return id;
  };
  const range = (bytes: Buffer, parent: string, start: number, end: number): string => {
    const id = hash(bytes); rows.set(id, { content: Buffer.alloc(0), byte_length: String(bytes.length), range_parent_hash: parent,
      range_start: String(start), range_end: String(end), archive_reference: null, archive: null }); return id;
  };
  const archive = (bytes: Buffer, descriptor: unknown, page: unknown = { fixturePage: "owned" }): string => {
    const id = hash(bytes); rows.set(id, { content: Buffer.alloc(0), byte_length: String(bytes.length), range_parent_hash: null,
      range_start: null, range_end: null, archive_reference: { archiveId: corpusArchiveIdentity(descriptor), page }, archive: descriptor }); return id;
  };
  return { rows, calls, receipts, material, range, archive, read: createCanonicalBlobReader(host) };
}
beforeEach(() => { archiveRead.mockReset(); });

describe("canonical evidence material and range bytes", () => {
  it("round-trips empty, binary and multilingual material without normalizing it", async () => {
    const f = fixture();
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 128, 1]), Buffer.from("雪 🧭 e\u0301 \u0000", "utf8")]) {
      const id = f.material(bytes); expect(await f.read(id)).toEqual(bytes);
    }
    expect(archiveRead).not.toHaveBeenCalled();
  });

  it("selects exact UTF-8 byte ranges and reuses only the verified parent", async () => {
    const f = fixture(), bytes = Buffer.from("prefix|雪🧭e\u0301|suffix"), parent = f.material(bytes);
    const text = Buffer.from("雪🧭e\u0301"), start = bytes.indexOf(text), id = f.range(text, parent, start, start + text.length);
    const selected = await f.read(id); expect(selected).toEqual(text);
    selected.fill(0);
    expect(await f.read(id)).toEqual(text);
    expect(f.calls.filter(key => key === parent)).toHaveLength(1);
    const cachedParent = await f.read(parent); cachedParent.fill(0);
    expect(await f.read(parent)).toEqual(bytes);
  });

  it.each(["", "sha256_bad", `sha256_${"A".repeat(64)}`, `sha256:${"0".repeat(64)}`])("rejects invalid hash %j before a host query", async id => {
    const f = fixture(); await expect(f.read(id)).rejects.toThrow("invalid or cyclic canonical blob reference"); expect(f.calls).toEqual([]);
  });

  it("reports a missing material body rather than returning an empty substitute", async () => {
    const f = fixture(); await expect(f.read(hash("absent"))).rejects.toThrow("blob not found"); expect(f.calls).toHaveLength(1);
  });

  it.each(["body", "length"])("verifies material %s against its content address", async mutation => {
    const f = fixture(), id = f.material(Buffer.from("owned"));
    if (mutation === "body") f.rows.get(id)!.content = Buffer.from("other"); else f.rows.get(id)!.byte_length = "6";
    await expect(f.read(id)).rejects.toThrow("canonical blob integrity mismatch");
  });

  it.each(["-1", "NaN", "9007199254740992"])("rejects invalid declared byte length %s", async length => {
    const f = fixture(), id = f.material(Buffer.from("owned")); f.rows.get(id)!.byte_length = length;
    await expect(f.read(id)).rejects.toThrow("invalid canonical blob length");
  });

  it("verifies a range's own hash and its parent's hash independently", async () => {
    const f = fixture(), parent = f.material(Buffer.from("abcdef")), id = f.range(Buffer.from("bc"), parent, 1, 3);
    f.rows.get(parent)!.content = Buffer.from("ABCDEF");
    await expect(f.read(id)).rejects.toThrow("canonical blob integrity mismatch");
    const g = fixture(), goodParent = g.material(Buffer.from("abcdef")), wrongRange = g.range(Buffer.from("xy"), goodParent, 1, 3);
    await expect(g.read(wrongRange)).rejects.toThrow("canonical blob integrity mismatch");
  });

  it.each(["negative", "fractional", "missing", "length"])("rejects %s range coordinates before reading its parent", async mutation => {
    const f = fixture(), parent = f.material(Buffer.from("abcdef")), id = f.range(Buffer.from("bc"), parent, 1, 3), row = f.rows.get(id)!;
    if (mutation === "negative") row.range_start = "-1";
    if (mutation === "fractional") row.range_end = "3.5";
    if (mutation === "missing") row.range_start = null;
    if (mutation === "length") row.byte_length = "1";
    await expect(f.read(id)).rejects.toThrow("invalid canonical blob range"); expect(f.calls).toEqual([id]);
  });

  it("rejects a range extending beyond a verified parent", async () => {
    const f = fixture(), parent = f.material(Buffer.from("abcdef")), id = f.range(Buffer.from("zz"), parent, 5, 7);
    await expect(f.read(id)).rejects.toThrow("canonical blob range exceeds its source");
  });

  it("rejects self cycles and multi-row cycles before rereading an ancestor", async () => {
    const f = fixture(), a = f.range(Buffer.from("aa"), hash("bb"), 0, 2), b = f.range(Buffer.from("bb"), a, 0, 2);
    await expect(f.read(a)).rejects.toThrow("invalid or cyclic canonical blob reference"); expect(f.calls).toEqual([a, b]);
    const g = fixture(), self = hash("self"); g.range(Buffer.from("self"), self, 0, 4);
    await expect(g.read(self)).rejects.toThrow("invalid or cyclic canonical blob reference"); expect(g.calls).toEqual([self]);
  });

  it("bounds ancestry to one range hop even when deeper coordinates would be valid", async () => {
    const f = fixture(), original = f.material(Buffer.from("abcdef")), middle = f.range(Buffer.from("bcde"), original, 1, 5), leaf = f.range(Buffer.from("cd"), middle, 1, 3);
    await expect(f.read(leaf)).rejects.toThrow("invalid or cyclic canonical blob reference"); expect(f.calls).toEqual([leaf, middle]);
  });

  it.each(["range body", "range archive", "material coordinates", "missing body"])("rejects an ambiguous or incomplete representation: %s", async mutation => {
    const f = fixture(), parent = f.material(Buffer.from("abcdef")), id = f.range(Buffer.from("bc"), parent, 1, 3), row = f.rows.get(id)!;
    if (mutation === "range body") row.content = Buffer.from("bc");
    if (mutation === "range archive") row.archive_reference = { archiveId: "fixture", page: {} };
    if (mutation === "material coordinates") row.range_parent_hash = null;
    if (mutation === "missing body") row.content = null as unknown as Buffer;
    await expect(f.read(id)).rejects.toThrow(/ambiguous|orphan|body is missing/u);
  });

  it("retains at most 64 verified parent bodies in one reader", async () => {
    const f = fixture(), pairs = Array.from({ length: 65 }, (_, index) => {
      const text = Buffer.from(String(index)), parent = f.material(Buffer.from(`${index}:parent`));
      return { parent, id: f.range(text, parent, 0, text.length), text };
    });
    for (const pair of pairs) expect(await f.read(pair.id)).toEqual(pair.text);
    expect(await f.read(pairs[64]!.id)).toEqual(pairs[64]!.text);
    expect(f.calls.filter(id => id === pairs[64]!.parent)).toHaveLength(1);
    expect(await f.read(pairs[0]!.id)).toEqual(pairs[0]!.text);
    expect(f.calls.filter(id => id === pairs[0]!.parent)).toHaveLength(2);
  });

  it("evicts verified parents when their combined bodies exceed 16 MiB", async () => {
    const f = fixture(), a = f.material(Buffer.alloc(9 * 1024 * 1024, 97)), b = f.material(Buffer.alloc(9 * 1024 * 1024, 98));
    const aa = f.range(Buffer.from("aa"), a, 0, 2), bb = f.range(Buffer.from("bb"), b, 0, 2);
    expect(await f.read(aa)).toEqual(Buffer.from("aa")); expect(await f.read(bb)).toEqual(Buffer.from("bb"));
    expect(await f.read(aa)).toEqual(Buffer.from("aa")); expect(f.calls.filter(id => id === a)).toHaveLength(2);
  });

  it("verifies but does not retain a parent larger than the 16 MiB cache budget", async () => {
    const f = fixture(), body = Buffer.alloc(16 * 1024 * 1024 + 1, 97), parent = f.material(body), id = f.range(Buffer.from("aa"), parent, 0, 2);
    expect(await f.read(id)).toEqual(Buffer.from("aa")); expect(await f.read(id)).toEqual(Buffer.from("aa"));
    expect(f.calls.filter(key => key === parent)).toHaveLength(2);
  });
});

describe("canonical archive descriptor and decoded hash boundary", () => {
  it("binds descriptor identity independently of property order", () => {
    expect(corpusArchiveIdentity({ schema: "fixture", version: 1 })).toBe(corpusArchiveIdentity({ version: 1, schema: "fixture" }));
    expect(corpusArchiveIdentity({ schema: "fixture", version: 1 })).not.toBe(corpusArchiveIdentity({ schema: "fixture", version: 2 }));
  });

  it("resolves an archive parent and its range without decoding the archive twice", async () => {
    const f = fixture(), bytes = Buffer.from("prefix|雪🧭|suffix"), descriptor = { schema: "test.archive", fixture: "range" }, page = { pageId: "12" };
    const parent = f.archive(bytes, descriptor, page), selected = Buffer.from("雪🧭"), start = bytes.indexOf(selected), id = f.range(selected, parent, start, start + selected.length);
    archiveRead.mockResolvedValue(bytes);
    expect(await f.read(id)).toEqual(selected); expect(await f.read(id)).toEqual(selected);
    expect(archiveRead).toHaveBeenCalledTimes(1);
    expect(archiveRead.mock.calls[0]?.[0]).toBe(descriptor);
    expect(archiveRead.mock.calls[0]?.[1]).toBe(page);
    expect(archiveRead.mock.calls[0]?.[2]?.verificationCache).toBeDefined();
  });

  it("stores and revalidates an exact archive-source verification receipt", async () => {
    const f = fixture(), bytes = Buffer.from("owned"), descriptor = { schema: "test.archive", fixture: "receipt" };
    const id = f.archive(bytes, descriptor), source = { path: "C:/fixture/wiki.bz2", sha256: `sha256:${"a".repeat(64)}` as const,
      byteLength: 5, stat: { size: "5", mtimeNs: "1", ctimeNs: "2", dev: "3", ino: "4" } };
    archiveRead.mockImplementation(async (_archive, _page, options) => {
      expect(await options?.verificationCache?.read(source, source.stat)).toBe(false);
      await options?.verificationCache?.write(source, source.stat);
      expect(await options?.verificationCache?.read(source, source.stat)).toBe(true);
      expect(await options?.verificationCache?.read(source, { ...source.stat, ctimeNs: "changed" })).toBe(false);
      return bytes;
    });
    expect(await f.read(id)).toEqual(bytes);
    expect(f.receipts.size).toBe(1);
  });

  it("rejects changed or missing descriptors before invoking the archive decoder", async () => {
    const f = fixture(), id = f.archive(Buffer.from("owned"), { schema: "test.archive", fixture: "changed" });
    f.rows.get(id)!.archive = { schema: "test.archive", fixture: "foreign" };
    await expect(f.read(id)).rejects.toThrow("canonical corpus archive identity mismatch");
    f.rows.get(id)!.archive = null;
    await expect(f.read(id)).rejects.toThrow("canonical corpus archive descriptor is missing");
    expect(archiveRead).not.toHaveBeenCalled();
  });

  it.each(["hash", "length"])("rejects archive output with a different %s", async mutation => {
    const f = fixture(), id = f.archive(Buffer.from("owned"), { schema: "test.archive", fixture: mutation });
    archiveRead.mockResolvedValue(Buffer.from(mutation === "hash" ? "other" : "shorter"));
    await expect(f.read(id)).rejects.toThrow("canonical blob integrity mismatch");
  });

  it("rechecks a descriptor received again after its identity has been cached", async () => {
    const f = fixture(), descriptor = { schema: "test.archive", fixture: "cached", revision: 1 }, bytes = Buffer.from("owned"), id = f.archive(bytes, descriptor);
    archiveRead.mockResolvedValue(bytes); expect(await f.read(id)).toEqual(bytes);
    descriptor.revision = 2;
    await expect(f.read(id)).rejects.toThrow("canonical corpus archive identity mismatch");
    expect(archiveRead).toHaveBeenCalledTimes(1);
  });
});
