// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import Tesseract from "tesseract.js";
import { DEFAULT_OCR_PROFILE, resolveOcrProfile, type ResolvedOcrProfile } from "./ocr-profile.js";

export type BundledOcrProfile = string;

export type DocumentWasmExtractionRequest =
  | { kind: "pdf-text"; bytes: Uint8Array; maxOutputBytes: number; ocrProfile?: BundledOcrProfile }
  | { kind: "image-ocr"; bytes: Uint8Array; maxOutputBytes: number; ocrProfile: BundledOcrProfile };

export interface DocumentWasmExtractionResult {
  text: string;
  pageCount?: number;
  ocrProfile?: BundledOcrProfile;
  scannedPdfOcr?: true;
  boundary?: "embedded_text_absent/ocr_unavailable";
}

const require = createRequire(import.meta.url);
const standardFontDataUrl = `${path.dirname(require.resolve("pdfjs-dist/standard_fonts/FoxitSerif.pfb")).replace(/\\/gu, "/")}/`;
const MAX_SCANNED_PDF_PAGES = 8;
const MAX_SCANNED_PDF_PAGE_PIXELS = 12_000_000;
const MAX_SCANNED_PDF_TOTAL_PIXELS = 48_000_000;
const MAX_IMAGE_PIXELS = 12_000_000;
const SCANNED_PDF_RENDER_SCALE = 2;

/**
 * Runs entirely inside a Node worker: PDF.js parses embedded PDF text and
 * Tesseract's packaged WASM plus packaged traineddata reads image text. The
 * caller owns worker lifetime, so no parser can outlive its wall-clock bound.
 */
export async function extractDocumentWasm(request: DocumentWasmExtractionRequest): Promise<DocumentWasmExtractionResult> {
  return request.kind === "pdf-text"
    ? extractPdfText(request.bytes, request.maxOutputBytes, request.ocrProfile)
    : extractImageText(request.bytes, request.maxOutputBytes, request.ocrProfile);
}

async function extractPdfText(bytes: Uint8Array, maxOutputBytes: number, ocrProfile?: BundledOcrProfile): Promise<DocumentWasmExtractionResult> {
  const task = loadPdf(bytes);
  const pdf = await task.promise;
  let text = "";
  try {
    const output = new BoundedUtf8Text(maxOutputBytes);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      if (pageNumber > 1) output.append("\f");
      for (const item of content.items) {
        if ("str" in item) output.append(item.str);
        if ("hasEOL" in item && item.hasEOL) output.append("\n");
      }
    }
    text = output.text();
    if (text.trim()) return { text, pageCount: pdf.numPages };
  } finally {
    await task.destroy();
  }
  return extractScannedPdfText(bytes, maxOutputBytes, ocrProfile);
}

async function extractImageText(bytes: Uint8Array, maxOutputBytes: number, profileId: BundledOcrProfile): Promise<DocumentWasmExtractionResult> {
  assertImagePixelBound(bytes);
  const profile = bundledOcrProfile(profileId);
  const worker = await createOcrWorker(profile);
  try {
    const recognized = await worker.recognize(Buffer.from(bytes));
    const output = new BoundedUtf8Text(maxOutputBytes);
    output.append(recognized.data.text);
    return { text: output.text(), ocrProfile: profile.id };
  } finally {
    await worker.terminate();
  }
}

function loadPdf(bytes: Uint8Array) {
  return getDocument({
    data: Uint8Array.from(bytes),
    useWorkerFetch: false,
    useSystemFonts: false,
    standardFontDataUrl,
    stopAtErrors: true
  });
}

function assertImagePixelBound(bytes: Uint8Array): void {
  const dimensions = imageDimensions(bytes);
  if (!dimensions) return;
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) throw new Error("document extraction exceeded image pixel limit");
}

