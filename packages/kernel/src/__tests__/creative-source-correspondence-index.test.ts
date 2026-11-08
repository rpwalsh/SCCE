// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { compileCreativeSourceCorrespondences, creativeSourceSurfaceGroupKey, createCreativeSourceCorrespondenceVerifier, type CreativeSourceCorrespondence } from "../creative-source-correspondence.js";
import { canonicalStringify, createClock, createHasher, toJsonValue } from "../primitives.js";
import { CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID } from "../language-training-recipe.js";
import type { LanguagePatternRecord } from "../storage.js";
import { createIdFactory } from "../ids.js";
import type { DurableCreativeEventConstruction } from "../language-construction-memory.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import type { EvidenceSpan } from "../types.js";

const hasher = createHasher();
const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "correspondence-index-control" });
const legacyOutputDigest = "1c83d67fa11893058293b7010d1865587a1e977629e4b9a15719d292fb5e2f4f";

function assertLegacyBytesAndAcquiredWitnesses(patterns: LanguagePatternRecord[], input: ReturnType<typeof fixture>) {
  const verifier = createCreativeSourceCorrespondenceVerifier(input);
  const legacy = patterns.map(pattern => {
    const { id: _id, surfaceBindingRecipe, ...material } = pattern.patternJson as Record<string, unknown>;
    expect(surfaceBindingRecipe).toBe(CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID);
    const rows = material.sourceObservations as CreativeSourceCorrespondence[];
    for (const row of rows) expect(verifier.verify(row, input.evidence.map(span => String(span.id)))).toBe(true);
    const acquired = verifier.acquireSurfaceBindings(rows);
    expect([...acquired.keys()].sort()).toEqual([...new Set(rows.map(creativeSourceSurfaceGroupKey))].sort());
    for (const [key, roles] of acquired) {
      const owned = rows.filter(row => creativeSourceSurfaceGroupKey(row) === key);
      expect(roles.map(role => role.requestRoleId).sort()).toEqual([...new Set(owned.flatMap(row => row.bindings.map(binding => binding.requestRoleId)))].sort());
      for (const role of roles) {
        expect(role.occurrences).toHaveLength(1);
        const seed = owned.flatMap(row => row.bindings).find(binding => binding.requestRoleId === role.requestRoleId)!;
        expect(role.occurrences[0]).toEqual({ start: seed.eventStart, end: seed.eventEnd });
      }
    }
    const id = `creative.observed.compatibility.${hasher.digestHex(canonicalStringify(toJsonValue(material)))}`;
    return { ...pattern, id, patternJson: toJsonValue({ ...material, id }) };
  });
  expect(hasher.digestHex(JSON.stringify(legacy))).toBe(legacyOutputDigest);
}

// Opaque development fixtures isolate event occurrence identity, compiler scope, and range selection.
function fixture(pairCount = 12) {
  const turns: TranscriptTurn[] = [];
  let position = 0;
  for (let pair = 0; pair < pairCount; pair++) for (const reply of [false, true]) {
    const surface = `${reply ? "ρ" : "τ"} μ${pair} ν${pair}`;
    const index = turns.length;
    turns.push({ index, speakerId: reply ? "speaker.reply" : "speaker.request", surface,
      startCodePoint: position, endCodePoint: position + [...surface].length,
      ...(reply ? { replyToTurnIndex: index - 1, commitmentScope: "conversation" as const } : { requestAuthority: "creative" as const }) });
    position += [...surface].length + 1;
  }
  const text = turns.map(turn => turn.surface).join("\n");
  const sourceVersionId = ids.sourceVersionId(text), contentHash = ids.contentHash(text);
  const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: contentHash }),
    sourceId: ids.sourceId("dialogue", "fixture://correspondence-index"), sourceVersionId, contentHash,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), chunkHash: contentHash }),
    mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: [...text].length,
    text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
  const selected: DurableCreativeEventConstruction[] = [];
  for (let pair = 0; pair < pairCount; pair++) {
    const reply = turns[pair * 2 + 1]!;
    for (let occurrence = 0; occurrence < 3; occurrence++) {
      const surface = occurrence === 2 ? `ν${pair}` : `μ${pair}`;
      const start = reply.startCodePoint + [...reply.surface.slice(0, reply.surface.indexOf(surface))].length;
      const compilerId = `compiler.${(pair + occurrence) % 3}`;
      selected.push({ id: `event.shared.${pair % 3}`, compilerId, constructionId: `construction.${pair}.${occurrence}`, profileId: "profile.control",
        sourceVersionId: String(sourceVersionId), evidenceId: String(evidence.id), evidenceContentHash: String(contentHash),
        evidenceCharStart: 0, evidenceCharEnd: evidence.charEnd, labelStartCodePoint: reply.startCodePoint, labelEndCodePoint: reply.startCodePoint + 1,
        sourceOrdinal: selected.length, relationId: `relation.${pair}.${occurrence}`, sourceLabel: "ρ", sourceLabelDigest: hasher.digestHex("ρ"),
        tenseId: "scce.tense.unknown", valencyId: "scce.valency.agent_patient", roleIds: ["scce.role.patient"],
        argumentFrame: { id: `argument.${pair}.${occurrence}`, schema: "scce.creative_event_argument_frame.v1", compilerId,
          sourceSentenceStartCodePoint: reply.startCodePoint, sourceSentenceEndCodePoint: reply.endCodePoint, roleIds: ["scce.role.patient"],
          bindings: [{ roleId: "scce.role.patient", surface, surfaceDigest: hasher.digestHex(surface), startCodePoint: start, endCodePoint: start + [...surface].length }] },
        forms: { infinitive: "ρ", past: "ρ", present: "ρ", gerund: "ρ", participle: "ρ" } });
    }
    selected.push(selected.at(-3)!);
  }
  const first = selected[0]!;
  const foreign = { ...first, compilerId: "compiler.foreign", evidenceId: "evidence.foreign" };
  const padding = Array.from({ length: selected.length * 3 }, (_, index) => ({ ...first, id: `event.unmatched.${index}`,
    labelStartCodePoint: 0, labelEndCodePoint: 1 }));
  const events = [foreign, ...selected.reverse(), ...padding];
  return { evidence: [evidence], events, turns, profileId: "profile.control", updatedAt: 1, hasher };
}

