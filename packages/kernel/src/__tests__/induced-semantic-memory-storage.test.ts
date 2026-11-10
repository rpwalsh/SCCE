// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeInducedSemanticMemory, decodeInducedSemanticMemory, INDUCED_SEMANTIC_FACTS_STORAGE_KEY as KEY } from "../induced-semantic-memory-storage.js";
import { canonicalDigestHex } from "../canonical-json-digest.js";
import { createClock, createHasher, toJsonValue } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageInductionEngine } from "../language-induction.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "../language-induction-memory.js";
import { requestSeedLanguagePattern } from "../request-language-hydration.js";
import type { LanguagePatternRecord } from "../storage.js";
import type { LanguageProfile } from "../types.js";

type Row = Record<string, any>;
const hasher = createHasher(), cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)), bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function facts(size: number): Row {
  const evidenceIds = ["evidence.exact.owner.abcdefghijklmnopqrstuvwxyz"], windows = Array.from({ length: size }, (_, i) => ({ ownerDocumentId: evidenceIds[0], startUtf16: i * 10, endUtf16: i * 10 + 10 }));
  const frames = Array.from({ length: size }, (_, i) => ({ id: `frame.${i}`, predicate: `predicate.${i}`, roles: Array.from({ length: 12 }, (_, j) => ({
    name: j < 6 ? "arg0" : "arg1", filler: `surface.${j}`, count: (i + 1) / 98765, salience: (i + 1) / 98765
  })), support: i / size, alphaPrior: i / size, predicateConfidence: (i + 1) / 98765, predicatePosteriorMass: (i + 1) / 98765,
  predicateAlternatives: [{ surface: "alternative", posterior: 1, energy: 0 }], examples: ["雪🧵e\u0301\u0000 observed source"], evidenceIds }));
  return { schema: "scce.induced_language_model.semantic_memory.v1", modelId: "model.exact", profileId: "profile.exact", sourceVersionId: "source.exact",
    semanticFrames: frames, graphBoundConstructions: frames.map(frame => ({ id: `construction.${frame.id}`, frameId: frame.id, predicate: frame.predicate,
      support: frame.support, evidenceIds: frame.evidenceIds, predicateSemanticRole: "predicate", sourceWindows: windows,
      slots: [{ roleId: "arg0", semanticRole: "entity", relation: "has_predicate", relationDirection: "source", observedFillers: ["surface.0"], lexicalClassId: "class.exact" }] })),
    lexicalClasses: [{ id: "class.exact", members: [{ symbol: "surface.0", support: 2 }], contextSupport: 1 }],
    relationHypothesisModel: { schema: "scce.relation_hypothesis_model.v1", id: "relation.exact", observationCount: size, sourceCount: 1,
      audit: { retained: true }, statistics: Object.fromEntries(frames.map(frame => [frame.predicate, { surface: frame.predicate, occurrenceCount: 1, sourceCount: 1,
        leftContextCount: 1, rightContextCount: 1, contextPairCount: 1, leftShapeCount: 1, rightShapeCount: 1,
        leftShapes: ["LLLL"], rightShapes: ["LLLL"], evidenceIds }])) } };
}
function pattern(value: Row): LanguagePatternRecord {
  return { id: "pattern.exact", profileId: value.profileId, patternKind: "semantic_role", support: 1, entropy: 0, evidenceIds: [], updatedAt: 1, patternJson: toJsonValue(value) };
}

