// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { languageStructuralDeltasFromPatterns } from "../language-state-delta.js";
import type { LanguagePatternRecord } from "../storage.js";
import type { EvidenceId } from "../types.js";

function learnedInterpretationPattern(): LanguagePatternRecord {
  return {
    id: "pattern.interpretation.1",
    profileId: "profile.fixture",
    patternKind: "discourse",
    support: 0.92,
    entropy: 0.1,
    patternJson: {
      schema: "scce.language_state_delta.v1",
      structuralDelta: {
        kind: "interpretation",
        surface: { from: "source", to: "preferred form" },
        grammatical: { fromRoleId: "role.ambiguous", toRoleId: "role.selected" },
        semantic: { fromRoleId: "sense.prior", toRoleId: "sense.learned" }
      }
    },
    evidenceIds: ["evidence.fixture" as unknown as EvidenceId],
    updatedAt: 1
  };
}

describe("durable language structural deltas", () => {
  it("changes production realization after a cold restart using persisted typed state", () => {
    const candidates = [
      { text: "generic", fit: 0.5 },
      { text: "preferred form", fit: 0.5 }
    ];
    const coldRuntime = createLanguageMemoryRuntime();
    const cold = coldRuntime.realize({
      state: coldRuntime.hydrate({ models: [], patterns: [] }),
      requestText: "source",
      candidates
    });
    expect(cold.text).toBe("generic");

    // A new runtime instance represents a process restart. The only signal
    // that changes the choice is the durable learner pattern hydrated below.
    const restartedRuntime = createLanguageMemoryRuntime();
    const restartedState = restartedRuntime.hydrate({
      models: [],
      patterns: [learnedInterpretationPattern()]
    });
    expect(restartedState.structuralDeltas).toHaveLength(1);
    const learned = restartedRuntime.realize({
      state: restartedState,
      requestText: "source",
      candidates
    });
    expect(learned.text).toBe("preferred form");
    expect(learned.audit).toMatchObject({
      structuralDeltaFit: 0.92,
      structuralDeltaIdsUsed: ["pattern.interpretation.1:structural-delta"]
    });

    // `generate()` is the production-called interpretation/realization seam
    // used by Mouth. The same hydrated state must influence it, rather than
    // only the lower-level realization helper.
    const generated = restartedRuntime.generate({
      state: restartedState,
      contextSymbols: ["source"],
      requiredTerms: [{ id: "term.preferred", text: "preferred form", weight: 0.5 }],
      generationExtent: 16
    });
    expect(generated.text).toContain("preferred form");
    expect(JSON.stringify(generated.audit)).toContain("structuralDeltaFit");
  });

  it("keeps structural morphology deltas typed and evidence-bound", () => {
    const [delta] = languageStructuralDeltasFromPatterns([{
      ...learnedInterpretationPattern(),
      id: "pattern.morphology.1",
      patternKind: "morphology",
      patternJson: {
        schema: "scce.language_state_delta.v1",
        structuralDelta: {
          kind: "morphology",
          surface: { from: "stem", to: "derived form" },
          grammatical: { toRoleId: "role.inflected" },
          semantic: { toRoleId: "sense.derived" }
        }
      }
    }]);
    expect(delta).toMatchObject({
      kind: "morphology",
      surface: { from: "stem", to: "derived form" },
      grammatical: { toRoleId: "role.inflected" },
      semantic: { toRoleId: "sense.derived" },
      evidenceIds: ["evidence.fixture"]
    });
  });

  it("hydrates deltas from the morphology records emitted by production induction", () => {
    const pattern: LanguagePatternRecord = {
      id: "pattern.induced.morphology.1",
      profileId: "profile.fixture",
      patternKind: "morphology",
      support: 0.9,
      entropy: 0.1,
      patternJson: {
        schema: "scce.induced_language_model.morphology_memory.v1",
        rules: [{
          id: "morph.rule.1",
          kind: "suffix",
          pattern: "STEM+¤",
          stemCount: 3,
          symbolCount: 6,
          productivity: 0.8,
          examples: ["mira¤", "tavo¤", "senu¤"]
        }],
        classBindings: [{
          id: "morph.binding.1",
          ruleId: "morph.rule.1",
          lexicalClassId: "lexical.class.1",
          stemOverlap: 3,
          ruleCoverage: 1,
          classCoverage: 1,
          confidence: 1
        }]
      },
      evidenceIds: ["evidence.induced" as unknown as EvidenceId],
      updatedAt: 2
    };
    const deltas = languageStructuralDeltasFromPatterns([pattern]);
    expect(deltas).toHaveLength(3);
    expect(deltas[0]).toMatchObject({
      kind: "morphology",
      grammatical: { ruleId: "morph.rule.1", lexicalClassId: "lexical.class.1" },
      evidenceIds: ["evidence.induced"]
    });
    expect(deltas[0]?.support).toBeCloseTo(0.72);
    expect(deltas.map(delta => delta.surface)).toContainEqual({ from: "mira", to: "mira¤" });

    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrate({ models: [], patterns: [pattern] });
    expect(state.structuralDeltas?.map(delta => delta.id)).toEqual(deltas.map(delta => delta.id));
  });

  it("rejects a sentence-shaped construction delta without its typed construction scope", () => {
    const [delta] = languageStructuralDeltasFromPatterns([{
      ...learnedInterpretationPattern(),
      id: "pattern.unscoped.construction",
      patternKind: "syntax",
      patternJson: {
        schema: "scce.language_state_delta.v1",
        structuralDelta: {
          kind: "construction",
          surface: { from: "q8 rel 99 z8.", to: "q8 rel 4 z8." }
        }
      }
    }]);
    expect(delta).toBeUndefined();
  });
});
