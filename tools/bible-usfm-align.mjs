#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Preparation-only Bible USFM parser/alignment review artifact. This tool never opens storage or trains a model.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { TextDecoder } from "node:util";
import { createClock, createHasher, createIdFactory } from "../packages/kernel/dist/index.js";

const DEFAULT_BOOKS = ["MAT", "MRK", "LUK", "JHN"];
const REVIEW_ID_FACTORY = createIdFactory({ clock: createClock({ fixedTime: 0 }), hasher: createHasher(), namespace: "bible-usfm-align", deterministicReplay: true });

export function parseUsfmText({ sourceId, language, relativePath, bytes }) {
  const fileBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = decodeUtf8(fileBytes);
  const fileSha256 = sha256(fileBytes);
  const lines = linesWithOffsets(text);
  let bookId = null;
  let chapter = null;
  let current = null;
  const verses = [];
  const blocks = [];
  const flush = (endChar, endByte) => {
    if (!current) return;
    const rawText = text.slice(current.startChar, endChar);
    const rawBytes = Buffer.from(rawText, "utf8");
    const cleaned = cleanVerseText(rawText);
    verses.push({
      sourceId,
      language,
      relativePath,
      fileSha256,
      bookId: current.bookId,
      chapter: current.chapter,
      verseLabel: current.verseLabel,
      verseKey: `${current.bookId}.${current.chapter}.${current.verseLabel}`,
      startByte: current.startByte,
      endByte,
      rawSha256: sha256(rawBytes),
      rawText,
      text: cleaned.text,
      markerIssues: cleaned.markerIssues
    });
    current = null;
  };
  for (const line of lines) {
    const content = line.text.replace(/(?:\r\n|\n|\r)$/u, "");
    const marker = /^\\([+]?[A-Za-z][A-Za-z0-9-]*)\b/u.exec(content)?.[1] ?? null;
    const markerName = marker?.replace(/^\+/u, "").toLowerCase() ?? null;
    if (markerName && BLOCK_MARKERS.has(markerName)) {
      const markerPayload = content.replace(/^\\[+]?[A-Za-z][A-Za-z0-9-]*\s*/u, "").trim();
      const continuation = current && CONTINUATION_MARKERS.has(markerName) && markerPayload.length > 0;
      if (!continuation) flush(line.startChar, line.startByte);
      const blockBytes = Buffer.from(line.text, "utf8");
      blocks.push({
        marker: markerName,
        startByte: line.startByte,
        endByte: line.startByte + blockBytes.length,
        rawSha256: sha256(blockBytes),
        rawText: content
      });
    }
    const id = /^\\id\s+([^\s]+)/u.exec(content);
    if (id) {
      bookId = id[1].toUpperCase();
      continue;
    }
    const chapterMatch = /^\\c\s+(\d+)/u.exec(content);
    if (chapterMatch) {
      chapter = Number(chapterMatch[1]);
      continue;
    }
    const verse = /^\\v\s+([^\s]+)\s*/u.exec(content);
    if (!verse || !bookId || !Number.isInteger(chapter)) continue;
    flush(line.startChar, line.startByte);
    current = {
      bookId,
      chapter,
      verseLabel: verse[1],
      startChar: line.startChar,
      startByte: line.startByte
    };
  }
  flush(text.length, fileBytes.length);
  return { sourceId, language, relativePath, fileSha256, bytes: fileBytes.length, blocks, verses };
}

