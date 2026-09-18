// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Keeping what the eye learned about a script, in the store that already holds exactly this: a source symbol, a
// target symbol, a score, and a basis of "shape". A learned sign IS a translation seed whose source symbol is
// the shape itself, so nothing new has to be added to the schema and nothing about the page it was read from is
// kept -- the page is not what recurs.
//
// Recall is deliberately NOT filtered by the script's name. A page arriving at the eye does not announce what
// script it is in, so everything remembered for the target language is offered and the page's own measured
// same-sign scale decides what matches (see `recallSigns`). The script id is carried for inspectability and for
// a caller that does know, never as the thing that gates a match.

import {
  decodeExemplar,
  encodeExemplar,
  type EvidenceId,
  type LearnedSign,
  type ScriptMemory,
  type TranslationSeed
} from "@scce/kernel";

/** The minimum storage surface this needs; the real PostgreSQL adapter satisfies it, and tests fake it. */
export interface VisualScriptMemoryStorage {
  translationSeeds: {
    putSeeds(input: {
      sourceLanguage: string;
      targetLanguage: string;
      seeds: readonly TranslationSeed[];
      observedAt: number;
    }): Promise<void>;
    listSeeds(targetLanguage: string, limit?: number): Promise<TranslationSeed[]>;
  };
}

// The exemplar encoding uses only digits, "x", ":" and ".", so "@" cannot occur inside it. The script id comes
// last and may contain anything, including "@": the split is at the FIRST one.
const KIND = "visual-sign:";
const SEPARATOR = "@";

function encodeSource(memory: Pick<ScriptMemory, "scriptId">, sign: LearnedSign): string {
  return `${KIND}${encodeExemplar(sign.exemplar)}${SEPARATOR}${memory.scriptId}`;
}

interface DecodedSource {
  readonly scriptId: string;
  readonly sign: LearnedSign;
}

/** Returns nothing rather than a guess for any seed that is not a learned sign. */
function decodeSource(seed: TranslationSeed): DecodedSource | undefined {
  if (seed.basis !== "shape" || !seed.sourceSymbol.startsWith(KIND)) return undefined;
  const body = seed.sourceSymbol.slice(KIND.length);
  const split = body.indexOf(SEPARATOR);
  if (split <= 0 || split === body.length - 1) return undefined;
  const exemplar = decodeExemplar(body.slice(0, split));
  if (!exemplar) return undefined;
  return {
    scriptId: body.slice(split + 1),
    sign: { exemplar, symbol: seed.targetSymbol, score: seed.score }
  };
}

/**
 * Keep what one reading learned. The store raises a held score and never lowers it, so a weaker later reading
 * of the same shape cannot undo a stronger earlier one. Returns how many signs were offered.
 */
export async function rememberScript(
  storage: VisualScriptMemoryStorage,
  memory: ScriptMemory,
  input: { readonly observedAt: number; readonly evidenceIds?: readonly EvidenceId[] } = { observedAt: Date.now() }
): Promise<number> {
  const seeds: TranslationSeed[] = [];
  for (const sign of memory.signs) {
    if (!sign.symbol.length || !Number.isFinite(sign.score)) continue;
    seeds.push({
      sourceSymbol: encodeSource(memory, sign),
      targetSymbol: sign.symbol,
      score: sign.score,
      basis: "shape",
      evidenceIds: [...(input.evidenceIds ?? [])]
    });
  }
  if (!seeds.length) return 0;
  await storage.translationSeeds.putSeeds({
    sourceLanguage: memory.scriptId,
    targetLanguage: memory.targetLanguage,
    seeds,
    observedAt: input.observedAt
  });
  return seeds.length;
}

/**
 * Every sign the eye has read before for this target language, best-supported first. A `scriptId` narrows it for
 * a caller that already knows which script the page is in; without one, every remembered script is offered and
 * shape decides.
 */
export async function recallScript(
  storage: VisualScriptMemoryStorage,
  targetLanguage: string,
  options: { readonly scriptId?: string; readonly limit?: number } = {}
): Promise<LearnedSign[]> {
  const seeds = await storage.translationSeeds.listSeeds(targetLanguage, options.limit);
  const learned: LearnedSign[] = [];
  for (const seed of seeds) {
    const decoded = decodeSource(seed);
    if (!decoded) continue;
    if (options.scriptId !== undefined && decoded.scriptId !== options.scriptId) continue;
    learned.push(decoded.sign);
  }
  return learned;
}
