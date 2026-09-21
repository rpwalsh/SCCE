// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { test } from "node:test";
import assert from "node:assert/strict";
import { alignBibleVerses, assertExtractedFileMatchesArchive, parseUsfmText, readZipArchiveEntries } from "./bible-usfm-align.mjs";

function source(sourceId, language, text) {
  return { sourceId, language, archiveFile: `${sourceId}.zip`, archiveSha256: `${sourceId}-hash`, root: ".tmp", documents: [], verses: [parseUsfmText({ sourceId, language, relativePath: `${sourceId}.usfm`, bytes: Buffer.from(text, "utf8") }).verses].flat() };
}

test("USFM parser preserves verse bytes, offsets, references, and strips markup only for surface text", () => {
  const parsed = parseUsfmText({
    sourceId: "eng-kjv2006",
    language: "en",
    relativePath: "40-MAT.usfm",
    bytes: Buffer.from(`\\id MAT
\\c 1
\\v 1 In the \\w beginning|strong="H7225"\\w* world.\\f + \\ft note\\f*
`, "utf8")
  });
  assert.equal(parsed.verses.length, 1);
  assert.equal(parsed.verses[0].verseKey, "MAT.1.1");
  assert.equal(parsed.verses[0].text, "In the beginning world.");
  assert.equal(parsed.verses[0].rawText.startsWith("\\v 1"), true);
  assert.equal(parsed.verses[0].rawSha256.length, 64);
  assert.equal(parsed.verses[0].endByte > parsed.verses[0].startByte, true);
});

test("USFM parser flushes structural boundaries and keeps CRLF, emoji, headings, and chapter metadata separate", () => {
  const parsed = parseUsfmText({
    sourceId: "eng-kjv2006",
    language: "en",
    relativePath: "40-MAT.usfm",
    bytes: Buffer.from("\\id MAT\r\n\\c 1\r\n\\v 1 First 😀\r\n\\s1 Heading\r\n\\v 2 Second\r\n\\q1 continuation 😀\r\n\\c 2\r\n\\p\r\n\\v 1 New chapter\r\n", "utf8")
  });
  assert.deepEqual(parsed.verses.map(verse => verse.verseKey), ["MAT.1.1", "MAT.1.2", "MAT.2.1"]);
  assert.equal(parsed.verses[0].rawText.includes("Heading"), false);
  assert.equal(parsed.verses[1].rawText.includes("\\c 2"), false);
  assert.equal(parsed.verses[0].text.includes("😀"), true);
  assert.equal(parsed.verses[1].text.includes("continuation 😀"), true);
  assert.deepEqual(parsed.blocks.map(block => block.marker), ["id", "c", "s1", "q1", "c", "p"]);
  assert.equal(parsed.verses[0].startByte, Buffer.byteLength("\\id MAT\r\n\\c 1\r\n", "utf8"));
});

test("USFM parser rejects malformed UTF-8 and preserves unresolved marker issues", () => {
  assert.throws(() => parseUsfmText({ sourceId: "x", language: "en", relativePath: "x.usfm", bytes: Buffer.from([0xc3, 0x28]) }), /invalid UTF-8/);
  const parsed = parseUsfmText({
    sourceId: "eng-kjv2006",
    language: "en",
    relativePath: "40-MAT.usfm",
    bytes: Buffer.from("\\id MAT\n\\c 1\n\\v 1 Unknown \\mystery payload\n\\v 2 Unclosed \\w word|lemma=x\n\\v 3 Alternate\n", "utf8")
  });
  assert.ok(parsed.verses[0].markerIssues.some(issue => issue.startsWith("unknown:")));
  assert.ok(parsed.verses[1].markerIssues.some(issue => issue.startsWith("unclosed:")));
  assert.equal(parsed.verses[2].verseLabel, "3");
});

test("extracted USFM bytes must match the verified archive entry", () => {
  assert.doesNotThrow(() => assertExtractedFileMatchesArchive({ archiveEntryBytes: Buffer.from("same"), extractedBytes: Buffer.from("same"), entryName: "40-MAT.usfm" }));
  assert.throws(() => assertExtractedFileMatchesArchive({ archiveEntryBytes: Buffer.from("same"), extractedBytes: Buffer.from("changed"), entryName: "40-MAT.usfm" }), /differs from ZIP entry/);
});

