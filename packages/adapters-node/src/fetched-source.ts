// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toJsonValue, type EvidenceDerivative, type JsonValue } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { extractDocument, type ExtractedDocument } from "./document.js";
import type { BundledOcrProfile } from "./document-wasm-extraction.js";
import { assertOcrProfileId } from "./ocr-profile.js";
import { extractPresentationText, inspectOfficeArchive } from "./spreadsheet-parser.js";

export interface FetchedSource {
  uri: string;
  mediaType: string;
  bytes: Uint8Array;
  metadata: JsonValue;
  evidenceDerivative?: EvidenceDerivative;
}

interface DetectedSource { format: string; mediaType: string; extension: string; }
const formats: Record<string, { mediaType: string; extension: string }> = {
  pdf: { mediaType: "application/pdf", extension: ".pdf" },
  docx: { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" },
  xlsx: { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" },
  xlsm: { mediaType: "application/vnd.ms-excel.sheet.macroenabled.12", extension: ".xlsm" },
  xls: { mediaType: "application/vnd.ms-excel", extension: ".xls" },
  pptx: { mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx" },
  png: { mediaType: "image/png", extension: ".png" }, jpeg: { mediaType: "image/jpeg", extension: ".jpg" },
  tiff: { mediaType: "image/tiff", extension: ".tiff" }, bmp: { mediaType: "image/bmp", extension: ".bmp" },
  webp: { mediaType: "image/webp", extension: ".webp" }
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const media = (value: string) => value.split(";", 1)[0]!.trim().toLowerCase();

/** Raw bytes remain the source. Only the explicit derivative can supply text evidence. */
export async function normalizeFetchedSource(
  source: FetchedSource,
  config: ScceRuntimeConfig,
  options: { signal?: AbortSignal; expectedFormat?: "text" | "xlsx" | "pptx" } = {}
): Promise<FetchedSource> {
  options.signal?.throwIfAborted();
  const maxBytes = Math.min(config.connectors.web?.maxBytes ?? 2 * 1024 * 1024, config.runtime.maxFileBytes);
  if (!source.bytes.length || source.bytes.length > maxBytes) throw new Error("fetched source is empty or exceeds its source byte limit");
  const detected = detectFetchedMedia(source, maxBytes);
  if (options.expectedFormat && (detected.format !== options.expectedFormat
    || options.expectedFormat === "text" && detected.mediaType !== "text/plain"))
    throw new Error(`public document export returned ${detected.format}; expected ${options.expectedFormat}; authentication or unsupported export may be required`);
  let text: string, extractor: string, extractionMetadata: JsonValue = null;
  let documentMetadata: JsonValue = {};
  if (detected.format === "text") {
    const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(source.mediaType)?.[1];
    const encoding = source.bytes[0] === 0xff && source.bytes[1] === 0xfe ? "utf-16le"
      : source.bytes[0] === 0xfe && source.bytes[1] === 0xff ? "utf-16be" : charset ?? "utf-8";
    try { text = new TextDecoder(encoding, { fatal: true }).decode(source.bytes); }
    catch { throw new Error("unsupported fetched source: invalid or unsupported text encoding"); }
    if (/\u0000/u.test(text) || [...text.slice(0, 4096)].filter(character => /[\u0001-\u0008\u000B\u000E-\u001F]/u.test(character)).length > 8)
      throw new Error("unsupported fetched source: binary control data cannot be text evidence");
    extractor = "bounded-unicode-text";
  } else if (detected.format === "pptx") {
    const extracted = extractPresentationText(source.bytes, {
      maxSourceBytes: maxBytes,
      maxArchiveEntryBytes: 16 * 1024 * 1024,
      maxArchiveUncompressedBytes: 32 * 1024 * 1024,
      maxParseMs: 30000
    });
    text = extracted.text;
    extractor = "bounded-pptx-text";
    documentMetadata = toJsonValue({ structure: { pages: extracted.slides.map(slide => ({ index: slide.index, charStart: slide.charStart, charEnd: slide.charEnd })) }, typedExtraction: { presentation: { slideCount: extracted.slides.length, slides: extracted.slides.map(slide => ({ index: slide.index, charStart: slide.charStart, charEnd: slide.charEnd })) } } });
    extractionMetadata = toJsonValue({ slideCount: extracted.slides.length });
    if (!text.trim()) throw new Error("fetched PowerPoint extraction returned no slide text");
  } else {
    const tempRoot = path.resolve(config.runtime.tempRoot);
    await mkdir(tempRoot, { recursive: true });
    const stage = await mkdtemp(path.join(tempRoot, "fetched-source-"));
    try {
      const stagedPath = path.join(stage, `source${detected.extension}`);
      await writeFile(stagedPath, source.bytes, { flag: "wx" });
      const extractionConfig: ScceRuntimeConfig = {
        ...config,
        runtime: {
          ...config.runtime, maxFileBytes: maxBytes,
          spreadsheet: {
            ...config.runtime.spreadsheet,
            maxSourceBytes: maxBytes,
            maxTextChars: Math.min(maxBytes, config.runtime.spreadsheet?.maxTextChars ?? maxBytes),
            maxArchiveEntryBytes: Math.min(16 * 1024 * 1024, config.runtime.spreadsheet?.maxArchiveEntryBytes ?? Infinity),
            maxArchiveUncompressedBytes: Math.min(32 * 1024 * 1024, config.runtime.spreadsheet?.maxArchiveUncompressedBytes ?? Infinity),
            maxParseMs: Math.min(30000, config.runtime.spreadsheet?.maxParseMs ?? 30000)
          }
        }
      };
      const extracted = detected.format === "docx"
        ? await extractDocxInBoundedProcess(stagedPath, maxBytes, options.signal)
        : await extractDocument(stagedPath, extractionConfig, {
          includeVisualAttributes: false, maxOutputBytes: maxBytes, timeoutMs: 30000,
          signal: options.signal, ocrProfile: sourceOcrProfile(source.metadata)
        });
      text = extracted.text;
      extractor = extracted.parser;
      documentMetadata = toJsonValue({ structure: extracted.structural, typedExtraction: object(extracted.metadata).typedExtraction ?? null });
      extractionMetadata = toJsonValue({ attempts: extracted.attempts, diagnostics: extracted.diagnostics });
      if (!text.trim()) throw new Error(`fetched source extraction failed: ${extracted.diagnostics.missingPreconditions.join("; ") || "extractor returned no text"}`);
    } finally {
      // This staging directory is generated here and contains one source file;
      // never recursively remove a path obtained from the remote document.
      if (path.dirname(path.resolve(stage)) !== tempRoot || !path.basename(stage).startsWith("fetched-source-")) throw new Error("invalid fetched-source cleanup path");
      await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  options.signal?.throwIfAborted();
  const normalizedText = text.replace(/\r\n?/gu, "\n").normalize("NFC");
  const normalizedBytes = Buffer.from(normalizedText, "utf8");
  if (!normalizedText.trim() || normalizedBytes.length > maxBytes) throw new Error("fetched source extracted text is empty or exceeds its output byte limit");
  const sameBytes = Buffer.from(source.bytes).equals(normalizedBytes);
  return {
    ...source,
    // Classify the original bytes by their detected media, retaining the HTTP
    // declaration separately. An extracted PDF derivative is never the PDF.
    mediaType: detected.mediaType,
    evidenceDerivative: sameBytes ? undefined : {
      bytes: normalizedBytes, text: normalizedText, kind: "extracted-text",
      transformId: "scce.fetched-source-text.v1", originalCoordinateSpace: "extracted-text-utf8", redactionMap: []
    },
    metadata: toJsonValue({
      ...object(source.metadata),
      ...object(documentMetadata),
      normalization: {
        schema: "scce.fetched-source-normalization.v1", status: "extracted", extractor,
        sourceUri: source.uri, originalMediaType: source.mediaType, detectedMediaType: detected.mediaType,
        originalSha256: digest(source.bytes), originalByteLength: source.bytes.length,
        normalizedSha256: digest(normalizedBytes), normalizedByteLength: normalizedBytes.length,
        evidenceCoordinateSpace: sameBytes ? "source-bytes" : "extracted-text-utf8", extraction: extractionMetadata
      }
    })
  };
}

function detectFetchedMedia(source: FetchedSource, maxBytes: number): DetectedSource {
  const bytes = Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
  const declared = media(source.mediaType);
  const extension = path.extname(new URL(source.uri).pathname).toLowerCase();
  const selected = (format: string): DetectedSource => ({ format, ...formats[format]! });
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return selected("pdf");
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    const archive = inspectOfficeArchive(bytes, { maxSourceBytes: maxBytes, maxArchiveEntryBytes: 16 * 1024 * 1024, maxArchiveUncompressedBytes: 32 * 1024 * 1024 });
    if (!archive.officeFormat) throw new Error("unsupported fetched source: ZIP is not a supported Office document");
    return selected(archive.officeFormat);
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    if (declared === formats.xls!.mediaType || extension === ".xls") return selected("xls");
    throw new Error("unsupported fetched source: unclassified OLE compound document");
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return selected("png");
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return selected("jpeg");
  if (["49492a00", "4d4d002a"].includes(bytes.subarray(0, 4).toString("hex"))) return selected("tiff");
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return selected("bmp");
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return selected("webp");
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) throw new Error("unsupported fetched source media type: image/gif");
  const knownBinary = Object.entries(formats).find(([, value]) => declared === value.mediaType || extension === value.extension);
  if (knownBinary) throw new Error(`unsupported fetched source: declared ${knownBinary[0]} does not match its binary signature`);
  const textMedia = declared.startsWith("text/") || ["application/json", "application/ld+json", "application/xml", "application/xhtml+xml", "application/yaml", "application/x-ndjson", "application/javascript"].includes(declared);
  if (!textMedia && declared !== "application/octet-stream" && declared !== "") throw new Error(`unsupported fetched source media type: ${declared}`);
  // UTF-8/BOM validation follows; HTML stays HTML so canonical ingestion can
  // use its existing content extraction rather than treating markup as prose.
  const prefix = bytes.subarray(0, 512).toString("utf8").trimStart();
  return { format: "text", mediaType: /^<(?:!doctype\s+html|html\b)/iu.test(prefix) ? "text/html" : !declared || declared === "application/octet-stream" ? "text/plain" : declared, extension: ".txt" };
}

function object(value: JsonValue): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

function sourceOcrProfile(metadata: JsonValue): BundledOcrProfile | undefined {
  const profile = object(metadata).ocrProfile;
  if (profile === undefined) return undefined;
  if (typeof profile !== "string") throw new Error("fetched source OCR profile must be an opaque local package identifier");
  return assertOcrProfileId(profile);
}

async function extractDocxInBoundedProcess(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<ExtractedDocument> {
  const local = new URL("./fetched-document-process.js", import.meta.url);
  const fallback = new URL("../dist/fetched-document-process.js", import.meta.url);
  const worker = existsSync(fileURLToPath(local)) ? local : fallback;
  if (!existsSync(fileURLToPath(worker))) throw new Error("fetched document parser is unavailable; build @scce/adapters-node");
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(fileURLToPath(worker), [], { execArgv: ["--max-old-space-size=384"], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const finish = (error?: Error, result?: ExtractedDocument) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      child.kill();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("fetched DOCX parse exceeded 30000ms")), 30000);
    const aborted = () => finish(new Error("fetched DOCX parse cancelled"));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    child.once("message", (message: { ok?: boolean; result?: ExtractedDocument; error?: string }) => finish(message.ok && message.result ? undefined : new Error(message.error ?? "fetched DOCX parser returned no result"), message.result));
    child.once("error", error => finish(error));
    child.once("exit", code => finish(new Error(`fetched DOCX parser exited before returning a result (${code})`)));
    child.send({ filePath, maxBytes }, error => { if (error) finish(error); });
  });
}

export function publicDocumentExport(uri: string): { uri: string; format: "text" | "xlsx" | "pptx"; provider: "google-workspace-public-export" } | undefined {
  const parsed = new URL(uri);
  if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com" || parsed.username || parsed.password) return undefined;
  const match = /^\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,})(?:\/(?:edit|view|preview))?\/?$/u.exec(parsed.pathname);
  if (!match) return undefined;
  const kind = match[1]!, id = match[2]!;
  const exported = new URL(`https://docs.google.com/${kind}/d/${id}/${kind === "presentation" ? "export/pptx" : "export"}`);
  if (kind !== "presentation") exported.searchParams.set("format", kind === "document" ? "txt" : "xlsx");
  return { uri: exported.toString(), format: kind === "document" ? "text" : kind === "spreadsheets" ? "xlsx" : "pptx", provider: "google-workspace-public-export" };
}
