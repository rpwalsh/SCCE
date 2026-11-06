// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { deriveClosedClassWords, requestClosedClassWords } from "../closed-class-words.js";
import { clearCorpusIdentitySignals, corpusIdentityUnits, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { trainKneserNey } from "../kneser-ney.js";
import { answerCoversRequest, requestContentEvidenceUnits } from "../local-evidence-runtime.js";
import type { LanguageContinuationPopulation } from "../storage.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

afterEach(() => clearCorpusIdentitySignals());

const request = "The Ainu people are indigenous to which country?";
const answering = "The Ainu are an indigenous ethnic group who reside in northern Japan and southern Russia.";

// Two hydrated documents that never rank the interrogative; the corpus-scale population does.
const hydrated = [
  trainKneserNey("The Ainu are an indigenous ethnic group who reside in northern Japan and southern Russia. The Ainu language is isolated."),
  trainKneserNey("Hokkaido is the northernmost island of Japan. The island was settled by fishermen and traders.")
];

describe("closed class from the corpus-scale population", () => {
  it("removes learned interrogative scaffolding while retaining the country relation and its bound member", () => {
    const population = fixturePopulation("language.corpus", ["which"]);
    const inHand = deriveClosedClassWords({ models: hydrated });
    const corpusScale = deriveClosedClassWords({ models: hydrated, continuationPopulation: population });
    expect(inHand.has("which")).toBe(false);
    expect(corpusScale.has("which")).toBe(true);
    expect(corpusScale.has("country")).toBe(false);
    expect(corpusScale.has("indigenous")).toBe(false);

    // Production order: the turn's corpus identity is primed before the mouth derives its units.
    primeCorpusIdentitySignals({ closedClass: corpusScale, identities: new Set(["ainu people"]), spread: new Map(), concentration: 0 });
    const closed = requestClosedClassWords({ requestText: request, models: hydrated, continuationPopulation: population });
    const units = requestContentEvidenceUnits(request).filter(unit => !closed.has(unit));
    expect(units).toContain("country");

    const span = fixtureSpan("ainu", answering);
    expect(answerCoversRequest([answering], span, units, request, { relationRequired: true, languageClosedClassWords: inHand })).toBe(false);
    // A capitalized source word alone does not establish membership in the requested category.
    expect(answerCoversRequest([answering], span, units, request, { relationRequired: true, languageClosedClassWords: corpusScale })).toBe(false);
    expect(answerCoversRequest([answering], span, units, request, {
      relationRequired: true, languageClosedClassWords: corpusScale, boundValues: ["Japan"]
    })).toBe(true);
    expect(answerCoversRequest([answering], span, units, request, {
      relationRequired: true, languageClosedClassWords: corpusScale, boundValues: ["Greece"]
    })).toBe(false);

    const explicit = fixtureSpan("ainu-explicit", "The Ainu are indigenous to the country Japan and the country Russia.");
    const unfilteredUnits = corpusIdentityUnits(request);
    expect(unfilteredUnits).toContain("which");
    expect(answerCoversRequest([explicit.text], explicit, unfilteredUnits, request, { relationRequired: true, languageClosedClassWords: inHand })).toBe(false);
    expect(answerCoversRequest([explicit.text], explicit, unfilteredUnits, request, { relationRequired: true, languageClosedClassWords: corpusScale })).toBe(true);
  });

  it("keeps the corpus signal on the opening words of the request-scoped class", () => {
    const closed = requestClosedClassWords({ requestText: "Where is the northern island?", models: hydrated });
    expect(closed.has("northern")).toBe(false);
    expect(closed.has("island")).toBe(false);
  });

  it("does not let an unmeasured identity class turn a known source topic into an answer to an unknown relation", () => {
    const sourceText = "Animalia sold over four million copies worldwide.";
    const span = fixtureSpan("animalia", sourceText, "Animalia");
    const units = requestContentEvidenceUnits("What was the blood type of the author of Animalia?");

    expect(answerCoversRequest(
      [sourceText],
      span,
      units,
      "What was the blood type of the author of Animalia?",
      { relationRequired: true, languageClosedClassWords: new Set() }
    )).toBe(false);
  });
});

function fixturePopulation(languageId: string, leading: readonly string[]): LanguageContinuationPopulation {
  const continuationCounts: Record<string, number> = {};
  for (let index = 0; index < 192; index += 1) {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    continuationCounts[`fixture${first}${second}`] = 10_000 - index;
  }
  for (let index = 0; index < leading.length; index += 1) continuationCounts[leading[index]!] = 20_000 - index;
  continuationCounts.country = 1;
  continuationCounts.indigenous = 1;
  continuationCounts.people = 1;
  return { languageId, modelCount: 2_000, continuationCounts };
}

function fixtureSpan(id: string, text: string, title = "Ainu people"): EvidenceSpan {
  return {
    id: `evidence:${id}` as EvidenceId,
    sourceVersionId: `version:${id}` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.9,
    charStart: 4000,
    features: [],
    provenance: {
      uri: `fixture://${id}`,
      title,
      identity: title.toLocaleLowerCase(),
      sourceVersionId: `version:${id}`,
      byteRange: [0, text.length],
      charRange: [4000, 4000 + text.length]
    }
  } as unknown as EvidenceSpan;
}
