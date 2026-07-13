import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { redactSecrets, type ContentHash, type IngestedSourceFile, type IngestionCheckpoint, type JsonValue } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";

type IngestStreamItem =
  | { type: "checkpoint"; checkpoint: IngestionCheckpoint }
  | { type: "file"; file: IngestedSourceFile; checkpoint: IngestionCheckpoint }
  | { type: "skipped"; skipped: { path: string; reason: string }; checkpoint: IngestionCheckpoint };

export interface ResolvedWikipediaCorpus {
  dumpPath: string;
  indexPath?: string;
  namespace: string;
  wikiCode: string;
  python: string;
  maxPagesPerRun: number;
  maxBlocksPerRun: number;
  maxArticleChars: number;
  maxBlockBytes: number;
  memorySafetyBoundMb: number;
  checkpointEveryPages: number;
  skipRedirects: boolean;
  allowedNamespaces: number[];
}

export interface WikipediaStreamOptions {
  resumeOffset?: number;
}

interface WikiIndexEntry {
  compressedOffset: number;
  pageId: string;
  title: string;
}

interface WikiCompressedBlock {
  compressedOffset: number;
  compressedEnd?: number;
  blockOrdinal: number;
  entries: WikiIndexEntry[];
}

interface ParsedWikiPage {
  title: string;
  pageId: string;
  revisionId: string;
  namespace: number;
  redirect: boolean;
  text: string;
}

const BZIP2_MAGIC_BYTES = 10;

export function resolveWikipediaCorpusTarget(config: ScceRuntimeConfig, absoluteTarget: string): ResolvedWikipediaCorpus | null {
  const configured = config.runtime.corpora?.wikipedia;
  const normalizedTarget = path.resolve(absoluteTarget);
  const configuredDump = configured?.dumpPath ? path.resolve(configured.dumpPath) : undefined;
  const targetName = path.basename(normalizedTarget).toLocaleLowerCase();
  const targetWikiCode = wikipediaDumpCode(targetName);
  const looksLikeWikiDump = Boolean(targetWikiCode);
  if (configured && !configured.enabled) return null;
  if (!looksLikeWikiDump && configuredDump !== normalizedTarget) return null;
  const usingConfiguredDump = Boolean(configuredDump && configuredDump === normalizedTarget);
  const dumpPath = looksLikeWikiDump ? normalizedTarget : configuredDump ?? normalizedTarget;
  const dumpWikiCode = targetWikiCode ?? wikipediaDumpCode(path.basename(dumpPath).toLocaleLowerCase()) ?? "wiki";
  const configuredIndex = usingConfiguredDump && configured?.indexPath && configured.indexPath.trim() ? path.resolve(configured.indexPath) : undefined;
  return {
    dumpPath,
    indexPath: configuredIndex,
    namespace: usingConfiguredDump && configured?.namespace ? configured.namespace : `wikipedia-${dumpWikiCode}`,
    wikiCode: dumpWikiCode,
    python: configured?.python || "python",
    maxPagesPerRun: Math.max(1, configured?.maxPagesPerRun ?? 2500),
    maxBlocksPerRun: configured?.maxBlocksPerRun && configured.maxBlocksPerRun > 0 ? configured.maxBlocksPerRun : 0,
    maxArticleChars: Math.max(4096, configured?.maxArticleChars ?? 160000),
    maxBlockBytes: Math.max(8 * 1024 * 1024, configured?.maxBlockBytes ?? 192 * 1024 * 1024),
    memorySafetyBoundMb: Math.max(512, configured?.memorySafetyBoundMb ?? 8192),
    checkpointEveryPages: Math.max(1, configured?.checkpointEveryPages ?? 1000),
    skipRedirects: configured?.skipRedirects ?? true,
    allowedNamespaces: configured?.allowedNamespaces?.length ? configured.allowedNamespaces : [0]
  };
}

function wikipediaDumpCode(fileName: string): string | undefined {
  const match = fileName.match(/^([a-z][a-z0-9_-]*wiki)-latest-pages-articles-multistream(?:-index\.txt)?(?:\.xml)?(?:\.bz2)?$/i)
    ?? fileName.match(/^([a-z][a-z0-9_-]*wiki)-\d{8}-pages-articles-multistream(?:-index\.txt)?(?:\.xml)?(?:\.bz2)?$/i);
  return match?.[1]?.toLocaleLowerCase();
}

