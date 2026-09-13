// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { centralSentences, summarizeAdmittedSource, summarizeSource, unwrapTypographicLineBreaks } from "../source-summary.js";

// Scaffolding a corpus would derive from its own continuation counts; the summarizer never supplies one itself.
const closedClass = new Set([
  "the", "of", "and", "in", "a", "to", "was", "were", "is", "are", "that", "which", "with",
  "for", "on", "at", "by", "from", "as", "it", "he", "his", "her", "she", "they", "their", "this", "or"
]);

/** Hard-wrapped the way a printed book arrives: a paragraph is several lines, and only its last line closes. */
function wrap(paragraph: string, width = 58): string {
  const lines: string[] = [];
  let line = "";
  for (const word of paragraph.split(" ")) {
    if (line && (line + " " + word).length > width) { lines.push(line); line = word; continue; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

const APPARATUS = [
  "The Project Gutenberg eBook of The Whale Fishery",
  "Title: The Whale Fishery",
  "*** START OF THE PROJECT GUTENBERG EBOOK THE WHALE FISHERY ***"
];

const CUES = ["PORTUGUESE SAILOR.", "DANISH SAILOR.", "SPANISH SAILOR.", "BELFAST SAILOR.", "OLD MANX SAILOR."];

const BODY = [
  "The whalemen of the northern fishery pursued the sperm whale through the open water for many months, and the boats that followed the whale were lowered at every rising of the spout.",
  "Every boat that followed the sperm whale carried a harpooneer, and the harpooneer of the northern fishery was reckoned the most practised of the whalemen who lowered for the open water.",
  "Among the whalemen of the open water the sperm whale was reckoned the most dangerous of the fishery, and the boats lowered for him carried more line than the boats of the northern fishery.",
  "No harpooneer lowered for the sperm whale without the line that the boats of the northern fishery carried, and the whalemen reckoned that line the most necessary of the boat's gear.",
  "The fishery of the open water reckoned its months by the whales the boats had taken, and the whalemen of the northern boats counted the sperm whale above every other whale."
];

const gutenbergSource = [
  APPARATUS.join("\n"),
  "",
  BODY.map(sentence => wrap(sentence)).join("\n\n"),
  "",
  CUES.join("\n")
].join("\n");

describe("source summary", () => {
  it("joins the line breaks a hard-wrapped source uses as typographic wrap", () => {
    const unwrapped = unwrapTypographicLineBreaks(gutenbergSource);
    expect(unwrapped).not.toBe(gutenbergSource);
    for (const sentence of BODY) expect(unwrapped).toContain(sentence);
  });

  it("leaves a source whose paragraphs are already single lines untouched", () => {
    const article = BODY.join("\n\n");
    expect(unwrapTypographicLineBreaks(article)).toBe(article);
  });

  it("speaks the work rather than its front matter", () => {
    const summary = summarizeSource({ text: gutenbergSource, closedClass, maxChars: 600 });
    expect(summary).not.toBe("");
    for (const line of APPARATUS) expect(summary).not.toContain(line);
    expect(BODY.some(sentence => summary.includes(sentence))).toBe(true);
  });

  it("does not rank a speaker cue above a sentence of the work", () => {
    const ranked = centralSentences(gutenbergSource, closedClass)
      .slice()
      .sort((left, right) => right.centrality - left.centrality);
    expect(ranked.length).toBeGreaterThan(0);
    expect(CUES).not.toContain(ranked[0]!.text);
  });

  it("speaks only sentences the source itself states", () => {
    const summary = summarizeSource({ text: gutenbergSource, closedClass, maxChars: 900 });
    const source = unwrapTypographicLineBreaks(gutenbergSource).replace(/\s+/gu, " ");
    for (const sentence of centralSentences(gutenbergSource, closedClass)) {
      if (!summary.includes(sentence.text)) continue;
      expect(source).toContain(sentence.text.replace(/\s+/gu, " "));
    }
  });
});

describe("summary of an admitted source", () => {
  const spans = BODY.map((sentence, index) => ({ sourceKey: "book", text: wrap(`${sentence} ${BODY[(index + 1) % BODY.length]}`) }));

  it("speaks the source's own sentences and names the spans they came from", () => {
    const excerpt = summarizeAdmittedSource({ spans, closedClass, maxChars: 560 });
    expect(excerpt).toBeDefined();
    expect(excerpt!.spokenFrom.length).toBeGreaterThan(0);
    for (const position of excerpt!.spokenFrom) expect(spans[position]).toBeDefined();
    for (const sentence of excerpt!.text.split(/(?<=\.)\s+/u)) {
      expect(spans.some(span => span.text.replace(/\s+/gu, " ").includes(sentence.replace(/\s+/gu, " ")))).toBe(true);
    }
  });

  it("summarizes the source most of the admitted spans belong to, never both", () => {
    const other = { sourceKey: "article", text: "A grammar of the tides describes the tide, the tide table and the tidal range of a harbour." };
    const excerpt = summarizeAdmittedSource({ spans: [...spans, other], closedClass, maxChars: 560 });
    expect(excerpt).toBeDefined();
    expect(excerpt!.text).not.toContain("grammar of the tides");
  });

  it("says nothing when no span is admitted", () => {
    expect(summarizeAdmittedSource({ spans: [], closedClass, maxChars: 560 })).toBeUndefined();
  });
});