it("preserves complete output bytes and every compiler scope of repeated event IDs", () => {
  const input = fixture();
  const patterns = compileCreativeSourceCorrespondences(input);
  assertLegacyBytesAndAcquiredWitnesses(patterns, input);
  const models = patterns.map(pattern => pattern.patternJson as { eventCompilerId: string; sourceObservations: Array<{ eventId: string; eventConstructionId: string }> });
  expect(models.map(model => model.eventCompilerId)).toEqual(["compiler.foreign", "compiler.2", "compiler.1", "compiler.0"]);
  for (const model of models) {
    const foreign = model.eventCompilerId === "compiler.foreign";
    expect(model.sourceObservations).toHaveLength(input.turns.length / 2 * (foreign ? 1 : 3));
    expect(new Set(model.sourceObservations.map(row => row.eventConstructionId)).size).toBe(model.sourceObservations.length);
    expect(new Set(model.sourceObservations.map(row => row.eventId))).toEqual(new Set(foreign ? ["event.shared.0"] : ["event.shared.0", "event.shared.1", "event.shared.2"]));
  }
});

it("visits a full evidence group once rather than scanning it for every reply or observed event", () => {
  const input = fixture();
  let rangeReads = 0, identityReads = 0;
  const events = input.events.map(event => Object.defineProperties({ ...event }, {
    labelStartCodePoint: { enumerable: true, get: () => { rangeReads++; return event.labelStartCodePoint; } },
    id: { enumerable: true, get: () => { identityReads++; return event.id; } }
  }));
  const patterns = compileCreativeSourceCorrespondences({ ...input, events });
  assertLegacyBytesAndAcquiredWitnesses(patterns, input);
  expect(rangeReads).toBeLessThanOrEqual(events.length * 2);
  expect(identityReads).toBeLessThanOrEqual(events.length + input.turns.length * 3);
});

it("preserves source-relative ranges under a nonzero evidence origin", () => {
  const input = fixture();
  const origin = [..."前置き\n"].length;
  const shifted = { ...input,
    evidence: input.evidence.map(span => ({ ...span, charStart: span.charStart + origin, charEnd: span.charEnd + origin })),
    turns: input.turns.map(turn => ({ ...turn, startCodePoint: turn.startCodePoint + origin, endCodePoint: turn.endCodePoint + origin })),
    events: input.events.map(event => ({ ...event, evidenceCharStart: event.evidenceCharStart + origin, evidenceCharEnd: event.evidenceCharEnd + origin })) };
  expect(JSON.stringify(compileCreativeSourceCorrespondences(shifted))).toBe(JSON.stringify(compileCreativeSourceCorrespondences(input)));
});

it("keeps wrong bindings and excluded turn ranges out of the indexed result", () => {
  const input = fixture();
  const source = input.events.find(event => event.compilerId === "compiler.0" && event.evidenceId === String(input.evidence[0]!.id))!;
  const wrongBinding = { ...source, id: "event.wrong.binding", argumentFrame: { ...source.argumentFrame, id: "argument.wrong.binding",
    bindings: source.argumentFrame.bindings.map(binding => ({ ...binding, surface: "ξξ", surfaceDigest: hasher.digestHex("ξξ") })) } };
  const wrongRange = { ...source, id: "event.wrong.range", labelStartCodePoint: source.labelStartCodePoint - 1 };
  expect(compileCreativeSourceCorrespondences({ ...input, events: [wrongBinding, wrongRange] })).toEqual([]);
  const expected = compileCreativeSourceCorrespondences(input);
  expect(JSON.stringify(compileCreativeSourceCorrespondences({ ...input, events: [...input.events, wrongBinding, wrongRange] }))).toBe(JSON.stringify(expected));
  for (const turns of [input.turns.map(turn => turn.replyToTurnIndex === undefined ? { ...turn, requestAuthority: "factual" as const } : turn),
    input.turns.map(turn => turn.replyToTurnIndex === undefined ? turn : { ...turn, commitmentScope: "external" as const })]) {
    expect(compileCreativeSourceCorrespondences({ ...input, turns })).toEqual([]);
  }
});