export async function detectWikipediaIndexPath(dumpPath: string): Promise<string | undefined> {
  const candidates = candidateIndexPaths(dumpPath);
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) return candidate;
  }
  return undefined;
}

export async function* streamWikipediaMultistream(corpus: ResolvedWikipediaCorpus, options: WikipediaStreamOptions = {}): AsyncIterable<IngestStreamItem> {
  const info = await stat(corpus.dumpPath);
  const rootUri = wikipediaRootUri(corpus);
  const indexPath = corpus.indexPath ?? await detectWikipediaIndexPath(corpus.dumpPath);
  yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "discovered", "pending", 0, { compressedBytes: info.size, indexPath: indexPath ?? null, indexMode: indexPath ? "index" : "bz2-magic-scan", memorySafetyBoundMb: corpus.memorySafetyBoundMb }) };

  let emitted = 0;
  let skipped = 0;
  let blockCount = 0;
  let pageOrdinal = 0;
  let lastOffset = options.resumeOffset ?? 0;
  yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "extracting", "running", lastOffset, { indexPath: indexPath ?? null, indexMode: indexPath ? "index" : "bz2-magic-scan", resumeOffset: lastOffset, memorySafetyBoundMb: corpus.memorySafetyBoundMb }) };

  const blocks = indexPath
    ? streamWikiBlocks(indexPath, info.size, corpus, options.resumeOffset ?? 0)
    : streamWikiBlocksFromDump(corpus.dumpPath, info.size, options.resumeOffset ?? 0);
  for await (const block of blocks) {
    if (corpus.maxBlocksPerRun > 0 && blockCount >= corpus.maxBlocksPerRun) break;
    blockCount++;
    lastOffset = block.compressedOffset;
    yield { type: "checkpoint", checkpoint: blockCheckpoint(rootUri, corpus, block, "extracting", "running", { entries: block.entries.length }) };
    let xml = "";
    try {
      xml = await readCompressedBlock(corpus.dumpPath, block.compressedOffset, block.compressedEnd, corpus.python, corpus.maxBlockBytes);
    } catch (error) {
      skipped++;
      yield { type: "skipped", skipped: { path: corpus.dumpPath, reason: messageOf(error) }, checkpoint: blockCheckpoint(rootUri, corpus, block, "skipped", "complete", { reason: messageOf(error) }, messageOf(error)) };
      continue;
    }
    let blockPages = 0;
    for (const pageBlock of drainPages(xml, corpus.maxArticleChars)) {
      pageOrdinal++;
      const page = parseWikiPage(pageBlock, corpus.maxArticleChars);
      if (!page || shouldSkip(page, corpus)) {
        skipped++;
        continue;
      }
      emitted++;
      blockPages++;
      const file = wikiPageFile(page, corpus, pageOrdinal, block);
      const itemCheckpoint = checkpoint(rootUri, file.uri, "extracted", "complete", block.compressedOffset, { pageOrdinal, blockOrdinal: block.blockOrdinal, blockOffset: block.compressedOffset, title: page.title, pageId: page.pageId, revisionId: page.revisionId, namespace: page.namespace }, `sha256_${sha256(file.bytes)}` as ContentHash, file.bytes.byteLength);
      yield { type: "file", file, checkpoint: itemCheckpoint };
      if (emitted % corpus.checkpointEveryPages === 0) yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "extracting", "running", block.compressedOffset, { emitted, skipped, blockCount, pageOrdinal }) };
      if (emitted >= corpus.maxPagesPerRun) {
        yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "stored", "complete", block.compressedOffset, { emitted, skipped, blockCount, pageOrdinal, stoppedAt: "maxPagesPerRun" }) };
        return;
      }
    }
    yield { type: "checkpoint", checkpoint: blockCheckpoint(rootUri, corpus, block, "stored", "complete", { pages: blockPages, emitted, skipped }) };
    xml = "";
  }

  yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "stored", "complete", lastOffset, { emitted, skipped, blockCount, pageOrdinal }) };
}

