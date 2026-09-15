// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createClock, createHasher, createIdFactory, createTypedIngestProjector, type JsonValue } from "@scce/kernel";
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
    runtime: { workspaceRoot: tempRoot, tempRoot, allowedRoots: [tempRoot], excludedPaths: [], maxFileBytes: 2 * 1024 * 1024, maxChunkBytes: 1000, tools: {} },
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

  it("extracts embedded PDF text in the packaged worker while retaining raw source bytes and derivative lineage", async () => {
    const raw = embeddedTextPdf("Measured 42");
    const result = await normalizeFetchedSource(source(raw, "application/pdf", "https://publisher.example/source.pdf"), config);
    expect(result.bytes).toEqual(raw);
    expect(result.evidenceDerivative?.text).toContain("Measured 42");
    expect(result.metadata).toMatchObject({ normalization: { extractor: "pdfjs-embedded-text-worker", originalSha256: hash(raw) } });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("runs standalone image OCR with the locally packaged profile and preserves image lineage", async () => {
    const raw = textBitmap("TEST");
    const result = await normalizeFetchedSource(source(raw, "image/bmp", "https://publisher.example/source.bmp"), config);
    expect(result.bytes).toEqual(raw);
    expect(result.evidenceDerivative?.text).toMatch(/test/i);
    expect(result.metadata).toMatchObject({
      normalization: { extractor: "tesseract-wasm-ocr-worker", originalSha256: hash(raw) },
      typedExtraction: { imageOcr: { profile: "eng", engine: "tesseract.js-wasm" } }
    });
    expect(await readdir(tempRoot)).toEqual([]);
  }, 30000);

  it("rejects an image whose decoded pixel dimensions exceed the worker bound", async () => {
    const raw = Buffer.alloc(54);
    raw.write("BM", 0, "ascii");
    raw.writeUInt32LE(54, 2);
    raw.writeUInt32LE(54, 10);
    raw.writeUInt32LE(40, 14);
    raw.writeInt32LE(100_000, 18);
    raw.writeInt32LE(100_000, 22);
    raw.writeUInt16LE(1, 26);
    raw.writeUInt16LE(24, 28);
    await expect(normalizeFetchedSource(source(raw, "image/bmp", "https://publisher.example/huge.bmp"), config)).rejects.toThrow("document extraction exceeded image pixel limit");
  });

  it("accepts an opaque non-English OCR profile identifier but refuses absent local package data", async () => {
    const input = source(textBitmap("TEST"), "image/bmp", "https://publisher.example/source.bmp");
    input.metadata = { ...input.metadata as Record<string, JsonValue>, ocrProfile: "kor" };
    await expect(normalizeFetchedSource(input, config)).rejects.toThrow("OCR profile is not locally packaged: kor");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("surfaces a PDF exceeding the bounded scanned-page limit as the explicit OCR-unavailable boundary", async () => {
    await expect(normalizeFetchedSource(source(emptyTextPdf(), "application/pdf", "https://publisher.example/scan.pdf"), config)).rejects.toThrow("embedded_text_absent/ocr_unavailable");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("renders a scanned PDF page inside the bounded worker before locally packaged OCR", async () => {
    const raw = scannedTextPdf("TEST");
    const result = await normalizeFetchedSource(source(raw, "application/pdf", "https://publisher.example/scanned.pdf"), config);
    expect(result.bytes).toEqual(raw);
    expect(result.evidenceDerivative?.text).toMatch(/test/i);
    expect(result.metadata).toMatchObject({
      normalization: { extractor: "pdfjs-rendered-tesseract-wasm-worker", originalSha256: hash(raw) },
      typedExtraction: { scannedPdfOcr: { profile: "eng", renderer: "pdfjs-napi-canvas", engine: "tesseract.js-wasm" } }
    });
  }, 30000);

  it("passes a requested local OCR profile through scanned PDF fallback", async () => {
    const input = source(scannedTextPdf("TEST"), "application/pdf", "https://publisher.example/scanned.pdf");
    input.metadata = { ...input.metadata as Record<string, JsonValue>, ocrProfile: "kor" };
    await expect(normalizeFetchedSource(input, config)).rejects.toThrow("OCR profile is not locally packaged: kor");
  }, 30000);

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

function embeddedTextPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(`BT /F1 18 Tf 72 72 Td (${text}) Tj ET`, "ascii")} >>\nstream\nBT /F1 18 Tf 72 72 Td (${text}) Tj ET\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii");
}

function textBitmap(text: string): Buffer {
  const glyphs: Record<string, readonly string[]> = {
    T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    E: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
    S: ["01111", "10000", "01110", "00001", "00001", "10001", "01110"]
  };
  const scale = 16, margin = 24, gap = 12;
  const width = margin * 2 + text.length * 5 * scale + (text.length - 1) * gap;
  const height = margin * 2 + 7 * scale;
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(54 + stride * height, 255);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34);
  for (let index = 0; index < text.length; index++) {
    const glyph = glyphs[text[index]!]!;
    for (let gy = 0; gy < glyph.length; gy++) for (let gx = 0; gx < glyph[gy]!.length; gx++) {
      if (glyph[gy]![gx] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const x = margin + index * (5 * scale + gap) + gx * scale + dx;
        const y = margin + gy * scale + dy;
        const offset = 54 + (height - 1 - y) * stride + x * 3;
        bytes[offset] = bytes[offset + 1] = bytes[offset + 2] = 0;
      }
    }
  }
  return bytes;
}

function emptyTextPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] /Count 9 >>",
    ...Array.from({ length: 9 }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] >>")
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii");
}

function scannedTextPdf(text: string): Buffer {
  const image = textRaster(text);
  const content = Buffer.from(`q\n${image.width} 0 0 ${image.height} 0 0 cm\n/Im0 Do\nQ`, "ascii");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`, "ascii"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"), content, Buffer.from("\nendstream", "ascii")]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.pixels.length} >>\nstream\n`, "ascii"), image.pixels, Buffer.from("\nendstream", "ascii")])
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let length = chunks[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "ascii"), object, Buffer.from("\nendobj\n", "ascii")]);
    chunks.push(entry);
    length += entry.length;
  }
  const xref = length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii"));
  return Buffer.concat(chunks);
}

function textRaster(text: string): { width: number; height: number; pixels: Buffer } {
  const glyphs: Record<string, readonly string[]> = {
    T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    E: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
    S: ["01111", "10000", "01110", "00001", "00001", "10001", "01110"]
  };
  const scale = 16, margin = 24, gap = 12;
  const width = margin * 2 + text.length * 5 * scale + (text.length - 1) * gap;
  const height = margin * 2 + 7 * scale;
  const pixels = Buffer.alloc(width * height, 255);
  for (let index = 0; index < text.length; index++) {
    const glyph = glyphs[text[index]!]!;
    for (let gy = 0; gy < glyph.length; gy++) for (let gx = 0; gx < glyph[gy]!.length; gx++) {
      if (glyph[gy]![gx] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const x = margin + index * (5 * scale + gap) + gx * scale + dx;
        const y = margin + gy * scale + dy;
        pixels[y * width + x] = 0;
      }
    }
  }
  return { width, height, pixels };
}
