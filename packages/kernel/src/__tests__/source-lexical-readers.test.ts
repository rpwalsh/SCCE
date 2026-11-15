// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createHasher, createClock, toJsonValue } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { withRequestLanguageFormScope } from "../request-language-form-scope.js";
import { LEXICAL_SENSE_SCHEMA, LEXICAL_SENSE_RECIPE, verifySourceOwnedLexicalPattern, primeLexicalSemanticMemory,
  lexicalSensesForSurface, lexicalMembershipWitnesses, lexicalRelationWitnesses, lexicalAlternativesForSurface,
  lexicalLookupUnits, clearLexicalSemanticMemory } from "../lexical-semantic-memory.js";
import { LEXICAL_GRAMMAR_SCHEMA, LEXICAL_GRAMMAR_RECIPE, primeSourceLexicalGrammar, sourceLexicalLemmaWitnesses,
  sourceObservedDiscourseReference } from "../source-lexical-grammar.js";
import { SOURCE_QUESTION_FRAME_SCHEMA, SOURCE_QUESTION_FRAME_RECIPE, primeSourceQuestionFrames, sourceQuestionExpression } from "../source-question-frames.js";
import { sourceBodyAnswersRequest } from "../local-evidence-runtime.js";
import { primeLearnedAnswerUnitForms } from "../learned-answer-unit-forms.js";
import { sourceOwnedAnswerUnitForms } from "./fixtures/source-owned-answer-unit-forms.js";
import type { LanguagePatternRecord } from "../storage.js";
import type { EvidenceSpan, SourceVersion, InformationAccessContext, InformationLabel } from "../types.js";

const hasher = createHasher(), ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
const label: InformationLabel = { tenantId: "lexical.tests", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const access: InformationAccessContext = { tenantId: "lexical.tests", principalId: "lexical.tests.reader", compartments: [], maximumExportClass: "public" };
const options = { hasher, informationAccess: access };

function envelope(payload: Record<string, unknown>, key: string) {
  const lexiconId = String(payload.lexiconId ?? "lexicon.one"), language = String(payload.language ?? "language.one");
  const text = JSON.stringify(payload), raw = `\u{10400}\n${text}`, sourceText = "café \u65e5\u672c\u8a9e";
  const annotationId = ids.sourceVersionId(raw + key), sourceVersionId = ids.sourceVersionId(sourceText + key);
  const sourceId = ids.sourceId("lexical.tests", `fixture:${key}`), rawSourceId = ids.sourceId("lexical.tests", `fixture:raw:${key}`);
  const sourceTrust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
    independenceGroup: key, accessScope: "local", licenseStatus: "test" };
  const annotation: SourceVersion = { sourceId: rawSourceId, sourceVersionId: annotationId, namespace: "lexical.tests", canonicalUri: `fixture:raw:${key}`,
    contentHash: ids.contentHash(raw), mediaType: "application/json", observedAt: 1, byteLength: new TextEncoder().encode(raw).length,
    metadata: { lexiconId, language }, sourceTrust, informationLabel: label, role: "original" };
  const source: SourceVersion = { sourceId, sourceVersionId, namespace: "lexical.tests", canonicalUri: `fixture:${key}`,
    contentHash: ids.contentHash(sourceText), mediaType: "text/plain", observedAt: 1, byteLength: new TextEncoder().encode(sourceText).length,
    metadata: { lexiconId, language }, sourceTrust, informationLabel: label, role: "evidence-derivative",
    derivation: { kind: "extracted-text", transformId: "declared.test.annotation-projection.v1", derivedFromSourceVersionId: annotationId,
      originalCoordinateSpace: "source-bytes", redactionMap: [] } };
  const byteStart = new TextEncoder().encode("\u{10400}\n").length, byteEnd = annotation.byteLength, hash = ids.contentHash(text);
  const span: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId: annotationId, byteStart, byteEnd, spanHash: hash }),
    chunkId: ids.chunkId({ sourceVersionId: annotationId, byteStart, byteEnd, chunkHash: hash }), sourceId: rawSourceId,
    sourceVersionId: annotationId, contentHash: hash, mediaType: "application/json", byteStart, byteEnd,
    charStart: 2, charEnd: 2 + [...text].length, text, textPreview: text, languageHints: {}, scriptHints: {},
    trustVector: { forceClass: "direct_evidence" }, provenance: { uri: annotation.canonicalUri }, features: [], status: "promoted", alpha: 1, observedAt: 1, informationLabel: label };
  const profileId = `profile:${key}`;
  const pattern: LanguagePatternRecord = { id: `pattern:${key}`, profileId, patternKind: "semantic_role", support: 1, entropy: 0,
    updatedAt: 1, evidenceIds: [span.id], informationLabel: label,
    patternJson: toJsonValue({ ...payload, lexiconId, language, sourceId, sourceVersionId, sourceContentHash: source.contentHash,
      annotationSourceVersionId: annotationId, annotationSourceContentHash: annotation.contentHash, profileId }) };
  return { pattern, source, evidenceOwners: [annotation], evidence: [span] };
}
function seal(payload: Record<string, unknown>, key: string) {
  const verified = verifySourceOwnedLexicalPattern(envelope(payload, key), options);
  expect(verified).toBeDefined(); return verified!;
}
function sense(id: string, words: string[], definition = "", extra: Record<string, unknown> = {}) {
  return { schema: LEXICAL_SENSE_SCHEMA, componentRecipe: LEXICAL_SENSE_RECIPE, senseId: id, partOfSpeech: "n",
    entries: words.map(lemma => ({ lemma, forms: [] })), definitions: [definition], examples: [], relations: [], ...extra };
}
function grammar(lemma: string, forms: string[], extra: Record<string, unknown> = {}) {
  return { schema: LEXICAL_GRAMMAR_SCHEMA, componentRecipe: LEXICAL_GRAMMAR_RECIPE, lemma, partOfSpeech: "VERB",
    forms: forms.map(surface => ({ surface, features: {}, dependency: "root", count: 1 })), ...extra };
}
afterEach(() => { clearLexicalSemanticMemory(); primeSourceLexicalGrammar([]); primeSourceQuestionFrames([]); });