async function* streamWikiBlocksFromDump(dumpPath: string, dumpSize: number, resumeOffset: number): AsyncIterable<WikiCompressedBlock> {
  let previous: number | undefined;
  let ordinal = 0;
  for await (const offset of streamBzip2StreamOffsets(dumpPath)) {
    if (previous === undefined) {
      previous = offset;
      continue;
    }
    ordinal++;
    if (afterResumeOffset(previous, resumeOffset)) yield { compressedOffset: previous, compressedEnd: offset, blockOrdinal: ordinal, entries: [] };
    previous = offset;
  }
  if (previous !== undefined) {
    ordinal++;
    if (afterResumeOffset(previous, resumeOffset)) yield { compressedOffset: previous, compressedEnd: dumpSize, blockOrdinal: ordinal, entries: [] };
  }
}

async function* streamBzip2StreamOffsets(dumpPath: string): AsyncIterable<number> {
  let absolute = 0;
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const raw of createReadStream(dumpPath, { highWaterMark: 8 * 1024 * 1024 })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = absolute - carry.length;
    for (let index = 0; index <= data.length - BZIP2_MAGIC_BYTES; index++) {
      if (isBzip2StreamMagic(data, index)) yield base + index;
    }
    absolute += chunk.length;
    carry = data.subarray(Math.max(0, data.length - (BZIP2_MAGIC_BYTES - 1)));
  }
}

async function* streamWikiBlocks(indexPath: string, dumpSize: number, corpus: ResolvedWikipediaCorpus, resumeOffset: number): AsyncIterable<WikiCompressedBlock> {
  let currentOffset: number | undefined;
  let currentEntries: WikiIndexEntry[] = [];
  let ordinal = 0;
  for await (const entry of streamWikiIndex(indexPath, corpus.python)) {
    if (currentOffset === undefined) {
      currentOffset = entry.compressedOffset;
      currentEntries = [entry];
      continue;
    }
    if (entry.compressedOffset === currentOffset) {
      currentEntries.push(entry);
      continue;
    }
    ordinal++;
    if (afterResumeOffset(currentOffset, resumeOffset)) {
      yield { compressedOffset: currentOffset, compressedEnd: entry.compressedOffset, blockOrdinal: ordinal, entries: currentEntries };
    }
    currentOffset = entry.compressedOffset;
    currentEntries = [entry];
  }
  if (currentOffset !== undefined) {
    ordinal++;
    if (afterResumeOffset(currentOffset, resumeOffset)) yield { compressedOffset: currentOffset, compressedEnd: dumpSize, blockOrdinal: ordinal, entries: currentEntries };
  }
}

function afterResumeOffset(offset: number, resumeOffset: number): boolean {
  return resumeOffset <= 0 || offset > resumeOffset;
}

async function* streamWikiIndex(indexPath: string, python: string): AsyncIterable<WikiIndexEntry> {
  const opened = openIndexText(indexPath, python);
  const reader = createInterface({ input: opened.stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const entry = parseIndexLine(String(line));
      if (entry) yield entry;
    }
  } finally {
    reader.close();
    opened.close();
  }
}

interface CloseableTextStream {
  stream: NodeJS.ReadableStream;
  close: () => void;
}

function openIndexText(filePath: string, python: string): CloseableTextStream {
  if (!filePath.toLocaleLowerCase().endsWith(".bz2")) {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    return { stream, close: () => stream.destroy() };
  }
  const child = spawn(python, ["-c", "import bz2,sys\nwith bz2.open(sys.argv[1],'rb') as f:\n    while True:\n        b=f.read(1048576)\n        if not b: break\n        sys.stdout.buffer.write(b)\n        sys.stdout.buffer.flush()", filePath], { windowsHide: true, shell: false });
  child.on("error", () => undefined);
  child.stderr.on("data", () => undefined);
  return {
    stream: child.stdout,
    close: () => {
      child.stdout.destroy();
      child.stderr.destroy();
      if (!child.killed) child.kill();
    }
  };
}

