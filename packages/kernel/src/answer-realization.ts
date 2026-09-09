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

export interface RealizationAttempt {
  accepted: boolean;
  surface?: RealizedConstructSurface;
  /** Why generation was rejected, even when a candidate was not returned -- the doctrine-required
   *  observability: a caller falling back to source-exact text should be able to say WHY, not just that it did. */
  diagnostic: JsonValue;
}

/**
 * The single choke point every verbatim-fallback answer producer should call before reaching for quoted
 * evidence text: attempts REAL generation from the corpus's own trained language model (the sanctioned
 * `generate()` in language-memory-runtime -- Kneser-Ney + construction algebra + rhetorical lattice, never a
 * neural model), seeded by the contract's bound subject/relation/value rather than loose prompting, and
 * accepts the result only if it survives `candidateSurvivesRealizationContract` (no fabrication, no missing
 * answerhood). `accepted: false` rather than a degraded substitute when generation fails the contract -- the
 * caller decides fallback policy; this function never silently quotes evidence as a consolation prize. The
 * diagnostic is returned on every outcome, accepted or not, so a fallback to source-exact text is traceable
 * to a real reason instead of being indistinguishable from a normal answer.
 */
export function attemptConstructRealization(
  contract: SemanticRealizationContract,
  opts: {
    languageMemory: LanguageMemoryRuntime;
    state: LanguageMemoryRuntimeState;
    languageProfile?: LanguageProfile;
    hasher?: Hasher;
    generationExtent?: number;
  }
): RealizationAttempt {
  const fact = contract.sourceFact;
  // Seeded the same way mouth.ts's own working call (rhetoricalLatticeCandidateFromFrames) seeds it: ONE
  // coherent claim string as the primary context symbol, not a bag of disconnected words -- measured live,
  // three loose words ("Albert Einstein", "born", "14 March 1879") gave the model nothing to continue from
  // and it echoed the subject then stopped (source_exhausted) after producing two words. requiredTerms left
  // empty to match; it does not carry the fact's meaning into generation the way a real claim sentence does.
  const claimText = [fact.subject, fact.predicate, fact.object].filter(Boolean).join(" ");
  const generation = opts.languageMemory.generate({
    state: opts.state,
    targetLanguageProfile: opts.languageProfile,
    contextSymbols: [claimText].filter(Boolean),
    requiredTerms: [],
    semanticFrameIds: opts.state.importedSemanticFrames.map(frame => frame.id).slice(0, 64),
    generationExtent: opts.generationExtent ?? 96
  });
  const text = ensureSurfaceSentence(generation.text.trim());
  if (!text) {
    return {
      accepted: false,
      diagnostic: toJsonValue({
        schema: "scce.answer_realization.v1",
        rejected: "empty_generation",
        generationStoppedBy: generation.stoppedBy,
        generationConfidence: generation.confidence
      })
    };
  }
  const survival = candidateSurvivesRealizationContract(text, contract, opts.hasher);
  const diagnostic = toJsonValue({
    schema: "scce.answer_realization.v1",
    rejected: survival.survives ? null : survival.reason ?? "contract_failed",
    generatedText: text,
    requiredAtomCount: survival.requiredAtomCount,
    addedUnsupportedAtomCount: survival.addedUnsupportedAtomCount,
    requiredRelationUnitCount: survival.requiredRelationUnitCount,
    missingRelationUnitCount: survival.missingRelationUnitCount,
    requestedSlotSatisfied: survival.requestedSlotSatisfied,
    requestedSlotId: contract.requestedSlotId ?? null,
    generationConfidence: generation.confidence,
    generationStoppedBy: generation.stoppedBy
  });
  if (!survival.survives) return { accepted: false, diagnostic };
  return {
    accepted: true,
    surface: { text, evidenceIds: contract.evidenceIds, realizationOrigin: "learned_generation", audit: diagnostic },
    diagnostic
  };
}
