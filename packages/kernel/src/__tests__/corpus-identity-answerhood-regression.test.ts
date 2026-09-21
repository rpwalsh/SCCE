// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { resetCorpusIdentityMeasurements } from "../corpus-identity-runtime.js";
import {
  answerCoversRequest,
  proposeSourceExactEvidenceAnswer
} from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

const requestText = "What was Allan Dwan's blood type?";
const closedClass = new Set(["was"]);
// Keep the relation coverage fixture focused on the measured content anchors; the generic opening word is not part
// of this regression's request obligation.
const requestUnits = ["allan", "dwan's", "blood", "type"];
const biography = "Allan Dwan was an American film director, producer, and screenwriter.";
const supported = "Allan Dwan's blood type was O positive.";

describe("corpus identity answerhood priming", () => {
  beforeEach(() => {
    resetCorpusIdentityMeasurements();
    clearCorpusIdentitySignals();
  });

  afterEach(() => {
    clearCorpusIdentitySignals();
    resetCorpusIdentityMeasurements();
  });

  it("rejects an unrelated biography before corpus identity priming", () => {
    expect(answerCoversRequest(
      [biography],
      span(biography),
      requestUnits,
      requestText,
      { relationRequired: true, languageClosedClassWords: closedClass }
    )).toBe(false);
  });

  it("still rejects the same unrelated biography after partial compound-name and attribute priming", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["allan", "blood"]),
      spread: new Map([["allan", 1], ["blood", 1]]),
      concentration: 1
    });
    expect(answerCoversRequest(
      [biography],
      span(biography),
      requestUnits,
      requestText,
      { relationRequired: true, languageClosedClassWords: closedClass }
    )).toBe(false);
  });

  it("still rejects when concentration selects the partial anchors without learned identities", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(),
      spread: new Map([["allan", 1], ["blood", 1]]),
      concentration: 1
    });
    expect(answerCoversRequest(
      [biography],
      span(biography),
      requestUnits,
      requestText,
      { relationRequired: true, languageClosedClassWords: closedClass }
    )).toBe(false);
  });

  it("accepts a sentence that actually carries the requested relation", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["allan", "blood"]),
      spread: new Map([["allan", 1], ["blood", 1]]),
      concentration: 1
    });
    expect(answerCoversRequest(
      [supported],
      span(supported),
      requestUnits,
      requestText,
      { relationRequired: true, languageClosedClassWords: closedClass }
    )).toBe(true);
  });

  it("does not let priming change a subject-only summary request", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["allan", "blood"]),
      spread: new Map([["allan", 1], ["blood", 1]]),
      concentration: 1
    });
    const subjectRequest = "Who was Allan Dwan?";
    expect(answerCoversRequest(
      [biography],
      span(biography),
      ["allan", "dwan"],
      subjectRequest,
      { relationRequired: true, languageClosedClassWords: closedClass }
    )).toBe(true);
  });

  it("does not propose the unrelated biography as an exact evidence answer", () => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["allan", "blood"]),
      spread: new Map([["allan", 1], ["blood", 1]]),
      concentration: 1
    });
    expect(proposeSourceExactEvidenceAnswer({
      requestText,
      selectedEvidence: [span(biography)],
      closedClassWords: closedClass,
      functionSymbols: closedClass
    })).toBeUndefined();
  });

  it("keeps the same answerhood boundary for a non-English source-neutral fixture", () => {
    const germanRequest = "Welche Blutgruppe hatte Niko Žora?";
    const germanClosedClass = new Set(["hatte"]);
    const germanUnits = ["niko", "žora", "blutgruppe"];
    const germanBiography = "Niko Žora war ein Musiker und Regisseur.";
    const germanSupported = "Niko Žoras Blutgruppe war A positiv.";
    primeCorpusIdentitySignals({
      closedClass: germanClosedClass,
      identities: new Set(["niko", "blutgruppe"]),
      spread: new Map([["niko", 1], ["blutgruppe", 1]]),
      concentration: 1
    });
    expect(answerCoversRequest(
      [germanBiography],
      span(germanBiography, "Niko Žora", "niko-zora"),
      germanUnits,
      germanRequest,
      { relationRequired: true, languageClosedClassWords: germanClosedClass }
    )).toBe(false);
    expect(answerCoversRequest(
      [germanSupported],
      span(germanSupported, "Niko Žora", "niko-zora"),
      germanUnits,
      germanRequest,
      { relationRequired: true, languageClosedClassWords: germanClosedClass }
    )).toBe(true);
  });
});

function span(text: string, title = "Allan Dwan", key = "allan-dwan"): EvidenceSpan {
  return {
    id: `evidence.${key}` as EvidenceId,
    sourceVersionId: `source-version.${key}` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.9,
    charStart: 0,
    charEnd: text.length,
    provenance: {
      uri: `fixture://${key}`,
      title,
      sourceVersionId: `source-version.${key}`,
      byteRange: [0, text.length],
      charRange: [0, text.length],
      metadata: { title }
    }
  } as unknown as EvidenceSpan;
}
