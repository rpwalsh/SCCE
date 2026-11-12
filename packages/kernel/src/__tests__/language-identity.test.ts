// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  closedClassPresence,
  discoverLanguageIdentities,
  languageProfileSignature,
  majorityClosedClass,
  otsuThreshold,
  selectLanguageIdentityForSurface,
  type LanguageIdentityRecord,
  type LanguageProfileSignature
} from "../language-identity.js";
import { createHasher } from "../primitives.js";
import { CORPUS_ROLE_IDS } from "../corpus-registry.js";
import type { LanguageProfile } from "../types.js";

/** Documents of one language share their function words whatever they are about; a different language shares none of them. */
const ENGLISH = ["the", "of", "and", "in", "to", "a", "was", "is", "as", "for", "on", "by", "with", "at", "from"];
const CODE = ["const", "import", "type", "return", "export", "function", "string", "number", "id", "from"];
const FRENCH = ["le", "la", "de", "et", "les", "des", "en", "un", "une", "est", "pour", "dans", "par", "qui", "que"];

function document(id: string, family: string, functionWords: readonly string[], topic: readonly string[], keep = functionWords.length, corpusRoleId?: string): LanguageProfileSignature {
  const words = [...functionWords.slice(0, keep), ...topic];
  return {
    id,
    family,
    ...(corpusRoleId ? { corpusRoleId } : {}),
    scripts: [{ script: "script:Latn", mass: 1 }],
    direction: "ltr",
    topContinuation: words.map((word, index) => [word, 1000 - index] as const)
  };
}

function corpus(family: string, count: number, functionWords: readonly string[], topics: readonly string[][], keep?: number, prefix = family, corpusRoleId?: string): LanguageProfileSignature[] {
  return Array.from({ length: count }, (_, index) => document(`${prefix}:${index}`, family, functionWords, topics[index % topics.length]!, keep, corpusRoleId));
}

