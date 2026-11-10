// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { canonicalStringify, createClock, createHasher, createIdFactory, createLanguageInductionEngine,
  INDUCED_SEMANTIC_FACTS_STORAGE_KEY, INDUCED_SEMANTIC_FACTS_STORAGE_SCHEMA,
  languageMemoryPatternsFromInducedLanguageModel, requestSeedLanguagePattern, type LanguagePatternRecord, type LanguageProfile } from "@scce/kernel";
import { decodeSemanticFrames, encodeSemanticFrames, SEMANTIC_FRAME_STORAGE_SCHEMA, SEMANTIC_MEMORY_SCHEMA } from "../semantic-frame-storage.js";
import { decodeDurableJoinPrograms, durableJoinProgramJsonByteLengths, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY,
  encodeDurableJoinPrograms } from "../durable-join-program-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected object");
  return value as Record<string, unknown>;
};
const hasher = createHasher(), bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
let pattern: LanguagePatternRecord;
beforeAll(() => {
  const text = (JSON.parse(readFileSync(new URL("../../../kernel/src/__tests__/fixtures/dolly-human-16.json", import.meta.url), "utf8")) as { text: string }).text;
  expect(hasher.digestHex(text)).toBe("307c6758d4173c6dd87d0b77460c74fafe62c3e58d934eabbf5e05268de3dadc");
  const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true, namespace: "semantic.storage" });
  const sourceVersionId = ids.sourceVersionId(text), contentHash = ids.contentHash(text);
  const evidenceId = ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: contentHash });
  const model = createLanguageInductionEngine({ hasher }).induce({ documents: [{ id: "human.dolly16", sourceVersionId, evidenceIds: [evidenceId], text }] });
  const profile: LanguageProfile = { id: "profile.human.dolly16", sourceVersionId, scripts: [], symbolShapes: [], charNgrams: [], direction: "unknown", entropy: 0, createdAt: 1 };
  const found = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory: ids, updatedAt: 1, sourceSystem: "dialogue" })
    .patterns.find(candidate => record(candidate.patternJson).schema === SEMANTIC_MEMORY_SCHEMA);
  if (!found) throw Error("human source did not produce semantic memory");
  pattern = found;
});

it("normalizes genuine human-source frames through the production durable boundary with exact public digest and counters", () => {
  const original = pattern.patternJson, packed = encodeDurableJoinPrograms(original), stored = record(record(packed)[INDUCED_SEMANTIC_FACTS_STORAGE_KEY]);
  expect(stored.schema).toBe(INDUCED_SEMANTIC_FACTS_STORAGE_SCHEMA);
  const frames = record(original).semanticFrames as Array<Record<string, unknown>>;
  expect(stored.frames).toHaveLength(frames.length);
  expect(new Set(stored.strings as string[]).size).toBe((stored.strings as string[]).length);
  expect(record(packed)).not.toHaveProperty("semanticFrames");
  expect(record(packed)).not.toHaveProperty("relationHypothesisModel");
  expect(bytes(packed)).toBeLessThan(bytes(original));
  const restored = decodeDurableJoinPrograms(cold(packed));
  expect(restored).toEqual(original);
  expect(hasher.digestHex(canonicalStringify(restored))).toBe(hasher.digestHex(canonicalStringify(original)));
  expect(record(packed)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(original));
  expect(encodeDurableJoinPrograms(packed)).toBe(packed);
  expect(record(restored).graphBoundConstructions).toEqual(record(original).graphBoundConstructions);
  expect(record(restored).relationHypothesisModel).toEqual(record(original).relationHypothesisModel);
});

it("retains the exact nongenerative seed projection without interpreting normalized frame rows", () => {
  const packed = encodeDurableJoinPrograms(pattern.patternJson);
  const storedPattern = { ...pattern, patternJson: packed as LanguagePatternRecord["patternJson"] };
  expect(requestSeedLanguagePattern(storedPattern)).toEqual(requestSeedLanguagePattern(pattern));
  const seed = record(requestSeedLanguagePattern(storedPattern).patternJson);
  expect(seed).not.toHaveProperty(INDUCED_SEMANTIC_FACTS_STORAGE_KEY);
  expect(seed).not.toHaveProperty("semanticFrames");
});