export function alignBibleVerses({ sources, books = DEFAULT_BOOKS, idFactory = REVIEW_ID_FACTORY }) {
  const selectedBooks = [...new Set(books.map(value => String(value).trim().toUpperCase()).filter(Boolean))];
  const bySource = new Map(sources.map(source => [source.sourceId, source]));
  if (bySource.size !== 3 || ["eng-kjv2006", "deu1912", "latVUC"].some(sourceId => !bySource.has(sourceId))) throw new Error("Bible alignment requires exactly these sources: eng-kjv2006, deu1912, latVUC");
  const sourceIds = [...bySource.keys()].sort();
  const workFamilyId = idFactory.semanticId("bible_work_family", { contract: "scce.bibleVerseAlignment.v1", workFamily: "bible-translation-family", sourceIds });
  const sourceDependencyGroupIds = [workFamilyId];
  const verseMaps = new Map(sourceIds.map(sourceId => [sourceId, groupVerses(bySource.get(sourceId).verses)]));
  const pairs = [];
  const unresolved = [];
  const booksAudit = [];
  for (const bookId of selectedBooks) {
    const keys = new Set();
    for (const sourceId of sourceIds) {
      for (const key of verseMaps.get(sourceId).keys()) if (key.startsWith(`${bookId}.`)) keys.add(key);
    }
    const sortedKeys = [...keys].sort(compareVerseKey);
    const keySets = sourceIds.map(sourceId => [...verseMaps.get(sourceId).keys()].filter(key => key.startsWith(`${bookId}.`)).sort(compareVerseKey));
    const exactKeySet = keySets.every((set, index) => index === 0 || stable(set) === stable(keySets[0]));
    let eligible = 0;
    for (const key of sortedKeys) {
      const entries = sourceIds.map(sourceId => verseMaps.get(sourceId).get(key) ?? []);
      const reasons = [];
      if (!exactKeySet) reasons.push("book_verse_set_differs_across_sources");
      if (entries.some(value => value.length !== 1)) reasons.push(entries.some(value => value.length > 1) ? "duplicate_verse_key" : "missing_verse_key");
      if (entries.some(value => value[0] && !/^\d+$/u.test(value[0].verseLabel))) reasons.push("alternate_or_range_verse_marker");
      if (entries.some(value => value[0] && !value[0].text)) reasons.push("empty_verse_after_markup_removal");
      if (entries.some(value => value[0]?.markerIssues?.length)) reasons.push("unknown_or_unbalanced_usfm_marker");
      if (reasons.length) {
        unresolved.push({ recordType: "unresolved", bookId, verseKey: key, reasons: [...new Set(reasons)], sourceIds });
        continue;
      }
      const english = verseMaps.get("eng-kjv2006").get(key)[0];
      const german = verseMaps.get("deu1912").get(key)[0];
      const latin = verseMaps.get("latVUC").get(key)[0];
      eligible += 1;
      const pairId = idFactory.semanticId("bible_verse_pair", {
        contract: "scce.bibleVerseAlignment.v1",
        verseKey: key,
        sources: [english, german, latin].map(verse => ({ sourceId: verse.sourceId, fileSha256: verse.fileSha256, rawSha256: verse.rawSha256, startByte: verse.startByte, endByte: verse.endByte }))
      });
      pairs.push({
        recordType: "pair",
        pairId,
        bookId,
        verseKey: key,
        alignmentBasis: "exact-book-chapter-verse-key-after-equal-set-audit",
        trainingEligible: false,
        source: compactVerse(english, sourceDependencyGroupIds, workFamilyId),
        german: compactVerse(german, sourceDependencyGroupIds, workFamilyId),
        latin: compactVerse(latin, sourceDependencyGroupIds, workFamilyId)
      });
    }
    booksAudit.push({
      bookId,
      sourceIds,
      sourceVerseCounts: Object.fromEntries(sourceIds.map((sourceId, index) => [sourceId, keySets[index].length])),
      exactKeySet,
      eligiblePairs: eligible,
      unresolvedRecords: sortedKeys.length - eligible
    });
  }
  return {
    schema: "scce.bibleVerseAlignment.v1",
    status: "review-required-not-training",
    selectedBooks,
    sourceIds,
    workFamilyId,
    sourceDependencyGroupIds,
    booksAudit,
    pairs,
    unresolved,
    excludedBookPolicy: "Only explicitly selected books are considered; other books remain outside this artifact.",
    trainingContract: "Review-only pairs must be validated, then mapped through the existing language-corpus source-version/evidence contract and durable translation seed/alignment stores; this artifact never trains or writes storage."
  };
}

function compactVerse(verse, sourceDependencyGroupIds, workFamilyId) {
  return {
    sourceId: verse.sourceId,
    language: verse.language,
    relativePath: verse.relativePath,
    fileSha256: verse.fileSha256,
    verseLabel: verse.verseLabel,
    startByte: verse.startByte,
    endByte: verse.endByte,
    rawSha256: verse.rawSha256,
    rawText: verse.rawText,
    text: verse.text,
    sourceDependencyGroupIds,
    workFamilyId
  };
}

function groupVerses(verses) {
  const grouped = new Map();
  for (const verse of verses) {
    if (!grouped.has(verse.verseKey)) grouped.set(verse.verseKey, []);
    grouped.get(verse.verseKey).push(verse);
  }
  return grouped;
}

