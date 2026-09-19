// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createEvidenceExtractor } from "../evidence.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import type { EvidenceId, SourceId, SourceVersionId } from "../types.js";

// Alpha is stamped on every span at ingest and read downstream by retrieval, the admission ceiling and
// training promotion. It used to be a weighted sum -- an intercept of 0.12 plus five channels at
// 0.25/0.25/0.18/0.12/0.08, one of which was a hand-ranked media prior -- and nothing measured any of it.
//
// It is now composed geometrically over the channels that measured something, so no channel outranks another
// by choice. These tests hold the properties a dozen downstream consumers depend on: alpha must stay bounded,
// must still DISCRIMINATE between spans, and must not collapse to zero on an ordinary document just because
// one structural channel found nothing.

const TRUST = {
  identity: 1, integrity: 1, parserReliability: 1, directness: 1,
  authority: 1, freshness: 1, independenceGroup: "fixture:alpha",
  accessScope: "owner_private", licenseStatus: "owner_authorized"
} as const;

function extract(text: string, mediaType = "text/plain") {
  const clock = createClock({ fixedTime: 1_000 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const sourceVersionId = ids.sourceVersionId(Buffer.from(text, "utf8"));
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({
    sourceVersionId, text, createdAt: clock.now()
  });
  return createEvidenceExtractor({ idFactory: ids, hasher }).extract({
    sourceId: ids.sourceId("fixture", "file://alpha"),
    sourceVersionId,
    namespace: "fixture",
    uri: "file://alpha",
    mediaType,
    text,
    languageProfile: profile,
    sourceTrust: TRUST,
    observedAt: clock.now(),
    maxChunkBytes: 4096
  });
}

/** Prose with headings and paragraphs: the ordinary case, and the one whose alpha must not collapse. */
function article(paragraphs: number): string {
  // Paragraphs of deliberately different lengths. Only two of alpha's channels are per-span -- the span's own
  // bytes and its feature count -- while structural confidence and lexical entropy are properties of the whole
  // document, which was equally true of the weighted sum this replaced. A fixture of uniform paragraphs gives
  // every span the same alpha under either formula and so proves nothing either way.
  const body = Array.from({ length: paragraphs }, (_, index) => {
    const sentences = 1 + (index % 6) * 3;
    const text = Array.from({ length: sentences }, (_, sentence) =>
      `Paragraph ${index} sentence ${sentence} carries its own symbols and its own length, and the `
      + `extractor measures each of those rather than being told what they are worth.`).join(" ");
    return `## Section ${index}\n\n${text}\n`;
  }).join("\n");
  return `# Fixture\n\n${body}`;
}

describe("evidence alpha composes measurements instead of weighting them", () => {
  it("stays bounded and never lands on zero for an ordinary document", () => {
    const extracted = extract(article(12));
    expect(extracted.spans.length).toBeGreaterThan(1);
    for (const span of extracted.spans) {
      expect(span.alpha).toBeGreaterThan(0);
      expect(span.alpha).toBeLessThanOrEqual(1);
      expect(Number.isFinite(span.alpha)).toBe(true);
    }
  });

  it("still discriminates between spans of the same document", () => {
    // A weighted sum's intercept guaranteed spread even when nothing varied. Without one, the spread has to
    // come from the measurements, so this asserts it actually does.
    const alphas = extract(article(16)).spans.map(span => span.alpha);
    expect(new Set(alphas).size).toBeGreaterThan(1);
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0);
  });

  it("does not collapse when a document has no detected sections", () => {
    // sectionMass reads zero here. Multiplying that straight through would stamp alpha 0 on every span, which
    // is why absent channels are skipped rather than multiplied.
    const flat = Array.from({ length: 10 }, (_, index) =>
      `Plain paragraph ${index} with no heading of any kind, carrying ordinary sentences and nothing structural.`
    ).join("\n\n");
    const extracted = extract(flat);
    expect(extracted.sections.length).toBe(0);
    expect(extracted.spans.length).toBeGreaterThan(0);
    for (const span of extracted.spans) expect(span.alpha).toBeGreaterThan(0);
  });

  it("gives the same alpha whatever container the text arrived in", () => {
    // The retired media prior ranked pdf/word/text/other by hand. A container is not a measurement of content,
    // so the same bytes must score the same however they were delivered.
    const text = article(8);
    const asText = extract(text, "text/plain").spans.map(span => span.alpha);
    const asPdf = extract(text, "application/pdf").spans.map(span => span.alpha);
    const asOther = extract(text, "application/octet-stream").spans.map(span => span.alpha);
    expect(asPdf).toEqual(asText);
    expect(asOther).toEqual(asText);
  });

  it("rises with the content a span actually carries", () => {
    // More text and more varied text measure higher on the channels that remain, so alpha has to follow.
    const thin = extract("Short.\n\nAlso short.").spans.map(span => span.alpha);
    const thick = extract(article(24)).spans.map(span => span.alpha);
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    expect(mean(thick)).toBeGreaterThan(mean(thin));
  });

  it("reports the distribution, so a downstream weight change is visible rather than silent", () => {
    const alphas = extract(article(20)).spans.map(span => span.alpha).sort((a, b) => a - b);
    const mean = alphas.reduce((total, value) => total + value, 0) / alphas.length;
    process.stdout.write(
      `\n  alpha over ${alphas.length} spans: min ${alphas[0]!.toFixed(4)}`
      + ` median ${alphas[Math.floor(alphas.length / 2)]!.toFixed(4)}`
      + ` max ${alphas[alphas.length - 1]!.toFixed(4)} mean ${mean.toFixed(4)}\n`
    );
    expect(alphas.length).toBeGreaterThan(0);
  });
});
