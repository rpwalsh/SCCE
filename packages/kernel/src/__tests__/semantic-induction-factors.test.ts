// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, createClock, toJsonValue } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { compileRelationHypothesisModel } from "../relation-hypothesis.js";
import { compileSemanticInductionFactors, replaySemanticInductionFactors, semanticInductionProjection, replaySemanticInductionProjection,
  sentenceSegments, lexicalSurfaceSymbols, type SemanticInductionFactors } from "../semantic-induction-factors.js";
import { constructionSourceExampleStorageJson as exactJson } from "../construction-source-example-storage.js";
import { createLanguageInductionEngine, type LanguageInductionDocument, type LexicalClass } from "../language-induction.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "../language-induction-memory.js";
import type { EvidenceId, LanguageProfile, SourceVersionId, JsonValue } from "../types.js";

const hasher = createHasher(), cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture() {
  const documents: LanguageInductionDocument[] = [
    { id: "doc\u0000甲", sourceFamilyId: "family.one", text: "甲 f9 乙。\n丙 f9 丁。 🧪e\u0301 f9 甲。", trust: 0.23,
      evidenceIds: ["evidence.甲", "evidence.shared"] as EvidenceId[], sourceWindow: { ownerDocumentId: "source\u0000甲", startUtf16: 17, endUtf16: 57 } },
    { id: "doc.乙", sourceFamilyId: "family.two", text: "乙 f9 丙。 丁 f9 甲。 e\u0301 f9 🧪。", trust: 0.91, evidenceIds: ["evidence.乙"] as EvidenceId[] },
    { id: "doc.number", text: "42", evidenceIds: ["evidence.number"] as EvidenceId[] }
  ];
  const lexicalClasses: LexicalClass[] = Array.from({ length: 129 }, (_, i) => ({ id: `class.${i}`,
    members: (i === 128 ? ["甲", "乙", "丙", "丁"] : [`unmatched.${i}`]).map(symbol => ({ symbol, scriptId: "script.opaque", count: 1 })),
    contextSupport: 1, cohesion: 0.5, exampleContexts: ["opaque _ opaque"] }));
  const relationModel = compileRelationHypothesisModel({ hasher, observations: documents.flatMap(doc => sentenceSegments(doc.text, hasher).map((sentence, i) => ({
    sourceId: doc.sourceFamilyId ?? doc.id, symbols: lexicalSurfaceSymbols(sentence, `${doc.id}.relation.${i}`, hasher)
      .filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char))), evidenceIds: doc.evidenceIds })) ) });
  const factors = compileSemanticInductionFactors({ documents, relationModel, lexicalClasses, maxFrames: 2048, hasher });
  return { documents, lexicalClasses, relationModel, factors };
}
function resign(factors: SemanticInductionFactors) {
  const { digest: _digest, ...material } = factors; factors.digest = hasher.digestHex(exactJson(material)); return factors;
}

