import { describe, expect, it } from "vitest";
import {
  languageGenerationDiscourseCoversRequiredContent,
  type LanguageDiscourseTrace,
  type LanguageGenerationAtom,
  type LanguageGenerationTerm
} from "../language-memory-runtime.js";

// Plan items 140-141. Kneser-Ney's own statistical seed selection
// (language-memory-runtime.ts's learnedContinuationDiscourse) can drive
// the actual content of a fallback discourse continuation, not just rank
// among already-licensed derivations -- item 140's real, confirmed
// violation, found by tracing the fallback-acceptance path in
// generateFromLanguageMemory. Before this pass's fix, the fallback was
// accepted purely on languageGenerationSurfaceAdequate's fluency check
// (length, lexical diversity, repetition, fragment-heaviness), with zero
// awareness of the caller's real requiredTerms/frameAtoms -- a fluent but
// factually empty continuation could replace a real, evidence-grounded
// one. This file proves the new gate this pass added
// (languageGenerationDiscourseCoversRequiredContent, now required
// alongside the fluency check before the fallback is ever accepted) --
// the concrete guarantee item 141 asks for: continuation memory cannot
// stand in as though it had introduced/proven a required entity/
// relation/number/date/claim it never actually covered.

function trace(overrides: Partial<Pick<LanguageDiscourseTrace, "requiredTermIdsCovered" | "propositionAtomIdsCovered">>): LanguageDiscourseTrace {
  return {
    text: "fixture discourse text",
    moves: [],
    boundaries: [],
    steps: [],
    generationStepCount: 1,
    stopReason: "source_exhausted",
    requiredTermIdsCovered: [],
    propositionAtomIdsCovered: [],
    scoreOrderTextHash: "hash.fixture",
    anchorCoverage: 1,
    cohesion: 0.8,
    repetitionPenalty: 0.1,
    discourseScore: 0.8,
    fluency: {
      beamWidth: 1,
      beamExpansions: 1,
      candidateMoveCount: 1,
      selectedBeamScore: 0.8,
      selectedUnitIds: [],
      latentCoherence: 0.8,
      ngramMeanActivation: 0.8,
      priorSupport: 0.8,
      coverageGain: 0.8,
      repetitionPenalty: 0.1,
      symbolCount: 6
    },
    ...overrides
  };
}

function term(id: string, weight = 0.9): LanguageGenerationTerm {
  return { id, text: id, weight };
}

function atom(id: string): LanguageGenerationAtom {
  return { id, text: id };
}

describe("languageGenerationDiscourseCoversRequiredContent (plan items 140-141)", () => {
  it("with no required terms or frame atoms, any discourse trivially satisfies coverage -- nothing was required, so nothing needs to be checked", () => {
    expect(languageGenerationDiscourseCoversRequiredContent(trace({}), [], [])).toBe(true);
  });

  it("rejects a fluent-looking discourse that covers zero of the real required terms -- the exact case a Kneser-Ney fallback that never actually mentioned the required content must fail", () => {
    const requiredTerms = [term("term.subject"), term("term.object")];
    const uncoveredDiscourse = trace({ requiredTermIdsCovered: [] });
    expect(languageGenerationDiscourseCoversRequiredContent(uncoveredDiscourse, requiredTerms, [])).toBe(false);
  });

  it("accepts a discourse that genuinely covers every real required term", () => {
    const requiredTerms = [term("term.subject"), term("term.object")];
    const coveredDiscourse = trace({ requiredTermIdsCovered: ["term.subject", "term.object"] });
    expect(languageGenerationDiscourseCoversRequiredContent(coveredDiscourse, requiredTerms, [])).toBe(true);
  });

  it("low-weight required terms (below the real 0.45 significance floor) do not force coverage -- only genuinely significant terms count toward the denominator", () => {
    const requiredTerms = [term("term.trivial", 0.1)];
    expect(languageGenerationDiscourseCoversRequiredContent(trace({ requiredTermIdsCovered: [] }), requiredTerms, [])).toBe(true);
  });

  it("requires at least half of real frame atoms to be covered, matching the same threshold the primary evidence-grounded beam-search path already holds itself to", () => {
    const frameAtoms = [atom("atom.1"), atom("atom.2"), atom("atom.3"), atom("atom.4")];
    const underThreshold = trace({ propositionAtomIdsCovered: ["atom.1"] }); // 1/4 < ceil(4*0.5)=2
    const atThreshold = trace({ propositionAtomIdsCovered: ["atom.1", "atom.2"] }); // 2/4 == 2
    expect(languageGenerationDiscourseCoversRequiredContent(underThreshold, [], frameAtoms)).toBe(false);
    expect(languageGenerationDiscourseCoversRequiredContent(atThreshold, [], frameAtoms)).toBe(true);
  });

  it("requires both required-term and frame-atom coverage together -- satisfying only one is not enough", () => {
    const requiredTerms = [term("term.subject")];
    const frameAtoms = [atom("atom.1"), atom("atom.2")];
    const onlyTermsCovered = trace({ requiredTermIdsCovered: ["term.subject"], propositionAtomIdsCovered: [] });
    const onlyAtomsCovered = trace({ requiredTermIdsCovered: [], propositionAtomIdsCovered: ["atom.1", "atom.2"] });
    const bothCovered = trace({ requiredTermIdsCovered: ["term.subject"], propositionAtomIdsCovered: ["atom.1"] }); // 1/2 meets ceil(2*0.5)=1
    expect(languageGenerationDiscourseCoversRequiredContent(onlyTermsCovered, requiredTerms, frameAtoms)).toBe(false);
    expect(languageGenerationDiscourseCoversRequiredContent(onlyAtomsCovered, requiredTerms, frameAtoms)).toBe(false);
    expect(languageGenerationDiscourseCoversRequiredContent(bothCovered, requiredTerms, frameAtoms)).toBe(true);
  });
});