describe("source-owned lexical reader ports", () => {
  it("validates raw Unicode ranges through the exact derived-source lineage", () => {
    const input = envelope(sense("cafe", ["café", "\u8336"]), "unicode");
    const verified = verifySourceOwnedLexicalPattern(input, options)!;
    expect(primeLexicalSemanticMemory([verified])).toBe(1);
    expect(lexicalSensesForSurface("café")).toHaveLength(1);
    expect(Object.isFrozen(verified.pattern.patternJson)).toBe(true);
    input.pattern.patternJson = {};
    expect(primeLexicalSemanticMemory([verified])).toBe(1);
    expect(primeLexicalSemanticMemory([input.pattern])).toBe(0);
    expect(primeLexicalSemanticMemory([{ ...verified }])).toBe(0);
  });

  it.each(["missing", "quarantined", "hash", "bytes", "codepoints", "source", "lineage", "rawhash", "derivedhash", "profile", "label", "access"])("rejects %s owner/evidence mismatches", failure => {
    const input = envelope(sense("one", ["a", "b"]), failure);
    if (failure === "missing") input.evidence = [];
    if (failure === "quarantined") input.evidence[0]!.status = "quarantined";
    if (failure === "hash") input.evidence[0]!.text += "x";
    if (failure === "bytes") input.evidence[0]!.byteEnd++;
    if (failure === "codepoints") input.evidence[0]!.charEnd++;
    if (failure === "source") input.evidence[0]!.sourceId = ids.sourceId("foreign", "owner");
    if (failure === "lineage") input.source.derivation!.derivedFromSourceVersionId = ids.sourceVersionId("foreign");
    if (failure === "rawhash") input.evidenceOwners[0]!.contentHash = ids.contentHash("foreign");
    if (failure === "derivedhash") input.source.contentHash = ids.contentHash("foreign");
    if (failure === "profile") input.pattern.profileId = "foreign";
    if (failure === "label") input.evidence[0]!.informationLabel = { ...label, tenantId: "foreign" };
    if (failure === "access") {
      const privateLabel: InformationLabel = { ...label, exportClass: "confidential", principals: ["another.reader"] };
      input.source.informationLabel = input.evidenceOwners[0]!.informationLabel = input.evidence[0]!.informationLabel = input.pattern.informationLabel = privateLabel;
    }
    expect(verifySourceOwnedLexicalPattern(input, options)).toBeUndefined();
  });

  it("requires the complete inventory rather than one supporting annotation", () => {
    const input = envelope(sense("one", ["a", "b"]), "inventory");
    input.pattern.evidenceIds.push(ids.evidenceId({ sourceVersionId: input.evidence[0]!.sourceVersionId, byteStart: 0, byteEnd: 1, spanHash: ids.contentHash("x") }));
    expect(verifySourceOwnedLexicalPattern(input, options)).toBeUndefined();
  });
});