test("alignment emits only exact equal verse sets for the selected Gospels", () => {
  const en = source("eng-kjv2006", "en", `\\id MAT
\\c 1
\\v 1 English one
\\v 2 English two
`);
  const de = source("deu1912", "de", `\\id MAT
\\c 1
\\v 1 Deutsch eins
\\v 2 Deutsch zwei
`);
  const la = source("latVUC", "la", `\\id MAT
\\c 1
\\v 1 Latin unus
\\v 2 Latin duo
`);
  const result = alignBibleVerses({ sources: [en, de, la], books: ["MAT"] });
  assert.equal(result.pairs.length, 2);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.booksAudit[0].exactKeySet, true);
  assert.equal(result.pairs[0].trainingEligible, false);
  assert.equal(result.pairs[0].source.language, "en");
  assert.equal(result.pairs[0].german.language, "de");
  assert.equal(result.pairs[0].latin.language, "la");
  assert.deepEqual(result.sourceDependencyGroupIds, result.pairs[0].source.sourceDependencyGroupIds);
  assert.deepEqual(result.pairs[0].source.sourceDependencyGroupIds, result.pairs[0].german.sourceDependencyGroupIds);
  assert.equal(result.workFamilyId, result.pairs[0].latin.workFamilyId);
  assert.match(result.pairs[0].pairId, /^bible_verse_pair_/u);
});

test("ZIP entry names are normalized without allowing collisions", () => {
  const zipWithNames = names => {
    const local = [];
    const central = [];
    let offset = 0;
    for (const value of names) {
      const name = Buffer.from(value, "utf8");
      const localHeader = Buffer.alloc(30 + name.length);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt32LE(0, 18);
      localHeader.writeUInt32LE(0, 22);
      localHeader.writeUInt16LE(name.length, 26);
      name.copy(localHeader, 30);
      local.push(localHeader);
      const centralHeader = Buffer.alloc(46 + name.length);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0, 10);
      centralHeader.writeUInt32LE(0, 20);
      centralHeader.writeUInt32LE(0, 24);
      centralHeader.writeUInt16LE(name.length, 28);
      centralHeader.writeUInt32LE(offset, 42);
      name.copy(centralHeader, 46);
      central.push(centralHeader);
      offset += localHeader.length;
    }
    const localBytes = Buffer.concat(local);
    const centralBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(localBytes.length, 16);
    return Buffer.concat([localBytes, centralBytes, end]);
  };
  assert.throws(() => readZipArchiveEntries(zipWithNames(["A.usfm", "a.usfm"])), /duplicate normalized ZIP entry name/);
});

test("review pair IDs are stable and bound to source bytes", () => {
  const make = suffix => [
    source("eng-kjv2006", "en", `\\id MAT\n\\c 1\n\\v 1 English ${suffix}\n`),
    source("deu1912", "de", "\\id MAT\n\\c 1\n\\v 1 Deutsch eins\n"),
    source("latVUC", "la", "\\id MAT\n\\c 1\n\\v 1 Latin unus\n")
  ];
  const first = alignBibleVerses({ sources: make("one"), books: ["MAT"] }).pairs[0].pairId;
  const repeat = alignBibleVerses({ sources: make("one"), books: ["MAT"] }).pairs[0].pairId;
  const changed = alignBibleVerses({ sources: make("two"), books: ["MAT"] }).pairs[0].pairId;
  assert.equal(first, repeat);
  assert.notEqual(first, changed);
});

test("verse ordering is numeric within a chapter", () => {
  const make = (sourceId, language) => source(sourceId, language, `\\id MAT\n\\c 1\n\\v 1 one\n\\v 2 two\n\\v 10 ten\n`);
  const result = alignBibleVerses({ sources: [make("eng-kjv2006", "en"), make("deu1912", "de"), make("latVUC", "la")], books: ["MAT"] });
  assert.deepEqual(result.pairs.map(pair => pair.verseKey), ["MAT.1.1", "MAT.1.2", "MAT.1.10"]);
});

test("mismatched, duplicate, and alternate verse keys remain unresolved", () => {
  const en = source("eng-kjv2006", "en", `\\id MAT
\\c 1
\\v 1 English one
\\v 2 English two
`);
  const de = source("deu1912", "de", `\\id MAT
\\c 1
\\v 1 Deutsch eins
\\v 2a Deutsch alternate
\\v 2b Deutsch duplicate
`);
  const la = source("latVUC", "la", `\\id MAT
\\c 1
\\v 1 Latin unus
\\v 2 Latin duo
`);
  const result = alignBibleVerses({ sources: [en, de, la], books: ["MAT"] });
  assert.equal(result.pairs.length, 0);
  assert.equal(result.booksAudit[0].exactKeySet, false);
  assert.ok(result.unresolved.some(row => row.reasons.includes("book_verse_set_differs_across_sources")));
});
