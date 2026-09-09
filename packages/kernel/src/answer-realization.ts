// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Hasher, JsonValue, LanguageProfile } from "./types.js";
import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { candidateSurvivesRealizationContract, type SemanticRealizationContract } from "./semantic-answer-construct.js";
import { languageGenerationFramesFromContract } from "./semantic-realization-frames.js";
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
    /** Real, attested text this fact is already known to appear in (typically the source-exact sentence
     *  already extracted from evidence). Kneser-Ney continuation has no data to draw from for a synthetic
     *  fact triple that was never seen as a sequence anywhere in training -- measured live, it produced two
     *  words then stopped, then nothing at all, on two different synthetic seedings. Seeding from real
     *  attested text instead gives the model an actual linguistic neighborhood to riff from. */
    attestedSeedText?: string;
  }
): RealizationAttempt {
  const fact = contract.sourceFact;
  const claimText = opts.attestedSeedText?.trim() || [fact.subject, fact.predicate, fact.object].filter(Boolean).join(" ");
  const frames = languageGenerationFramesFromContract(contract, {
    ...(opts.languageProfile?.id ? { targetLanguage: opts.languageProfile.id } : {}),
    ...(opts.languageProfile?.scripts[0]?.script ? { targetScript: opts.languageProfile.scripts[0].script } : {})
  });
  const requiredTerms = frames.flatMap(frame => frame.requiredTerms ?? []);
  const generation = opts.languageMemory.generate({
    state: opts.state,
    targetLanguageProfile: opts.languageProfile,
    contextSymbols: [claimText].filter(Boolean),
    requiredTerms,
    frames,
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
        generationConfidence: generation.confidence,
        realizationFrameCount: frames.length,
        realizationFrameAtomCount: frames.reduce((sum, frame) => sum + (frame.propositionAtoms?.length ?? 0), 0)
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
    generationStoppedBy: generation.stoppedBy,
    realizationFrameCount: frames.length,
    realizationFrameAtomCount: frames.reduce((sum, frame) => sum + (frame.propositionAtoms?.length ?? 0), 0)
  });
  if (!survival.survives) return { accepted: false, diagnostic };
  return {
    accepted: true,
    surface: { text, evidenceIds: contract.evidenceIds, realizationOrigin: "learned_generation", audit: diagnostic },
    diagnostic
  };
}