describe("lexical candidate membership", () => {
  it("uses canonical source-learned morphology witnesses for relation forms", () => {
    const teaching = sourceOwnedAnswerUnitForms("walla r0. wallawalla r0. tinu r0. tinutinu r0. kobo r0. kobokobo r0.");
    expect(lexicalRelationWitnesses("walla", "wallawalla", "")).toEqual([]);
    try {
      teaching.prime();
      const witnesses = lexicalRelationWitnesses("walla", "wallawalla", "");
      expect(witnesses.length).toBeGreaterThan(0);
      const sourcePatternIds = new Set(teaching.projection.patterns.map(pattern => pattern.id));
      expect(witnesses.every(id => sourcePatternIds.has(id))).toBe(true);
      expect(lexicalRelationWitnesses("walla", "tinu", "")).toEqual([]);
    } finally { primeLearnedAnswerUnitForms({ deltas: [], profileIds: new Set() }); }
  });
  it("qualifies identity by lexicon and language and never equates colliding IDs", () => {
    expect(primeLexicalSemanticMemory([seal(sense("shared", ["alpha"], "", { lexiconId: "one" }), "a"),
      seal(sense("shared", ["beta"], "", { lexiconId: "two" }), "b"),
      seal(sense("shared", ["gamma"], "", { lexiconId: "one", language: "language.two" }), "c")])).toBe(3);
    expect(lexicalMembershipWitnesses("alpha", "beta", "")).toEqual([]);
    expect(lexicalMembershipWitnesses("alpha", "gamma", "")).toEqual([]);
  });

  it("preserves zero-score and positive-score ambiguity on both sides", () => {
    primeLexicalSemanticMemory([seal(sense("river", ["bank", "shore"], "river edge"), "river"),
      seal(sense("money", ["bank", "lender"], "money deposits"), "money"),
      seal(sense("other", ["shore", "brace"], "construction brace"), "brace")]);
    expect(lexicalMembershipWitnesses("bank", "shore", "")).toEqual([]);
    expect(lexicalMembershipWitnesses("bank", "shore", "river money")).toEqual([]);
    expect(lexicalMembershipWitnesses("bank", "shore", "construction")).toEqual([]);
    const match = lexicalMembershipWitnesses("bank", "shore", "river edge");
    expect(match).toMatchObject([{ senseId: "river", usage: "retrieval_expansion", patternIds: ["pattern:river"] }]);
    expect(match[0]!.evidenceIds).toHaveLength(1);
  });

  it("does not traverse overlapping senses, antonymy or hypernymy as equality", () => {
    primeLexicalSemanticMemory([seal(sense("one", ["hot", "heated"], "temperature", { relations: [{ type: "antonym", target: "two" }] }), "hot"),
      seal(sense("two", ["cold", "chilled"], "temperature"), "cold"), seal(sense("three", ["heated", "angry"], "emotion"), "angry")]);
    expect(lexicalMembershipWitnesses("hot", "cold", "temperature")).toEqual([]);
    expect(lexicalMembershipWitnesses("hot", "angry", "emotion")).toEqual([]);
  });

  it("uses the same full-word Unicode lookup units for indexed forms and requests", () => {
    expect(lexicalLookupUnits("\uff26\uff2f\uff2f take place \u65e5\u672c\u8a9e foo")).toEqual(["foo", "take", "place", "\u65e5\u672c\u8a9e"]);
    primeLexicalSemanticMemory([seal(sense("event", ["take place", "happen", "\uff26\uff2f\uff2f"]), "event")]);
    expect(lexicalSensesForSurface("take   place")).toHaveLength(1);
    expect(lexicalSensesForSurface("foo")).toHaveLength(1);
    expect(lexicalSensesForSurface("place")).toEqual([]);
    expect(lexicalAlternativesForSurface("happen")).toContain("take place");
  });

  it("keeps synonym membership from certifying predicate roles at actual answer admission", () => {
    primeLexicalSemanticMemory([seal(sense("intentionally-shared", ["won", "awarded"], "medal", { partOfSpeech: "v" }), "role")]);
    expect(lexicalMembershipWitnesses("won", "awarded", "medal")).toHaveLength(1);
    expect(lexicalRelationWitnesses("won", "awarded", "medal")).toEqual([]);
    const input = envelope({}, "world-source"), span = input.evidence[0]!;
    const source = { ...span, text: "Mira awarded the medal to Theo.", textPreview: "Mira awarded the medal to Theo.",
      provenance: { title: "Mira", identity: "Mira" }, features: ["mira", "awarded", "medal", "theo"] };
    expect(sourceBodyAnswersRequest(source, "Who won the medal from Mira?", new Set(["who", "the", "from"]))).toBe(false);
    expect(sourceBodyAnswersRequest(source, "Did Mira win the medal from Theo?", new Set(["did", "the", "from"]))).toBe(false);
  });
});

