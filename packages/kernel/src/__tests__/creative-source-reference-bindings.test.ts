// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher, toJsonValue } from "../primitives.js";
import { compileSourceReferenceBindingPattern, type SourceReferenceBindingDeclaration } from "../source-reference-bindings.js";
import { compileCreativeSourceCorrespondences, verifyCreativeSourceCorrespondence, type CreativeSourceCorrespondence } from "../creative-source-correspondence.js";
import { compileCreativeRequestFrameFromCompatibilityModels, creativeEventCompatibilityModelsFromPatterns } from "../creative-event-compatibility.js";
import type { DurableCreativeEventConstruction } from "../language-construction-memory.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import type { EvidenceSpan } from "../types.js";

describe("synthetic opaque source reference role controls", () => {
  it("binds equal source spellings by declared referents, keeps split roles separate, and excludes a third homonym", () => {
    const hasher = createHasher(), request = "q May x May", reply = "v May. w May. context May.", text = `${request}\n${reply}`;
    const evidence = { id: "evidence.control", sourceId: "source.control", sourceVersionId: "version.control", contentHash: hasher.digestHex(text),
      charStart: 0, charEnd: [...text].length, text, status: "promoted" } as unknown as EvidenceSpan;
    const positions = [...text.matchAll(/May/gu)].map(match => match.index);
    const declaration: SourceReferenceBindingDeclaration = { schema: "scce.source_reference_bindings.v1", coordinateSpace: "unicode_code_point",
      sourceTextHash: hasher.digestHex(text), basis: { kind: "source_annotated", annotationSchema: "test.synthetic.explicit_roles", annotationId: "test.roles" },
      completeReferentIds: ["r.a", "r.b", "r.c"], completeProperties: [{ referentId: "r.a", propertyId: "p" }, { referentId: "r.b", propertyId: "p" }],
      occurrences: positions.map((start, index) => ({ id: `m.${index}`, referentId: ["r.a", "r.b", "r.a", "r.b", "r.c"][index]!, propertyId: "p",
        startCodePoint: start, endCodePoint: start + 3 })) };
    const references = compileSourceReferenceBindingPattern({ declaration, text, profileId: "profile.control", evidence: [evidence], hasher, updatedAt: 1 });
    expect(references.issues).toEqual([]);
    const turns: TranscriptTurn[] = [{ index: 0, speakerId: "request", surface: request, startCodePoint: 0, endCodePoint: request.length, requestAuthority: "creative" },
      { index: 1, speakerId: "reply", surface: reply, startCodePoint: request.length + 1, endCodePoint: text.length, replyToTurnIndex: 0, commitmentScope: "conversation" }];
    const events = ["v", "w", "context"].map((label, index): DurableCreativeEventConstruction => {
      const start = text.indexOf(label, request.length), argumentStart = positions[index + 2]!;
      return { id: `event.${index}`, compilerId: "test.events", constructionId: `construction.${index}`, profileId: "profile.control", sourceVersionId: String(evidence.sourceVersionId),
        evidenceId: String(evidence.id), evidenceContentHash: String(evidence.contentHash), evidenceCharStart: 0, evidenceCharEnd: text.length,
        labelStartCodePoint: start, labelEndCodePoint: start + label.length, sourceOrdinal: index, relationId: `relation.${index}`, sourceLabel: label, sourceLabelDigest: hasher.digestHex(label),
        tenseId: "scce.tense.unknown", valencyId: "scce.valency.agent_patient", roleIds: ["scce.role.patient"],
        argumentFrame: { id: `argument.frame.${index}`, schema: "scce.creative_event_argument_frame.v1", compilerId: "test.events",
          sourceSentenceStartCodePoint: start, sourceSentenceEndCodePoint: argumentStart + 3, roleIds: ["scce.role.patient"],
          bindings: [{ roleId: "scce.role.patient", surface: "May", surfaceDigest: hasher.digestHex("May"), startCodePoint: argumentStart, endCodePoint: argumentStart + 3 }] },
        forms: { infinitive: label, past: label, present: label, gerund: label, participle: label } };
    });
    const context = { evidence: [evidence], events, hasher, referenceBindings: [references.bindings!] };
    expect(compileCreativeSourceCorrespondences({ ...context, referenceBindings: [], turns, profileId: "profile.control", updatedAt: 1 })).toEqual([]);
    const patterns = compileCreativeSourceCorrespondences({ ...context, turns, profileId: "profile.control", updatedAt: 1 });
    const models = creativeEventCompatibilityModelsFromPatterns(patterns, context);
    expect(models).toHaveLength(1);
    const observations = models.flatMap(model => model.sourceObservations ?? []);
    expect(observations.map(row => [row.eventId, row.bindings[0]!.requestStart]).sort()).toEqual([["event.0", 2], ["event.1", 8]]);
    expect(observations.every(row => row.bindings[0]!.sourceReference)).toBe(true);
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: "q Κварц x 月", models, hasher })!;
    expect(frame.arguments.map(argument => argument.span.text)).toEqual(["Κварц", "月"]);
    const first = observations.find(row => row.eventId === "event.0")!, second = observations.find(row => row.eventId === "event.1")!;
    const wrong = { ...first, bindings: first.bindings.map(binding => ({ ...binding, sourceReference: second.bindings[0]!.sourceReference })) };
    const { id: _previous, ...material } = wrong;
    const changed: CreativeSourceCorrespondence = { ...material, id: `creative.source.correspondence.${hasher.digestHex(canonicalStringify(toJsonValue(material)))}` };
    expect(verifyCreativeSourceCorrespondence(changed, context, [String(evidence.id)])).toBe(false);
    const identityOnly = compileSourceReferenceBindingPattern({ declaration: { ...declaration, completeProperties: [],
      occurrences: declaration.occurrences.map(({ propertyId: _property, ...occurrence }) => occurrence) }, text, profileId: "profile.control", evidence: [evidence], hasher, updatedAt: 1 });
    expect(compileCreativeSourceCorrespondences({ ...context, referenceBindings: [identityOnly.bindings!], turns, profileId: "profile.control", updatedAt: 1 })).toEqual([]);
  });
});
