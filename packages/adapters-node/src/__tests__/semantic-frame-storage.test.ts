// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { canonicalStringify, createClock, createHasher, createIdFactory, createLanguageInductionEngine,
  languageMemoryPatternsFromInducedLanguageModel, requestSeedLanguagePattern, type LanguagePatternRecord, type LanguageProfile } from "@scce/kernel";
import { decodeSemanticFrames, encodeSemanticFrames, SEMANTIC_FRAME_STORAGE_SCHEMA, SEMANTIC_MEMORY_SCHEMA } from "../semantic-frame-storage.js";
import { decodeDurableArtifact, decodedJsonByteLengths, DECODED_JSON_BYTE_LEDGER_KEY,
  encodeDurableArtifact } from "../durable-artifact-storage.js";
import { SEMANTIC_PROJECTION_STORAGE_KEY } from "../semantic-projection-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected object");
  return value as Record<string, unknown>;
};
const hasher = createHasher(), bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
let pattern: LanguagePatternRecord, projectedPattern: LanguagePatternRecord;
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
  projectedPattern = found;
  // Exercise the expanded-frame codec independently of the sufficient-tape codec.
  // Both are supported authored payloads, and both must retain their tamper checks.
  const { semanticInductionProjection: _tape, ...expanded } = record(found.patternJson);
  pattern = { ...found, patternJson: expanded as LanguagePatternRecord["patternJson"] };
});

it("uses the sufficient tape for current genuine human-source publication and restores the complete record", () => {
  const original = projectedPattern.patternJson, packed = record(encodeDurableArtifact(original));
  expect(packed[SEMANTIC_PROJECTION_STORAGE_KEY]).toBeDefined();
  expect(packed.semanticFrames).toBeUndefined();
  const restored = decodeDurableArtifact<LanguagePatternRecord["patternJson"]>(cold(packed));
  expect(restored).toEqual(original);
  // Kernel projections consume the public logical record. The PostgreSQL
  // request-seed path has its own test proving that the admitted replay tape
  // is hydrated before this boundary.
  expect(requestSeedLanguagePattern({ ...projectedPattern, patternJson: restored }))
    .toEqual(requestSeedLanguagePattern(projectedPattern));
});

it("normalizes genuine human-source frames through the production durable boundary with exact public digest and counters", () => {
  const original = pattern.patternJson, packed = encodeDurableArtifact(original), stored = record(record(packed).semanticFrames);
  expect(stored.schema).toBe(SEMANTIC_FRAME_STORAGE_SCHEMA);
  const frames = record(original).semanticFrames as Array<Record<string, unknown>>;
  expect((stored.sentences as string[]).length).toBeLessThan(frames.flatMap(frame => frame.examples as string[]).length);
  expect(bytes(packed)).toBeLessThan(bytes(original));
  const restored = decodeDurableArtifact(cold(packed));
  expect(restored).toEqual(original);
  expect(hasher.digestHex(canonicalStringify(restored))).toBe(hasher.digestHex(canonicalStringify(original)));
  expect(record(packed)[DECODED_JSON_BYTE_LEDGER_KEY]).toMatchObject(decodedJsonByteLengths(original));
  expect(encodeDurableArtifact(packed)).toBe(packed);
  expect(record(restored).graphBoundConstructions).toEqual(record(original).graphBoundConstructions);
  expect(record(restored).relationHypothesisModel).toEqual(record(original).relationHypothesisModel);
});

it("retains the exact nongenerative seed projection without interpreting normalized frame rows", () => {
  const packed = encodeDurableArtifact(pattern.patternJson);
  const storedPattern = { ...pattern, patternJson: packed as LanguagePatternRecord["patternJson"] };
  expect(requestSeedLanguagePattern(storedPattern)).toEqual(requestSeedLanguagePattern(pattern));
  expect(JSON.stringify(requestSeedLanguagePattern(storedPattern))).not.toContain(SEMANTIC_FRAME_STORAGE_SCHEMA);
});

it("uses the same boundary in nested model and event payloads without changing source ownership", () => {
  const original = { projection: { patterns: [pattern] }, eventPayload: { learned: pattern.patternJson }, retained: null };
  const encoded = encodeDurableArtifact(original);
  expect(JSON.stringify(encoded)).toContain(SEMANTIC_FRAME_STORAGE_SCHEMA);
  expect(decodeDurableArtifact(cold(encoded))).toEqual(original);
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

it.each(["missing_sentence", "changed_sentence", "missing_evidence", "changed_evidence", "negative_reference", "changed_role", "missing_digest", "unknown_marker"])("refuses %s before restoring a public frame", kind => {
  const packed = record(cold(encodeDurableArtifact(pattern.patternJson))), marker = record(packed.semanticFrames);
  const frames = marker.frames as Array<Record<string, unknown>>;
  if (kind === "missing_sentence") marker.sentences = [];
  if (kind === "changed_sentence") (marker.sentences as string[])[0] += " altered";
  if (kind === "missing_evidence") marker.evidence = [];
  if (kind === "changed_evidence") (marker.evidence as string[])[0] += ".foreign";
  if (kind === "negative_reference") frames[0]!.examples = [-1];
  if (kind === "changed_role") (frames[0]!.roles as unknown[][])[0]![1] = "foreign";
  if (kind === "missing_digest") delete marker.digest;
  if (kind === "unknown_marker") marker.extra = true;
  expect(() => decodeDurableArtifact(packed)).toThrow("invalid semantic frame storage");
});

it("does not interpret unrelated or malformed semantic lookalikes", () => {
  const value = { schema: "unrelated", semanticFrames: [{ examples: ["source"], evidenceIds: [], roles: [], predicateAlternatives: [] }] };
  expect(encodeDurableArtifact(value)).toBe(value);
  expect(encodeSemanticFrames([{ examples: null, evidenceIds: [] }])).toBeUndefined();
  expect(() => decodeSemanticFrames({ schema: SEMANTIC_FRAME_STORAGE_SCHEMA, sentences: [], evidence: [], frames: [] })).toThrow("invalid semantic frame storage");
});