function cleanVerseText(rawText) {
  const markerIssues = validateMarkers(rawText);
  const text = rawText
    .replace(/^\\v\s+[^\s]+\s*/u, "")
    .replace(/\\f\b[\s\S]*?\\f\*/gu, " ")
    .replace(/\\x\b[\s\S]*?\\x\*/gu, " ")
    .replace(/\\\+?w\s+([^|\\]+)\|[^\\]*\\\+?w\*/gu, "$1")
    .replace(/\\\+?add\s+([\s\S]*?)\\\+?add\*/gu, "$1")
    .replace(/\\[a-z0-9-]+\*?/giu, " ")
    .replace(/[|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return { text, markerIssues };
}

const BLOCK_MARKERS = new Set(["id", "h", "toc1", "toc2", "toc3", "mt1", "mt2", "c", "cl", "p", "m", "q", "q1", "q2", "s", "s1", "s2", "ms", "ms1", "r", "d", "sp", "li", "li1", "li2", "b", "rem", "qa", "qc"]);
const CONTINUATION_MARKERS = new Set(["p", "m", "q", "q1", "q2", "li", "li1", "li2"]);
const KNOWN_MARKERS = new Set(["id", "h", "toc1", "toc2", "toc3", "mt1", "mt2", "c", "cl", "p", "m", "q", "q1", "q2", "s", "s1", "s2", "ms", "ms1", "r", "d", "sp", "li", "li1", "li2", "b", "rem", "qa", "qc", "v", "w", "add", "nd", "f", "fr", "fk", "ft", "x", "xo", "xt", "rq", "qt", "wj", "sup", "it", "bd", "sc", "em", "ior", "tl"]);
const PAIRED_MARKERS = new Set(["w", "add", "nd", "f", "x", "qt", "wj", "sup", "it", "bd", "sc", "em", "ior", "tl"]);

function validateMarkers(rawText) {
  const issues = [];
  const stack = [];
  for (const match of rawText.matchAll(/\\([+]?)([A-Za-z][A-Za-z0-9-]*)(\*)?/gu)) {
    const name = match[2].toLowerCase();
    const normalized = name;
    if (!KNOWN_MARKERS.has(normalized)) {
      issues.push(`unknown:${match[0]}`);
      continue;
    }
    if (match[3]) {
      if (!PAIRED_MARKERS.has(normalized) || stack.at(-1) !== normalized) issues.push(`unbalanced:${match[0]}`);
      else stack.pop();
    } else if (PAIRED_MARKERS.has(normalized)) stack.push(normalized);
  }
  for (const name of stack) issues.push(`unclosed:${name}`);
  return [...new Set(issues)];
}

function linesWithOffsets(text) {
  const lines = [];
  const pattern = /.*(?:\r\n|\n|\r|$)/gu;
  let match;
  let startByte = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[0]) break;
    const line = match[0];
    lines.push({ text: line, startChar: match.index, startByte });
    startByte += Buffer.byteLength(line, "utf8");
  }
  return lines;
}

function compareVerseKey(left, right) {
  const [leftBook, leftChapter, leftVerse] = left.split(".");
  const [rightBook, rightChapter, rightVerse] = right.split(".");
  return leftBook.localeCompare(rightBook, "en") || Number(leftChapter) - Number(rightChapter) || Number(leftVerse) - Number(rightVerse) || left.localeCompare(right, "en");
}

function stable(value) {
  return JSON.stringify(value);
}

