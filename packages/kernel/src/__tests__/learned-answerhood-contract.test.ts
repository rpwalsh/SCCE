// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { learnedAnswerUnitFormVerdict, primeLearnedAnswerUnitForms } from "../learned-answer-unit-forms.js";
import { answerCoversRequest, learnedRequestScaffoldingUnits, localEvidenceAnswerClaimSurface, localEvidenceAnswerSurface, requestLeadingScaffoldingUnit, requestUnitMatchesSurface, requestUnitSharesStem, runtimeEvidenceWindowsForRequest } from "../local-evidence-runtime.js";
import { scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { sourceOwnedAnswerUnitForms } from "./fixtures/source-owned-answer-unit-forms.js";
import type { EvidenceSpan } from "../types.js";

afterEach(() => { clearCorpusIdentitySignals(); primeLearnedAnswerUnitForms({ deltas: [], profileIds: new Set() }); });
function span(text: string, title = "vessel"): EvidenceSpan {
  return { id: "evidence.source-answer", sourceVersionId: "source.source-answer", text, textPreview: text, status: "promoted", alpha: 1,
    charStart: 0, charEnd: text.length, features: [], provenance: { title } } as unknown as EvidenceSpan;
}

describe("learned answerhood language contract", () => {
  const teaching = sourceOwnedAnswerUnitForms();
  it("uses actual induced source-owned morphology across case, scripts, and request permutations", () => {
    expect(teaching.model.morphology.some(rule => rule.kind === "reduplication")).toBe(true);
    expect(teaching.state.structuralDeltas?.some(delta => delta.surface.from === "walla" && delta.surface.to === "wallawalla")).toBe(true);
    expect(requestUnitMatchesSurface("walla", "wallawalla")).toBe(false);
    teaching.prime();
    const verdict = learnedAnswerUnitFormVerdict("WALLA", "wallaWALLA");
    expect(verdict.status).toBe("same");
    expect(verdict.witnesses[0]?.patternId).toBeTruthy();
    expect(verdict.witnesses[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(requestUnitSharesStem("walla", "wallawalla")).toBe(true);
    expect(requestUnitMatchesSurface("סירה", "סירהסירה")).toBe(true);
    expect(requestUnitMatchesSurface("東京湾岸港", "東京湾岸港東京湾岸港")).toBe(false);
    expect(requestUnitMatchesSurface("wallawalla", "wallawallb")).toBe(false);
    const closed = new Set(["who", "the"]);
    primeCorpusIdentitySignals({ closedClass: closed, identities: new Set(["vessel"]), spread: new Map(), concentration: 0 });
    const evidence = span("rana walla the vessel beside the harbor.");
    for (const request of ["who wallawalla the vessel?", "the vessel wallaWALLA WHO?", "VESSEL WALLAWALLA who?"]) {
      expect(answerCoversRequest([evidence.text], evidence, ["wallawalla", "vessel"], request, { relationRequired: true, languageClosedClassWords: closed })).toBe(true);
      const selected = localEvidenceAnswerSurface({ requestText: request, selectedEvidence: [evidence], closedClassWords: closed, functionSymbols: closed });
      expect(selected).toBeDefined();
      expect(localEvidenceAnswerClaimSurface(selected!)).toBe(evidence.text);
    }
    expect(answerCoversRequest([evidence.text], evidence, ["wallawallb", "vessel"], "who wallawallb vessel?", { relationRequired: true, languageClosedClassWords: closed })).toBe(false);
    const opaqueClosed = new Set(["מי"]);
    primeCorpusIdentitySignals({ closedClass: opaqueClosed, identities: new Set(["נמלית"]), spread: new Map(), concentration: 0 });
    const opaqueEvidence = span("רנה סירה נמלית ליד הנמל.", "נמלית");
    for (const requestText of ["מי סירהסירה נמלית?", "נמלית סירהסירה מי?"]) {
      const selected = localEvidenceAnswerSurface({ requestText, selectedEvidence: [opaqueEvidence], closedClassWords: opaqueClosed, functionSymbols: opaqueClosed });
      expect(selected).toBeDefined();
      expect(localEvidenceAnswerClaimSurface(selected!)).toBe(opaqueEvidence.text);
    }
    const foreign = scopeLanguageMemoryStateToLanguage(teaching.state, "language.foreign", { profile: () => "language.learned-answer-forms", corpus: () => undefined });
    expect(foreign.structuralDeltas).toEqual([]);
    primeLearnedAnswerUnitForms({ deltas: foreign.structuralDeltas ?? [], profileIds: new Set() });
    expect(requestUnitMatchesSurface("walla", "wallawalla")).toBe(false);
  });

  it("recognizes only learned scaffolding regardless of length, position, or case", () => {
    const closed = new Set(["interrogativeparticle", "who"]);
    for (const request of ["nux interrogativeparticle vessel", "VESSEL INTERROGATIVEPARTICLE nux", "interrogativeparticle nux vessel"]) {
      expect([...learnedRequestScaffoldingUnits(request, closed)]).toEqual(["interrogativeparticle"]);
      expect(requestLeadingScaffoldingUnit(request, closed)).toBe("interrogativeparticle");
    }
    expect(requestLeadingScaffoldingUnit("nux vessel", closed)).toBeUndefined();
    expect(requestLeadingScaffoldingUnit("who vessel interrogativeparticle", closed)).toBeUndefined();
  });

  it("keeps the canonical source choice invariant when only capitalization changes", () => {
    const closed = new Set(["what", "the"]);
    primeCorpusIdentitySignals({ closedClass: closed, identities: new Set(["epsilon"]), spread: new Map(), concentration: 0 });
    const choose = (text: string) => {
      const selected = localEvidenceAnswerSurface({ requestText: "epsilon controls what?", selectedEvidence: [span(text, "epsilon")], closedClassWords: closed, functionSymbols: closed });
      expect(selected).toBeDefined();
      return localEvidenceAnswerClaimSurface(selected!).toLocaleLowerCase();
    };
    const canonical = choose("Epsilon controls the nux observatory. Epsilon controls the vax observatory.");
    expect(canonical).toBe("epsilon controls the nux observatory.");
    expect(choose("epsilon controls the nux observatory. Epsilon controls the vax observatory.")).toBe(canonical);
    expect(choose("ePsIlOn controls the nux observatory. EPSILON controls the vax observatory.")).toBe(canonical);
  });

  it("uses the same learned relation plan for long-source retrieval windows", () => {
    teaching.prime();
    const closed = new Set(["who", "the"]);
    primeCorpusIdentitySignals({ closedClass: closed, identities: new Set(["vessel"]), spread: new Map(), concentration: 0 });
    const fact = "rana walla the vessel beside the harbor.";
    const source = span(`${"the harbor remained quiet throughout the night. ".repeat(300)}${fact}`);
    const [window] = runtimeEvidenceWindowsForRequest("vessel wallawalla who?", [source]);
    expect(window!.retrievalWindow).toBe(fact);
    expect(window!.text).toBe(source.text);
    expect(window!.id).toBe(source.id);
    const [unknown] = runtimeEvidenceWindowsForRequest("who wallawallb vessel?", [source]);
    expect(unknown).toBe(source);
  });
});
