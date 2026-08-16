import type { LexicalAlignmentRecord, MultilingualLanguageProfile, MultilingualTranslationPlan } from "./multilingual-translation.js";
import { buildTranslationPlan } from "./multilingual-translation.js";
import { factualRoundTripGate, type FactualRoundTripGateResult } from "./semantic-round-trip.js";
import type { Hasher } from "./types.js";

/**
 * Plan items 124-125: real translation-quality round-trip validation
 * specific to the translation path (`A -> Realize -> y -> Interpret ->
 * Ahat`, `d_G` distance) and a hard factual gate rejecting any
 * translation that introduces an atom absent from the source. Built
 * entirely on already-real, already-tested machinery, never
 * reimplemented here: `buildTranslationPlan`
 * (`multilingual-translation.ts`) performs the real Realize (A->y) step,
 * and -- driven by the same real lexical alignments, mechanically
 * reversed, never a separate heuristic -- the real Interpret (y->Ahat)
 * step; `factualRoundTripGate` (`semantic-round-trip.ts`, items 142-143)
 * performs the real `d_G` distance decomposition and the hard accept/
 * reject decision on `A` vs `Ahat`.
 */

/** A mechanical reversal (source<->target swapped throughout), not a separate alignment heuristic -- the same real lexical pairs used in the opposite direction. */
export function reverseLexicalAlignment(record: LexicalAlignmentRecord): LexicalAlignmentRecord {
  return {
    ...record,
    id: `${record.id}:reversed`,
    sourceText: record.targetText,
    targetText: record.sourceText,
    sourceProfileId: record.targetProfileId,
    targetProfileId: record.sourceProfileId,
    lexicalPairs: record.lexicalPairs.map(pair => ({ source: pair.target, target: pair.source, score: pair.score }))
  };
}

export interface TranslationRoundTripValidation {
  sourceText: string;
  targetText: string;
  backTranslatedText: string;
  forwardPlan: MultilingualTranslationPlan;
  interpretedPlan: MultilingualTranslationPlan;
  gate: FactualRoundTripGateResult;
}

/**
 * Runs the real, complete translation round trip and applies the real
 * hard factual gate to it. `accepted === false` on
 * `.gate` means this translation must be rejected outright (item 125),
 * not softened into a lower confidence score. `.gate.cycleTrace.distance`
 * carries the full real `d_G` decomposition (item 124) for any caller
 * that needs more than the accept/reject boolean.
 */
export function validateTranslationRoundTrip(input: {
  sourceText: string;
  sourceProfile: MultilingualLanguageProfile;
  targetProfile: MultilingualLanguageProfile;
  lexicalAlignments: readonly LexicalAlignmentRecord[];
  hasher?: Hasher;
}): TranslationRoundTripValidation {
  const forwardPlan = buildTranslationPlan(input.sourceText, input.sourceProfile, input.targetProfile, [...input.lexicalAlignments]);
  const reverseAlignments = input.lexicalAlignments.map(reverseLexicalAlignment);
  const interpretedPlan = buildTranslationPlan(forwardPlan.targetText, input.targetProfile, input.sourceProfile, reverseAlignments);
  const gate = factualRoundTripGate({
    intendedText: input.sourceText,
    realizedText: interpretedPlan.targetText,
    ...(input.hasher ? { hasher: input.hasher } : {})
  });
  return {
    sourceText: input.sourceText,
    targetText: forwardPlan.targetText,
    backTranslatedText: interpretedPlan.targetText,
    forwardPlan,
    interpretedPlan,
    gate
  };
}
