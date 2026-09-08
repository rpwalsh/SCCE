// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { codeIdentifierTokens, codeSurfaceTokens } from "./code-surface.js";
import { codeLanguageForPath } from "./code-request.js";
import { toJsonValue } from "./primitives.js";
import type { EvidenceSpan, JsonValue } from "./types.js";

/**
 * What a request written in a human language has to do with code.
 *
 * The code lane is driven by compiler diagnostics, which is why it can repair a file and has nothing to say when
 * asked to write one: a request has no diagnostics. Reading the request with a code tokenizer is not an answer
 * either -- every word in every language looks like an identifier to it, so "fix the misspelled property access"
 * came back as five symbols and none of them meant anything.
 *
 * The connection already exists in the corpus. Every source file is trained twice: its token stream into the
 * code corpus, and its comments and the words its identifiers are spelled out of into the documentation corpus.
 * Both carry the same file path. So a request matched against documentation surfaces -- ordinary retrieval, the
 * same lane a question about a document uses -- lands on files, and those files name the code models, the
 * constructions and the symbols that are relevant. Prose in, code out, with no vocabulary written down anywhere.
 */

export interface CodeIntentReference {
  /** The file whose documentation matched, when the corpus recorded one. */
  relativePath?: string;
  /** The formal language that path is written in. */
  languageId?: string;
  /** How strongly this surface answered the request, as the retrieval scored it. */
  score: number;
}

export interface CodeIntent {
  /** Formal language the intent concerns, when the references agree on one. */
  languageId?: string;
  /**
   * Names the request puts in play.
   *
   * A request's own words qualify only when some code actually uses them as a name; the rest come from the
   * documentation surfaces that answered it, which is how a request that names nothing still reaches the
   * vocabulary of the code it is about.
   */
  symbols: string[];
  /** The files the request is about, best first. */
  references: CodeIntentReference[];
  audit: JsonValue;
}

const REFERENCE_LIMIT = 8;
const SYMBOL_LIMIT = 32;

/**
 * The intent behind a request, read off documentation the corpus already holds.
 *
 * Retrieval is the caller's -- this is pure, and takes the spans that came back. A request that matched nothing
 * yields an intent with no references and no borrowed symbols, which is the honest result: the corpus has not
 * been shown code this request is about, and saying so is different from guessing.
 */
export function codeIntentFromDocumentation(input: {
  requestText: string;
  /** Documentation-corpus spans retrieved for this request, best first. */
  documentation: readonly EvidenceSpan[];
  /** Every symbol some code in play actually uses, so a request word is admitted only when it names something. */
  knownSymbols?: ReadonlySet<string>;
  /** Formal language the request already named, when it did. */
  languageId?: string;
  referenceLimit?: number;
  symbolLimit?: number;
}): CodeIntent {
  const referenceLimit = Math.max(1, Math.min(32, Math.floor(input.referenceLimit ?? REFERENCE_LIMIT)));
  const symbolLimit = Math.max(1, Math.min(128, Math.floor(input.symbolLimit ?? SYMBOL_LIMIT)));

  const references: CodeIntentReference[] = [];
  for (const span of input.documentation.slice(0, referenceLimit * 2)) {
    const relativePath = documentedPath(span);
    if (!relativePath) continue;
    if (references.some(reference => reference.relativePath === relativePath)) continue;
    const languageId = codeLanguageForPath(relativePath);
    references.push({
      relativePath,
      ...(languageId ? { languageId } : {}),
      score: Number.isFinite(span.alpha) ? span.alpha : 0
    });
    if (references.length >= referenceLimit) break;
  }

  // A request's own words are names only where code uses them as names; the documentation's are already about
  // code, so its identifiers are admitted on the evidence of having been written next to it.
  const requested = codeIdentifierTokens(codeSurfaceTokens(input.requestText), symbolLimit * 2);
  const known = input.knownSymbols;
  const symbols: string[] = [];
  const admit = (symbol: string): void => {
    if (!symbol || symbols.includes(symbol) || symbols.length >= symbolLimit) return;
    symbols.push(symbol);
  };
  for (const symbol of requested) if (!known || known.has(symbol)) admit(symbol);
  for (const span of input.documentation.slice(0, referenceLimit)) {
    for (const symbol of codeIdentifierTokens(codeSurfaceTokens(span.text || span.textPreview || ""), symbolLimit)) {
      if (known && !known.has(symbol)) continue;
      admit(symbol);
    }
  }

  const languageId = input.languageId ?? dominantLanguage(references);
  return {
    ...(languageId ? { languageId } : {}),
    symbols,
    references,
    audit: toJsonValue({
      source: "code-intent.codeIntentFromDocumentation",
      documentationSpans: input.documentation.length,
      references: references.length,
      requestedSymbols: requested.length,
      admittedSymbols: symbols.length,
      languageId: languageId ?? null
    })
  };
}

/** The path a documentation surface was trained from, as the corpus lane recorded it. */
function documentedPath(span: EvidenceSpan): string | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = (provenance as Record<string, JsonValue>).relativePath;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The language most of the matched files are written in, when they agree enough to name one. */
function dominantLanguage(references: readonly CodeIntentReference[]): string | undefined {
  const counts = new Map<string, number>();
  for (const reference of references) {
    if (!reference.languageId) continue;
    counts.set(reference.languageId, (counts.get(reference.languageId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const best = ranked[0];
  return best && best[1] * 2 > references.length ? best[0] : undefined;
}