function decodeUtf8(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`invalid UTF-8 in USFM input: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("invalid UTF-8 in USFM input: round-trip mismatch");
  return text;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertExtractedFileMatchesArchive({ archiveEntryBytes, extractedBytes, entryName, relativePath }) {
  const archiveBytes = Buffer.isBuffer(archiveEntryBytes) ? archiveEntryBytes : Buffer.from(archiveEntryBytes);
  const fileBytes = Buffer.isBuffer(extractedBytes) ? extractedBytes : Buffer.from(extractedBytes);
  if (!archiveBytes.equals(fileBytes)) throw new Error(`extracted USFM differs from ZIP entry ${entryName ?? relativePath ?? "<unknown>"}`);
}

export function readZipArchiveEntries(zipBytes) {
  const bytes = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 0xffff - 22); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory record missing");
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP central directory entry");
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8").replace(/\\/gu, "/");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`invalid ZIP local header for ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`unsupported ZIP compression ${method} for ${name}`); })();
    if (content.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${name}`);
    const normalizedName = name.toLowerCase();
    if (entries.has(normalizedName)) throw new Error(`duplicate normalized ZIP entry name: ${name}`);
    entries.set(normalizedName, { name, bytes: content, sha256: sha256(content) });
  }
  if (cursor !== directoryOffset + directorySize) throw new Error("ZIP central directory size mismatch");
  return entries;
}

async function collectUsfm(root, sourceId, language, archiveEntries) {
  const files = await walk(root);
  const documents = [];
  for (const file of files.filter(file => file.toLowerCase().endsWith(".usfm"))) {
    const bytes = await readFile(file);
    const relativePath = path.relative(root, file).replace(/\\/gu, "/");
    const entry = archiveEntries?.get(relativePath.toLowerCase()) ?? archiveEntries?.get(path.basename(relativePath).toLowerCase());
    if (archiveEntries && !entry) throw new Error(`${sourceId} extracted USFM has no matching ZIP entry: ${relativePath}`);
    if (entry) assertExtractedFileMatchesArchive({ archiveEntryBytes: entry.bytes, extractedBytes: bytes, entryName: entry.name, relativePath });
    const document = parseUsfmText({ sourceId, language, relativePath, bytes });
    documents.push({ ...document, archiveEntry: entry?.name ?? null, archiveEntrySha256: entry?.sha256 ?? null });
  }
  return { root, documents, verses: documents.flatMap(document => document.verses) };
}

async function walk(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walk(absolute));
    else out.push(absolute);
  }
  return out.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.manifest ?? "data/corpora/bibles/manifest.json");
  const manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/u, ""));
  const roots = new Map(args.roots.map(value => {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`--source-root requires sourceId=path: ${value}`);
    return [value.slice(0, separator), path.resolve(value.slice(separator + 1))];
  }));
  const required = ["eng-kjv2006", "deu1912", "latVUC"];
  const sources = [];
  for (const sourceId of required) {
    const source = manifest.sources.find(value => value.id === sourceId);
    const root = roots.get(sourceId);
    if (!source || !root) throw new Error(`missing manifest/source root for ${sourceId}`);
    const archivePath = path.resolve(path.dirname(manifestPath), source.file);
    const archiveBytes = await readFile(archivePath);
    const archiveSha256 = sha256(archiveBytes);
    if (archiveSha256 !== source.sha256) throw new Error(`${sourceId} archive hash mismatch: expected ${source.sha256}, got ${archiveSha256}`);
    const archiveEntries = readZipArchiveEntries(archiveBytes);
    const collected = await collectUsfm(root, sourceId, source.language, archiveEntries);
    sources.push({ sourceId, language: source.language, archiveFile: source.file, archiveSha256, ...collected });
  }
  const artifact = alignBibleVerses({ sources, books: args.books ? args.books.split(",") : DEFAULT_BOOKS });
  const { pairs, unresolved, ...artifactSummary } = artifact;
  const header = {
    recordType: "manifest",
    ...artifactSummary,
    workFamilyId: artifact.workFamilyId,
    sourceDependencyGroupIds: artifact.sourceDependencyGroupIds,
    sources: sources.map(source => ({ sourceId: source.sourceId, language: source.language, archiveFile: source.archiveFile, archiveSha256: source.archiveSha256, root: source.root, workFamilyId: artifact.workFamilyId, sourceDependencyGroupIds: artifact.sourceDependencyGroupIds, documents: source.documents.map(document => ({ relativePath: document.relativePath, archiveEntry: document.archiveEntry, archiveEntrySha256: document.archiveEntrySha256, fileSha256: document.fileSha256, bytes: document.bytes, verseCount: document.verses.length, blocks: document.blocks })) }))
  };
  const lines = [JSON.stringify(header), ...pairs.map(value => JSON.stringify(value)), ...unresolved.map(value => JSON.stringify(value)), JSON.stringify({ recordType: "summary", pairCount: pairs.length, unresolvedCount: unresolved.length, booksAudit: artifact.booksAudit })];
  await writeFile(path.resolve(args.out ?? ".tmp/bible-verse-alignment.jsonl"), `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ schema: artifact.schema, status: artifact.status, out: path.resolve(args.out ?? ".tmp/bible-verse-alignment.jsonl"), pairCount: artifact.pairs.length, unresolvedCount: artifact.unresolved.length, booksAudit: artifact.booksAudit })}\n`);
}

function parseArgs(raw) {
  const args = { roots: [] };
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    const separator = value.indexOf("=");
    const name = separator >= 0 ? value.slice(0, separator) : value;
    const argument = separator >= 0 ? value.slice(separator + 1) : raw[++index];
    if (name === "--source-root") args.roots.push(argument);
    else if (name === "--manifest") args.manifest = argument;
    else if (name === "--books") args.books = argument;
    else if (name === "--out") args.out = argument;
    else throw new Error(`unknown option ${name}`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
