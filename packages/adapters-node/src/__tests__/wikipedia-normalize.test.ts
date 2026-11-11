// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { symbolizeData } from "@scce/kernel";
import { normalizeWikiText, wikipediaLanguageSurface, wikiPageStructure } from "../wikipedia.js";

describe("wikitext normalization", () => {
  it("closes the separators a stripped template leaves behind", () => {
    const text = "'''Augusta Ada King''' ({{IPAc-en|ˈ|eɪ|d|ə}}; 10 December 1815 – 27 November 1852) was an English mathematician.";
    expect(normalizeWikiText(text)).toContain("(10 December 1815 – 27 November 1852) was an English mathematician.");
  });

  it("drops a section that is a citation list and keeps prose sections", () => {
    const text = "Lead sentence.\n\n== Life ==\nShe wrote notes in 1843.\n\n== References ==\n* Smith, J. (1999). A book. https://example.org/a\n* Jones, K. (2001). Another book.\n";
    const normalized = normalizeWikiText(text);
    expect(normalized).toContain("She wrote notes in 1843.");
    expect(normalized).not.toContain("Another book");
  });

  it("keeps article links and headings as declared structure before the markup is stripped", () => {
    const raw = "[[ada Lovelace|her]] met [[Charles Babbage]] ([[File:Babbage.jpg|thumb]]).\n== Early life ==\nText.\n[[Category:1815 births]]\n[[Star Trek: The Next Generation]]";
    const structure = wikiPageStructure(raw);
    expect(structure.links).toEqual([
      { target: "Ada Lovelace", label: "her" },
      { target: "Charles Babbage", label: "Charles Babbage" },
      { target: "Star Trek: The Next Generation", label: "Star Trek: The Next Generation" }
    ]);
    expect(structure.headings).toEqual([{ text: "Early life", level: 2, charStart: raw.indexOf("== Early") }]);
  });

  it("keeps gallery evidence exact but admits only its caption to the prose-learning surface", () => {
    const raw = "Honey bees visit many flowers.\n<gallery widths=\"240\">\nBee on rock rose.jpg | western honey bees.\n</gallery>\nThey collect nectar.";
    const evidence = normalizeWikiText(raw);
    const language = wikipediaLanguageSurface(raw);

    expect(evidence).toContain("Bee on rock rose.jpg | western honey bees.");
    expect(language.text).not.toContain("Bee on rock rose.jpg");
    expect(language.text).toContain("western honey bees.");
    expect(language.figures).toEqual([expect.objectContaining({
      id: "Bee on rock rose.jpg",
      caption: "western honey bees.",
      origin: "gallery"
    })]);
    const filename = language.roles.find(role => role.role === "gallery-filename")!;
    const caption = language.roles.find(role => role.role === "gallery-caption")!;
    expect(raw.slice(filename.sourceCharStart, filename.sourceCharEnd)).toBe("Bee on rock rose.jpg");
    expect(raw.slice(caption.sourceCharStart, caption.sourceCharEnd)).toBe("western honey bees.");
    expect(filename.projectedCharStart).toBe(filename.sourceCharStart);
    expect(filename.projectedCharEnd).toBe(filename.sourceCharEnd);
    expect(language.text).toHaveLength(evidence.length);
    expect(symbolizeData(language.text)).not.toContain("\u{E0000}");
    expect(symbolizeData(language.text).join(" ")).not.toContain("Bee on rock rose.jpg");
  });

  it("does not blacklist a filename that the article itself discusses", () => {
    const filename = "Bee on rock rose.jpg";
    const raw = `${filename} is the filename discussed by this article.\n<gallery>\n${filename}|A specimen caption.\n</gallery>`;
    const language = wikipediaLanguageSurface(raw);

    expect(language.text).toContain(`${filename} is the filename discussed by this article.`);
    expect(language.text.match(/Bee on rock rose\.jpg/gu)).toHaveLength(1);
    expect(language.figures[0]).toMatchObject({ id: filename, caption: "A specimen caption." });

  });

  it("does not blank an identical filename-caption record used as ordinary prose before the gallery", () => {
    const record = "Bee on rock rose.jpg | western honey bees.";
    const raw = `${record}\nThis exact record is discussed in prose.\n<gallery>\n${record}\n</gallery>\nLater prose remains aligned.`;
    const evidence = normalizeWikiText(raw);
    const language = wikipediaLanguageSurface(raw, undefined, evidence);

    expect(evidence.match(/Bee on rock rose\.jpg \| western honey bees\./gu)).toHaveLength(2);
    expect(language.text.match(/Bee on rock rose\.jpg \| western honey bees\./gu)).toHaveLength(1);
    expect(language.text.startsWith(record)).toBe(true);
    expect(language.text.slice(evidence.indexOf("Later prose"))).toMatch(/^Later prose remains aligned\./u);
  });

  it("anchors a gallery record after document-global apparatus filtering changes prefix offsets", () => {
    const filename = "Bee on rock rose.jpg";
    const headings = Array.from({ length: 6 }, (_, index) => `== H${index} ==`);
    const raw = [...headings, "<gallery>", `${filename} | western honey bees.`, "</gallery>",
      "Ordinary prose words ".repeat(500)].join("\n");
    const evidence = normalizeWikiText(raw);
    const language = wikipediaLanguageSurface(raw, undefined, evidence);

    expect(evidence).not.toContain("== H0 ==");
    expect(evidence).toContain(filename);
    expect(language.text).not.toContain(filename);
    expect(language.text).toContain("western honey bees.");
    expect(language.mappings).toHaveLength(1);
    expect(language.text).toHaveLength(evidence.length);
  });

  it("declares table and reference apparatus without pretending their semantic contents are qualified", () => {
    const raw = "Measured prose.<ref name=\"source\">Smith (2020), measured result.</ref>\n"
      + "{| class=\"wikitable\"\n|+ Measurements\n|-\n! Item !! Value\n|-\n| sample || 42\n|}";
    const language = wikipediaLanguageSurface(raw);
    const table = language.roles.find(role => role.role === "table-apparatus")!;
    const reference = language.roles.find(role => role.role === "reference-apparatus")!;

    expect(table.channel).toBe("unqualified");
    expect(reference.channel).toBe("unqualified");
    expect(raw.slice(table.sourceCharStart, table.sourceCharEnd)).toMatch(/^\{\|/u);
    expect(raw.slice(reference.sourceCharStart, reference.sourceCharEnd)).toContain("Smith (2020)");
    expect(language.tables[0]).toMatchObject({ label: "Measurements", rows: 3 });
  });
});
