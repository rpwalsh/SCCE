// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { compileRelationHypothesisModel } from "../relation-hypothesis.js";
import { compileSemanticInductionFactors, lexicalSurfaceSymbols, sentenceSegments,
  replaySemanticInductionFactors, type SemanticInductionFactors } from "../semantic-induction-factors.js";
import { compileSemanticRelationReplayV2, reduceSemanticRelationReplayV2, replaySemanticRelationsV2,
  replaySemanticRelationsFromTrainingV2,
  evaluateSemanticRelationReplayV2, type SemanticRelationReplayResultV2 } from "../semantic-relation-replay-v2.js";
import { constructionSourceExampleStorageJson as exactJson } from "../construction-source-example-storage.js";
import type { EvidenceId } from "../types.js";

const hasher = createHasher();
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function factorsFor(texts: string[]): SemanticInductionFactors {
  const documents = texts.map((text, index) => ({ id: `doc.${index}`, text, sourceFamilyId: `source.${index}`,
    evidenceIds: [`evidence.${index}` as EvidenceId], trust: (index % 5) / 5,
    sourceWindow: { ownerDocumentId: `owner.${index}`, startUtf16: index * 100, endUtf16: index * 100 + text.length } }));
  const relationModel = compileRelationHypothesisModel({ hasher, observations: documents.flatMap(doc =>
    sentenceSegments(doc.text, hasher).map(sentence => ({ sourceId: doc.sourceFamilyId,
      symbols: lexicalSurfaceSymbols(sentence, doc.id, hasher).filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char))),
      evidenceIds: doc.evidenceIds }))) });
  return compileSemanticInductionFactors({ documents, relationModel, lexicalClasses: [], maxFrames: 128, hasher });
}
const corpus = [
  "the cat repairs the boat.", "the dog repairs the bridge.",
  "the bird repairs the house.", "the fox repairs the car.",
  "the boat repairs the cat.", "the bridge repairs the dog."
];
function assertLocal(result: SemanticRelationReplayResultV2, factors: SemanticInductionFactors) {
  for (const relation of result.relations) {
    const row = factors.sentences[relation.sentenceIndex]!, doc = factors.documents[row.documentIndex]!;
    expect(relation.documentId).toBe(doc.id);
    expect(relation.sourceId).toBe(doc.sourceId);
    expect(relation.evidenceIds).toEqual(doc.evidenceIds);
    expect(relation.sourceWindow).toEqual(doc.sourceWindow);
    expect(relation.trust).toBe(doc.trust);
    for (const span of [relation.predicate, ...relation.roles]) {
      expect(span.surface).toBe(row.sentence.slice(span.sentenceStartUtf16, span.sentenceEndUtf16));
      expect(span.symbols).toEqual(row.symbols.slice(span.symbolStart, span.symbolEnd));
      expect(span.symbolEnd).toBeGreaterThan(span.symbolStart);
    }
    expect(new Set(relation.roles.map(role => role.roleType))).toEqual(new Set(["participant_candidate"]));
    expect(relation.status).toBe("source_bound_candidate");
  }
}

