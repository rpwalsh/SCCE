// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { trainKneserNey } from "../kneser-ney.js";
import { clearFreeFormLexicon, freeFormLexicon, freeFormLexiconGeneration, primeFreeFormLexicon, residentLanguageModels } from "../free-form-lexicon.js";
import { learnedAnswerUnitFormVerdict, learnedAnswerUnitFormsGeneration, learnedAnswerUnitSharedBaseWitnesses, primeLearnedAnswerUnitForms } from "../learned-answer-unit-forms.js";
import { withRequestLanguageFormScope } from "../request-language-form-scope.js";
import { sourceOwnedAnswerUnitForms } from "./fixtures/source-owned-answer-unit-forms.js";
import type { KneserNeyModel } from "../kneser-ney.js";
import type { LanguageStructuralDelta } from "../language-state-delta.js";

afterEach(() => {
  clearFreeFormLexicon();
  primeLearnedAnswerUnitForms({ deltas: [], profileIds: new Set() });
});

describe("request language form scope", () => {
  it("isolates overlapping owners' model and morphology witnesses across awaits", async () => {
    const modelA = ownerModel("owneralpha") as KneserNeyModel;
    const modelB = ownerModel("ownerbeta") as KneserNeyModel;
    const witnessA = learnedDelta("owner.a", "walla", "wallawalla");
    const witnessB = learnedDelta("owner.b", "sira", "sirasira");
    primeFreeFormLexicon([modelA]);
    primeLearnedAnswerUnitForms({ deltas: [witnessA], profileIds: new Set(["owner.a"]) });
    let ready = 0;
    let resolveReady!: () => void;
    const bothReady = new Promise<void>(resolve => { resolveReady = resolve; });
    let release!: () => void;
    const resume = new Promise<void>(resolve => { release = resolve; });

    const run = (owner: "a" | "b", model: KneserNeyModel, delta: LanguageStructuralDelta) => withRequestLanguageFormScope(async () => {
      const profileId = `owner.${owner}`;
      primeFreeFormLexicon([model]);
      primeLearnedAnswerUnitForms({ deltas: [delta], profileIds: new Set([profileId]) });
      expect(residentLanguageModels().map(item => item.sourceKey)).toEqual([profileId]);
      expect(freeFormLexicon()?.measure(owner === "a" ? "owneralpha" : "ownerbeta")).toBeDefined();
      const generation = learnedAnswerUnitFormsGeneration();
      expect(freeFormLexiconGeneration()).toBe(generation);
      ready++;
      if (ready === 2) resolveReady();
      await resume;
      expect(learnedAnswerUnitFormVerdict("walla", "wallawalla").status).toBe(owner === "a" ? "same" : "unresolved");
      expect(learnedAnswerUnitFormVerdict("sira", "sirasira").status).toBe(owner === "b" ? "same" : "unresolved");
      expect(freeFormLexicon()?.measure(owner === "a" ? "owneralpha" : "ownerbeta")).toBeDefined();
      expect(freeFormLexicon()?.measure(owner === "a" ? "ownerbeta" : "owneralpha")).toBeUndefined();
    });

    const ownerA = run("a", modelA, witnessA);
    const ownerB = run("b", modelB, witnessB);
    await bothReady;
    release();
    await Promise.all([ownerA, ownerB]);
    await withRequestLanguageFormScope(async () => {
      expect(learnedAnswerUnitFormVerdict("walla", "wallawalla").status).toBe("unresolved");
      expect(learnedAnswerUnitFormVerdict("sira", "sirasira").status).toBe("unresolved");
      expect(residentLanguageModels()).toEqual([]);
      expect(freeFormLexicon()).toBeUndefined();
    });
  });

  it("restores a parent's snapshot after a nested scope rejects", async () => {
    await withRequestLanguageFormScope(async () => {
      primeLearnedAnswerUnitForms({ deltas: [learnedDelta("owner.a", "walla", "wallawalla")], profileIds: new Set(["owner.a"]) });
      await expect(withRequestLanguageFormScope(async () => {
        primeLearnedAnswerUnitForms({ deltas: [learnedDelta("owner.b", "sira", "sirasira")], profileIds: new Set(["owner.b"]) });
        expect(learnedAnswerUnitFormVerdict("sira", "sirasira").status).toBe("same");
        throw new Error("turn failed");
      })).rejects.toThrow("turn failed");
      expect(learnedAnswerUnitFormVerdict("walla", "wallawalla").status).toBe("same");
      expect(learnedAnswerUnitFormVerdict("sira", "sirasira").status).toBe("unresolved");
    });
    expect(learnedAnswerUnitFormVerdict("walla", "wallawalla").status).toBe("unresolved");
  });

  it("requires two forward derivations from one attested base in the same profile", async () => {
    await withRequestLanguageFormScope(async () => {
      const deltas = [
        learnedDelta("owner.a", "and", "command"),
        learnedDelta("owner.a", "command", "commanded"),
        learnedDelta("owner.a", "command", "commander"),
        learnedDelta("owner.b", "rootword", "command"),
        learnedDelta("owner.b", "command", "commanded"),
        learnedDelta("owner.b", "rootword", "plux"),
        learnedDelta("owner.b", "plux", "pluxity"),
        learnedDelta("owner.c", "rootword", "command"),
        learnedDelta("owner.c", "command", "commander"),
        learnedDelta("owner.c", "rootword", "plux"),
        learnedDelta("owner.c", "plux", "pluxer")
      ];
      primeLearnedAnswerUnitForms({ deltas, profileIds: new Set(["owner.a", "owner.b", "owner.c"]) });
      expect(learnedAnswerUnitSharedBaseWitnesses("commanded", "commander")).toHaveLength(1);
      expect(learnedAnswerUnitSharedBaseWitnesses("and", "commanded")).toEqual([]);
      expect(learnedAnswerUnitSharedBaseWitnesses("pluxity", "pluxer")).toEqual([]);
    });
  });

  it("accepts a bound stem only when source-induced rule pairs recur on another stem", async () => {
    const teaching = sourceOwnedAnswerUnitForms("contribute contributions operate operations rotate rotations expectation expectations.");
    await withRequestLanguageFormScope(async () => {
      teaching.prime();
      const witnesses = learnedAnswerUnitSharedBaseWitnesses("contribute", "contributions");
      expect(witnesses.length).toBeGreaterThan(0);
      expect(witnesses[0]?.basis).toBe("parallel-paradigm");
      expect(witnesses[0]?.corroborating?.base).not.toBe(witnesses[0]?.base);
      expect(witnesses[0]?.corroborating?.left.evidenceIds.length).toBeGreaterThan(0);
      expect(witnesses[0]?.corroborating?.right.evidenceIds.length).toBeGreaterThan(0);
      expect(teaching.state.structuralDeltas?.some(delta => delta.kind === "morphology"
        && delta.surface.from === "operat" && delta.surface.to === "operations")).toBe(true);
      expect(learnedAnswerUnitSharedBaseWitnesses("unobservedbase", "unobservedsurface")).toEqual([]);
    });
  });

  it("does not transfer a lone or cross-profile bound family by an unrelated rule pair", async () => {
    await withRequestLanguageFormScope(async () => {
      const deltas = [
        learnedDelta("owner.a", "corpusroot", "corroborator", "rule.root"),
        learnedDelta("owner.a", "corroborator", "corroboratedleft", "rule.left"),
        learnedDelta("owner.a", "corroborator", "corroboratedright", "rule.right"),
        learnedDelta("owner.a", "shadow", "shadowleft", "rule.left"),
        learnedDelta("owner.a", "shadow", "shadowright", "rule.right"),
        learnedDelta("owner.a", "lonely", "lonelyleft", "rule.lone.left"),
        learnedDelta("owner.a", "lonely", "lonelyright", "rule.lone.right"),
        learnedDelta("owner.a", "splitshadow", "splitleft", "rule.split.left"),
        learnedDelta("owner.b", "othershadow", "splitright", "rule.split.right")
      ];
      primeLearnedAnswerUnitForms({ deltas, profileIds: new Set(["owner.a", "owner.b"]) });
      expect(learnedAnswerUnitSharedBaseWitnesses("shadowleft", "shadowright")[0]?.corroborating?.base).toBe("corroborator");
      expect(learnedAnswerUnitSharedBaseWitnesses("lonelyleft", "lonelyright")).toEqual([]);
      expect(learnedAnswerUnitSharedBaseWitnesses("splitleft", "splitright")).toEqual([]);
    });
  });
});

function learnedDelta(profileId: string, from: string, to: string, ruleId = `rule.${profileId}`): LanguageStructuralDelta {
  return { id: `delta.${profileId}.${from}.${to}`, patternId: `pattern.${profileId}.${from}.${to}`, profileId, kind: "morphology",
    surface: { from, to }, grammatical: { ruleId }, semantic: {}, support: 1,
    evidenceIds: [`evidence.${profileId}`] as never[] };
}

function ownerModel(ownerSurface: string): KneserNeyModel {
  const stream: string[] = [];
  const contexts = Array.from({ length: 24 }, (_, index) => `frame${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`);
  const emit = (form: string, tokens: number, contextCount: number) => {
    for (let index = 0; index < tokens; index++) stream.push(contexts[index % contextCount]!, form);
  };
  for (let index = 0; index < 48; index++) emit(`form${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, 4 + index % 11, 2 + index % 9);
  emit(ownerSurface, 40, 22);
  emit(`${ownerSurface}s`, 31, 19);
  return { ...trainKneserNey(stream, { order: 2 }), sourceKey: ownerSurface === "owneralpha" ? "owner.a" : "owner.b" };
}
