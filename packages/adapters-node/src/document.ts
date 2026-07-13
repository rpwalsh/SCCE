import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import mammoth from "mammoth";
import { createHasher, normalizePath, toJsonValue, type JsonValue } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { extractNodeSourceCodeFacts } from "./code-graph.js";
import { extractWorkbookBytes } from "./spreadsheet.js";

export interface ParserAttempt {
  parser: string;
  ok: boolean;
  durationMs: number;
  bytesRead: number;
  warnings: string[];
  stderr?: string;
}

export interface ExtractedDocument {
  uri: string;
  absolutePath: string;
  namespace: string;
  mediaType: string;
  bytes: Uint8Array;
  text: string;
  sha256: string;
  parser: string;
  attempts: ParserAttempt[];
  structural: DocumentStructure;
  diagnostics: DocumentDiagnostics;
  metadata: JsonValue;
}

export interface DocumentStructure {
  pages: Array<{ index: number; charStart: number; charEnd: number; byteStart: number; byteEnd: number; label?: string }>;
  sheets: Array<{ name: string; rows: number; cols: number; charStart: number; charEnd: number }>;
  headings: Array<{ text: string; level: number; charStart: number; charEnd: number }>;
  codeBlocks: Array<{ language: string; charStart: number; charEnd: number }>;
  tables: Array<{ label: string; rows: number; cols: number; charStart: number; charEnd: number }>;
}

export interface DocumentDiagnostics {
  sizeBytes: number;
  charLength: number;
  lineCount: number;
  binaryRatio: number;
  nulCount: number;
  parserCount: number;
  missingPreconditions: string[];
  warnings: string[];
}

export async function extractDocument(filePath: string, config: ScceRuntimeConfig): Promise<ExtractedDocument> {
  const absolutePath = path.resolve(filePath);
  const info = await stat(absolutePath);
  const bytes = await readBounded(absolutePath, config.runtime.maxFileBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const mediaType = guessMediaType(absolutePath, bytes);
  const attempts: ParserAttempt[] = [];
  const start = Date.now();
  const run = async (name: string, fn: () => Promise<{ text: string; structural?: Partial<DocumentStructure>; warnings?: string[]; stderr?: string; typedExtraction?: JsonValue }>) => {
    const before = Date.now();
    try {
      const result = await fn();
      attempts.push({ parser: name, ok: Boolean(result.text.trim()), durationMs: Date.now() - before, bytesRead: bytes.byteLength, warnings: result.warnings ?? [], stderr: result.stderr });
      return result;
    } catch (error) {
      attempts.push({ parser: name, ok: false, durationMs: Date.now() - before, bytesRead: bytes.byteLength, warnings: [error instanceof Error ? error.message : String(error)] });
      return { text: "", warnings: [error instanceof Error ? error.message : String(error)] };
    }
  };

  let text = "";
  let structural: Partial<DocumentStructure> = {};
  let parser = "none";
  let typedExtraction: JsonValue = {};
  const ext = path.extname(absolutePath).toLowerCase();
  if (ext === ".pdf") {
    const result = await run("poppler-pdftotext-layout", () => extractPdfText(absolutePath, config));
    text = result.text;
    structural = result.structural ?? {};
    parser = "poppler-pdftotext-layout";
  } else if (ext === ".docx") {
    const result = await run("mammoth-docx-raw", () => extractDocxText(absolutePath));
    text = result.text;
    structural = result.structural ?? {};
    parser = "mammoth-docx-raw";
  } else if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
    const result = await run("sheetjs-ce-0.20.3", () => extractWorkbookText(bytes, absolutePath, config));
    text = result.text;
    structural = result.structural ?? {};
    typedExtraction = result.typedExtraction ?? {};
    parser = result.text.trim() ? "sheetjs-ce-0.20.3" : "none";
  } else if (isImageMedia(mediaType)) {
    const result = await run("tesseract-ocr", () => extractImageText(absolutePath, config));
    text = result.text;
    structural = result.structural ?? {};
    parser = "tesseract-ocr";
  } else {
    const result = await run("bounded-unicode-text", async () => ({ text: decodeText(bytes), structural: inferTextStructure(decodeText(bytes)) }));
    text = result.text;
    structural = result.structural ?? {};
    parser = "bounded-unicode-text";
  }

  if (!text.trim() && !isProbablyBinary(bytes) && !requiresBinaryParser(ext)) {
    const result = await run("secondary-unicode-text", async () => ({ text: decodeText(bytes), structural: inferTextStructure(decodeText(bytes)) }));
    if (result.text.trim()) {
      text = result.text;
      structural = mergeStructure(structural, result.structural ?? {});
      parser = "secondary-unicode-text";
    }
  }

  const normalized = normalizeExtractedText(text);
  const completeStructure = finalizeStructure(normalized, structural);
  const diagnostics = documentDiagnostics({ bytes, text: normalized, attempts, sizeBytes: info.size });
  const relativeUri = normalizePath(path.relative(config.runtime.workspaceRoot, absolutePath));
  const sourceCodeFacts = extractNodeSourceCodeFacts({
    absolutePath,
    uri: relativeUri,
    mediaType,
    text: normalized,
    sha256,
    hasher: createHasher()
  });
  return {
    uri: relativeUri,
    absolutePath,
    namespace: "local-file",
    mediaType,
    bytes,
    text: normalized,
    sha256,
    parser,
    attempts,
    structural: completeStructure,
    diagnostics,
    metadata: toJsonValue({
      extractor: parser,
      attempts: attempts.map(attempt => ({ parser: attempt.parser, ok: attempt.ok, durationMs: attempt.durationMs, warnings: attempt.warnings.slice(0, 8), stderr: attempt.stderr?.slice(0, 500) ?? null })),
      structure: completeStructure,
      typedExtraction,
      sourceCode: sourceCodeFacts ?? null,
      diagnostics,
      sha256,
      totalExtractionMs: Date.now() - start
    })
  };
}