describe("semantic induction sufficient factors", () => {
  it("matches the frozen pre-extraction ordered reducer including every Float64, ID, evidence and source window", () => {
    const { factors, relationModel } = fixture(), replayed = replaySemanticInductionFactors({ factors: cold(factors), hasher });
    // Frozen from the original language-induction.ts reducer, before it was moved here.
    expect(hasher.digestHex(exactJson(replayed))).toBe("e134cdc933b8a2911107982669c41762d3342517fe9855a540207a6fb167a988");
    expect(replayed.relationHypothesisModel).toEqual(relationModel);
    expect(replayed.semanticFrames).toHaveLength(6);
    expect(replayed.graphBoundConstructions.some(graph => graph.slots.some(slot => slot.lexicalClassId === "class.128"))).toBe(true);
    expect(replayed.graphBoundConstructions.some(graph => graph.sourceWindows?.some(window => window.ownerDocumentId.includes("\u0000")))).toBe(true);
    expect(factors.sentences.find(row => row.sentence === "42")?.hypotheses).toEqual([]);
    expect(factors.sentences.find(row => row.sentence === "42")?.symbols).toEqual(["42"]);
  });

  it("captures each posterior once and owns snapshots without recomputing a learner on cold restore", () => {
    const { factors, documents, lexicalClasses } = fixture(), original = cold(factors);
    documents[0]!.text = "changed"; documents[0]!.evidenceIds!.push("foreign" as EvidenceId); lexicalClasses[128]!.members[0]!.symbol = "foreign";
    expect(factors).toEqual(original);
    const first = replaySemanticInductionFactors({ factors, hasher });
    first.semanticFrames[0]!.roles[0]!.count = 99;
    expect(replaySemanticInductionFactors({ factors, hasher }).semanticFrames[0]!.roles[0]!.count).not.toBe(99);
    expect(factors).toEqual(original);
    for (const row of factors.sentences) expect(new Set(row.hypotheses.map(hypothesis => hypothesis[0])).size).toBe(row.hypotheses.length);
  });

  it("preserves exact projected ID order and full lexical lookup knowledge beyond the existing 128-row projection", () => {
    const { factors } = fixture(), replayed = replaySemanticInductionFactors({ factors, hasher });
    const selected = { semanticFrames: replayed.semanticFrames.slice(1, 4).reverse(), graphBoundConstructions: replayed.graphBoundConstructions.slice(0, 2).reverse(),
      lexicalClasses: replayed.lexicalClasses.slice(0, 128), relationHypothesisModel: replayed.relationHypothesisModel };
    const projection = semanticInductionProjection({ factors, ...selected, hasher });
    expect(projection.factors.lexicalClasses).toHaveLength(129);
    expect(replaySemanticInductionProjection({ projection: cold(projection), hasher })).toEqual(toJsonValue(selected));
    for (const mutate of [
      (p: typeof projection) => { p.factors.sentences[0]!.hypotheses[0]![1] = 0.123; },
      (p: typeof projection) => { p.factors.sentences[0]!.hypotheses[0]![1] = 0.123; resign(p.factors); },
      (p: typeof projection) => { p.frameIds.reverse(); },
      (p: typeof projection) => { p.graphIds.push("foreign"); },
      (p: typeof projection) => { p.expectedDerivedDigest = "changed"; }
    ]) {
      const changed = cold(projection); mutate(changed);
      expect(() => replaySemanticInductionProjection({ projection: changed, hasher })).toThrow(/semantic induction/u);
    }
  });

  it("rejects unknown markers, malformed hypotheses, duplicate positions, changed source identities and reordered documents", () => {
    const { factors } = fixture();
    for (const mutate of [
      (p: SemanticInductionFactors) => { p.schema = "unknown" as typeof p.schema; },
      (p: SemanticInductionFactors) => { p.documents[0]!.sourceId = "foreign"; },
      (p: SemanticInductionFactors) => { p.sentences[0]!.hypotheses[0]![0] = 99999; resign(p); },
      (p: SemanticInductionFactors) => { p.sentences[0]!.hypotheses.push(cold(p.sentences[0]!.hypotheses[0]!)); resign(p); },
      (p: SemanticInductionFactors) => { p.sentences.reverse(); resign(p); }
    ]) {
      const changed = cold(factors); mutate(changed);
      expect(() => replaySemanticInductionFactors({ factors: changed, hasher })).toThrow(/semantic induction/u);
    }
    const unsafe = { ...factors, get extension() { throw Error("getter evaluated"); } };
    expect(() => replaySemanticInductionFactors({ factors: unsafe, hasher })).toThrow("invalid semantic induction factors");
  });

  it("carries measured factors through the real producer and memory projector while retaining the public logical fields", () => {
    const sourceVersionId = "source.fixture" as SourceVersionId;
    const model = createLanguageInductionEngine({ hasher }).induce({ documents: [{ id: "doc.fixture", sourceVersionId,
      text: "Ada visits London. Eve visits Paris. Ada visits Paris.", evidenceIds: ["evidence.fixture" as EvidenceId] }] });
    expect(model.semanticInductionFactors).toBeDefined();
    const profile: LanguageProfile = { id: "profile.fixture", sourceVersionId, scripts: [], symbolShapes: [], charNgrams: [], direction: "unknown", entropy: 0, createdAt: 1 };
    const idFactory = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
    const projected = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory, updatedAt: 1 });
    const semantic = projected.patterns.map(row => row.patternJson as Record<string, JsonValue>).find(row => row.schema === "scce.induced_language_model.semantic_memory.v1")!;
    expect(semantic.semanticFrames).toBeDefined(); expect(semantic.graphBoundConstructions).toBeDefined(); expect(semantic.relationHypothesisModel).toBeDefined();
    expect(replaySemanticInductionProjection({ projection: cold(semantic.semanticInductionProjection), hasher })).toEqual({ semanticFrames: semantic.semanticFrames,
      graphBoundConstructions: semantic.graphBoundConstructions, lexicalClasses: semantic.lexicalClasses, relationHypothesisModel: semantic.relationHypothesisModel });
  });
});
