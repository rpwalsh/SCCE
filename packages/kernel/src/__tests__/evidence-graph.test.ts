// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createEvidenceExtractor } from "../evidence.js";
import { createSourceGraphBuilder } from "../graphbuild.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";

describe("evidence extraction and graph build", () => {
  const clock = createClock({ fixedTime: 10 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

  it("keeps whole-source Unicode traversals constant as exact-source paragraphs grow", () => {
    const measure = (count: number) => {
      const text = Array.from({ length: count }, (_, index) => `# 🧪章 ${index}\r\n\r\n甲 e\u0301 🦉 العربية ${index}。\r\n`).join("\r\n");
      const sourceVersionId = ids.sourceVersionId(text);
      const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 10 });
      const original = String.prototype[Symbol.iterator];
      let traversals = 0;
      String.prototype[Symbol.iterator] = function (this: string) {
        if (String(this) === text) traversals++;
        return original.call(this);
      };
      let extracted;
      try {
        extracted = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
          sourceId: ids.sourceId("test", "inline://source-coordinate-scaling"), sourceVersionId, namespace: "test", uri: "inline://source-coordinate-scaling",
          mediaType: "text/markdown", text, languageProfile: profile, observedAt: 10, maxChunkBytes: 160, exactSourceText: true,
          sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "fixture", licenseStatus: "fixture" }
        });
      } finally { String.prototype[Symbol.iterator] = original; }
      const points = [...text];
      const bytes = Buffer.from(text);
      expect(extracted.spans.length).toBeGreaterThan(1);
      for (const span of extracted.spans) {
        expect(points.slice(span.charStart, span.charEnd).join("")).toBe(span.text);
        expect(bytes.subarray(span.byteStart, span.byteEnd).toString()).toBe(span.text);
        expect(span.byteEnd - span.byteStart).toBe(Buffer.byteLength(span.text));
        expect(span.contentHash).toBe(ids.contentHash(Buffer.from(span.text)));
      }
      for (const section of extracted.sections) {
        expect(bytes.subarray(section.byteStart, section.byteEnd).toString()).toBe(points.slice(section.charStart, section.charEnd).join(""));
      }
      expect(extracted.spans.some(span => span.text.includes("e\u0301"))).toBe(true);
      return traversals;
    };
    const first = measure(128);
    const second = measure(256);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("preserves byte ranges and builds higher-order graph material", () => {
    const sourceVersionId = ids.sourceVersionId(Buffer.from("alpha"));
    const sourceId = ids.sourceId("test", "inline://alpha");
    const language = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({
      sourceVersionId,
      text: "# Alpha Layer\n\nEvidence links proof, provenance, and graph pressure.\n\n## ProgramGraph\n\nThe construct emits files and tests.",
      createdAt: clock.now()
    });
    const extracted = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
      sourceId,
      sourceVersionId,
      namespace: "test",
      uri: "inline://alpha",
      mediaType: "text/markdown",
      text: "# Alpha Layer\n\nEvidence links proof, provenance, and graph pressure.\n\n## ProgramGraph\n\nThe construct emits files and tests.",
      languageProfile: language,
      sourceTrust: {
        identity: 1, integrity: 1, parserReliability: 1, directness: 1,
        authority: 1, freshness: 1, independenceGroup: "fixture:evidence-graph",
        accessScope: "fixture", licenseStatus: "fixture"
      },
      observedAt: clock.now(),
      maxChunkBytes: 48
    });
    expect(extracted.spans.length).toBeGreaterThan(1);
    expect(extracted.spans.every(span => span.byteEnd > span.byteStart)).toBe(true);
    const graph = createSourceGraphBuilder({ idFactory: ids }).build({ sourceVersionId, uri: "inline://alpha", mediaType: "text/markdown", languageProfile: language, evidence: extracted.spans, observedAt: clock.now() });
    expect(graph.nodes.length).toBeGreaterThan(extracted.spans.length);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.hyperedges.length).toBeGreaterThan(0);
  });

  it.each([
    ["emoji and astral", "# 🧠 Section\r\n\r\nA😀B 𝟘 end."],
    ["combining characters", "# Cafe\u0301\n\nna\u0308ive re\u0301sume\u0301"],
    ["CJK", "# 標題\n\n証拠は正確な範囲を保持します。"],
    ["Arabic and Hebrew", "# عنوان\n\nدليل دقيق ראיה מדויקת"],
    ["mixed scripts and CRLF", "# MIXED 🌍\r\n\r\nEnglish 中文 العربية עברית 🚀"]
  ])("round-trips NFC code-point and UTF-8 byte ranges for %s", (_name, inputText) => {
    const normalized = inputText.normalize("NFC");
    const sourceVersionId = ids.sourceVersionId(Buffer.from(normalized));
    const sourceId = ids.sourceId("test", `inline://unicode/${_name}`);
    const language = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: normalized, createdAt: clock.now() });
    const extracted = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
      sourceId,
      sourceVersionId,
      namespace: "test",
      uri: `inline://unicode/${_name}`,
      mediaType: "text/markdown",
      text: inputText,
      languageProfile: language,
      sourceTrust: {
        identity: 1, integrity: 1, parserReliability: 1, directness: 1,
        authority: 1, freshness: 1, independenceGroup: "fixture:evidence-unicode",
        accessScope: "fixture", licenseStatus: "fixture"
      },
      observedAt: clock.now(),
      maxChunkBytes: 9
    });
    const bytes = Buffer.from(normalized, "utf8");
    const codePoints = [...normalized];
    expect(extracted.spans.length).toBeGreaterThan(1);
    for (const span of extracted.spans) {
      expect(bytes.subarray(span.byteStart, span.byteEnd).toString("utf8")).toBe(span.text);
      expect(codePoints.slice(span.charStart, span.charEnd).join("")).toBe(span.text);
    }
    for (const section of extracted.sections) {
      const sectionText = codePoints.slice(section.charStart, section.charEnd).join("");
      expect(bytes.subarray(section.byteStart, section.byteEnd).toString("utf8")).toBe(sectionText);
    }
  });
});
