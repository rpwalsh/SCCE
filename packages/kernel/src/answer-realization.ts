// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Hasher, JsonValue, LanguageProfile } from "./types.js";
import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { candidateSurvivesRealizationContract, type SemanticRealizationContract } from "./semantic-answer-construct.js";
import { toJsonValue } from "./primitives.js";
import { ensureSurfaceSentence } from "./surface-linguistics.js";

export interface RealizedConstructSurface {
  text: string;
  evidenceIds: string[];
  realizationOrigin: "learned_generation";
  audit: JsonValue;
}

/**
 * The single choke point every verbatim-fallback answer producer should call before reaching for quoted
 * evidence text: attempts REAL generation from the corpus's own trained language model (the sanctioned
 * `generate()` in language-memory-runtime -- Kneser-Ney + construction algebra + rhetorical lattice, never a
 * neural model), seeded by the contract's bound subject/relation/value rather than loose prompting, and
 * accepts the result only if it survives `candidateSurvivesRealizationContract` (no fabrication, no missing
 * answerhood). Returns undefined rather than a degraded substitute when generation fails the contract --
 * the caller decides fallback policy; this function never silently quotes evidence as a consolation prize.
 */
export function realizeConstructSurface(
  contract: SemanticRealizationContract,
  opts: {
    languageMemory: LanguageMemoryRuntime;
    state: LanguageMemoryRuntimeState;
    languageProfile?: LanguageProfile;
    hasher?: Hasher;
    generationExtent?: number;
  }
): RealizedConstructSurface | undefined {
  const fact = contract.sourceFact;
  const requiredTerms = [fact.subject, ...contract.requiredRelationUnits, fact.object]
    .filter(Boolean)
    .map(text => ({ text }));
  const generation = opts.languageMemory.generate({
    state: opts.state,
    targetLanguageProfile: opts.languageProfile,
    contextSymbols: [fact.subject, fact.predicate, fact.object].filter(Boolean),
    requiredTerms,
    generationExtent: opts.generationExtent ?? 48
  });
  const text = ensureSurfaceSentence(generation.text.trim());
  if (!text) return undefined;
  const survival = candidateSurvivesRealizationContract(text, contract, opts.hasher);
  if (!survival.survives) return undefined;
  return {
    text,
    evidenceIds: contract.evidenceIds,
    realizationOrigin: "learned_generation",
    audit: toJsonValue({
      schema: "scce.answer_realization.v1",
      realizationOrigin: "learned_generation",
      requiredAtomCount: survival.requiredAtomCount,
      addedUnsupportedAtomCount: survival.addedUnsupportedAtomCount,
      requiredRelationUnitCount: survival.requiredRelationUnitCount,
      missingRelationUnitCount: survival.missingRelationUnitCount,
      requestedSlotSatisfied: survival.requestedSlotSatisfied,
      requestedSlotId: contract.requestedSlotId ?? null,
      generationConfidence: generation.confidence,
      generationStoppedBy: generation.stoppedBy
    })
  };
}