function parseIndexLine(line: string): WikiIndexEntry | undefined {
  if (!line) return undefined;
  const first = line.indexOf(":");
  if (first < 1) return undefined;
  const second = line.indexOf(":", first + 1);
  if (second < 0) return undefined;
  const compressedOffset = Number(line.slice(0, first));
  if (!Number.isSafeInteger(compressedOffset) || compressedOffset < 0) return undefined;
  return { compressedOffset, pageId: line.slice(first + 1, second), title: line.slice(second + 1) };
}

async function readCompressedBlock(dumpPath: string, offset: number, end: number | undefined, python: string, maxBlockBytes: number): Promise<string> {
  const limit = end && end > offset ? end - offset : 0;
  const script = [
    "import bz2,sys",
    "path=sys.argv[1]",
    "off=int(sys.argv[2])",
    "limit=int(sys.argv[3])",
    "max_out=int(sys.argv[4])",
    "d=bz2.BZ2Decompressor()",
    "out=[]",
    "total=0",
    "read=0",
    "with open(path,'rb') as f:",
    "    f.seek(off)",
    "    while True:",
    "        want=65536",
    "        if limit>0:",
    "            left=limit-read",
    "            if left<=0: break",
    "            want=min(want,left)",
    "        chunk=f.read(want)",
    "        if not chunk: break",
    "        read += len(chunk)",
    "        part=d.decompress(chunk)",
    "        if part:",
    "            total += len(part)",
    "            if total > max_out: raise RuntimeError('decompressed block exceeds configured max bytes')",
    "            out.append(part)",
    "        if d.eof: break",
    "sys.stdout.buffer.write(b''.join(out))"
  ].join("\n");
  const child = spawn(python, ["-c", script, dumpPath, String(offset), String(limit), String(maxBlockBytes)], { windowsHide: true, shell: false });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  for await (const raw of child.stdout) chunks.push(Buffer.from(raw as Buffer));
  for await (const raw of child.stderr) errors.push(Buffer.from(raw as Buffer));
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  if (code !== 0) throw new Error(`wiki block decode failed at ${offset}: ${Buffer.concat(errors).toString("utf8").slice(0, 800)}`);
  return Buffer.concat(chunks).toString("utf8");
}

function drainPages(buffer: string, maxArticleChars: number): string[] {
  const pages: string[] = [];
  let cursor = 0;
  while (pages.length < 4096) {
    const start = buffer.indexOf("<page>", cursor);
    if (start < 0) break;
    const end = buffer.indexOf("</page>", start);
    if (end < 0) break;
    const close = end + "</page>".length;
    const block = buffer.slice(start, close);
    pages.push(block.length > maxArticleChars * 3 ? block.slice(0, maxArticleChars * 3) : block);
    cursor = close;
  }
  return pages;
}

function parseWikiPage(block: string, maxArticleChars: number): ParsedWikiPage | null {
  const title = tagText(block, "title");
  const namespace = Number(tagText(block, "ns") || "0");
  const revisionStart = block.indexOf("<revision>");
  const head = revisionStart >= 0 ? block.slice(0, revisionStart) : block;
  const revision = revisionStart >= 0 ? block.slice(revisionStart) : "";
  const pageId = tagText(head, "id");
  const revisionId = tagText(revision, "id");
  const rawText = tagTextWithAttributes(block, "text");
  if (!title || !pageId || !rawText) return null;
  const text = normalizeWikiText(decodeXml(rawText)).slice(0, maxArticleChars);
  return { title: decodeXml(title), namespace, pageId, revisionId, redirect: block.includes("<redirect"), text };
}

function shouldSkip(page: ParsedWikiPage, corpus: ResolvedWikipediaCorpus): boolean {
  if (corpus.skipRedirects && page.redirect) return true;
  if (!corpus.allowedNamespaces.includes(page.namespace)) return true;
  if (page.text.trim().length < 160) return true;
  return false;
}