describe("normalized induced semantic facts", () => {
  it("retains every ordered fact and owner while making shared window amplification linear", () => {
    const original = facts(64), before = cold(original), encoded = encodeInducedSemanticMemory(original) as Row;
    const restored = decodeInducedSemanticMemory(cold(encoded));
    expect(restored).toEqual(original);
    expect(canonicalDigestHex(restored, hasher)).toBe(canonicalDigestHex(original, hasher));
    expect(original).toEqual(before);
    expect(encoded[KEY].windows).toHaveLength(64); expect(encoded[KEY].windowLists).toHaveLength(1);
    expect(encoded[KEY].numbers.length).toBeLessThan(original.semanticFrames.length * 6);
    expect(encoded).not.toHaveProperty("semanticFrames"); expect(encoded).not.toHaveProperty("relationHypothesisModel");
    expect(requestSeedLanguagePattern(pattern(encoded))).toEqual(requestSeedLanguagePattern(pattern(original)));
    expect(encodeInducedSemanticMemory(encoded)).toBe(encoded);
    const larger = facts(128), largerEncoded = encodeInducedSemanticMemory(larger);
    expect(bytes(larger) / bytes(original)).toBeGreaterThan(3.4);
    expect(bytes(largerEncoded) / bytes(encoded)).toBeLessThan(2.5);
    expect(bytes(encoded)).toBeLessThan(bytes(original) / 3);
  });

  it("round trips a genuine human-source producer without changing its public projection", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-window-160-193.json", import.meta.url), "utf8")) as { turns: Array<{ surface: string }> };
    const text = fixture.turns[0]!.surface, ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), namespace: "semantic.facts", deterministicReplay: true });
    const sourceVersionId = ids.sourceVersionId(text), evidenceId = ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: ids.contentHash(text) });
    const model = createLanguageInductionEngine({ hasher }).induce({ documents: [{ id: "dolly.actual", text, sourceVersionId, evidenceIds: [evidenceId] }] });
    const profile: LanguageProfile = { id: "profile.actual", sourceVersionId, scripts: [], symbolShapes: [], charNgrams: [], direction: "unknown", entropy: 0, createdAt: 1 };
    const produced = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory: ids, updatedAt: 1 }).patterns
      .find(value => (value.patternJson as Row).schema === "scce.induced_language_model.semantic_memory.v1")!;
    const encoded = encodeInducedSemanticMemory(produced.patternJson);
    expect(decodeInducedSemanticMemory(cold(encoded))).toEqual(produced.patternJson);
    expect(requestSeedLanguagePattern({ ...produced, patternJson: encoded as LanguagePatternRecord["patternJson"] })).toEqual(requestSeedLanguagePattern(produced));
  });

  it("preserves extensions, null, missing members, duplicate refs and prototype-shaped names without aliases", () => {
    const value = facts(2), extension = JSON.parse('{"__proto__":{"observed":true},"constructor":null,"unicode":"雪🧵e\\u0301\\u0000"}');
    value.semanticFrames[0].extension = extension; value.semanticFrames[0].roles[0].extension = extension;
    value.semanticFrames[0].examples.push(value.semanticFrames[0].examples[0]);
    value.graphBoundConstructions[0].sourceWindows.push(value.graphBoundConstructions[0].sourceWindows[0]);
    Object.defineProperty(value.relationHypothesisModel.statistics, "__proto__", { enumerable: true, value: { ...value.relationHypothesisModel.statistics["predicate.0"], surface: "__proto__" } });
    const encoded = encodeInducedSemanticMemory(value), decoded = decodeInducedSemanticMemory<Row>(cold(encoded));
    expect(decoded).toEqual(value); expect(Object.hasOwn(decoded.semanticFrames[0].extension, "__proto__")).toBe(true);
    expect(decoded.semanticFrames[0]).not.toHaveProperty("missing");
    decoded.semanticFrames[0].extension.__proto__.observed = false;
    expect(value.semanticFrames[0].extension.__proto__.observed).toBe(true);
  });

  it.each(["digest", "string", "number", "frame_ref", "window_ref", "entity_projection", "unknown_field", "duplicate_term"])("rejects corrupted %s before returning logical facts", kind => {
    const stored = cold(encodeInducedSemanticMemory(facts(2))) as Row, marker = stored[KEY];
    if (kind === "digest") marker.digest = "wrong";
    if (kind === "string") marker.strings[0] += ".wrong";
    if (kind === "number") marker.numbers[0] += 1;
    if (kind === "frame_ref") marker.constructions[0][0] = -1;
    if (kind === "window_ref") marker.windowLists[0][0] = -1;
    if (kind === "entity_projection") stored.graphBoundConstructions[0].slots[0].observedFillers = ["wrong"];
    if (kind === "unknown_field") marker.unknown = true;
    if (kind === "duplicate_term") marker.strings.push(marker.strings[0]);
    expect(() => decodeInducedSemanticMemory(stored)).toThrow("invalid induced semantic facts storage");
  });

  it("leaves unrelated records and nongenerative seed projections alone", () => {
    const unrelated = { schema: "other", semanticFrames: [] }, seed = requestSeedLanguagePattern(pattern(facts(1))).patternJson;
    expect(encodeInducedSemanticMemory(unrelated)).toBe(unrelated); expect(decodeInducedSemanticMemory(unrelated)).toBe(unrelated);
    expect(encodeInducedSemanticMemory(seed)).toBe(seed);
  });
});
