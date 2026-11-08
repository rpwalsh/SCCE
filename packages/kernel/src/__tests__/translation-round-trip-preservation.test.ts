// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticAtom } from "../semantic-proof-types.js";
import type { MultilingualLanguageProfile, MultilingualTranslationPlan } from "../multilingual-translation.js";
import { validateTranslationRoundTrip } from "../translation-round-trip-gate.js";

// Boundary tests: execute the real translation wrapper AND factual acceptance
// gate with controlled interpretation/planning outputs. These are not tests of
// natural-language parsing or translation quality; the existing translation
// suite and semantic-round-trip-soundness.test.ts exercise the real components.
const state = vi.hoisted(() => ({
  atoms: new Map<string, SemanticAtom[]>(),
  targets: new Map<string, string>(),
  plannedTexts: [] as string[]
}));
vi.mock("../semantic-proof-system.js", () => ({
  atomizeText: ({ text }: { text: string }) => {
    const atoms = state.atoms.get(text);
    if (!atoms) throw new Error(`missing explicit interpretation fixture: ${text}`);
    return atoms;
  }
}));
vi.mock("../multilingual-translation.js", () => ({
  buildTranslationPlan: (text: string) => {
    state.plannedTexts.push(text);
    const targetText = state.targets.get(text);
    if (targetText === undefined) throw new Error(`missing explicit translation fixture: ${text}`);
    return { targetText } as MultilingualTranslationPlan;
  }
}));
afterEach(() => { state.atoms.clear(); state.targets.clear(); state.plannedTexts.length = 0; });

function fact(id: string, subject: string): SemanticAtom {
  return {
    id, predicate: "ships", predicateFeatures: [],
    roles: [
      { name: "arg0", value: subject, normalized: subject, type: "entity", features: [], weight: 1 },
      { name: "arg1", value: "crates", normalized: "crates", type: "entity", features: [], weight: 1 }
    ],
    constraints: [], polarity: 1, alpha: 0.5, modality: "fixture.asserted",
    source: "fixture", sourceText: `${subject} ships crates.`,
    evidenceIds: [], nodeIds: [], vector: [], proofClass: "", certifiesFactualProof: false
  };
}

function validate(realized: SemanticAtom[], realizedTargetText?: string) {
  state.atoms.set("source.input", [fact("a", "alice"), fact("b", "bob")]);
  state.atoms.set("source.back", realized);
  state.targets.set("source.input", "target.generated");
  state.targets.set(realizedTargetText ?? "target.generated", "source.back");
  return validateTranslationRoundTrip({
    sourceText: "source.input",
    sourceProfile: { id: "source.profile" } as MultilingualLanguageProfile,
    targetProfile: { id: "target.profile" } as MultilingualLanguageProfile,
    lexicalAlignments: [],
    ...(realizedTargetText !== undefined ? { realizedTargetText } : {})
  });
}

describe("translation requires the complete represented source meaning", () => {
  it("rejects an otherwise faithful translation that drops one fact", () => {
    const result = validate([fact("a.realized", "alice")]);
    expect(result.gate.cycleTrace.distance.added).toHaveLength(0);
    expect(result.gate.cycleTrace.distance.missing).toHaveLength(1);
    expect(result.gate.accepted).toBe(false);
    expect(result.gate.reason).toMatch(/omits 1 required atom/);
  });

  it("accepts both represented facts even when their order changes", () => {
    const result = validate([fact("b.realized", "bob"), fact("a.realized", "alice")]);
    expect(result.gate.accepted).toBe(true);
    expect(result.targetText).toBe("target.generated");
    expect(result.backTranslatedText).toBe("source.back");
  });

  it("checks another lane's supplied output for completeness as well", () => {
    const result = validate([fact("a.realized", "alice")], "target.other-lane");
    expect(result.targetText).toBe("target.other-lane");
    expect(state.plannedTexts).toEqual(["source.input", "target.other-lane"]);
    expect(result.gate.accepted).toBe(false);
    expect(result.gate.reason).toMatch(/omits 1 required atom/);
  });

  it("does not let complete fact count excuse altered meaning", () => {
    const result = validate([{ ...fact("a.realized", "alice"), polarity: -1 }, fact("b.realized", "bob")]);
    expect(result.gate.accepted).toBe(false);
    expect(result.gate.cycleTrace.distance.polarityMismatches).toHaveLength(1);
  });

  it("rejects a translation with no interpreted claims", () => {
    expect(validate([]).gate.accepted).toBe(false);
  });
});