it("uses the same boundary in nested model and event payloads without changing source ownership", () => {
  const original = { projection: { patterns: [pattern] }, eventPayload: { learned: pattern.patternJson }, retained: null };
  const encoded = encodeDurableJoinPrograms(original);
  const nested = record(encoded);
  const patterns = record(nested.projection).patterns as LanguagePatternRecord[];
  expect(record(record(patterns[0]!.patternJson)[INDUCED_SEMANTIC_FACTS_STORAGE_KEY]).schema).toBe(INDUCED_SEMANTIC_FACTS_STORAGE_SCHEMA);
  expect(record(record(record(nested.eventPayload).learned)[INDUCED_SEMANTIC_FACTS_STORAGE_KEY]).schema).toBe(INDUCED_SEMANTIC_FACTS_STORAGE_SCHEMA);
  expect(nested[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(original));
  expect(decodeDurableJoinPrograms(cold(encoded))).toEqual(original);
});

it("retains the standalone legacy frame table and cold legacy durable records", () => {
  const frames = record(pattern.patternJson).semanticFrames as Array<Record<string, unknown>>, stored = encodeSemanticFrames(frames)!;
  expect(stored.schema).toBe(SEMANTIC_FRAME_STORAGE_SCHEMA);
  expect(stored.sentences.length).toBeLessThan(frames.flatMap(frame => frame.examples as string[]).length);
  expect(decodeSemanticFrames(cold(stored))).toEqual(frames);
  const legacy = { ...record(pattern.patternJson), semanticFrames: stored, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: {
    schema: "scce.durable_join_program.byte_ledger.v1", ...durableJoinProgramJsonByteLengths(pattern.patternJson)
  } };
  expect(encodeDurableJoinPrograms(legacy)).toBe(legacy);
  expect(decodeDurableJoinPrograms(cold(legacy))).toEqual(pattern.patternJson);
});

it("preserves unknown fields, Unicode, NUL, prototype names, missing and explicit null members", () => {
  const extension = JSON.parse('{"__proto__":{"retained":true},"constructor":null,"text":"雪🧭é\\u0000","zero":0}');
  const frames = [{ id: "frame.owned", predicate: "↦", roles: [{ name: "arg.opaque", filler: "雪🧭é\u0000", count: 1, salience: 0, extension }],
    predicateAlternatives: [{ surface: "↦", posterior: 1, energy: 0, extension }], examples: ["雪🧭é\u0000", "雪🧭é\u0000"],
    evidenceIds: ["evidence.owned", "evidence.owned"], extension, nullable: null }];
  const stored = encodeSemanticFrames(frames);
  expect(stored).toBeDefined();
  const restored = decodeSemanticFrames(cold(stored));
  expect(restored).toEqual(frames);
  expect(Object.hasOwn(restored[0]!, "absent")).toBe(false);
  expect(Object.hasOwn(restored[0]!, "nullable")).toBe(true);
  expect(Object.hasOwn(record(restored[0]!.extension), "__proto__")).toBe(true);
});

it.each(["missing_sentence", "changed_sentence", "missing_evidence", "changed_evidence", "negative_reference", "changed_role", "missing_digest", "unknown_marker"])("legacy frame codec refuses %s before restoring a public frame", kind => {
  const marker = record(cold(encodeSemanticFrames(record(pattern.patternJson).semanticFrames as unknown[])));
  const frames = marker.frames as Array<Record<string, unknown>>;
  if (kind === "missing_sentence") marker.sentences = [];
  if (kind === "changed_sentence") (marker.sentences as string[])[0] += " altered";
  if (kind === "missing_evidence") marker.evidence = [];
  if (kind === "changed_evidence") (marker.evidence as string[])[0] += ".foreign";
  if (kind === "negative_reference") frames[0]!.examples = [-1];
  if (kind === "changed_role") (frames[0]!.roles as unknown[][])[0]![1] = "foreign";
  if (kind === "missing_digest") delete marker.digest;
  if (kind === "unknown_marker") marker.extra = true;
  expect(() => decodeSemanticFrames(marker)).toThrow("invalid semantic frame storage");
});

it.each(["missing_sentence", "changed_sentence", "missing_evidence", "changed_evidence", "negative_reference", "changed_role", "missing_digest", "unknown_marker", "foreign_frame", "foreign_projection"])("production semantic facts refuse %s before restoring learned data", kind => {
  const packed = record(cold(encodeDurableJoinPrograms(pattern.patternJson))), marker = record(packed[INDUCED_SEMANTIC_FACTS_STORAGE_KEY]);
  const frames = marker.frames as unknown[][], strings = marker.strings as string[];
  const originalFrame = (record(pattern.patternJson).semanticFrames as Array<Record<string, unknown>>)[0]!;
  const example = (originalFrame.examples as string[])[0]!, evidence = (originalFrame.evidenceIds as string[])[0]!;
  if (kind === "missing_sentence") strings.splice(strings.indexOf(example), 1);
  if (kind === "changed_sentence") strings[strings.indexOf(example)] += " altered";
  if (kind === "missing_evidence") strings.splice(strings.indexOf(evidence), 1);
  if (kind === "changed_evidence") strings[strings.indexOf(evidence)] += ".foreign";
  if (kind === "negative_reference") frames[0]![8] = -1;
  if (kind === "changed_role") strings[(marker.roles as number[][])[0]![1]!] = "foreign";
  if (kind === "missing_digest") delete marker.digest;
  if (kind === "unknown_marker") marker.extra = true;
  if (kind === "foreign_frame") (marker.constructions as unknown[][])[0]![0] = -1;
  if (kind === "foreign_projection") (packed.graphBoundConstructions as Array<Record<string, unknown>>)[0]!.evidenceIds = ["foreign.owner"];
  expect(() => decodeDurableJoinPrograms(packed)).toThrow("invalid induced semantic facts storage");
});

it("retains source provenance and Unicode extensions in the production normal form without mutating the producer", () => {
  const original = record(cold(pattern.patternJson)), frames = original.semanticFrames as Array<Record<string, unknown>>;
  const extension = JSON.parse('{"__proto__":{"retained":true},"constructor":null,"text":"雪🧵e\\u0301\\u0000","zero":0}');
  frames[0]!.extension = extension; frames[0]!.nullable = null;
  (frames[0]!.roles as Array<Record<string, unknown>>)[0]!.extension = extension;
  const before = hasher.digestHex(canonicalStringify(original)), encoded = encodeDurableJoinPrograms(original);
  expect(hasher.digestHex(canonicalStringify(original))).toBe(before);
  const restored = record(decodeDurableJoinPrograms(cold(encoded))), frame = (restored.semanticFrames as Array<Record<string, unknown>>)[0]!;
  expect(hasher.digestHex(canonicalStringify(restored))).toBe(before);
  expect(Object.hasOwn(frame, "absent")).toBe(false); expect(Object.hasOwn(frame, "nullable")).toBe(true);
  expect(Object.hasOwn(record(frame.extension), "__proto__")).toBe(true);
  expect(record(encoded)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toMatchObject(durableJoinProgramJsonByteLengths(original));
  expect(restored.sourceVersionId).toBe(original.sourceVersionId); expect(restored.profileId).toBe(original.profileId);
});

it("does not interpret unrelated or malformed semantic lookalikes", () => {
  const value = { schema: "unrelated", semanticFrames: [{ examples: ["source"], evidenceIds: [], roles: [], predicateAlternatives: [] }] };
  expect(encodeDurableJoinPrograms(value)).toBe(value);
  expect(encodeSemanticFrames([{ examples: null, evidenceIds: [] }])).toBeUndefined();
  expect(() => decodeSemanticFrames({ schema: SEMANTIC_FRAME_STORAGE_SCHEMA, sentences: [], evidence: [], frames: [] })).toThrow("invalid semantic frame storage");
});
