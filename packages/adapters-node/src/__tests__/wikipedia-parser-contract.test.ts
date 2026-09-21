// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClock, createEvidenceExtractor, createHasher, createIdFactory, createLanguageAcquisitionEngine } from "@scce/kernel";
import { normalizeWikiText, streamWikipediaMultistream, wikiPageStructure, type ResolvedWikipediaCorpus } from "../wikipedia.js";
import { decodeWikiEntities, type WikiNormalizationDiagnostics } from "../wikipedia-markup.js";
import { wikipediaSourceVersionIdentities } from "../wikipedia-v3-ingestor.js";

const captured: Array<{ title: string; revision: string; raw: string }> = JSON.parse(readFileSync(
  new URL("./fixtures/wikipedia-parser-regressions.json", import.meta.url), "utf8"
));
const diagnostics = (): WikiNormalizationDiagnostics => ({ unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 });
const xmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const pageXml = (raw: string) => `<page><title>Parser fixture</title><ns>0</ns><id>42</id><revision><id>99</id><text xml:space="preserve">${xmlEscape(raw)}</text></revision></page>`;
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

async function dumpFixture(xml: Uint8Array, maxArticleChars = 160000) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-wiki-parser-"));
  const dumpPath = path.join(root, "enwiki-fixture.xml.bz2");
  const indexPath = path.join(root, "index.txt");
  const compressed = execFileSync("python", ["-c", "import bz2,sys; sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read()))"], { input: xml, windowsHide: true });
  await writeFile(dumpPath, compressed);
  await writeFile(indexPath, "0:42:Parser fixture\n");
  const corpus: ResolvedWikipediaCorpus = { dumpPath, indexPath, namespace: "fixture", wikiCode: "enwiki", python: "python",
    maxPagesPerRun: 100, maxBlocksPerRun: 0, maxArticleChars, maxBlockBytes: 8_000_000,
    memorySafetyBoundMb: 100000, checkpointEveryPages: 100, skipRedirects: true, allowedNamespaces: [0] };
  return { root, corpus, compressed, close: () => rm(root, { recursive: true, force: true }) };
}