function wikiPageFile(page: ParsedWikiPage, corpus: ResolvedWikipediaCorpus, pageOrdinal: number, block: WikiCompressedBlock): IngestedSourceFile {
  const cleaned = redactSecrets(page.text);
  const bytes = Buffer.from(cleaned, "utf8");
  const safeTitle = encodeURIComponent(collapseWhitespace(page.title).replaceAll(" ", "_")).slice(0, 180);
  return {
    uri: `wikipedia://${corpus.wikiCode}/pages/${page.pageId}/${safeTitle}`,
    namespace: corpus.namespace,
    mediaType: "text/x-wiki",
    bytes,
    text: cleaned,
    metadata: {
      sourceSystem: "wikipedia",
      sourceKind: "wikimedia_dump",
      ingestionLane: "wiki_stream",
      forceClass: "direct_evidence",
      corpus: path.basename(corpus.dumpPath),
      wikiCode: corpus.wikiCode,
      dumpPath: corpus.dumpPath,
      indexPath: corpus.indexPath ?? null,
      pageOrdinal,
      blockOrdinal: block.blockOrdinal,
      blockOffset: block.compressedOffset,
      title: page.title,
      pageId: page.pageId,
      revisionId: page.revisionId,
      namespace: page.namespace,
      redirect: page.redirect
    }
  };
}

function checkpoint(rootUri: string, itemUri: string, phase: IngestionCheckpoint["phase"], status: IngestionCheckpoint["status"], offsetBytes: number, metadata: JsonValue, contentHash?: ContentHash, byteLength?: number, reason?: string): IngestionCheckpoint {
  return {
    id: `ingest_${sha256(`${rootUri}\u001f${itemUri}\u001f${phase}\u001f${offsetBytes}`).slice(0, 32)}`,
    rootUri,
    itemUri,
    phase,
    status,
    offsetBytes,
    contentHash,
    byteLength,
    reason,
    updatedAt: Date.now(),
    metadata
  };
}

function blockCheckpoint(rootUri: string, corpus: ResolvedWikipediaCorpus, block: WikiCompressedBlock, phase: IngestionCheckpoint["phase"], status: IngestionCheckpoint["status"], metadata: JsonValue, reason?: string): IngestionCheckpoint {
  return checkpoint(rootUri, wikiBlockUri(corpus, block.compressedOffset), phase, status, block.compressedOffset, { ...objectOrEmpty(metadata), blockOrdinal: block.blockOrdinal, blockOffset: block.compressedOffset, compressedEnd: block.compressedEnd ?? null }, undefined, undefined, reason);
}

export function wikipediaRootUri(corpus: Pick<ResolvedWikipediaCorpus, "dumpPath">): string {
  const base = path.basename(corpus.dumpPath).toLocaleLowerCase();
  return `wikipedia://${wikipediaDumpCode(base) ?? "wiki"}/${path.basename(corpus.dumpPath)}`;
}

export function wikiBlockUri(corpus: Pick<ResolvedWikipediaCorpus, "dumpPath">, offset: number): string {
  return `${wikipediaRootUri(corpus)}/block/${offset}`;
}

function tagText(block: string, tag: string): string {
  return tagTextWithAttributes(block, tag);
}

function tagTextWithAttributes(block: string, tag: string): string {
  const openStart = block.indexOf(`<${tag}`);
  if (openStart < 0) return "";
  const openEnd = block.indexOf(">", openStart);
  if (openEnd < 0) return "";
  const closeStart = block.indexOf(`</${tag}>`, openEnd + 1);
  if (closeStart < 0) return "";
  return block.slice(openEnd + 1, closeStart);
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&#039;", "'");
}

function normalizeWikiText(value: string): string {
  let text = removeDelimited(value, "<!--", "-->");
  text = removeRefTags(text);
  text = removeTemplates(text);
  text = renderWikiLinks(text);
  text = removeXmlTags(text);
  text = stripRepeatedApostrophes(text);
  return collapseWhitespace(text).trim();
}

function removeDelimited(input: string, startNeedle: string, endNeedle: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf(startNeedle, cursor);
    if (start < 0) return out + input.slice(cursor);
    out += input.slice(cursor, start) + " ";
    const end = input.indexOf(endNeedle, start + startNeedle.length);
    if (end < 0) return out;
    cursor = end + endNeedle.length;
  }
  return out;
}