describe("language identity discovery", () => {
  const hasher = createHasher();
  const wikipedia = corpus("wikipedia", 40, ENGLISH, [["rowspan", "align", "style", "born"], ["senate", "state", "film", "album"], ["river", "county", "school"]]);
  const gutenberg = corpus("gutenberg", 8, ENGLISH, [["captain", "ship", "treasure"], ["marsh", "fog", "london"]]);
  const batches = corpus("synthetic", 6, ENGLISH, [["align", "style", "rowspan", "references"], ["template", "markup", "table", "links"], ["chapter", "paragraph", "quote", "notes"]]);
  const code = corpus("files", 12, CODE, [["evidence", "graph", "kernel"], ["mouth", "surface", "plan"]]);
  const docs = corpus("files", 5, ENGLISH, [["license", "install", "runtime"]], undefined, "docs");
  const french = corpus("frwiki", 10, FRENCH, [["fleuve", "commune", "département"], ["village", "region", "histoire"], ["ecole", "route", "province"]]);

  it("learns a family's closed class from document frequency, not from a list", () => {
    const closed = majorityClosedClass(wikipedia).map(row => row.word);
    expect(closed).toEqual(expect.arrayContaining(ENGLISH));
    expect(closed).not.toContain("rowspan");
    expect(closed).not.toContain("born");
  });

  it("unites families that carry each other's closed class and separates the ones that do not", () => {
    const { identities, assignments } = discoverLanguageIdentities({ signatures: [...wikipedia, ...gutenberg, ...batches, ...code, ...docs, ...french], hasher, now: 1 });
    const of = (id: string) => identities.find(identity => identity.id === assignments.get(id))!;
    expect(of("wikipedia:0")).toBe(of("gutenberg:3"));
    expect(of("wikipedia:0")).toBe(of("synthetic:2"));
    expect(of("wikipedia:0")).not.toBe(of("files:0"));
    expect(of("wikipedia:0")).not.toBe(of("frwiki:0"));
    expect(of("frwiki:0")).not.toBe(of("files:0"));
    // The mixed family splits by nearest identity: its English documents join English, its source files join code.
    expect(of("docs:0")).toBe(of("wikipedia:0"));
    expect(of("files:0").closedClass.map(row => row.word)).toEqual(expect.arrayContaining(["const", "import", "type"]));
    expect(identities.map(identity => identity.families.map(row => row.family))).toContainEqual(expect.arrayContaining(["wikipedia", "gutenberg", "synthetic", "files"]));
  });

  it("keeps a markup-heavy document of the language with the language", () => {
    const table = document("wikipedia:table", "wikipedia", ENGLISH, ["rowspan", "colspan", "align", "style", "bgcolor", "width", "references"], 5);
    const { identities, assignments } = discoverLanguageIdentities({ signatures: [...wikipedia, ...code, table], hasher, now: 1 });
    const of = (id: string) => identities.find(identity => identity.id === assignments.get(id))!;
    expect(of("wikipedia:table")).toBe(of("wikipedia:0"));
  });

  it("is deterministic across member order", () => {
    const forward = discoverLanguageIdentities({ signatures: [...wikipedia, ...code], hasher, now: 1 });
    const reverse = discoverLanguageIdentities({ signatures: [...code, ...wikipedia].reverse(), hasher, now: 1 });
    expect(reverse.identities.map(identity => identity.id).sort()).toEqual(forward.identities.map(identity => identity.id).sort());
  });

  it("selects the identity of a request surface by closed-class coverage within its script", () => {
    const { identities } = discoverLanguageIdentities({ signatures: [...wikipedia, ...code, ...french], hasher, now: 1 });
    const english = identities.find(identity => identity.closedClass.some(row => row.word === "the"))!;
    const codeIdentity = identities.find(identity => identity.closedClass.some(row => row.word === "const"))!;
    const frenchIdentity = identities.find(identity => identity.closedClass.some(row => row.word === "le"))!;
    expect(selectLanguageIdentityForSurface(identities, "When was Albert Einstein born?")?.identity).toBe(english);
    expect(selectLanguageIdentityForSurface(identities, "export const kernel: string")?.identity).toBe(codeIdentity);
    expect(selectLanguageIdentityForSurface(identities, "Quelle est la capitale de la France?")?.identity).toBe(frenchIdentity);
    // No learned symbol distinguishes these identities, so retain uncertainty rather than choosing the largest.
    expect(selectLanguageIdentityForSurface(identities, "Apollo 11 commander")).toBeUndefined();
  });

  it("routes natural-language questions away from a better-matching symbolic identity without losing code identity access", () => {
    const observedProseClass = ENGLISH.filter(word => word !== "for");
    const observedCodeClass = ["const", "for", "string", "return", "from", "number", "type", "import", "export", "function"];
    const prose = corpus("wikipedia", 20, observedProseClass, [["rabbit", "carry", "white"], ["captain", "ship", "pequod"]], undefined, "prose", CORPUS_ROLE_IDS.encyclopedic);
    const symbolic = corpus("files", 12, observedCodeClass, [["rabbit", "carry", "white"], ["captain", "ship", "pequod"]], undefined, "code", CORPUS_ROLE_IDS.softwareSymbolic);
    const identities = discoverLanguageIdentities({ signatures: [...prose, ...symbolic], hasher, now: 1 }).identities;
    const request = "What does White Rabbit carry for?";
    const codeIdentity = identities.find(identity => identity.corpusRoles.some(role => role.corpusRoleId === CORPUS_ROLE_IDS.softwareSymbolic))!;
    const proseIdentity = identities.find(identity => identity.corpusRoles.some(role => role.corpusRoleId === CORPUS_ROLE_IDS.encyclopedic))!;

    // The observed overlap that caused the live route: `for` is code closed-class material while the English
    // closed class has zero coverage. The general selector still recognizes the code surface when requested.
    expect(selectLanguageIdentityForSurface(identities, request)?.identity).toBe(codeIdentity);
    // Request-language eligibility excludes only the typed symbolic population; with one natural identity for this
    // observed script, the existing singleton contract resolves even when its closed-class coverage is zero.
    expect(selectLanguageIdentityForSurface(identities, request, {
      excludeCorpusRoleIds: [CORPUS_ROLE_IDS.softwareSymbolic]
    })?.identity).toBe(proseIdentity);
    expect(selectLanguageIdentityForSurface([codeIdentity], request, {
      excludeCorpusRoleIds: [CORPUS_ROLE_IDS.softwareSymbolic]
    })).toBeUndefined();
    expect(selectLanguageIdentityForSurface(identities, "export const kernel: string")?.identity).toBe(codeIdentity);
  });

  it("does not guess among multiple natural languages with zero closed-class coverage", () => {
    const prose = corpus("wikipedia", 20, ENGLISH.filter(word => word !== "for"), [["river", "county"], ["school", "senate"]], undefined, "prose", CORPUS_ROLE_IDS.encyclopedic);
    const codeRows = corpus("files", 12, CODE, [["rabbit", "carry", "white"]], undefined, "code", CORPUS_ROLE_IDS.softwareSymbolic);
    const frenchRows = corpus("frwiki", 12, FRENCH, [["lapin", "porter", "blanc"]], undefined, "french", CORPUS_ROLE_IDS.encyclopedic);
    const identities = discoverLanguageIdentities({ signatures: [...prose, ...codeRows, ...frenchRows], hasher, now: 1 }).identities;
    expect(selectLanguageIdentityForSurface(identities, "What does White Rabbit carry for?", {
      excludeCorpusRoleIds: [CORPUS_ROLE_IDS.softwareSymbolic]
    })).toBeUndefined();
  });

  it("uses learned form-word prevalence instead of corpus size to resolve equal coverage", () => {
    const identity = (id: string, profileCount: number, documentShare: number): LanguageIdentityRecord => ({
      schema: "scce.language_identity.v2",
      id,
      script: "script:Latn",
      directions: [{ direction: "ltr", count: profileCount }],
      closedClass: [{ word: "forma", documentShare }],
      families: [],
      corpusRoles: [{ corpusRoleId: CORPUS_ROLE_IDS.encyclopedic, count: profileCount }],
      profileCount,
      membershipCut: 0,
      createdAt: 1
    } as LanguageIdentityRecord);
    const largeIncidental = identity("language.large", 1000, 0.15);
    const smallMeasured = identity("language.measured", 10, 0.9);

    expect(selectLanguageIdentityForSurface([largeIncidental, smallMeasured], "forma subject")?.identity)
      .toBe(smallMeasured);
    expect(selectLanguageIdentityForSurface([smallMeasured, identity("language.tied", 5000, 0.9)], "forma subject"))
      .toBeUndefined();
  });

  it("reads a signature from a profile's compact Kneser-Ney summary and drops apparatus symbols", () => {
    const profile = { id: "profile.x", sourceVersionId: "source.x", scripts: [{ script: "script:Latn", mass: 1 }], symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 1, createdAt: 1, kneserNey: { topContinuation: [["|", 3898], [".", 1408], ["the", 1018], ["=", 985], ["of", 714], ["<s>", 3]] } } as unknown as LanguageProfile;
    const signature = languageProfileSignature(profile, "wikipedia")!;
    expect(signature.topContinuation.map(([word]) => word)).toEqual(["the", "of"]);
    expect(closedClassPresence(signature, new Set(["the", "of", "and", "in"]))).toBe(0.5);
    expect(otsuThreshold([0.1, 0.12, 0.11, 0.9, 0.92, 0.88])).toBeGreaterThan(0.12);
  });
});
