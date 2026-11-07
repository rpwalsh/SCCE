// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { answerCoversRequest } from "../local-evidence-runtime.js";
import type { EvidenceSpan } from "../types.js";

const closed = new Set(["who", "what", "is", "did", "the", "of"]);
afterEach(clearCorpusIdentitySignals);

function ownedSpan(text: string, title: string, identity = title) {
  let reads = 0;
  const span = { id: "evidence.context", sourceVersionId: "source.context", get text() { reads++; return text; }, textPreview: text,
    status: "promoted", alpha: 1, charStart: 100, charEnd: 100 + text.length, features: [],
    provenance: { title, metadata: { title, identity } } } as unknown as EvidenceSpan;
  return { span, reads: () => reads };
}

function prime(identities: string[] = []) {
  primeCorpusIdentitySignals({ closedClass: closed, identities: new Set(identities), spread: new Map(), concentration: 0 });
}

describe("answerhood reads preceding source context only when its decision needs it", () => {
  it("rejects unknown relations across a long source without rescanning the full source for every candidate", () => {
    prime(["pequod"]);
    const sentence = "The captain of the Pequod was Ahab.";
    const source = ownedSpan(`${sentence} ${"The vessel sailed through the harbor. ".repeat(1800)}`, "Moby Dick", "Moby Dick; or, The Whale. By Herman Melville");
    for (let index = 0; index < 80; index++) {
      expect(answerCoversRequest([sentence], source.span, ["dentist", "pequod"], "Who is the dentist of the Pequod?", { relationRequired: true, languageClosedClassWords: closed })).toBe(false);
    }
    expect(source.reads()).toBe(0);
  });

  it("preserves a literal Moby-Dick captain passage without reading unrelated preceding material", () => {
    prime(["pequod"]);
    const sentence = "But if you are speaking of Captain Ahab, of that ship there, the Pequod, then let me tell you, that I know all about the loss of his leg.";
    const source = ownedSpan(sentence, "Moby Dick", "Moby Dick; or, The Whale. By Herman Melville");
    expect(answerCoversRequest([sentence], source.span, ["captain", "pequod"], "Who is the captain of the Pequod?", { relationRequired: true, languageClosedClassWords: closed })).toBe(true);
    expect(source.reads()).toBe(0);
  });

  it("still reads the previous sentence for a source-owned anaphoric subject", () => {
    prime(["ahab"]);
    const sentence = "He commanded the Pequod.";
    const source = ownedSpan(`Ahab boarded the vessel. ${sentence}`, "Ahab");
    expect(answerCoversRequest([sentence], source.span, ["ahab", "commanded"], "What did Ahab command?", { relationRequired: true, languageClosedClassWords: closed })).toBe(true);
    expect(source.reads()).toBe(1);
  });

  it.each([{ qualifier: "11", expected: true }, { qualifier: "12", expected: false }])("keeps the full numeric subject obligation with preceding Apollo $qualifier", ({ qualifier, expected }) => {
    prime(["apollo 11"]);
    const sentence = "Armstrong commanded the mission.";
    const source = ownedSpan(`Apollo ${qualifier} was the mission. ${sentence}`, "Apollo 11", "Apollo 11 mission");
    expect(answerCoversRequest([sentence], source.span, ["apollo", "11", "commanded"], "Who commanded Apollo 11?", { relationRequired: true, languageClosedClassWords: closed })).toBe(expected);
    expect(source.reads()).toBe(1);
  });
});
