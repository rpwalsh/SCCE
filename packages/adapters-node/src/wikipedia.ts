// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { redactSecretsWithMap, stripApparatusLines, type ContentHash, type IngestedSourceFile, type IngestionCheckpoint, type JsonValue } from "@scce/kernel";
import { effectiveMaxArticleChars, type ScceRuntimeConfig } from "./config.js";
import { decodeWikiEntities, renderWikiLinks, renderWikiTemplates, WIKIPEDIA_SURFACE_TRANSFORM, type WikiNormalizationDiagnostics } from "./wikipedia-markup.js";

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
  /** Distinguishes a committed block at byte zero from a fresh run. */
  resumeAfterBlock?: boolean;
  /** The ingestor freezes index discovery before hashing its input manifest. */
  discoverIndex?: boolean;
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
  rawText: string;
  normalization: WikiNormalizationDiagnostics & { normalizedChars: number; truncatedChars: number };
  links: WikiPageLink[];
  headings: WikiPageHeading[];
}

export interface WikiPageLink {
  target: string;
  label: string;
}

export interface WikiPageHeading {
  text: string;
  level: number;
  charStart: number;
}

/** Declared structure the normalizer would otherwise strip: article links (label → title) and section headings. */
export function wikiPageStructure(raw: string): { links: WikiPageLink[]; headings: WikiPageHeading[] } {
  const links = new Map<string, WikiPageLink>();
  for (const match of raw.matchAll(/\[\[([^[\]|#]{1,200}?)(?:#[^\]|]*)?(?:\|([^\]]{0,200}))?\]\]/gu)) {
    const rawTarget = collapseWhitespace((match[1] ?? "").replace(/_/gu, " "));
    // A single-word prefix before a colon is a namespace (file, category, project), not an article.
    if (!rawTarget || /^\p{L}{2,20}:\S/u.test(rawTarget)) continue;
    const target = rawTarget.charAt(0).toLocaleUpperCase() + rawTarget.slice(1);
    const label = collapseWhitespace(match[2] ?? "") || target;
    const key = `${target}${label}`;
    if (!links.has(key)) links.set(key, { target, label });
    if (links.size >= 400) break;
  }
  const headings: WikiPageHeading[] = [];
  let headingOffset = 0;
  let headingChars = 0;
  for (const match of raw.matchAll(/^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gmu)) {
    const text = collapseWhitespace((match[2] ?? "").replace(/'{2,}/gu, ""));
    if (!text) continue;
    for (const _char of raw.slice(headingOffset, match.index)) headingChars++;
    headingOffset = match.index;
    headings.push({ text, level: match[1]!.length, charStart: headingChars });
    if (headings.length >= 128) break;
  }
  return { links: [...links.values()], headings };
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
  // The dump is not its own index. Configured that way, every offset read is a line of XML, so each seek
  // decodes garbage and the whole run reports blocks with zero pages; falling back to the magic scan reads it.
  const configuredIndexPath = usingConfiguredDump && configured?.indexPath && configured.indexPath.trim() ? path.resolve(configured.indexPath) : undefined;
  const configuredIndex = configuredIndexPath === dumpPath ? undefined : configuredIndexPath;
  return {
    dumpPath,
    indexPath: configuredIndex,
    namespace: usingConfiguredDump && configured?.namespace ? configured.namespace : `wikipedia-${dumpWikiCode}`,
    wikiCode: dumpWikiCode,
    python: configured?.python || "python",
    maxPagesPerRun: Math.max(1, configured?.maxPagesPerRun ?? 2500),
    maxBlocksPerRun: configured?.maxBlocksPerRun && configured.maxBlocksPerRun > 0 ? configured.maxBlocksPerRun : 0,
    maxArticleChars: effectiveMaxArticleChars(configured?.maxArticleChars),
    maxBlockBytes: Math.max(8 * 1024 * 1024, configured?.maxBlockBytes ?? 192 * 1024 * 1024),
    memorySafetyBoundMb: Math.max(512, configured?.memorySafetyBoundMb ?? 8192),
    checkpointEveryPages: Math.max(1, configured?.checkpointEveryPages ?? 1000),
    skipRedirects: configured?.skipRedirects ?? true,
    allowedNamespaces: configured?.allowedNamespaces?.length ? configured.allowedNamespaces : [0]
  };
}

function wikipediaDumpCode(fileName: string): string | undefined {
  // Whole dumps, dated dumps, and numbered multistream parts (…multistream1.xml-p1p41242.bz2) all name their wiki.
  const match = fileName.match(/^([a-z][a-z0-9_-]*wiki)-(?:latest|\d{8})-pages-articles(?:-multistream\d*)?(?:-index\d*\.txt)?(?:\.xml)?(?:-p\d+p\d+)?(?:\.bz2)?$/i);
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
  const indexPath = corpus.indexPath ?? (options.discoverIndex === false ? undefined : await detectWikipediaIndexPath(corpus.dumpPath));
  yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "discovered", "pending", 0, { compressedBytes: info.size, indexPath: indexPath ?? null, indexMode: indexPath ? "index" : "bz2-magic-scan", memorySafetyBoundMb: corpus.memorySafetyBoundMb }) };

  let emitted = 0;
  let skipped = 0;
  let blockCount = 0;
  let pageOrdinal = 0;
  let lastOffset = options.resumeOffset ?? 0;
  yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "extracting", "running", lastOffset, { indexPath: indexPath ?? null, indexMode: indexPath ? "index" : "bz2-magic-scan", resumeOffset: lastOffset, memorySafetyBoundMb: corpus.memorySafetyBoundMb }) };

  const blocks = indexPath
    ? streamWikiBlocks(indexPath, info.size, corpus, options.resumeOffset ?? 0, options.resumeAfterBlock)
    : streamWikiBlocksFromDump(corpus.dumpPath, info.size, options.resumeOffset ?? 0, options.resumeAfterBlock);
  for await (const block of blocks) {
    if (emitted >= corpus.maxPagesPerRun) {
      yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "stored", "complete", lastOffset, { emitted, skipped, blockCount, pageOrdinal, stoppedAt: "maxPagesPerRun", reachedEnd: false }) };
      return;
    }
    if (corpus.maxBlocksPerRun > 0 && blockCount >= corpus.maxBlocksPerRun) {
      yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "stored", "complete", lastOffset, { emitted, skipped, blockCount, pageOrdinal, stoppedAt: "maxBlocksPerRun", reachedEnd: false }) };
      return;
    }
    blockCount++;
    lastOffset = block.compressedOffset;
    yield { type: "checkpoint", checkpoint: blockCheckpoint(rootUri, corpus, block, "extracting", "running", { entries: block.entries.length }) };
    let xml = "";
    try {
      xml = await readCompressedBlock(corpus.dumpPath, block.compressedOffset, block.compressedEnd, corpus.python, corpus.maxBlockBytes);
    } catch (error) {
      yield { type: "checkpoint", checkpoint: blockCheckpoint(rootUri, corpus, block, "failed", "failed", { reason: messageOf(error) }, messageOf(error)) };
      throw new Error(`Wikipedia block at ${block.compressedOffset} failed: ${messageOf(error)}`);
    }
    let blockPages = 0;
    let blockPageOrdinal = 0;
    let indexedPages = 0;
    for (const pageBlock of drainPages(xml)) {
      if (emitted >= corpus.maxPagesPerRun) {
        yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "stored", "complete", block.compressedOffset, { emitted, skipped, blockCount, pageOrdinal, stoppedAt: "maxPagesPerRun", reachedEnd: false }) };
        return;
      }
      if (indexPath) {
        const expected = block.entries[indexedPages++];
        const head = pageBlock.slice(0, pageBlock.indexOf("<revision>"));
        if (!expected || tagText(head, "id") !== expected.pageId || decodeXml(tagText(head, "title")) !== expected.title) {
          throw new Error(`Wikipedia index/dump page identity mismatch in block ${block.compressedOffset}`);
        }
      }
      pageOrdinal++;
      blockPageOrdinal++;
      const page = parseWikiPage(pageBlock, corpus.maxArticleChars);
      if (!page || shouldSkip(page, corpus)) {
        skipped++;
        continue;
      }
      emitted++;
      blockPages++;
      const file = wikiPageFile(page, corpus, pageOrdinal, block);
      const itemCheckpoint = checkpoint(rootUri, file.uri, "extracted", "complete", block.compressedOffset, { pageOrdinal, blockPageOrdinal, blockOrdinal: block.blockOrdinal, blockOffset: block.compressedOffset, title: page.title, pageId: page.pageId, revisionId: page.revisionId, namespace: page.namespace }, `sha256_${sha256(file.bytes)}` as ContentHash, file.bytes.byteLength);
      yield { type: "file", file, checkpoint: itemCheckpoint };
      if (emitted % corpus.checkpointEveryPages === 0) yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "extracting", "running", block.compressedOffset, { emitted, skipped, blockCount, pageOrdinal }) };
    }
    if (indexPath && indexedPages !== block.entries.length) {
      throw new Error(`Wikipedia index/dump page count mismatch in block ${block.compressedOffset}`);
    }
    yield { type: "checkpoint", checkpoint: blockCheckpoint(rootUri, corpus, block, "stored", "complete", { pages: blockPages, emitted, skipped }) };
    xml = "";
  }

  yield { type: "checkpoint", checkpoint: checkpoint(rootUri, corpus.dumpPath, "stored", "complete", lastOffset, { emitted, skipped, blockCount, pageOrdinal, reachedEnd: true }) };
}

