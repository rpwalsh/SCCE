// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { splitSurfaceClauses } from "./surface-linguistics.js";

/**
 * What a request that quotes a sentence with a hole in it is actually asking for.
 *
 * A request can carry someone else's sentence minus a run of it. The near-duplicate path already establishes that
 * the two are the same sentence; the run the request does NOT carry is the hole, and it is recoverable as a
 * sequence difference, with no marker to look for and nothing assumed about any language: align the two token
 * sequences by longest common subsequence and take the longest maximal run of sentence tokens outside it.
 *
 * The answer today is the whole sentence, which is why a cloze answer contains the asked value rather than
 * stating it: measured on the frozen 311-row run, 71 of the 94 correct answers that bury the fact past their
 * opening are cloze.
 */

// Letter/number runs, with internal apostrophes and hyphens kept: the unit a sequence comparison is made of. It is
// the tokenization, not a word list -- no script is assumed and no class of word is named.
const TOKEN_PATTERN = /[\p{L}\p{N}\p{M}]+(?:['’‐-―-][\p{L}\p{N}\p{M}]+)*/gu;

interface SurfaceToken {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** The surface's tokens with their offsets, folded for comparison. Pure. */
function surfaceTokens(text: string): SurfaceToken[] {
  const out: SurfaceToken[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const value = match[0];
    const start = match.index ?? 0;
    out.push({ key: value.normalize("NFC").toLocaleLowerCase(), start, end: start + value.length });
  }
  return out;
}

/**
 * Which of `sentence`'s tokens also appear, in order, in `request`.
 *
 * Standard longest-common-subsequence over the two token key sequences. Both are one sentence's worth of tokens,
 * so the table is small; the cost bound below only exists so a pathological input cannot make it large.
 */
function matchedSentenceTokens(sentenceKeys: readonly string[], requestKeys: readonly string[]): boolean[] {
  const rows = sentenceKeys.length;
  const cols = requestKeys.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i]![j] = sentenceKeys[i] === requestKeys[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const matched = new Array<boolean>(rows).fill(false);
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (sentenceKeys[i] === requestKeys[j]) { matched[i] = true; i++; j++; continue; }
    if (table[i + 1]![j]! >= table[i]![j + 1]!) i++; else j++;
  }
  return matched;
}

/** Cost bound, not a modelling choice: tokens of either side entering the alignment table. */
const ALIGNMENT_TOKEN_BOUND = 400;

/**
 * The longest run of `sentence` that `requestText` does not carry, verbatim from the sentence, or "" when the two
 * do not stand in that relation.
 *
 * Returns "" rather than guessing when the hole is not smaller than what the request and the sentence share: that
 * is the case where the request is not quoting this sentence with a hole in it, whatever else it is doing, and the
 * caller should keep saying what it was going to say. Pure.
 */
export function quotedSentenceGap(sentence: string, requestText: string): string {
  const sentenceTokens = surfaceTokens(sentence).slice(0, ALIGNMENT_TOKEN_BOUND);
  if (sentenceTokens.length < 2) return "";
  const sentenceKeys = sentenceTokens.map(token => token.key);
  // Which part of the request is the quotation is itself decided by the alignment: of the parts a clause boundary
  // divides the request into, the quotation is the one that shares the most of this sentence, and a request that
  // divides into one part is compared whole. Nothing here reads the frame, the boundary symbol, or any word.
  const candidates = [requestText, ...splitSurfaceClauses(requestText)];
  let requestTokens: SurfaceToken[] = [];
  let matched: boolean[] = [];
  let bestShared = -1;
  for (const candidate of candidates) {
    const tokens = surfaceTokens(candidate).slice(0, ALIGNMENT_TOKEN_BOUND);
    if (tokens.length < 2) continue;
    const aligned = matchedSentenceTokens(sentenceKeys, tokens.map(token => token.key));
    const shared = aligned.filter(Boolean).length;
    // A shorter part that accounts for the same sentence tokens is the quotation; the longer one is it plus a frame.
    if (shared > bestShared || (shared === bestShared && tokens.length < requestTokens.length)) {
      bestShared = shared;
      requestTokens = tokens;
      matched = aligned;
    }
  }
  if (!requestTokens.length) return "";
  const matchedCount = matched.filter(Boolean).length;
  let best: { from: number; to: number } | undefined;
  let tiedAtBest = 0;
  let runStart = -1;
  for (let index = 0; index <= sentenceTokens.length; index++) {
    const inRun = index < sentenceTokens.length && !matched[index];
    if (inRun && runStart < 0) runStart = index;
    if (!inRun && runStart >= 0) {
      const length = index - runStart;
      const bestLength = best ? best.to - best.from : 0;
      if (!best || length > bestLength) { best = { from: runStart, to: index }; tiedAtBest = 1; }
      else if (length === bestLength) tiedAtBest++;
      runStart = -1;
    }
  }
  // Several runs of the same length: which one is the hole is undecided, so say nothing rather than guess.
  if (!best || tiedAtBest > 1) return "";
  const gapLength = best.to - best.from;
  // The sentence is the quotation with exactly ONE hole in it, and nothing else: every token outside this run is
  // accounted for by the request. Anything less is a sentence that merely resembles the request, and the run taken
  // out of it is not what was asked for.
  if (matchedCount + gapLength !== sentenceTokens.length) return "";
  // The hole is smaller than the quotation around it; when it is not, this is not a quotation with a hole.
  if (gapLength >= matchedCount) return "";
  const from = sentenceTokens[best.from]!.start;
  const to = sentenceTokens[best.to - 1]!.end;
  return sentence.slice(from, to);
}