function removeRefTags(input: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < input.length) {
    const start = indexOfIgnoreCase(input, "<ref", cursor);
    if (start < 0) return out + input.slice(cursor);
    out += input.slice(cursor, start) + " ";
    const openEnd = input.indexOf(">", start);
    if (openEnd < 0) return out;
    const selfClosing = input.slice(start, openEnd + 1).includes("/>");
    if (selfClosing) {
      cursor = openEnd + 1;
      continue;
    }
    const close = indexOfIgnoreCase(input, "</ref>", openEnd + 1);
    cursor = close < 0 ? openEnd + 1 : close + "</ref>".length;
  }
  return out;
}

function removeTemplates(input: string): string {
  let out = "";
  let cursor = 0;
  let depth = 0;
  while (cursor < input.length) {
    const two = input.slice(cursor, cursor + 2);
    if (two === "{{") {
      depth++;
      cursor += 2;
      if (depth === 1) out += " ";
      continue;
    }
    if (two === "}}" && depth > 0) {
      depth--;
      cursor += 2;
      continue;
    }
    if (depth === 0) out += input[cursor] ?? "";
    cursor++;
  }
  return out;
}

function renderWikiLinks(input: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf("[[", cursor);
    if (start < 0) return out + input.slice(cursor);
    out += input.slice(cursor, start);
    const end = input.indexOf("]]", start + 2);
    if (end < 0) return out + input.slice(start);
    const inner = input.slice(start + 2, end);
    const lower = inner.toLocaleLowerCase();
    if (!lower.startsWith("file:") && !lower.startsWith("image:") && !lower.startsWith("category:")) {
      const pipe = inner.lastIndexOf("|");
      out += pipe >= 0 ? inner.slice(pipe + 1) : inner;
    }
    cursor = end + 2;
  }
  return out;
}

function removeXmlTags(input: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf("<", cursor);
    if (start < 0) return out + input.slice(cursor);
    out += input.slice(cursor, start) + " ";
    const end = input.indexOf(">", start + 1);
    if (end < 0) return out;
    cursor = end + 1;
  }
  return out;
}

function stripRepeatedApostrophes(input: string): string {
  let out = "";
  let run = 0;
  for (const ch of input) {
    if (ch === "'") {
      run++;
      if (run < 2) out += ch;
      continue;
    }
    run = 0;
    out += ch;
  }
  return out;
}

function collapseWhitespace(input: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const space = code <= 32 || code === 160;
    if (space) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function indexOfIgnoreCase(input: string, needle: string, start: number): number {
  const lowerNeedle = needle.toLocaleLowerCase();
  for (let i = Math.max(0, start); i <= input.length - needle.length; i++) {
    if (input.slice(i, i + needle.length).toLocaleLowerCase() === lowerNeedle) return i;
  }
  return -1;
}

function candidateIndexPaths(dumpPath: string): string[] {
  const out: string[] = [];
  if (dumpPath.endsWith(".xml.bz2")) {
    out.push(`${dumpPath.slice(0, -".xml.bz2".length)}-index.txt.bz2`);
    out.push(`${dumpPath.slice(0, -".xml.bz2".length)}-index.txt`);
  }
  const marker = "pages-articles-multistream.xml.bz2";
  if (dumpPath.endsWith(marker)) {
    const prefix = dumpPath.slice(0, -marker.length);
    out.push(`${prefix}pages-articles-multistream-index.txt.bz2`);
    out.push(`${prefix}pages-articles-multistream-index.txt`);
  }
  return [...new Set(out)];
}

function isBzip2StreamMagic(data: Buffer, index: number): boolean {
  if (data[index] !== 0x42) return false;
  if (data[index + 1] !== 0x5a) return false;
  if (data[index + 2] !== 0x68) return false;
  const level = data[index + 3] ?? 0;
  if (level < 0x31 || level > 0x39) return false;
  return data[index + 4] === 0x31
    && data[index + 5] === 0x41
    && data[index + 6] === 0x59
    && data[index + 7] === 0x26
    && data[index + 8] === 0x53
    && data[index + 9] === 0x59;
}

function objectOrEmpty(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)).digest("hex");
}