async function* streamWikiBlocksFromDump(dumpPath: string, dumpSize: number, resumeOffset: number, resumeAfterBlock = false): AsyncIterable<WikiCompressedBlock> {
  let previous: number | undefined;
  let ordinal = 0;
  for await (const offset of streamBzip2StreamOffsets(dumpPath)) {
    if (previous === undefined) {
      previous = offset;
      continue;
    }
    ordinal++;
    if (afterResumeOffset(previous, resumeOffset, resumeAfterBlock)) yield { compressedOffset: previous, compressedEnd: offset, blockOrdinal: ordinal, entries: [] };
    previous = offset;
  }
  if (previous !== undefined) {
    ordinal++;
    if (afterResumeOffset(previous, resumeOffset, resumeAfterBlock)) yield { compressedOffset: previous, compressedEnd: dumpSize, blockOrdinal: ordinal, entries: [] };
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

async function* streamWikiBlocks(indexPath: string, dumpSize: number, corpus: ResolvedWikipediaCorpus, resumeOffset: number, resumeAfterBlock = false): AsyncIterable<WikiCompressedBlock> {
  let currentOffset: number | undefined;
  let currentEntries: WikiIndexEntry[] = [];
  let ordinal = 0;
  for await (const entry of streamWikiIndex(indexPath, corpus.python)) {
    if (entry.compressedOffset >= dumpSize || (currentOffset !== undefined && entry.compressedOffset < currentOffset)) {
      throw new Error("Wikipedia index offsets are outside the dump or out of order");
    }
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
    if (afterResumeOffset(currentOffset, resumeOffset, resumeAfterBlock)) {
      yield { compressedOffset: currentOffset, compressedEnd: entry.compressedOffset, blockOrdinal: ordinal, entries: currentEntries };
    }
    currentOffset = entry.compressedOffset;
    currentEntries = [entry];
  }
  if (currentOffset !== undefined) {
    ordinal++;
    if (afterResumeOffset(currentOffset, resumeOffset, resumeAfterBlock)) yield { compressedOffset: currentOffset, compressedEnd: dumpSize, blockOrdinal: ordinal, entries: currentEntries };
  } else throw new Error("Wikipedia index contains no page entries");
}

function afterResumeOffset(offset: number, resumeOffset: number, resumeAfterBlock: boolean): boolean {
  // An incomplete journal cursor points at the block that must be replayed so its
  // block-local page ordinal can skip only the already-processed prefix. A stored
  // block checkpoint is the only case where the offset itself is safe to skip.
  return resumeAfterBlock ? offset > resumeOffset : offset >= resumeOffset;
}

async function* streamWikiIndex(indexPath: string, python: string): AsyncIterable<WikiIndexEntry> {
  const opened = openIndexText(indexPath, python);
  const reader = createInterface({ input: opened.stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const entry = parseIndexLine(String(line));
      if (!entry && String(line).trim()) throw new Error("Wikipedia index contains a malformed page entry");
      if (entry) yield entry;
    }
    await opened.completed?.();
  } finally {
    reader.close();
    opened.close();
  }
}

interface CloseableTextStream {
  stream: NodeJS.ReadableStream;
  close: () => void;
  completed?: () => Promise<void>;
}

function openIndexText(filePath: string, python: string): CloseableTextStream {
  if (!filePath.toLocaleLowerCase().endsWith(".bz2")) {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    return { stream, close: () => stream.destroy() };
  }
  const child = spawn(python, ["-c", "import bz2,sys\nwith bz2.open(sys.argv[1],'rb') as f:\n    while True:\n        b=f.read(1048576)\n        if not b: break\n        sys.stdout.buffer.write(b)\n        sys.stdout.buffer.flush()", filePath], { windowsHide: true, shell: false });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(0, 800); });
  // Resolve rather than reject until EOF is observed, avoiding an unhandled
  // rejection when a bounded consumer intentionally closes the stream early.
  const outcome = new Promise<Error | undefined>(resolve => {
    child.once("error", error => resolve(error));
    child.once("close", code => resolve(code === 0 ? undefined : new Error(`Wikipedia index decode failed (${code}): ${stderr}`)));
  });
  return {
    stream: child.stdout,
    completed: async () => { const error = await outcome; if (error) throw error; },
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
  const pageId = line.slice(first + 1, second);
  const title = line.slice(second + 1);
  if (!/^\d+$/u.test(line.slice(0, first)) || !Number.isSafeInteger(compressedOffset) || compressedOffset < 0 || !/^\d+$/u.test(pageId) || !title) return undefined;
  return { compressedOffset, pageId, title };
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
    "        chunk=b''",
    "        if d.needs_input:",
    "            want=65536",
    "            if limit>0:",
    "                left=limit-read",
    "                if left<=0: break",
    "                want=min(want,left)",
    "            chunk=f.read(want)",
    "            if not chunk: break",
    "            read += len(chunk)",
    "        part=d.decompress(chunk,max_length=max_out-total+1)",
    "        if part:",
    "            total += len(part)",
    "            if total > max_out: raise RuntimeError('decompressed block exceeds configured max bytes')",
    "            out.append(part)",
    "        if d.eof: break",
    "if not d.eof: raise RuntimeError('truncated bzip2 stream')",
    "sys.stdout.buffer.write(b''.join(out))"
  ].join("\n");
  const child = spawn(python, ["-c", script, dumpPath, String(offset), String(limit), String(maxBlockBytes)], { windowsHide: true, shell: false });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  const finished = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const [code] = await Promise.all([
    finished,
    (async () => { for await (const raw of child.stdout) chunks.push(Buffer.from(raw as Buffer)); })(),
    (async () => { for await (const raw of child.stderr) errors.push(Buffer.from(raw as Buffer)); })()
  ]);
  if (code !== 0) throw new Error(`wiki block decode failed at ${offset}: ${Buffer.concat(errors).toString("utf8").slice(0, 800)}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function* drainPages(buffer: string): Iterable<string> {
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf("<page>", cursor);
    if (start < 0) break;
    const end = buffer.indexOf("</page>", start);
    if (end < 0) throw new Error("Wikipedia block contains an incomplete page");
    const close = end + "</page>".length;
    const block = buffer.slice(start, close);
    // The decoded block is already bounded. Cutting XML can erase </text> and silently skip a large page.
    yield block;
    cursor = close;
  }
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
  const raw = decodeXml(rawText);
  const diagnostics: WikiNormalizationDiagnostics = { unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 };
  const normalized = normalizeWikiText(raw, diagnostics);
  let text = normalized.slice(0, maxArticleChars);
  if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
  const structure = wikiPageStructure(raw);
  return { title: decodeXml(title), namespace, pageId, revisionId, redirect: block.includes("<redirect"), text, rawText: raw,
    normalization: { ...diagnostics, normalizedChars: normalized.length, truncatedChars: normalized.length - text.length },
    links: structure.links, headings: structure.headings };
}

function shouldSkip(page: ParsedWikiPage, corpus: ResolvedWikipediaCorpus): boolean {
  if (corpus.skipRedirects && page.redirect) return true;
  if (!corpus.allowedNamespaces.includes(page.namespace)) return true;
  if (page.text.trim().length < 160) return true;
  return false;
}

function wikiPageFile(page: ParsedWikiPage, corpus: ResolvedWikipediaCorpus, pageOrdinal: number, block: WikiCompressedBlock): IngestedSourceFile {
  const redacted = redactSecretsWithMap(page.text);
  const cleaned = redacted.text;
  const bytes = Buffer.from(page.rawText, "utf8");
  const safeTitle = encodeURIComponent(collapseWhitespace(page.title).replaceAll(" ", "_")).slice(0, 180);
  return {
    uri: `wikipedia://${corpus.wikiCode}/pages/${page.pageId}/${safeTitle}`,
    namespace: corpus.namespace,
    mediaType: "text/x-wiki",
    bytes,
    text: page.rawText,
    ...(cleaned !== page.rawText ? { evidenceDerivative: {
      bytes: Buffer.from(cleaned, "utf8"), text: cleaned, kind: "extracted-text" as const,
      transformId: `${WIKIPEDIA_SURFACE_TRANSFORM}+redact-secrets`, originalCoordinateSpace: "extracted-text-utf8" as const,
      redactionMap: redacted.redactionMap
    } } : {}),
    metadata: {
      sourceSystem: "wikipedia",
      sourceKind: "wikimedia_dump",
      ingestionLane: "wiki_stream",
      sourceFamilyId: "wikimedia:wikipedia",
      normalization: { transformId: WIKIPEDIA_SURFACE_TRANSFORM, characterUnit: "utf16-code-units", ...page.normalization },
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
      redirect: page.redirect,
      links: page.links.map(link => ({ target: link.target, label: link.label })),
      originalStructure: { coordinateSpace: "original-source-codepoints", headings: page.headings.map(heading => ({ ...heading })) },
      structure: { coordinateSpace: "evidence-source-codepoints", headings: surfaceHeadings(page.headings, cleaned).map(heading => ({ ...heading })) }
    }
  };
}

