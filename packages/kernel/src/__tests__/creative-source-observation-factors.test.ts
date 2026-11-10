// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { creativeSourceObservationStorageForm, creativeSourceObservationsFromStorage } from "../creative-event-compatibility.js";
import { compileCreativeSourceCorrespondences, createCreativeSourceCorrespondenceVerifier, deriveCreativeSourceCorrespondence,
  type CreativeSourceCorrespondence } from "../creative-source-correspondence.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import type { DurableCreativeEventConstruction } from "../language-construction-memory.js";
import type { EvidenceSpan } from "../types.js";

const hasher = createHasher(), cold = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
function fixture(count = 8, padding = "") {
  const request = `🧵 ${padding}α 雪 e\u0301`, reply = Array.from({ length: count }, () => "ρ 雪.").join(" "), text = `${request}\n${reply}`;
  const start = [...request].length + 1;
  const evidence = { id: "evidence.source", sourceId: "source.owned", sourceVersionId: "version.owned", contentHash: hasher.digestHex(text),
    charStart: 0, charEnd: [...text].length, text, status: "promoted" } as unknown as EvidenceSpan;
  const turns: TranscriptTurn[] = [{ index: 0, speakerId: "request", surface: request, startCodePoint: 0, endCodePoint: start - 1, requestAuthority: "creative" },
    { index: 1, speakerId: "reply", surface: reply, startCodePoint: start, endCodePoint: [...text].length, replyToTurnIndex: 0, commitmentScope: "conversation" }];
  const events = Array.from({ length: count }, (_, index): DurableCreativeEventConstruction => {
    const label = start + index * 5, argument = label + 2;
    return { id: `event.${index}`, compilerId: "compiler.events", constructionId: "construction.owned", profileId: "profile.owned",
      sourceVersionId: "version.owned", evidenceId: "evidence.source", evidenceContentHash: String(evidence.contentHash), evidenceCharStart: 0, evidenceCharEnd: evidence.charEnd,
      labelStartCodePoint: label, labelEndCodePoint: label + 1, sourceOrdinal: index, relationId: "relation.owned", sourceLabel: "ρ", sourceLabelDigest: hasher.digestHex("ρ"),
      tenseId: "scce.tense.unknown", valencyId: "scce.valency.agent_patient", roleIds: ["scce.role.patient"],
      argumentFrame: { id: "argument.owned", schema: "scce.creative_event_argument_frame.v1", compilerId: "compiler.events", sourceSentenceStartCodePoint: label,
        sourceSentenceEndCodePoint: label + 4, roleIds: ["scce.role.patient"], bindings: [{ roleId: "scce.role.patient", surface: "雪", surfaceDigest: hasher.digestHex("雪"), startCodePoint: argument, endCodePoint: argument + 1 }] },
      forms: { infinitive: "ρ", past: "ρ", present: "ρ", gerund: "ρ", participle: "ρ" } };
  });
  const context = { evidence: [evidence], events, hasher };
  const patterns = compileCreativeSourceCorrespondences({ ...context, turns, profileId: "profile.owned", updatedAt: 1 });
  const rows = patterns.flatMap(pattern => (pattern.patternJson as unknown as { sourceObservations: CreativeSourceCorrespondence[] }).sourceObservations);
  return { rows, context, evidence };
}

it("retains one owned Unicode premise and every compiled event, binding, ordered row and canonical identity", () => {
  const { rows, context, evidence } = fixture();
  expect(rows).toHaveLength(8);
  const before = canonicalStringify(rows), stored = creativeSourceObservationStorageForm(rows), encoded = JSON.stringify(stored);
  expect(stored.groups).toHaveLength(1);
  expect(stored.occurrences).toHaveLength(rows.length);
  const restored = creativeSourceObservationsFromStorage(cold(stored));
  expect(restored).toEqual(rows);
  expect(canonicalStringify(restored)).toBe(before);
  const verifier = createCreativeSourceCorrespondenceVerifier(context);
  expect(restored.every(row => verifier.verify(row, [String(evidence.id)]))).toBe(true);
  expect(restored[0]!.request.surface).toContain("🧵");
  expect(restored[0]!.request.surface).toContain("e\u0301");
  expect(JSON.stringify(stored)).toBe(encoded);
  restored[0]!.request.surface = "changed";
  expect(restored[1]!.request.surface).toBe(rows[1]!.request.surface);
  expect(canonicalStringify(rows)).toBe(before);
});

it("retains declared source-reference bindings and does not authorize foreign or missing source premises", () => {
  const { rows, context } = fixture(2);
  const references = rows.map(row => { const { id: _id, ...material } = row;
    return deriveCreativeSourceCorrespondence({ ...material, bindings: material.bindings.map(binding => ({ ...binding,
      sourceReference: { patternId: "reference.owned", referentId: "雪🧵", propertyId: "property.e\u0301" } })) }, hasher); });
  expect(creativeSourceObservationsFromStorage(cold(creativeSourceObservationStorageForm(references)))).toEqual(references);
  const restored = creativeSourceObservationsFromStorage(cold(creativeSourceObservationStorageForm(rows)));
  const verifier = createCreativeSourceCorrespondenceVerifier(context);
  expect(restored.every(row => !verifier.verify(row, ["foreign.evidence"]))).toBe(true);
  expect(restored.every(row => !createCreativeSourceCorrespondenceVerifier({ ...context, evidence: [] }).verify(row, ["evidence.source"]))).toBe(true);
  const foreign = { ...context.evidence[0]!, sourceVersionId: "foreign.version" } as EvidenceSpan;
  expect(restored.every(row => !createCreativeSourceCorrespondenceVerifier({ ...context, evidence: [foreign] }).verify(row, ["evidence.source"]))).toBe(true);
});

it("rejects corrupt source facts, dangling references, altered occurrences, duplicate or unused groups and invalid source row IDs", () => {
  const { rows } = fixture(2), original = creativeSourceObservationStorageForm(rows);
  const bad = (mutate: (value: typeof original) => void) => { const value = cold(original); mutate(value);
    expect(() => creativeSourceObservationsFromStorage(value)).toThrow("invalid creative source observation factors"); };
  bad(value => { value.groups[0]!.sourceVersionId = "foreign.version"; });
  bad(value => { value.groups[0]!.request.surface += "changed"; });
  bad(value => { value.occurrences[0]![0] = 99; });
  bad(value => { value.occurrences[0]![1] = "foreign.event"; });
  bad(value => { value.occurrences[0]![5][0]!.eventStart++; });
  bad(value => { value.groups.push(cold(value.groups[0]!)); });
  bad(value => { value.occurrences = []; });
  bad(value => { (value as unknown as Record<string, unknown>).extra = "unknown"; });
  expect(() => creativeSourceObservationStorageForm([{ ...rows[0]!, id: "changed.id" }])).toThrow("invalid creative source observation factors");
});

it("stores source premise growth once instead of multiplying long requests by event count", () => {
  const measure = (n: number) => { const { rows } = fixture(n, "source ".repeat(n * 20));
    const stored = creativeSourceObservationStorageForm(rows);
    expect(rows).toHaveLength(n);
    expect(stored.groups).toHaveLength(1);
    expect(creativeSourceObservationsFromStorage(cold(stored))).toEqual(rows);
    return { raw: size(rows), stored: size(stored) }; };
  const small = measure(16), large = measure(32);
  expect(large.raw / small.raw).toBeGreaterThan(3);
  expect(large.stored / small.stored).toBeLessThan(2.1);
  expect(large.stored).toBeLessThan(large.raw / 3);
});