describe("Wikipedia source and surface contract", () => {
  it("separates source ownership and coordinate roles even when all source bytes are identical", async () => {
    const raw = "The source and normalized surface have the same bytes. ".repeat(4).trim();
    const f = await dumpFixture(Buffer.from(pageXml(raw)));
    try {
      const item = (await collect(streamWikipediaMultistream(f.corpus))).find(row => row.type === "file");
      if (item?.type !== "file") throw new Error("missing fixture page");
      expect(item.file.evidenceDerivative).toBeUndefined();
      const ids = createIdFactory({ clock: createClock({ fixedTime: 1700000000000 }), hasher: createHasher() });
      const identity = wikipediaSourceVersionIdentities(item.file, ids);
      expect(identity.evidenceVersionId).toBe(identity.originalVersionId);
      // A caller-supplied derivative still has a distinct role even if its output happens to be identical.
      const withDerivative = wikipediaSourceVersionIdentities({ ...item.file, evidenceDerivative: {
        text: raw, bytes: item.file.bytes, kind: "extracted-text", transformId: "fixture.identity-transform",
        originalCoordinateSpace: "extracted-text-utf8", redactionMap: []
      } }, ids);
      expect(withDerivative.evidenceVersionId).not.toBe(withDerivative.originalVersionId);
      expect(wikipediaSourceVersionIdentities(item.file, ids)).toEqual(identity);
      const otherPage = wikipediaSourceVersionIdentities({ ...item.file, uri: `${item.file.uri}/other` }, ids);
      expect(otherPage.originalVersionId).not.toBe(identity.originalVersionId);
      expect(otherPage.evidenceVersionId).not.toBe(identity.evidenceVersionId);
      const nextRevision = wikipediaSourceVersionIdentities({ ...item.file, metadata: { ...(item.file.metadata as any), revisionId: "100" } }, ids);
      expect(nextRevision.originalVersionId).not.toBe(identity.originalVersionId);
    } finally { await f.close(); }
  });

  it.each([
    ["0:7:Wrong source\n", "identity mismatch"],
    ["0:42:Parser fixture\n0:43:Missing page\n", "count mismatch"],
    ["not an index\n", "malformed page entry"],
    ["", "no page entries"],
    ["9999999999:42:Parser fixture\n", "outside the dump"],
    ["10:42:Parser fixture\n0:42:Parser fixture\n", "out of order"]
  ])("rejects an incompatible or malformed index (%s)", async (index, failure) => {
    const f = await dumpFixture(Buffer.from(pageXml("Source text with enough material to pass admission. ".repeat(4))));
    try {
      await writeFile(f.corpus.indexPath!, index);
      const seen: any[] = [];
      await expect((async () => { for await (const item of streamWikipediaMultistream(f.corpus)) seen.push(item); })()).rejects.toThrow(failure);
      expect(seen.some(item => item.checkpoint.phase === "stored" && item.checkpoint.itemUri.includes("/block/"))).toBe(false);
    } finally { await f.close(); }
  });

  it("preserves the captured Bonn quantity and removes the complete nested Albedo image", () => {
    expect(normalizeWikiText(captured.find(row => row.title === "Bonn")!.raw)).toContain("about 24 km south-southeast of Cologne");
    const albedo = normalizeWikiText(captured.find(row => row.title === "Albedo")!.raw);
    expect(albedo).toMatch(/^Albedo is the fraction of sunlight/);
    expect(albedo).not.toContain("Greenland");
    expect(albedo).not.toContain("]]");
    expect(albedo).toContain("scale from 0");
  });

  it.each([
    ["{{convert|12|to|24|km|mi}}", "12 to 24 km"],
    ["{{cvt|5|ft|8|in|cm}}", "5 ft 8 in"],
    ["{{convert|1=24|2=km|3=0|abbr=on}}", "24 km"],
    ["{{nowrap|{{lang|de|[[Köln|Köln]]}}}}", "Köln"]
  ])("renders source inputs without inventing conversion output: %s", (raw, expected) => {
    expect(normalizeWikiText(raw)).toBe(expected);
  });

  it("preserves apostrophes and comparisons while removing actual formatting tags", () => {
    expect(normalizeWikiText("'''Bonn''' and ''Cologne'' aren't the same. x < 5 and y > 3; a <b>bold</b> word."))
      .toBe("Bonn and Cologne aren't the same. x < 5 and y > 3; a bold word.");
    expect(normalizeWikiText("The limit is x < 5.")).toBe("The limit is x < 5.");
  });

  it("decodes each source layer once and retains unknown entity spelling", () => {
    const raw = decodeWikiEntities("&amp;lt; &amp;amp; &#x1F642; &amp;unknown;", true);
    expect(raw).toBe("&lt; &amp; 🙂 &unknown;");
    expect(normalizeWikiText(raw)).toBe("< & 🙂 &unknown;");
    expect(decodeWikiEntities("&#xD800; &#1114112; &#0;")).toBe("&#xD800; &#1114112; &#0;");
  });

  it("records unsupported and malformed constructs without swallowing trailing text", () => {
    const report = diagnostics();
    expect(normalizeWikiText("A {{unsupported|42}} B {{broken|tail", report)).toContain("tail");
    expect(report).toMatchObject({ unexpandedTemplateCount: 1, unexpandedTemplates: ["unsupported"], malformedConstructs: 1 });
    const brokenLink = diagnostics();
    expect(normalizeWikiText("A [[unfinished tail", brokenLink)).toContain("unfinished tail");
    expect(brokenLink.malformedConstructs).toBe(1);
  });

  it("keeps a curly-brace link label intact during separator cleanup", () => {
    const report = diagnostics();
    expect(normalizeWikiText("[[Left curly bracket|{]]", report)).toBe("{");
    expect(report.malformedConstructs).toBe(0);
    const squareReport = diagnostics();
    expect(normalizeWikiText("[[Left square bracket|[]]", squareReport)).toBe("[");
    expect(squareReport.malformedConstructs).toBe(0);
  });

  it("uses source code-point coordinates for headings", () => {
    const raw = "🙂 Lead.\n== Heading ==\nBody.";
    expect(wikiPageStructure(raw).headings[0]).toMatchObject({ text: "Heading", charStart: 8 });
  });

  it("streams a large page intact, clipping only the derivative at a Unicode boundary", async () => {
    const raw = "A".repeat(1600) + "🙂" + " tail".repeat(1500);
    const f = await dumpFixture(Buffer.from(pageXml(raw)), 1601);
    try {
      const items = await collect(streamWikipediaMultistream(f.corpus));
      const entry = items.find(item => item.type === "file");
      expect(entry?.type).toBe("file");
      if (!entry || entry.type !== "file") throw new Error("missing source page");
      expect(Buffer.from(entry.file.bytes).toString("utf8")).toBe(raw);
      expect(entry.file.text).toBe(raw);
      const derived = entry.file.evidenceDerivative!;
      expect(derived.text).toBe("A".repeat(1600));
      expect(Buffer.from(derived.bytes).toString("utf8")).toBe(derived.text);
      expect((entry.file.metadata as any).normalization.truncatedChars).toBe(raw.length - 1600);
      expect((entry.file.metadata as any).sourceFamilyId).toBe("wikimedia:wikipedia");
    } finally { await f.close(); }
  });

  it("binds normalized evidence to exact derivative bytes while preserving raw wikitext", async () => {
    const raw = "🙂 " + captured.find(row => row.title === "Bonn")!.raw;
    const f = await dumpFixture(Buffer.from(pageXml(raw)));
    try {
      const items = await collect(streamWikipediaMultistream(f.corpus));
      const entry = items.find(item => item.type === "file");
      if (!entry || entry.type !== "file") throw new Error("missing source page");
      expect(entry.file.text).toBe(raw);
      const derived = entry.file.evidenceDerivative!;
      const clock = createClock({ fixedTime: 1700000000000 }), hasher = createHasher();
      const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
      const version = ids.sourceVersionId(derived.bytes);
      const original = ids.sourceVersionId(entry.file.bytes);
      const derivation = { kind: derived.kind, transformId: derived.transformId, derivedFromSourceVersionId: original,
        originalCoordinateSpace: derived.originalCoordinateSpace, redactionMap: derived.redactionMap };
      const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: version, text: derived.text, createdAt: clock.now() });
      const { spans } = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
        sourceId: ids.sourceId("fixture", entry.file.uri), sourceVersionId: version, namespace: "fixture", uri: entry.file.uri,
        mediaType: "text/plain", text: derived.text, languageProfile: profile, observedAt: clock.now(), maxChunkBytes: 4096,
        sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
          independenceGroup: "wikimedia:wikipedia", accessScope: "public", licenseStatus: "licensed" },
        metadata: entry.file.metadata, sourceVersionDerivation: derivation, exactSourceText: true
      });
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.sourceVersionId).toBe(version);
        expect(Buffer.from(derived.bytes).subarray(span.byteStart, span.byteEnd).toString("utf8")).toBe(span.text);
        expect([...derived.text].slice(span.charStart, span.charEnd).join("")).toBe(span.text);
      }
      expect(version).not.toBe(original);
    } finally { await f.close(); }
  });

  it("keeps heading coordinates and redaction intervals in their declared source spaces", async () => {
    const raw = "{{unsupported|discard}} 🙂 " + "Ordinary prose. ".repeat(15)
      + "\n== A '''heading''' ==\npassword = correct-horse-battery-staple\nMore body text.";
    const f = await dumpFixture(Buffer.from(pageXml(raw)));
    try {
      const items = await collect(streamWikipediaMultistream(f.corpus));
      const entry = items.find(item => item.type === "file");
      if (!entry || entry.type !== "file") throw new Error("missing source page");
      const derived = entry.file.evidenceDerivative!;
      const meta = entry.file.metadata as any;
      const heading = meta.structure.headings[0];
      expect([...derived.text].slice(heading.charStart).join("")).toMatch(/^== A heading ==/);
      expect([...raw].slice(meta.originalStructure.headings[0].charStart).join("")).toMatch(/^== A '''heading''' ==/);
      expect(derived.originalCoordinateSpace).toBe("extracted-text-utf8");
      expect(derived.redactionMap.length).toBeGreaterThan(0);
      expect(derived.text).not.toContain("correct-horse-battery-staple");
      for (const interval of derived.redactionMap) {
        expect(Buffer.from(derived.bytes).subarray(interval.derivativeByteStart, interval.derivativeByteEnd).toString("utf8")).toBe(interval.replacement);
        expect(Buffer.from(normalizeWikiText(raw)).subarray(interval.originalByteStart, interval.originalByteEnd).toString("utf8")).not.toBe(interval.replacement);
      }
    } finally { await f.close(); }
  });

  it.each(["truncated-bzip2", "invalid-utf8"])("rejects %s instead of marking a block complete", async mode => {
    const raw = Buffer.from(pageXml("Ordinary prose. ".repeat(30)));
    const xml = mode === "invalid-utf8" ? Buffer.concat([raw.subarray(0, 130), Buffer.from([0xff]), raw.subarray(130)]) : raw;
    const f = await dumpFixture(xml);
    try {
      if (mode === "truncated-bzip2") await writeFile(f.corpus.dumpPath, f.compressed.subarray(0, f.compressed.length - 8));
      const checkpoints: any[] = [];
      await expect((async () => {
        for await (const item of streamWikipediaMultistream(f.corpus)) checkpoints.push(item.checkpoint);
      })()).rejects.toThrow();
      expect(checkpoints.some(row => row.phase === "stored" && row.status === "complete")).toBe(false);
    } finally { await f.close(); }
  });

  it("commits a completed final block when the page cap lands exactly at its end", async () => {
    const f = await dumpFixture(Buffer.from(pageXml("A complete article sentence. ".repeat(10))));
    try {
      const items = await collect(streamWikipediaMultistream({ ...f.corpus, maxPagesPerRun: 1 }));
      expect(items.filter(item => item.checkpoint.itemUri.includes("/block/") && item.checkpoint.phase === "stored")).toHaveLength(1);
      expect((items.at(-1)!.checkpoint.metadata as any).reachedEnd).toBe(true);
    } finally { await f.close(); }
  });

  it("rejects a block exceeding its decoded-byte budget", async () => {
    const f = await dumpFixture(Buffer.from(pageXml("An article sentence. ".repeat(100))));
    try {
      await expect(collect(streamWikipediaMultistream({ ...f.corpus, maxBlockBytes: 512 }))).rejects.toThrow("exceeds configured max bytes");
    } finally { await f.close(); }
  });
});