/** Page structure is persisted once on the source version; a span's provenance carries the page's identity, not its link list. */
export const WIKI_PAGE_STRUCTURE_KEYS = ["links", "structure", "originalStructure", "normalization"] as const;

export function spanProvenanceMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const scoped: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
  for (const key of WIKI_PAGE_STRUCTURE_KEYS) delete scoped[key];
  return scoped;
}

/** Bind headings to the actual evidence surface, not the original wikitext's offsets. */
function surfaceHeadings(headings: WikiPageHeading[], surface: string): WikiPageHeading[] {
  const result: WikiPageHeading[] = [];
  let cursor = 0, chars = 0;
  for (const heading of headings) {
    const title = redactSecretsWithMap(normalizeWikiText(heading.text)).text;
    if (!title) continue;
    const marker = "=".repeat(heading.level);
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`${marker}\\s*${escaped}\\s*${marker}`, "gu");
    pattern.lastIndex = cursor;
    const found = pattern.exec(surface);
    if (!found) continue; // Dropped apparatus or a clipped heading has no evidence coordinate.
    for (const _char of surface.slice(cursor, found.index)) chars++;
    result.push({ text: title, level: heading.level, charStart: chars });
    for (const _char of found[0]) chars++;
    cursor = found.index + found[0].length;
  }
  return result;
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
  return decodeWikiEntities(value, true);
}

