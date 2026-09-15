// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createClock, createHasher, createIdFactory, createTypedIngestProjector } from "@scce/kernel";
import type { ScceRuntimeConfig } from "../config.js";
import { runProcess } from "../document.js";
import { normalizeFetchedSource, publicDocumentExport, type FetchedSource } from "../fetched-source.js";
import { inspectOfficeArchive } from "../spreadsheet-parser.js";

let tempRoot: string;
let config: ScceRuntimeConfig;
beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "scce-fetched-test-"));
  config = {
    server: { url: "http://127.0.0.1:3873" }, database: { url: "postgresql://localhost/scce", schema: "scce" },
    runtime: { workspaceRoot: tempRoot, tempRoot, allowedRoots: [tempRoot], excludedPaths: [], maxFileBytes: 2 * 1024 * 1024, maxChunkBytes: 1000, tools: { pdftotext: "scce-missing-pdftotext-fixture", tesseract: "scce-missing-tesseract-fixture" } },
    connectors: { web: { enabled: true, allowedHosts: [], maxBytes: 2 * 1024 * 1024 } },
    policy: { allowMutation: false, requireTwoPhaseCommit: true, dryRunByDefault: true, maxNetworkRequests: 12, maxToolCalls: 24, maxSpendCents: 0, alphaRiskCeiling: 0.55, encryptSecretsAtRest: false }
  };
});
afterEach(async () => {
  if (path.dirname(tempRoot) !== path.resolve(os.tmpdir()) || !path.basename(tempRoot).startsWith("scce-fetched-test-")) throw new Error("invalid test cleanup root");
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
const source = (bytes: Uint8Array, mediaType = "application/octet-stream", uri = "https://publisher.example/source"): FetchedSource => ({
  bytes, mediaType, uri, metadata: { requestedUri: "https://catalog.example/record", redirectChain: ["https://catalog.example/record", uri], quarantined: true }
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("bounded fetched document derivatives", () => {
  it.each(["xlsx", "xlsm", "xls"] as const)("extracts actual %s content while retaining original source identity and raw bytes", async bookType => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["\uad00\uce21", "value"], ["\u03b1", 42]]), "\uacb0\uacfc");
    const raw = XLSX.write(workbook, { type: "buffer", bookType }) as Buffer;
    // OLE requires the .xls or media declaration; OOXML is sniffed even with neither.
    const input = source(raw, "application/octet-stream", `https://publisher.example/${bookType === "xls" ? "source.xls" : "download"}`);
    const result = await normalizeFetchedSource(input, config);
    expect(result.bytes).toBe(input.bytes);
    expect(hash(result.bytes)).toBe(hash(raw));
    expect(result.uri).toBe(input.uri);
    expect(result.mediaType).not.toBe("application/octet-stream");
    expect(result.evidenceDerivative).toMatchObject({ kind: "extracted-text", transformId: "scce.fetched-source-text.v1", originalCoordinateSpace: "extracted-text-utf8", redactionMap: [] });
    expect(result.evidenceDerivative?.text).toContain("42");
    expect(result.evidenceDerivative?.text).toContain("\u03b1");
    expect(Buffer.from(result.evidenceDerivative!.bytes).toString("utf8")).toBe(result.evidenceDerivative!.text);
    expect(result.metadata).toMatchObject({
      quarantined: true, redirectChain: input.metadata && (input.metadata as { redirectChain: string[] }).redirectChain,
      typedExtraction: { workbook: { sourceFormat: bookType, complete: true, security: { macroExecution: false, formulaEvaluation: false, externalLinkResolution: false } } },
      normalization: { originalSha256: hash(raw), sourceUri: input.uri, extractor: "sheetjs-ce-0.20.3", originalMediaType: "application/octet-stream" }
    });
    const hasher = createHasher();
    const idFactory = createIdFactory({ hasher, clock: createClock({ fixedTime: 100, stepMs: 1 }), deterministicReplay: true, namespace: "fetched-source-test" });
    const preview = createTypedIngestProjector({ hasher, idFactory }).preview({ uri: result.uri, mediaType: result.mediaType, text: result.evidenceDerivative!.text, metadata: result.metadata });
    expect(preview.observationCounts).toMatchObject({ table: 1 });
    expect(preview.suppressRawLanguageTraining).toBe(true);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("extracts real DOCX XML through bounded Mammoth without reclassifying the raw ZIP as text", async () => {
    const raw = officeFixture("docx");
    expect(inspectOfficeArchive(raw).officeFormat).toBe("docx");
    const result = await normalizeFetchedSource(source(raw), config);
    expect(result.bytes).toEqual(raw);
    expect(result.evidenceDerivative?.text).toContain("\u03b1 \uad00\uce21 42");
    expect(result.metadata).toMatchObject({ normalization: { extractor: "mammoth-docx-raw", originalSha256: hash(raw), detectedMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("normalizes declared Unicode encoding and line endings as an explicit derivative", async () => {
    const raw = Buffer.from("\ufeff\uad00\uce21\r\n42", "utf16le");
    const result = await normalizeFetchedSource(source(raw, "text/plain; charset=utf-16le"), config);
    expect(result.bytes).toEqual(raw);
    expect(result.evidenceDerivative?.text).toBe("\uad00\uce21\n42");
    const unchanged = await normalizeFetchedSource(source(Buffer.from("unchanged source"), "text/plain"), config);
    expect(unchanged.evidenceDerivative).toBeUndefined();
  });

  it.each([
    ["PDF", Buffer.from("%PDF-1.7\nfixture"), "pdftotext"],
    ["PNG", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), "tesseract"],
    ["JPEG", Buffer.from([255, 216, 255, 0]), "tesseract"],
    ["TIFF", Buffer.from("49492a0000000000", "hex"), "tesseract"],
    ["BMP", Buffer.from("BM\u0000\u0000"), "tesseract"],
    ["WEBP", Buffer.from("RIFFxxxxWEBPxxxx"), "tesseract"]
  ])("routes %s to its configured extractor and rejects missing tools without binary fallback", async (_label, raw, tool) => {
    await expect(normalizeFetchedSource(source(raw as Buffer), config)).rejects.toThrow(new RegExp(String(tool)));
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("rejects unsupported binary and false media declarations while extracting ordered PPTX slide text", async () => {
    await expect(normalizeFetchedSource(source(Buffer.from([0, 255, 0])), config)).rejects.toThrow(/unsupported fetched source/);
    await expect(normalizeFetchedSource(source(Buffer.from("not a PDF"), "application/pdf"), config)).rejects.toThrow(/binary signature/);
    await expect(normalizeFetchedSource(source(Buffer.from("GIF89a"), "image/gif"), config)).rejects.toThrow(/unsupported fetched source media/);
    await expect(normalizeFetchedSource(source(Buffer.from("GIF89a")), config)).rejects.toThrow(/unsupported fetched source media/);
    const pptxRaw = officeFixture("pptx");
    const pptx = await normalizeFetchedSource(source(pptxRaw), config);
    expect(pptx.bytes).toEqual(pptxRaw);
    expect(pptx.evidenceDerivative?.text).toBe("first slide α\n\nsecond slide 42");
    expect(pptx.metadata).toMatchObject({
      normalization: { extractor: "bounded-pptx-text", originalSha256: hash(pptxRaw) },
      typedExtraction: { presentation: { slideCount: 2 } }
    });
  });

  it("rejects archive entity expansion, source/output overflow and cancelled extraction", async () => {
    await expect(normalizeFetchedSource(source(officeFixture("docx", true)), config)).rejects.toThrow(/entity declarations/);
    config.connectors.web!.maxBytes = 4;
    await expect(normalizeFetchedSource(source(Buffer.from("too large"), "text/plain"), config)).rejects.toThrow(/source byte limit/);
    await expect(normalizeFetchedSource(source(Buffer.from([255, 255, 255, 255]), "text/plain; charset=windows-1252"), config)).rejects.toThrow(/output byte limit/);
    const controller = new AbortController();
    controller.abort(new Error("fixture cancellation"));
    await expect(normalizeFetchedSource(source(Buffer.from("text"), "text/plain"), config, { signal: controller.signal })).rejects.toThrow("fixture cancellation");
  });
});

describe("document extraction process bounds", () => {
  it("discards partial stdout when its output limit is exceeded", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(65536))"], { maxOutputBytes: 128, timeoutMs: 5000 });
    expect(result).toMatchObject({ code: null, stdout: "", stderr: "document extraction exceeded output byte limit" });
  });
  it("discards partial stdout on timeout", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('partial'); setTimeout(()=>{}, 10000)"], { maxOutputBytes: 128, timeoutMs: 250 });
    expect(result).toMatchObject({ code: null, stdout: "", stderr: "document extraction timed out" });
  });
});

describe("public Google Workspace export mapping", () => {
  it.each([
    ["document", "export?format=txt", "text"], ["spreadsheets", "export?format=xlsx", "xlsx"], ["presentation", "export/pptx", "pptx"]
  ] as const)("maps a public %s viewing URL to a deterministic export", (kind, suffix, format) => {
    expect(publicDocumentExport(`https://docs.google.com/${kind}/d/fixture_public_document/edit?usp=sharing#gid=0`)).toEqual({
      uri: `https://docs.google.com/${kind}/d/fixture_public_document/${suffix}`, format, provider: "google-workspace-public-export"
    });
  });
  it("does not rewrite other hosts, authenticated URLs or published opaque paths", () => {
    for (const uri of ["https://other.example/document/d/fixture_public_document/edit", "https://user:secret@docs.google.com/document/d/fixture_public_document/edit", "https://docs.google.com/document/d/e/fixture_public_document/pub", "http://docs.google.com/document/d/fixture_public_document/edit"]) expect(publicDocumentExport(uri)).toBeUndefined();
  });
});

function officeFixture(kind: "docx" | "pptx", entity = false): Buffer {
  const archive = XLSX.CFB.utils.cfb_new();
  const part = kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  const contentType = kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
  const entries: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="${contentType}"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${part}"/></Relationships>`,
    [part]: kind === "docx" ? `${entity ? '<!DOCTYPE w:document [<!ENTITY a "unsafe">]>' : ""}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>\u03b1 \uad00\uce21 42</w:t></w:r></w:p></w:body></w:document>` : '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
  };
  if (kind === "pptx") {
    entries["ppt/_rels/presentation.xml.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`;
    entries["ppt/presentation.xml"] = '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst></p:presentation>';
    entries["ppt/slides/slide1.xml"] = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>first</a:t><a:t>slide α</a:t></p:sld>';
    entries["ppt/slides/slide2.xml"] = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>second slide</a:t><a:t>42</a:t></p:sld>';
  }
  for (const [name, text] of Object.entries(entries)) XLSX.CFB.utils.cfb_add(archive, name, Buffer.from(text, "utf8"));
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}