function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) };
  }
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { width: Math.abs(readInt32Le(bytes, 18)), height: Math.abs(readInt32Le(bytes, 22)) };
  }
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return webpDimensions(bytes);
  if (bytes.length >= 8 && (bytes[0] === 0x49 && bytes[1] === 0x49 || bytes[0] === 0x4d && bytes[1] === 0x4d)) return tiffDimensions(bytes);
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = readUint16Be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) {
      if (length < 7) return undefined;
      return { height: readUint16Be(bytes, offset + 3), width: readUint16Be(bytes, offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { width: 1 + readUint24Le(bytes, 24), height: 1 + readUint24Le(bytes, 27) };
  }
  return undefined;
}

function tiffDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const littleEndian = bytes[0] === 0x49;
  const read16 = (offset: number) => littleEndian ? readUint16Le(bytes, offset) : readUint16Be(bytes, offset);
  const read32 = (offset: number) => littleEndian ? readUint32Le(bytes, offset) : readUint32Be(bytes, offset);
  if (read16(2) !== 42) return undefined;
  const directory = read32(4);
  if (directory + 2 > bytes.length) return undefined;
  const entries = read16(directory);
  if (directory + 2 + entries * 12 > bytes.length) return undefined;
  let width: number | undefined;
  let height: number | undefined;
  for (let index = 0; index < entries; index++) {
    const entry = directory + 2 + index * 12;
    const tag = read16(entry);
    if (tag !== 256 && tag !== 257) continue;
    const type = read16(entry + 2);
    const count = read32(entry + 4);
    const size = tiffTypeSize(type);
    if (!size || count < 1 || count > Number.MAX_SAFE_INTEGER / size) return undefined;
    const valueOffset = count * size <= 4 ? entry + 8 : read32(entry + 8);
    if (valueOffset + size > bytes.length) return undefined;
    const value = tiffValue(read16, read32, valueOffset, type);
    if (value === undefined || value <= 0) return undefined;
    if (tag === 256) width = value; else height = value;
  }
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function tiffTypeSize(type: number): number | undefined {
  return type === 1 || type === 2 || type === 6 || type === 7 ? 1
    : type === 3 || type === 8 ? 2
      : type === 4 || type === 9 || type === 11 ? 4
        : type === 5 || type === 10 || type === 12 ? 8 : undefined;
}

function tiffValue(read16: (offset: number) => number, read32: (offset: number) => number, offset: number, type: number): number | undefined {
  if (type === 3) return read16(offset);
  if (type === 4) return read32(offset);
  if (type === 8) return Math.abs(read16(offset));
  if (type === 9) return Math.abs(read32(offset));
  if (type === 5 || type === 10) {
    const denominator = read32(offset + 4);
    return denominator ? Math.abs(read32(offset)) / denominator : undefined;
  }
  return undefined;
}

function readUint16Be(bytes: Uint8Array, offset: number): number { return (bytes[offset]! << 8) | bytes[offset + 1]!; }
function readUint16Le(bytes: Uint8Array, offset: number): number { return bytes[offset]! | (bytes[offset + 1]! << 8); }
function readUint24Le(bytes: Uint8Array, offset: number): number { return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16); }
function readUint32Be(bytes: Uint8Array, offset: number): number { return bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!; }
function readUint32Le(bytes: Uint8Array, offset: number): number { return bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16) + bytes[offset + 3]! * 0x1000000; }
function readInt32Le(bytes: Uint8Array, offset: number): number { const value = readUint32Le(bytes, offset); return value > 0x7fffffff ? value - 0x100000000 : value; }
function ascii(bytes: Uint8Array, start: number, end: number): string { return String.fromCharCode(...bytes.subarray(start, end)); }

async function extractScannedPdfText(bytes: Uint8Array, maxOutputBytes: number, ocrProfile?: BundledOcrProfile): Promise<DocumentWasmExtractionResult> {
  const task = loadPdf(bytes);
  const pdf = await task.promise;
  try {
    return await renderScannedPdfText(pdf, maxOutputBytes, ocrProfile);
  } finally {
    await task.destroy();
  }
}

async function renderScannedPdfText(pdf: PDFDocumentProxy, maxOutputBytes: number, ocrProfile?: BundledOcrProfile): Promise<DocumentWasmExtractionResult> {
  if (pdf.numPages > MAX_SCANNED_PDF_PAGES) return { text: "", boundary: "embedded_text_absent/ocr_unavailable" };
  const profile = bundledOcrProfile(ocrProfile ?? DEFAULT_OCR_PROFILE);
  let worker: Tesseract.Worker | undefined;
  try {
    worker = await createOcrWorker(profile);
    const output = new BoundedUtf8Text(maxOutputBytes);
    let pixelsUsed = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: SCANNED_PDF_RENDER_SCALE });
        const requestedPixels = Math.ceil(base.width) * Math.ceil(base.height);
        const pageBudget = Math.min(MAX_SCANNED_PDF_PAGE_PIXELS, MAX_SCANNED_PDF_TOTAL_PIXELS - pixelsUsed);
        if (!Number.isFinite(requestedPixels) || requestedPixels <= 0 || pageBudget <= 0) return { text: "", boundary: "embedded_text_absent/ocr_unavailable" };
        const scale = requestedPixels > pageBudget ? SCANNED_PDF_RENDER_SCALE * Math.sqrt(pageBudget / requestedPixels) : SCANNED_PDF_RENDER_SCALE;
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.floor(viewport.width));
        const height = Math.max(1, Math.floor(viewport.height));
        pixelsUsed += width * height;
        const canvas = createCanvas(width, height);
        try {
          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
            viewport
          }).promise;
          const recognized = await worker.recognize(canvas.toBuffer("image/png"));
          if (pageNumber > 1 && recognized.data.text) output.append("\f");
          output.append(recognized.data.text);
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      } finally {
        page.cleanup();
      }
    }
    return { text: output.text(), ocrProfile: profile.id, scannedPdfOcr: true };
  } catch (error) {
    if (error instanceof Error && error.message === "document extraction exceeded output byte limit") throw error;
    return { text: "", boundary: "embedded_text_absent/ocr_unavailable" };
  } finally {
    await worker?.terminate();
  }
}

async function createOcrWorker(profile: ReturnType<typeof bundledOcrProfile>): Promise<Tesseract.Worker> {
  const worker = await Tesseract.createWorker(profile.data.code, Tesseract.OEM.LSTM_ONLY, {
    // `langPath` is a package location, so Tesseract reads traineddata from
    // disk. It never falls through to the library's CDN default.
    langPath: profile.data.langPath,
    gzip: profile.data.gzip,
    cacheMethod: "none",
    logger: () => undefined
  });
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO, user_defined_dpi: "300" });
  return worker;
}

function bundledOcrProfile(id: BundledOcrProfile): ResolvedOcrProfile {
  return resolveOcrProfile(id);
}

class BoundedUtf8Text {
  private readonly parts: string[] = [];
  private byteLength = 0;

  constructor(private readonly maxBytes: number) {}

  append(value: string): void {
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (this.byteLength + valueBytes > this.maxBytes) throw new Error("document extraction exceeded output byte limit");
    this.parts.push(value);
    this.byteLength += valueBytes;
  }

  text(): string {
    return this.parts.join("");
  }
}
