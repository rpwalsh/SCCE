// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { trainKneserNey } from "../kneser-ney.js";
import { clearFreeFormLexicon, corpusTreatsUnitsAsOneForm, freeFormLexicon, primeFreeFormLexicon } from "../free-form-lexicon.js";
import { requestUnitSharesStem } from "../local-evidence-runtime.js";

/**
 * One surface plus one letter is the same unit when the corpus uses both as free forms, and not when either is a
 * fragment of one fixed phrase. Nothing here is English: "zorbit" and "quixa" are invented, and the corpus below is
 * the only thing that says which of them stands on its own.
 */
describe("free-form lexicon", () => {
  afterEach(() => clearFreeFormLexicon());

  /** A corpus with a real type/token spread, plus one form the corpus only ever puts one word in front of. */
  function corpusSymbols(): string[] {
    let seed = 20260912;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    // Letters only: a symbol carrying a digit is not a word symbol anywhere in the kernel.
    const name = (stem: string, index: number) => `${stem}${String.fromCharCode(97 + Math.floor(index / 26) % 26)}${String.fromCharCode(97 + index % 26)}`;
    const frames = Array.from({ length: 160 }, (_, index) => name("frame", index));
    const stream: string[] = [];
    const emit = (form: string, tokens: number, contexts: number) => {
      for (let i = 0; i < tokens; i++) {
        stream.push(frames[i % contexts] ?? frames[0]!, form);
      }
    };
    for (let index = 0; index < 150; index++) {
      const tokens = 4 + Math.floor(next() * 120);
      const contexts = Math.max(1, Math.min(tokens, Math.round(Math.pow(tokens, 0.8) * (0.7 + next() * 0.6))));
      emit(name("word", index), tokens, contexts);
    }
    emit("zorbit", 60, 40);
    emit("zorbity", 44, 30);
    emit("quixal", 60, 40);
    // The fragment: sixty occurrences, always the same word before it.
    for (let i = 0; i < 60; i++) stream.push("per", "quixa");
    return stream;
  }

  const hydrate = () => primeFreeFormLexicon([trainKneserNey(corpusSymbols(), { order: 2 })]);

  it("calls a form bound when the corpus only ever puts one word before it", () => {
    hydrate();
    const lexicon = freeFormLexicon();
    expect(lexicon?.verdict("zorbit")).toBe("free");
    expect(lexicon?.verdict("zorbity")).toBe("free");
    expect(lexicon?.verdict("quixal")).toBe("free");
    expect(lexicon?.verdict("quixa")).toBe("bound");
    expect(lexicon?.measure("quixa")?.contexts).toBe(1);
  });

  it("reads one extra letter as the same unit only where both forms are free", () => {
    hydrate();
    expect(corpusTreatsUnitsAsOneForm("zorbit", "zorbity")).toBe(true);
    expect(corpusTreatsUnitsAsOneForm("quixa", "quixal")).toBe(false);
    // The letter is never the reason: the accepted pair ends in "y" and the refused one in "l".
    expect(requestUnitSharesStem("zorbit", "zorbity")).toBe(true);
    expect(requestUnitSharesStem("quixa", "quixal")).toBe(false);
  });

  it("says nothing about a surface the corpus has not seen", () => {
    hydrate();
    expect(freeFormLexicon()?.verdict("zorbitrium")).toBe("unknown");
    expect(corpusTreatsUnitsAsOneForm("zorbit", "zorbitx")).toBe(false);
  });

  it("refuses every pair when no corpus has been hydrated", () => {
    expect(corpusTreatsUnitsAsOneForm("zorbit", "zorbity")).toBe(false);
    expect(freeFormLexicon()).toBeUndefined();
  });
});
