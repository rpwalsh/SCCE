// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";

/**
 * Structural residue: a surface that is serialized apparatus rather than a statement.
 *
 * A Wikipedia article carries a machine-written reference table (`["CITEREFMasten2003"] = 1,` repeated for every
 * citation), a book carries a licence header and a chapter index, a source file carries a copyright banner. All of
 * it is stored as evidence and all of it is reachable as an answer: "What is the boiling point of tungsten?" was
 * answered with the tungsten article's citation table, because that table was the ONE span of that article the
 * admission tier left promoted.
 *
 * The criterion is the one `joint-objective.md` requires. Apparatus compresses beautifully under surface MDL and
 * earns nothing under `L(G | Theta)`; template residue additionally has a shape no sentence has, and that shape is
 * measurable without knowing any language:
 *
 *   symbolDensity      how much of the token stream is punctuation rather than word or number
 *   bigramDiversity    how many distinct token bigrams the stream spends its length on
 *
 * A key-value table is dense in symbols AND spends its length re-using one bigram skeleton, so the product
 * `symbolDensity * (1 - bigramDiversity)` separates it from prose, which is sparse in symbols and almost never
 * repeats a bigram. No casing, no word list, no position, no language.
 *
 * Deliberately NOT a list of markup literals. `isUnparsedMarkupText` already tests for `{{`, `|` and `==`, which is
 * why it misses this table entirely: the table contains none of them. A literal list is a rule about one markup
 * dialect; this is a measurement of the surface itself, and it fires on the citation table, on a URL query-string
 * fragment and on a wikitext reference list alike.
 *
 * SENTENCE GRANULARITY, never span granularity. Measured on the live corpus: scoring whole spans refuses the lead
 * of every article whose 4 KB span also contains a results table (`Moldova national football team results` scores
 * 0.647 on the span and its first sentence is ordinary prose). The residue is a property of the surface that would
 * be spoken, so that is what is measured.
 */

/** Word runs lowercased, digit runs collapsed to one token, every other non-space character its own token. Pure. */
export function residueTokens(text: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/u.test(char)) { index++; continue; }
    if (/[\p{L}\p{M}]/u.test(char)) {
      let end = index;
      while (end < text.length && (/[\p{L}\p{M}]/u.test(text[end]!) || text[end] === "'")) end++;
      out.push(text.slice(index, end).toLocaleLowerCase());
      index = end;
      continue;
    }
    if (/\p{Nd}/u.test(char)) {
      let end = index;
      while (end < text.length && /\p{Nd}/u.test(text[end]!)) end++;
      out.push(" digits");
      index = end;
      continue;
    }
    out.push(char);
    index++;
  }
  return out;
}

export interface StructuralResidueMeasurement {
  symbolDensity: number;
  bigramDiversity: number;
  score: number;
  tokens: number;
}

/** How much of this surface is repeated punctuation skeleton rather than statement. Pure, language-free. */
export function structuralResidueMeasurement(text: string): StructuralResidueMeasurement {
  const tokens = residueTokens(String(text ?? ""));
  // Too short to have a skeleton: three tokens give two bigrams and any ratio over them is noise.
  if (tokens.length < 4) return { symbolDensity: 0, bigramDiversity: 1, score: 0, tokens: tokens.length };
  const bigrams = new Set<string>();
  for (let index = 1; index < tokens.length; index++) bigrams.add(`${tokens[index - 1]}${tokens[index]}`);
  const bigramDiversity = bigrams.size / (tokens.length - 1);
  let symbols = 0;
  for (const token of tokens) if (token.length === 1 && !/[\p{L}\p{M}\p{Nd}]/u.test(token)) symbols++;
  const symbolDensity = symbols / tokens.length;
  return { symbolDensity, bigramDiversity, score: symbolDensity * (1 - bigramDiversity), tokens: tokens.length };
}

/** The corpus's own Otsu split of the score above; see `evidence.structural_residue_cut`. Pure. */
export function structuralResidueScore(text: string): number {
  return structuralResidueMeasurement(text).score;
}

/** True when this surface is apparatus and must never be spoken as an answer. Pure. */
export function isStructuralResidueSurface(text: string): boolean {
  return structuralResidueScore(text) >= calibrated("evidence.structural_residue_cut");
}