describe("source-observed lexical grammar", () => {
  it("requires one owned annotation group for both forms", () => {
    primeSourceLexicalGrammar([seal(grammar("write", ["write", "wrote"]), "write")]);
    expect(sourceLexicalLemmaWitnesses("write", "wrote")).toEqual(["pattern:write"]);
    expect(sourceLexicalLemmaWitnesses("write", "written")).toEqual([]);
    primeSourceLexicalGrammar([seal(grammar("verb", ["left"], { lexiconId: "one" }), "left"),
      seal(grammar("verb", ["right"], { lexiconId: "two" }), "right")]);
    expect(sourceLexicalLemmaWitnesses("left", "right")).toEqual([]);
  });

  it("uses annotation features without manufacturing references or equivalent forms", () => {
    primeSourceLexicalGrammar([seal(grammar("\u5f7c", ["\u5f7c"], { partOfSpeech: "PRON", forms: [
      { surface: "\u5f7c", features: { Person: "3", PronType: "Prs" }, dependency: "nsubj", count: 1 }] }), "pronoun")]);
    expect(sourceObservedDiscourseReference("\u5f7c")).toBe(true);
    expect(sourceObservedDiscourseReference("\u5f7c\u5973")).toBe(false);
  });

  it("isolates lexical state across request scopes", async () => {
    const a = seal(grammar("uno", ["unos"]), "uno");
    primeSourceLexicalGrammar([a]);
    await withRequestLanguageFormScope(async () => {
      expect(sourceLexicalLemmaWitnesses("uno", "unos")).toEqual([]);
      primeSourceLexicalGrammar([a]);
      expect(sourceLexicalLemmaWitnesses("uno", "unos")).toEqual(["pattern:uno"]);
    });
    expect(sourceLexicalLemmaWitnesses("uno", "unos")).toEqual(["pattern:uno"]);
  });
});



describe("source-owned copular question frames", () => {
  const frame = (prefix: string, suffix: string) => ({ schema: SOURCE_QUESTION_FRAME_SCHEMA,
    componentRecipe: SOURCE_QUESTION_FRAME_RECIPE, prefix, suffix });
  it("requires the opaque verified owner and rejects serialized or copied proof", () => {
    const input = envelope(frame("Qu\u00e9 es ", "?"), "question.owner");
    expect(primeSourceQuestionFrames([input.pattern])).toBe(0);
    const verified = verifySourceOwnedLexicalPattern(input, options)!;
    expect(primeSourceQuestionFrames([verified])).toBe(1);
    expect(sourceQuestionExpression("QU\u00c9 es 2 + 3? ")?.expression).toBe("2 + 3");
    expect(primeSourceQuestionFrames([{ ...verified }, JSON.parse(JSON.stringify(verified))])).toBe(0);
    expect(sourceQuestionExpression("Qu\u00e9 es 2 + 3?")).toBeUndefined();
    input.evidence[0]!.status = "quarantined";
    expect(verifySourceOwnedLexicalPattern(input, options)).toBeUndefined();
  });
  it("isolates cold requests and preserves Unicode and complete-request boundaries", async () => {
    const verified = seal(frame("Qu\u00e9 es ", "?"), "question.scope");
    primeSourceQuestionFrames([verified]);
    await withRequestLanguageFormScope(async () => {
      expect(sourceQuestionExpression("Qu\u00e9 es 2 + 3?")).toBeUndefined();
      expect(primeSourceQuestionFrames([verified])).toBe(1);
      expect(sourceQuestionExpression("QUE\u0301 es \u8336? ")?.expression).toBe("\u8336");
      expect(sourceQuestionExpression("prefix Qu\u00e9 es 2 + 3?")).toBeUndefined();
      expect(sourceQuestionExpression("Qu\u00e9 es 2 + 3? suffix")).toBeUndefined();
      expect(sourceQuestionExpression("Qu\u00e9 es ?")).toBeUndefined();
    });
    await withRequestLanguageFormScope(async () => {
      expect(sourceQuestionExpression("Qu\u00e9 es 2 + 3?")).toBeUndefined();
    });
  });
  it("refuses conflicting extracted expressions and empty observed controls", () => {
    expect(primeSourceQuestionFrames([seal(frame("What is ", "?"), "question.a"),
      seal(frame("What ", "?"), "question.b"), seal(frame("", ""), "question.empty")])).toBe(2);
    expect(sourceQuestionExpression("What is 2 + 3?")).toBeUndefined();
  });
});
