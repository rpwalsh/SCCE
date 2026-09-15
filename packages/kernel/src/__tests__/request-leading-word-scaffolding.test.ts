// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { deriveClosedClassWords } from "../closed-class-words.js";
import { requestRelationBeyondSourceIdentity } from "../local-evidence-runtime.js";
import type { LanguageContinuationPopulation } from "../storage.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * Scaffolding is what the corpus ranks as scaffolding, at every position and at every length.
 *
 * The removed rule read the request's first word and called it scaffolding whenever it was at most five characters
 * long. Both halves of that are decided by measurement here: a nine-character interrogative the corpus ranks into
 * its closed class is scaffolding wherever it stands, and a four-character subject name is not, including when it
 * stands first. A request that names the same units in a different order therefore asks for the same relation.
 */
describe("request scaffolding by corpus rank, not by leading-word length", () => {
  // Continuation counts, the quantity the hydrated runtime reads its closed class off. The interrogative and the
  // copula continue many contexts; the words these requests ask about continue one.
  const closedClass = deriveClosedClassWords({
    continuationPopulation: fixturePopulation("language.leading-word", ["ja", "on", "se", "ei", "mutta", "millainen", "kuinka"])
  });
  // A source about the wider region, so nothing the request names is subtracted as this document's own identity.
  const region = titledSpan("evidence:rheinland", "Rheinland", "unused");

  it("keeps a four-character content word in first position out of the scaffolding", () => {
    expect(closedClass.has("bonn")).toBe(false);
    expect(closedClass.has("millainen")).toBe(true);
    expect(requestRelationBeyondSourceIdentity("bonn on millainen kaupunki", region, closedClass))
      .toEqual(["bonn", "kaupunki"]);
  });

  it("reads the same relation whichever unit the request leads with", () => {
    const leadingSubject = requestRelationBeyondSourceIdentity("bonn on millainen kaupunki", region, closedClass);
    const leadingInterrogative = requestRelationBeyondSourceIdentity("millainen kaupunki on bonn", region, closedClass);
    expect([...leadingInterrogative]).not.toContain("millainen");
    expect([...leadingSubject].sort()).toEqual([...leadingInterrogative].sort());
  });
});

/** A corpus-scale continuation population: the ranked symbols a closed class is read off, counts only. */
function fixturePopulation(languageId: string, leading: readonly string[]): LanguageContinuationPopulation {
  const continuationCounts: Record<string, number> = {};
  for (let index = 0; index < 192; index += 1) {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    continuationCounts[`fixture${first}${second}`] = 10_000 - index;
  }
  for (let index = 0; index < leading.length; index += 1) continuationCounts[leading[index]!] = 20_000 - index;
  for (const content of ["bonn", "kaupunki", "museo"]) continuationCounts[content] = 1;
  return { languageId, modelCount: 2_000, continuationCounts };
}

function titledSpan(id: string, title: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceVersionId: `${id}:v1` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.9,
    charStart: 0,
    features: [],
    provenance: {
      uri: `fixture://${id}`,
      title,
      identity: title.toLocaleLowerCase(),
      sourceVersionId: `${id}:v1`,
      byteRange: [0, text.length],
      charRange: [0, text.length],
      metadata: { title }
    }
  } as unknown as EvidenceSpan;
}