describe("experimental source-bound semantic relation replay v2", () => {
  it("ranks content relations above a frequent repeated function token using retained corpus counts", () => {
    const factors = factorsFor(corpus), plan = compileSemanticRelationReplayV2({ factors, hasher });
    const content = plan.statistics.find(row => row.surface === "repairs")!;
    const common = plan.statistics.find(row => row.surface === "the")!;
    expect(common.occurrences).toBe(content.occurrences * 2);
    expect(common.repeatedWithinSentence).toBe(true);
    expect(content.score).toBeGreaterThan(common.score);
    const result = reduceSemanticRelationReplayV2({ factors: cold(factors), plan: cold(plan), hasher });
    expect(result.relations.map(row => row.predicate.symbols[0])).toEqual(corpus.map(() => "repairs"));
    assertLocal(result, factors);
  });

  it("keeps roles local and contiguous without combining observations or inventing directed agents", () => {
    const factors = factorsFor(corpus), result = replaySemanticRelationsV2({ factors, hasher });
    expect(result.relations[0]!.roles.map(role => role.surface)).toEqual(["the cat", "the boat"]);
    expect(result.relations[4]!.roles.map(role => role.surface)).toEqual(["the boat", "the cat"]);
    expect(result.relations[0]!.roles.map(role => role.roleType)).toEqual(result.relations[4]!.roles.map(role => role.roleType));
    expect(result.relations[0]!.evidenceIds).toEqual(["evidence.0"]);
    expect(result.relations[4]!.evidenceIds).toEqual(["evidence.4"]);
    expect(exactJson(result)).not.toMatch(/acts_on|arg0|arg1|has_predicate/u);
    assertLocal(result, factors);
  });

  it("retains separate predicate occurrences with punctuation-bounded roles in the same source sentence", () => {
    const factors = factorsFor([...corpus, "the cat repairs the boat, the dog repairs the bridge."]);
    const result = replaySemanticRelationsV2({ factors, hasher });
    const occurrences = result.relations.filter(row => row.documentId === "doc.6");
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map(row => row.roles.map(role => role.surface))).toEqual([
      ["the cat", "the boat"], ["the dog", "the bridge"]
    ]);
    expect(new Set(occurrences.map(row => row.id)).size).toBe(2);
    expect(occurrences[0]!.predicate.symbolStart).toBeLessThan(occurrences[1]!.predicate.symbolStart);
    assertLocal(result, factors);
  });

  it("retains distinct corpus-supported relations in separate punctuation components", () => {
    const texts = [...corpus, "the cat paints the wall.", "the dog paints the gate.",
      "the bird paints the roof.", "the cat repairs the boat, the dog paints the gate."];
    const factors = factorsFor(texts), result = replaySemanticRelationsV2({ factors, hasher });
    const relations = result.relations.filter(row => row.documentId === `doc.${texts.length - 1}`);
    expect(relations.map(row => row.predicate.surface)).toEqual(["repairs", "paints"]);
    expect(relations.map(row => row.roles.map(role => role.surface))).toEqual([
      ["the cat", "the boat"], ["the dog", "the gate"]
    ]);
  });

  it("admits corpus-supported predicates at either sentence boundary without an order heuristic", () => {
    for (const texts of [
      ["boats Alice repairs.", "bridges Boris repairs.", "houses Cora repairs."],
      ["repairs Alice boats.", "repairs Boris bridges.", "repairs Cora houses."]
    ]) {
      const factors = factorsFor(texts), result = replaySemanticRelationsV2({ factors, hasher });
      expect(result.relations).toHaveLength(3);
      expect(result.relations.map(row => row.predicate.surface)).toEqual(texts.map(() => "repairs"));
    }
  });

  it("abstains on structurally tied surfaces instead of breaking ties by spelling", () => {
    const factors = factorsFor(["x aa y bb z.", "u aa v bb w.", "p aa q bb r."]);
    const result = replaySemanticRelationsV2({ factors, hasher });
    expect(result.relations).toEqual([]);
    expect(result.abstainedSentenceIndices).toEqual([0, 1, 2]);
  });

  it("applies a validated corpus plan without learning from the target sentence", () => {
    const trainingFactors = factorsFor(corpus);
    const targetFactors = factorsFor(["the otter repairs the dam."]);
    const result = replaySemanticRelationsFromTrainingV2({ trainingFactors, targetFactors, hasher });
    expect(result.relations.map(row => row.predicate.surface)).toEqual(["repairs"]);
    expect(result.relations[0]!.roles.map(role => role.surface)).toEqual(["the otter", "the dam"]);

    const unseen = replaySemanticRelationsFromTrainingV2({
      trainingFactors, targetFactors: factorsFor(["the otter paints the dam."]), hasher
    });
    expect(unseen.relations).toEqual([]);
    expect(unseen.abstainedSentenceIndices).toEqual([0]);
  });

  it("is neutral to active/passive-like order and corpus reversal rather than mapping order to semantic force", () => {
    const active = factorsFor(["Alice repairs boats.", "Boris repairs bridges.", "Cora repairs houses."]);
    const reverse = factorsFor(["boats repairs Alice.", "bridges repairs Boris.", "houses repairs Cora."]);
    const a = compileSemanticRelationReplayV2({ factors: active, hasher });
    const b = compileSemanticRelationReplayV2({ factors: reverse, hasher });
    expect(a.statistics.find(row => row.surface === "repairs")!.score).toBe(b.statistics.find(row => row.surface === "repairs")!.score);
    const first = replaySemanticRelationsV2({ factors: active, hasher }).relations[0]!;
    const second = replaySemanticRelationsV2({ factors: reverse, hasher }).relations[0]!;
    expect(first.predicate.symbols).toEqual(second.predicate.symbols);
    expect(first.roles.map(role => role.symbols.join(" ")).sort()).toEqual(second.roles.map(role => role.symbols.join(" ")).sort());
    // An actual passive surface remains observational; no English auxiliary/voice rules are embedded.
    const passive = replaySemanticRelationsV2({ factors: factorsFor([...corpus, "the boat is repaired by the cat."]), hasher });
    expect(passive.relations.every(row => row.roles.every(role => role.roleType === "participant_candidate"))).toBe(true);
  });

  it("retains possessive/appositive surfaces without turning Alice or a possessive marker into an owner claim", () => {
    const texts = ["Alice ... our cat Dinah.", "Dinah’s our cat.",
      "Boris called that cat Felix.", "Cora called this cat Milo.",
      "Dara called a cat Nala.", "Eve called her cat Luna.", "Faye called his cat Oscar."];
    const factors = factorsFor(texts), result = replaySemanticRelationsV2({ factors, hasher });
    const appositive = result.relations.find(row => row.documentId === "doc.0")!;
    const possessive = result.relations.find(row => row.documentId === "doc.1")!;
    expect(appositive.predicate.symbols).toEqual(["cat"]);
    expect(appositive.roles.some(role => role.surface === "Dinah")).toBe(true);
    expect(appositive.roles.some(role => role.surface.includes("Alice"))).toBe(false);
    expect(possessive.predicate.symbols).toEqual(["cat"]);
    expect(possessive.roles.some(role => role.surface.includes("Dinah"))).toBe(true);
    expect(exactJson(result)).not.toMatch(/"owner"|"subject"|"agent"|"patient"/u);
    assertLocal(result, factors);
  });

  it("uses identical rules for CJK, Arabic and arbitrary renamed vocabulary", () => {
    for (const texts of [
      ["小王连接北京。", "小李连接上海。", "小林连接南京。"],
      ["سارة تربط بغداد.", "علي تربط القاهرة.", "نور تربط دمشق."],
      ["ζα κξ λπ.", "βη κξ μρ.", "γθ κξ νσ."]
    ]) {
      const factors = factorsFor(texts), result = replaySemanticRelationsV2({ factors, hasher });
      expect(result.relations).toHaveLength(3);
      expect(new Set(result.relations.map(row => row.predicate.symbols[0])).size).toBe(1);
      assertLocal(result, factors);
    }
    const renamed = factorsFor(corpus.map(text => text.replaceAll("the", "ع").replaceAll("repairs", "λ")));
    const plan = compileSemanticRelationReplayV2({ factors: renamed, hasher });
    expect(plan.statistics.find(row => row.surface === "λ")!.score).toBeGreaterThan(plan.statistics.find(row => row.surface === "ع")!.score);
  });

  it("excludes pure punctuation, code operators, numeric tokens and emoji, and respects punctuation barriers", () => {
    const factors = factorsFor([...corpus, "42 += === 🧪 ;", "Alice(repairs) boats; Bob => bridges."]);
    const result = replaySemanticRelationsV2({ factors, hasher });
    expect(result.abstainedSentenceIndices.some(index => factors.sentences[index]!.sentence.startsWith("42"))).toBe(true);
    expect(result.relations.every(row => /\p{Letter}/u.test(row.predicate.surface))).toBe(true);
    const code = result.relations.find(row => row.sentence.startsWith("Alice("));
    expect(code).toBeUndefined();
    assertLocal(result, factors);
  });

  it("owns snapshots, is deterministic after cold restore, leaves every v1 output unchanged, and fingerprints every version", () => {
    const factors = factorsFor(corpus), frozen = cold(factors);
    const v1 = replaySemanticInductionFactors({ factors, hasher });
    const plan = compileSemanticRelationReplayV2({ factors, hasher });
    const first = reduceSemanticRelationReplayV2({ factors, plan, hasher });
    expect(replaySemanticRelationsV2({ factors: cold(factors), hasher })).toEqual(first);
    expect(evaluateSemanticRelationReplayV2({ factors, hasher }).replayFingerprint).toBe(first.fingerprint);
    first.relations[0]!.evidenceIds.push("foreign" as EvidenceId);
    first.relations[0]!.roles[0]!.symbols.push("foreign");
    expect(replaySemanticRelationsV2({ factors, hasher }).relations[0]!.evidenceIds).toEqual(["evidence.0"]);
    expect(factors).toEqual(frozen);
    expect(replaySemanticInductionFactors({ factors, hasher })).toEqual(v1);
    for (const key of ["compiler", "reducer", "schema", "fingerprint", "factorsDigest"] as const) {
      const bad = cold(plan); bad[key] = "wrong" as never;
      expect(() => reduceSemanticRelationReplayV2({ factors, plan: bad, hasher })).toThrow(/semantic relation replay/u);
    }
    const bad = cold(plan); bad.statistics[0]!.score += 1;
    const { fingerprint: _, ...body } = bad; bad.fingerprint = hasher.digestHex(exactJson(body));
    expect(() => reduceSemanticRelationReplayV2({ factors, plan: bad, hasher })).toThrow(/semantic relation replay/u);
  });

  it("rejects limits, tampered factors, segmentation drift and foreign source ownership without partial output", () => {
    const factors = factorsFor(corpus);
    for (const limits of [{ maxSentences: 1 }, { maxSymbolsPerSentence: 1 }, { maxUtf16: 1 }, { maxRelations: 1 }, { maxRoleSymbols: 0 }]) {
      expect(() => replaySemanticRelationsV2({ factors, limits, hasher })).toThrow();
    }
    const plan = compileSemanticRelationReplayV2({ factors, hasher });
    const changed = cold(factors); changed.documents[0]!.evidenceIds = ["foreign" as EvidenceId];
    expect(() => reduceSemanticRelationReplayV2({ factors: changed, plan, hasher })).toThrow();
    const drift = cold(factors); drift.sentences[0]!.symbols[0] = "foreign";
    const { digest: _, ...body } = drift; drift.digest = hasher.digestHex(exactJson(body));
    expect(() => compileSemanticRelationReplayV2({ factors: drift, hasher })).toThrow(/semantic relation replay/u);
  });
});
