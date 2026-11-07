// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { clearFreeFormLexicon } from "../free-form-lexicon.js";
import { answerCoversRequest, answerhoodMemoWorkStats, clearAnswerhoodWorkMemos, localEvidenceAnswerClaimSurface, localEvidenceAnswerSurface, requestUnitMatchesSurface, requestUnitSharesStem } from "../local-evidence-runtime.js";
import type { EvidenceSpan } from "../types.js";

const closed = new Set(["who", "what", "is", "did", "the", "of"]);
afterEach(() => { clearCorpusIdentitySignals(); clearFreeFormLexicon(); clearAnswerhoodWorkMemos(); });
function source(text: string): EvidenceSpan {
  return { id: "evidence.memo", sourceVersionId: "source.memo", text, textPreview: text, status: "promoted", alpha: 1,
    charStart: 192444, charEnd: 192444 + text.length, features: [],
    provenance: { title: "Moby Dick", metadata: { title: "Moby Dick", identity: "Moby Dick; or, The Whale. By Herman Melville" } } } as unknown as EvidenceSpan;
}

describe("canonical answerhood repeated work", () => {
  it("reuses exact Moby-Dick and Unicode comparison work without changing positive or unknown-role decisions", () => {
    clearAnswerhoodWorkMemos();
    primeCorpusIdentitySignals({ closedClass: closed, identities: new Set(["pequod"]), spread: new Map(), concentration: 0 });
    const fact = "But if you are speaking of Captain Ahab, of that ship there, the Pequod, then let me tell you, that I know all about the loss of his leg.";
    const span = source(`“Captain Ahab.” “What! the captain of our ship, the Pequod?” ${fact}`);
    const options = { relationRequired: true, languageClosedClassWords: closed };
    const evaluate = () => [
      answerCoversRequest([fact], span, ["captain", "pequod"], "Who is the captain of the Pequod?", options),
      answerCoversRequest([fact], span, ["dentist", "pequod"], "Who is the dentist of the Pequod?", options),
      answerCoversRequest(["the captain of our ship, the Pequod?”"], span, ["captain", "pequod"], "Who is the captain of the Pequod?", options),
      requestUnitSharesStem("調査航海船", "調査航海船団"),
      requestUnitSharesStem("調査航海船", "異なる船舶")
    ];
    expect(evaluate()).toEqual([true, false, false, true, false]);
    const initial = answerhoodMemoWorkStats();
    expect(initial.matchEvaluations).toBeGreaterThan(0);
    expect(initial.subjectEvaluations).toBe(2);
    for (let index = 0; index < 80; index++) expect(evaluate()).toEqual([true, false, false, true, false]);
    const repeated = answerhoodMemoWorkStats();
    expect(repeated.matchEvaluations).toBe(initial.matchEvaluations);
    expect(repeated.stemEvaluations).toBe(initial.stemEvaluations);
    expect(repeated.subjectEvaluations).toBe(initial.subjectEvaluations);
    expect(repeated.comparisons.misses).toBe(initial.comparisons.misses);
    const selected = localEvidenceAnswerSurface({ requestText: "Who is the captain of the Pequod?", selectedEvidence: [span], closedClassWords: closed, functionSymbols: closed });
    expect(selected).toBeDefined();
    expect(localEvidenceAnswerClaimSurface(selected!)).toBe(fact);
    expect(localEvidenceAnswerSurface({ requestText: "Who is the dentist of the Pequod?", selectedEvidence: [span], closedClassWords: closed, functionSymbols: closed })).toBeUndefined();
  });

  it("reads the exact current learned function set and invalidates measured forms when the corpus changes", () => {
    clearAnswerhoodWorkMemos();
    const functions = new Set(["尾詞"]);
    expect(requestUnitMatchesSurface("船舶阿爾法", "船舶阿爾法尾詞", functions)).toBe(true);
    expect(requestUnitMatchesSurface("船舶阿爾法", "船舶阿爾法尾詞", new Set(["別詞"]))).toBe(false);
    functions.delete("尾詞"); functions.add("別詞");
    expect(requestUnitMatchesSurface("船舶阿爾法", "船舶阿爾法尾詞", functions)).toBe(false);
    requestUnitSharesStem("調査航海船", "調査航海船団");
    const initial = answerhoodMemoWorkStats();
    clearFreeFormLexicon();
    expect(requestUnitSharesStem("調査航海船", "調査航海船団")).toBe(true);
    expect(answerhoodMemoWorkStats().stemEvaluations).toBe(initial.stemEvaluations + 1);
    primeCorpusIdentitySignals({ closedClass: closed, identities: new Set(["pequod"]), spread: new Map(), concentration: 0 });
    const span = source("The captain of the Pequod was Ahab.");
    expect(answerCoversRequest([span.text], span, ["captain", "pequod"], "Who is the captain of the Pequod?", { relationRequired: true, languageClosedClassWords: closed })).toBe(true);
    const subjects = answerhoodMemoWorkStats().subjectEvaluations;
    clearCorpusIdentitySignals();
    answerCoversRequest([span.text], span, ["captain", "pequod"], "Who is the captain of the Pequod?", { relationRequired: true, languageClosedClassWords: closed });
    expect(answerhoodMemoWorkStats().subjectEvaluations).toBe(subjects + 1);
  });
});
