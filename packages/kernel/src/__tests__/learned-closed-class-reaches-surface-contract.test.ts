// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { COMMITMENT_AUTHORITY_IDS, candidateCommitmentInventory } from "../candidate-commitment-inventory.js";
import { SURFACE_AUTHORITY_CLASS_IDS } from "../conversational-act-binding.js";
import { createHasher } from "../primitives.js";
import {
  closedClassForFamilies,
  discoverLanguageIdentities,
  majorityClosedClass,
  type LanguageProfileSignature
} from "../language-identity.js";
import { corpusFamiliesForRole } from "../language-identity-runtime.js";
import { CORPUS_ROLE_IDS, createCorpusRegistry } from "../corpus-registry.js";
import { conversationalSession, type TraceRow } from "./conversational-session-fixture.js";

/**
 * Two families of one script, shaped like the live brain: a large encyclopedic family that seeds the identity, and a
 * small dialogue family that joins it. The dialogue family's own function words are the ones the seed never names.
 */
const ENCYCLOPEDIC_WORDS = ["the", "in", "a", "of", "and", "to", "was", "is", "as", "on", "for", "by", "at", "with", "from"];
const DIALOGUE_WORDS = [...ENCYCLOPEDIC_WORDS, "i", "you", "my", "that", "he", "not"];

function signatures(family: string, count: number, words: readonly string[]): LanguageProfileSignature[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${family}.${index}`,
    family,
    scripts: [{ script: "script:Latn", mass: 1 }],
    direction: "ltr",
    // Each document carries its family's words plus one of its own, so document frequency, not a list, names the class.
    topContinuation: [...words.map((word, rank) => [word, words.length - rank] as const), [`${family}${index}`, 1] as const]
  }));
}

function discover() {
  return discoverLanguageIdentities({
    signatures: [...signatures("wikipedia", 40, ENCYCLOPEDIC_WORDS), ...signatures("gutenberg", 8, DIALOGUE_WORDS)],
    hasher: createHasher(),
    now: 1
  });
}

describe("the learned closed class reaches the surface contract", () => {
  it("keeps a joining family's own learned class on the identity instead of the seed family's", () => {
    const { identities } = discover();
    const identity = identities.find(row => row.profileCount === 48);
    expect(identity).toBeDefined();
    // The seed family's class is what the identity as a whole reports, and it names neither "i" nor "you".
    const identityWords = identity!.closedClass.map(row => row.word);
    expect(identityWords).not.toContain("i");
    expect(identityWords).not.toContain("you");
    // The families that joined it kept theirs. This is the record field the fix adds; without it the array is
    // {family, count} only and every corpus role reads the seed family's class.
    const joined = identity!.families.find(row => row.family === "gutenberg");
    expect(joined?.count).toBe(8);
    const joinedWords = (joined?.closedClass ?? []).map(row => row.word);
    expect(joinedWords).toContain("i");
    expect(joinedWords).toContain("you");
    // Learned, not asserted: it is exactly what document frequency over that family's own members yields.
    expect(joinedWords).toEqual(majorityClosedClass(signatures("gutenberg", 8, DIALOGUE_WORDS)).map(row => row.word));
  });

  it("selects one family's class by corpus role and never unions the families together", () => {
    const { identities } = discover();
    const identity = identities.find(row => row.profileCount === 48)!;
    const proseFamilies = corpusFamiliesForRole(createCorpusRegistry(), CORPUS_ROLE_IDS.publicDomainProse);
    expect(proseFamilies).toContain("gutenberg");
    const prose = closedClassForFamilies(identity, proseFamilies);
    expect(prose).toContain("i");
    expect(prose).toContain("you");
    // The encyclopedic role reads its own family, which never learned them. A union would have handed it both.
    const encyclopedic = closedClassForFamilies(identity, corpusFamiliesForRole(createCorpusRegistry(), CORPUS_ROLE_IDS.encyclopedic));
    expect(encyclopedic).not.toContain("i");
    expect(encyclopedic).not.toContain("you");
    // A role whose families this identity never saw falls back to the identity's own class, not to nothing.
    expect(closedClassForFamilies(identity, ["a-family-this-corpus-never-had"]))
      .toEqual(identity.closedClass.map(row => row.word));
  });

  it("counts the role's function words as form, so a conversational surface is not an unsupported factual claim", () => {
    const { identities } = discover();
    const identity = identities.find(row => row.profileCount === 48)!;
    const closedClass = closedClassForFamilies(identity, corpusFamiliesForRole(createCorpusRegistry(), CORPUS_ROLE_IDS.publicDomainProse));
    // The live surface-contract audit flagged exactly these units as unlicensed over 76 audits in 21 turns.
    const text = "you know that i was not";
    const withLearnedClass = candidateCommitmentInventory({
      text,
      evidenceTexts: [],
      conversationTurns: [{ turnId: "turn.request", turnIndex: 0, surface: "know" }],
      claimBases: [],
      closedClass
    });
    const form = withLearnedClass.units
      .filter(unit => unit.authorityId === COMMITMENT_AUTHORITY_IDS.form)
      .map(unit => unit.surface);
    expect(form).toContain("you");
    expect(form).toContain("i");
    expect(withLearnedClass.closedClassMeasured).toBe(true);
    expect(withLearnedClass.unlicensedUnits).toEqual([]);
    expect(withLearnedClass.authorityClassId).toBe(SURFACE_AUTHORITY_CLASS_IDS.conversationBound);

    // Without a learned class nothing is form: the safe direction, and the verdict the live turns actually reported.
    const withoutLearnedClass = candidateCommitmentInventory({
      text,
      evidenceTexts: [],
      conversationTurns: [{ turnId: "turn.request", turnIndex: 0, surface: "know" }],
      claimBases: []
    });
    expect(withoutLearnedClass.closedClassMeasured).toBe(false);
    expect(withoutLearnedClass.unlicensedUnits.map(unit => unit.surface)).toContain("you");
    expect(withoutLearnedClass.unlicensedUnits.map(unit => unit.surface)).toContain("i");
    expect(withoutLearnedClass.authorityClassId).toBe(SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual);
  });
});

describe("a production turn reaches the surface contract holding its language's closed class", () => {
  it("reports commitment.authority.form in the audit instead of calling every word content", async () => {
    const session = conversationalSession();
    const out = await session.turn("the pump feed reads high");
    const audits = (out.trace as TraceRow[])
      .filter(row => row.stage === "mouth.surface_contract")
      .map(row => (row.support as { contract?: { commitments?: { closedClassMeasured?: boolean; authorityIds?: string[] } } }).contract);
    expect(audits.length).toBeGreaterThan(0);
    // Measured zero across 163 live audits before this change: the turn held models, never a learned closed class.
    expect(audits.some(audit => audit?.commitments?.closedClassMeasured === true)).toBe(true);
    expect(audits.some(audit => (audit?.commitments?.authorityIds ?? []).includes(COMMITMENT_AUTHORITY_IDS.form))).toBe(true);
  }, 600_000);
});