function requiresBinaryParser(extension: string): boolean {
  return extension === ".pdf"
    || extension === ".docx"
    || extension === ".xlsx"
    || extension === ".xlsm"
    || extension === ".xls"
    || [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"].includes(extension);
}

export async function diagnoseExtractionTools(config: ScceRuntimeConfig): Promise<Array<{ name: string; ok: boolean; detail: string; requiredFor: string[] }>> {
  const pdftotext = await runProcess(config.runtime.tools.pdftotext ?? "pdftotext", ["-v"], { timeoutMs: 5000 });
  const tesseract = await runProcess(config.runtime.tools.tesseract ?? "tesseract", ["--version"], { timeoutMs: 5000 });
  return [
    { name: "pdftotext", ok: pdftotext.code !== null && (pdftotext.code === 0 || Boolean(pdftotext.stderr || pdftotext.stdout)), detail: firstLine(pdftotext.stdout || pdftotext.stderr), requiredFor: ["pdf"] },
    { name: "tesseract", ok: tesseract.code !== null && tesseract.code === 0, detail: firstLine(tesseract.stdout || tesseract.stderr), requiredFor: ["image-ocr"] },
    { name: "mammoth", ok: true, detail: "npm package", requiredFor: ["docx"] },
    { name: "sheetjs-ce", ok: true, detail: "vendored 0.20.3; bounded child process; formulas are not evaluated", requiredFor: ["xlsx", "xlsm", "xls"] }
  ];
}

async function extractPdfText(filePath: string, config: ScceRuntimeConfig): Promise<{ text: string; structural: Partial<DocumentStructure>; warnings: string[]; stderr?: string }> {
  const tool = config.runtime.tools.pdftotext ?? "pdftotext";
  const result = await runProcess(tool, ["-layout", "-enc", "UTF-8", "-eol", "unix", filePath, "-"], { timeoutMs: 120000 });
  const warnings = result.code === 0 ? [] : [`pdftotext exit ${result.code}`];
  const text = result.stdout;
  return { text, structural: inferPagedStructure(text), warnings, stderr: result.stderr };
}

async function extractDocxText(filePath: string): Promise<{ text: string; structural: Partial<DocumentStructure>; warnings: string[] }> {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value;
  return { text, structural: inferTextStructure(text), warnings: result.messages.map(message => message.message) };
}

async function extractWorkbookText(bytes: Uint8Array, filePath: string, config: ScceRuntimeConfig): Promise<{ text: string; structural: Partial<DocumentStructure>; warnings: string[]; typedExtraction: JsonValue }> {
  const result = await extractWorkbookBytes(bytes, filePath, config.runtime.spreadsheet);
  return {
    text: result.text,
    structural: result.structural,
    warnings: result.warnings,
    typedExtraction: toJsonValue(result.typedExtraction)
  };
}

async function extractImageText(filePath: string, config: ScceRuntimeConfig): Promise<{ text: string; structural: Partial<DocumentStructure>; warnings: string[]; stderr?: string }> {
  const tool = config.runtime.tools.tesseract ?? "tesseract";
  const result = await runProcess(tool, [filePath, "stdout", "--psm", "3"], { timeoutMs: 180000 });
  const warnings = result.code === 0 ? [] : [`tesseract exit ${result.code}`];
  return { text: result.stdout, structural: inferTextStructure(result.stdout), warnings, stderr: result.stderr };
}

export async function runProcess(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60000);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: error.message, durationMs: Date.now() - started });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), durationMs: Date.now() - started });
    });
  });
}

