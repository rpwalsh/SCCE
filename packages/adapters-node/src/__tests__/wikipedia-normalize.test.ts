// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { normalizeWikiText } from "../wikipedia.js";

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
});
