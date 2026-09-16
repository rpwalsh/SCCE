// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { sourceIdentityAdmissibleEvidenceForRequest } from "../local-evidence-runtime.js";
import type { ContentHash, EvidenceId, EvidenceSpan, SourceId, SourceVersionId } from "../index.js";

// Measured live 2026-09-16: "the pump feed reads high" was answered with the insulin pump article, cited. Admission
// bound it on the single unit "pump" (tiers identityBound=4, contentBound=0, exact=0, primaryEvidence=0), and a
// conversational turn with no subject at all reached the titleless rescue block and admitted whatever spans shared
// one word. Spreads below are the production corpus's own, measured the way sourceIdentityArbitration measures them,
// against its Otsu concentration split of 319.
const CONCENTRATION = 319;

// The production article's own lead, verbatim: it shares exactly one unit with the request, and that was enough.
const INSULIN_PUMP =
  "An 'insulin pump' is a medical device used for the administration of insulin in the treatment of diabetes "
  + "mellitus, also known as continuous subcutaneous insulin therapy.";

const ALBANIA =
  "'Albania', officially the 'Republic of Albania', is a country in Southeast Europe. Its capital and largest "
  + "city is Tirana, which is also the capital of the surrounding county.";

const LOVELACE =
  "'Augusta Ada King, Countess of Lovelace' was an English mathematician chiefly known for her work on Charles "
  + "Babbage's proposed mechanical general-purpose computer, the Analytical Engine.";

function span(input: { id: string; title: string; text: string }): EvidenceSpan {
  return {
    id: input.id as EvidenceId,
    sourceId: `source:${input.id}` as SourceId,
    sourceVersionId: `source_version:${input.id}` as SourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${input.id}` as ContentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.9, sourceTrust: 0.9, structuralConfidence: 0.9, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "wrong-topic-admission-test", title: input.title, uri: `https://example.invalid/${input.id}` },
    features: [],
    status: "promoted",
    alpha: 0.8,
    observedAt: 1000
  } as EvidenceSpan;
}

// What "hey, how's it going?" was answered with live: a chapter sharing one word with the greeting. The rescue
// block that admits it asks for every binding anchor in one sentence, which is no requirement when there is one.
const TREASURE_ISLAND =
  "The doctor said we should be going ashore that evening, and the ship lay quiet at her moorings while the tide "
  + "was going out.";

const insulinPump = span({ id: "evidence.insulin_pump", title: "insulin pump", text: INSULIN_PUMP });
const albania = span({ id: "evidence.albania", title: "albania", text: ALBANIA });
const lovelace = span({ id: "evidence.ada_lovelace", title: "ada lovelace", text: LOVELACE });
const chapter = span({ id: "evidence.treasure_island", title: "treasure island", text: TREASURE_ISLAND });

const closedClass = new Set(["the", "is", "of", "was", "a", "it", "we", "so", "about", "do", "who", "what"]);

afterEach(() => clearCorpusIdentitySignals());

describe("wrong-topic content admission", () => {
  it("refuses a span sharing one unit when the corpus measures the request's whole run at zero sources", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["insulin pump", "albania", "ada lovelace"]),
      // The corpus carries no source with pump, feed, reads and high together; each unit alone is concentrated.
      spread: new Map([["pump feed reads high", 0], ["pump", 112], ["feed", 190], ["reads", 196], ["high", 3050]]),
      concentration: CONCENTRATION
    });
    const admitted = sourceIdentityAdmissibleEvidenceForRequest(
      "the pump feed reads high",
      [insulinPump, albania, lovelace],
      new Set(),
      closedClass
    );
    expect(admitted.evidence.map(entry => String(entry.id))).toEqual([]);
  });

  it("refuses every span when no unit of a conversational request is one the corpus documents", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["insulin pump", "albania", "ada lovelace"]),
      // Every unit on offer sits above the corpus's own concentration split: words it uses, not subjects it documents.
      spread: new Map([["what should", 540], ["what", 856], ["should", 580], ["going", 844], ["how", 1432]]),
      concentration: CONCENTRATION
    });
    for (const request of ["so what should we do about it", "hey, how is it going?"]) {
      const admitted = sourceIdentityAdmissibleEvidenceForRequest(
        request,
        [insulinPump, albania, lovelace, chapter],
        new Set(),
        closedClass
      );
      expect(admitted.evidence.map(entry => String(entry.id))).toEqual([]);
    }
  });

  it("still admits the article the corpus is titled with for a request that names it", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["insulin pump", "albania", "ada lovelace"]),
      spread: new Map([["capital", 886], ["albania", 99], ["lovelace", 106], ["ada lovelace", 96]]),
      concentration: CONCENTRATION
    });
    const capital = sourceIdentityAdmissibleEvidenceForRequest(
      "what is the capital of Albania?",
      [insulinPump, albania, lovelace],
      new Set(),
      closedClass
    );
    expect(capital.evidence.map(entry => String(entry.id))).toContain("evidence.albania");

    const ada = sourceIdentityAdmissibleEvidenceForRequest(
      "who was Ada Lovelace?",
      [insulinPump, albania, lovelace],
      new Set(),
      closedClass
    );
    expect(ada.evidence.map(entry => String(entry.id))).toContain("evidence.ada_lovelace");
  });

  it("leaves admission unchanged where the corpus has measured nothing", () => {
    // Unmeasured is not zero. With no primed signal at all, and with one carrying no spread for these runs,
    // every tier must decide identically -- the gate reads a measurement or it stands aside.
    const pool = [insulinPump, albania, lovelace, chapter];
    const requests = ["the pump feed reads high", "hey, how is it going?", "what is the capital of Albania?"];
    const ids = (request: string): string[] =>
      sourceIdentityAdmissibleEvidenceForRequest(request, pool, new Set(), closedClass).evidence.map(entry => String(entry.id));

    clearCorpusIdentitySignals();
    const unprimed = requests.map(ids);
    primeCorpusIdentitySignals({ closedClass, identities: new Set(["insulin pump"]), spread: new Map(), concentration: CONCENTRATION });
    expect(requests.map(ids)).toEqual(unprimed);
  });
});