export async function readBounded(filePath: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of createReadStream(filePath, { highWaterMark: 65536 })) {
    const piece = Buffer.from(chunk as Buffer);
    total += piece.length;
    if (total > maxBytes) throw new Error(`file exceeds configured maxFileBytes: ${filePath}`);
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function guessMediaType(filePath: string, bytes: Uint8Array): string {
  const ext = path.extname(filePath).toLowerCase();
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && ext === ".xlsm") return "application/vnd.ms-excel.sheet.macroEnabled.12";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && ext === ".xls") return "application/vnd.ms-excel";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".xlsm") return "application/vnd.ms-excel.sheet.macroEnabled.12";
  if (ext === ".xls") return "application/vnd.ms-excel";
  if (ext === ".json") return "application/json";
  if (ext === ".jsonl" || ext === ".ndjson") return "application/x-ndjson";
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".yaml" || ext === ".yml") return "application/yaml";
  if (ext === ".sql") return "application/sql";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".css") return "text/css";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".ts" || ext === ".tsx") return "text/typescript";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "text/javascript";
  if (ext === ".py") return "text/x-python";
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"].includes(ext)) return `image/${ext.slice(1).replace("jpg", "jpeg")}`;
  return isProbablyBinary(bytes) ? "application/octet-stream" : "text/plain";
}

function isImageMedia(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function isProbablyBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let suspicious = 0;
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  for (const b of sample) if (b === 0 || (b < 8 && b !== 9 && b !== 10 && b !== 13)) suspicious++;
  return suspicious / sample.length > 0.08;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return Buffer.from(bytes).toString("utf16le");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return Buffer.from(bytes.slice(3)).toString("utf8");
  return Buffer.from(bytes).toString("utf8");
}

function normalizeExtractedText(text: string): string {
  return text.replace(/\u0000/g, " ").replace(/\r\n?/g, "\n").normalize("NFC");
}

function inferPagedStructure(text: string): Partial<DocumentStructure> {
  const pages: DocumentStructure["pages"] = [];
  const normalized = normalizeExtractedText(text);
  const splits = normalized.split(/\f/g);
  let char = 0;
  let byte = 0;
  splits.forEach((page, index) => {
    const size = Buffer.byteLength(page, "utf8");
    pages.push({ index, charStart: char, charEnd: char + page.length, byteStart: byte, byteEnd: byte + size, label: `page ${index + 1}` });
    char += page.length + 1;
    byte += size + 1;
  });
  return { pages, ...inferTextStructure(normalized) };
}