export function normalizeWikiText(value: string, diagnostics?: WikiNormalizationDiagnostics): string {
  return collapseWhitespace(stripApparatusLines(wikiSurfaceLines(value, diagnostics))).trim();
}

/** The page's surface with wiki constructs resolved and its line structure still intact: that population is what
 *  `stripApparatusLines` measures, and collapsing whitespace first destroys the only evidence the lines carry. */
export function wikiSurfaceLines(value: string, diagnostics?: WikiNormalizationDiagnostics): string {
  let text = removeDelimited(value, "<!--", "-->");
  text = removeRefTags(text);
  text = renderWikiTemplates(text, diagnostics);
  text = renderWikiLinks(text, diagnostics);
  text = closeSeparatorsLeftByTemplates(text);
  text = removeXmlTags(text);
  text = decodeWikiEntities(text);
  text = stripRepeatedApostrophes(text);
  return dropCitationListSections(text);
}

/** A section whose lines are citation bullets is a reference list, whatever its heading is called in whatever
 *  language: "When was Ada Lovelace born?" was answered from one with a cited article's publication date. The
 *  shape decides -- bullet lines carrying a year or a URL -- so no heading name is assumed. Pure. */
function dropCitationListSections(text: string): string {
  const newline = String.fromCharCode(10);
  const lines = text.split(newline);
  const heading = /^={2,}\s*[^=].*?\s*={2,}\s*$/u;
  const citationLine = /^\s*[*#]+\s.*?(?:\b\d{4}\b|https?:\/\/|www\.)/u;
  const out: string[] = [];
  let section: string[] = [];
  let headingLine: string | null = null;
  const flush = () => {
    const body = section.filter(line => line.trim().length > 0);
    const citations = body.filter(line => citationLine.test(line)).length;
    const isCitationList = body.length >= 2 && citations >= 2 && citations / body.length >= 0.6;
    if (!isCitationList) {
      if (headingLine !== null) out.push(headingLine);
      out.push(...section);
    }
    section = [];
  };
  for (const line of lines) {
    if (heading.test(line)) { flush(); headingLine = line; continue; }
    section.push(line);
  }
  flush();
  return out.join(newline);
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

/** A removed template leaves the separator that followed it: "({{IPAc-en|...}}; {{nee|Byron}}; 10 December 1815"
 *  became "( ; 10 December 1815" in 1,426 promoted spans. Punctuation only, so it reads the same in any script. Pure. */
function closeSeparatorsLeftByTemplates(text: string): string {
  return text
    .replace(/([(\[{\u3010\uff08])\s*[;,:\u3001\uff0c\uff1b\uff1a]+\s*/gu, "$1")
    .replace(/[;,:\u3001\uff0c\uff1b\uff1a]\s*(?=[;,:\u3001\uff0c\uff1b\uff1a])/gu, "")
    .replace(/\s+([;,:\u3001\uff0c\uff1b\uff1a]|[.\u3002])/gu, "$1")
    .replace(/\(\s*\)/gu, "")
    .replace(/\[\s*\]/gu, "")
    .replace(/\{\s*\}/gu, "")
    .replace(/\u3010\s*\u3011/gu, "")
    .replace(/\uff08\s*\uff09/gu, "");
}

function removeXmlTags(input: string): string {
  // Angle-bracket comparisons are source content, not tags. Quoted attribute
  // values may contain '>'; an unmatched '<' must not erase the article tail.
  return input.replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gu, " ");
}

function stripRepeatedApostrophes(input: string): string {
  return input.replace(/'{2,}/gu, "");
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