function inferTextStructure(text: string): Partial<DocumentStructure> {
  const headings: DocumentStructure["headings"] = [];
  const codeBlocks: DocumentStructure["codeBlocks"] = [];
  const tables: DocumentStructure["tables"] = [];
  const lines = normalizeExtractedText(text).split("\n");
  let char = 0;
  let inFence: { language: string; start: number } | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed) ?? (/^(\d+(?:\.\d+)*)\s+(.{3,160})$/.exec(trimmed) ? ["", "1", trimmed] : null);
    if (heading) headings.push({ text: heading[2] ?? trimmed, level: heading[1]?.length ?? 1, charStart: char + line.indexOf(trimmed), charEnd: char + line.length });
    const fence = /^```([\w.+-]*)/.exec(trimmed);
    if (fence && !inFence) inFence = { language: fence[1] || "plain", start: char };
    else if (fence && inFence) {
      codeBlocks.push({ language: inFence.language, charStart: inFence.start, charEnd: char + line.length });
      inFence = undefined;
    }
    if (line.includes("|") && line.split("|").length >= 3) tables.push({ label: `table:${tables.length + 1}`, rows: 1, cols: line.split("|").length - 1, charStart: char, charEnd: char + line.length });
    char += line.length + 1;
  }
  return { pages: [], sheets: [], headings, codeBlocks, tables: coalesceTables(tables) };
}

function coalesceTables(rows: DocumentStructure["tables"]): DocumentStructure["tables"] {
  if (!rows.length) return [];
  const out: DocumentStructure["tables"] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && row.charStart - last.charEnd < 3) {
      last.rows++;
      last.cols = Math.max(last.cols, row.cols);
      last.charEnd = row.charEnd;
    } else out.push({ ...row });
  }
  return out;
}

function finalizeStructure(text: string, partial: Partial<DocumentStructure>): DocumentStructure {
  const inferred = inferTextStructure(text);
  return {
    pages: partial.pages?.length ? partial.pages : inferred.pages ?? [],
    sheets: partial.sheets ?? [],
    headings: partial.headings?.length ? partial.headings : inferred.headings ?? [],
    codeBlocks: partial.codeBlocks?.length ? partial.codeBlocks : inferred.codeBlocks ?? [],
    tables: partial.tables?.length ? partial.tables : inferred.tables ?? []
  };
}

function mergeStructure(left: Partial<DocumentStructure>, right: Partial<DocumentStructure>): Partial<DocumentStructure> {
  return {
    pages: left.pages?.length ? left.pages : right.pages,
    sheets: [...(left.sheets ?? []), ...(right.sheets ?? [])],
    headings: [...(left.headings ?? []), ...(right.headings ?? [])],
    codeBlocks: [...(left.codeBlocks ?? []), ...(right.codeBlocks ?? [])],
    tables: [...(left.tables ?? []), ...(right.tables ?? [])]
  };
}

function documentDiagnostics(input: { bytes: Uint8Array; text: string; attempts: ParserAttempt[]; sizeBytes: number }): DocumentDiagnostics {
  const nulCount = input.bytes.reduce((sum, byte) => sum + (byte === 0 ? 1 : 0), 0);
  const binaryRatio = input.bytes.length ? nulCount / input.bytes.length : 0;
  const failed = input.attempts.filter(attempt => !attempt.ok);
  return {
    sizeBytes: input.sizeBytes,
    charLength: input.text.length,
    lineCount: input.text ? input.text.split("\n").length : 0,
    binaryRatio,
    nulCount,
    parserCount: input.attempts.length,
    missingPreconditions: failed.flatMap(attempt => attempt.warnings.map(warning => `${attempt.parser}:${warning}`)).slice(0, 12),
    warnings: [
      ...(input.text.trim() ? [] : ["empty-text"]),
      ...(binaryRatio > 0.08 ? ["binary-like-source"] : []),
      ...input.attempts.flatMap(attempt => attempt.warnings.map(warning => `${attempt.parser}:${warning}`))
    ].slice(0, 24)
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0] ?? "";
}
