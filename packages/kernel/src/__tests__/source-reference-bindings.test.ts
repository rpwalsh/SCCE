// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { compileSourceReferenceBindingPattern, sourceReferenceBindingsFromPatterns, sourceReferencePropertiesForSpan,
  sourceReferencePropertyByIdentity, type SourceReferenceBindingDeclaration } from "../source-reference-bindings.js";
import type { EvidenceSpan } from "../types.js";

const hasher = createHasher();

function fixture(text = "May speaks. In May, May answers.") {
  const evidence = { id: "evidence.reference", sourceId: "source.reference", sourceVersionId: "version.reference",
    chunkId: "chunk.reference", contentHash: hasher.digestHex(text), charStart: 0, charEnd: [...text].length, text, status: "promoted" } as unknown as EvidenceSpan;
  const starts = [...text.matchAll(/May/gu)].map(match => [...text.slice(0, match.index)].length);
  const declaration: SourceReferenceBindingDeclaration = { schema: "scce.source_reference_bindings.v1", coordinateSpace: "unicode_code_point",
    sourceTextHash: hasher.digestHex(text), basis: { kind: "source_annotated", annotationSchema: "test.explicit_opaque_references", annotationId: "annotation.synthetic.control" },
    completeReferentIds: ["r.1", "r.2"], completeProperties: [{ referentId: "r.1", propertyId: "p.1" }, { referentId: "r.2", propertyId: "p.1" }],
    occurrences: starts.map((start, index) => ({ id: `mention.${index}`, referentId: index === 1 ? "r.2" : "r.1", propertyId: "p.1",
      startCodePoint: start, endCodePoint: start + 3, scopeIds: ["scope.document"] })) };
  const compile = (value = declaration) => compileSourceReferenceBindingPattern({ declaration: value, text, profileId: "profile.reference", evidence: [evidence], hasher, updatedAt: 1 });
  return { text, evidence, starts, declaration, compile };
}

describe("source-owned reference and property occurrences", () => {
  it.each(["compiled", "cold_hydrated"])("does not let a live identity-only %s document acquire property rewrite authority", mode => {
    const f = fixture();
    const compiled = f.compile({ ...f.declaration, completeProperties: [],
      occurrences: f.declaration.occurrences.map(({ propertyId: _property, ...occurrence }) => occurrence) });
    const document = mode === "compiled" ? compiled.bindings! : sourceReferenceBindingsFromPatterns({
      patterns: JSON.parse(JSON.stringify([compiled.pattern])), evidence: [f.evidence], hasher }).bindings[0]!;
    const occurrence = document.occurrences[0]!, referentId = occurrence.binding.referentId;
    const attempt = (mutate: () => unknown) => { try { mutate(); } catch (error) { if (!(error instanceof TypeError)) throw error; } };
    attempt(() => Reflect.set(occurrence, "propertyId", "p.injected"));
    attempt(() => Reflect.set(occurrence, "propertySpan", { start: 0, end: 3, surfaceHash: hasher.digestHex("May") }));
    attempt(() => (document.completeProperties as Array<{ referentId: string; propertyId: string }>).push({ referentId, propertyId: "p.injected" }));
    expect(sourceReferencePropertiesForSpan({ documents: [document], sourceVersionId: String(f.evidence.sourceVersionId), startCodePoint: 0, endCodePoint: 3 })).toEqual([]);
    expect(sourceReferencePropertyByIdentity({ documents: [document], patternId: document.id, referentId, propertyId: "p.injected" })).toBeUndefined();
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.completeProperties)).toBe(true);
    expect(Object.isFrozen(occurrence)).toBe(true);
  });

  it.each(["coordinates", "property_identity", "referent_identity", "completeness", "occurrence_inventory", "annotation_basis"])("preserves live owned %s after an attempted mutation", field => {
    const f = fixture(), document = f.compile().bindings!;
    const occurrence = document.occurrences[0]!, referentId = occurrence.binding.referentId;
    const query = { documents: [document], sourceVersionId: String(f.evidence.sourceVersionId), startCodePoint: 0, endCodePoint: 3 };
    const original = JSON.parse(JSON.stringify(sourceReferencePropertiesForSpan(query)));
    try {
      if (field === "coordinates") Object.assign(occurrence.propertySpan!, { start: f.starts[1], end: f.starts[1]! + 3 });
      else if (field === "property_identity") Reflect.set(occurrence, "propertyId", "p.foreign");
      else if (field === "referent_identity") Reflect.set(occurrence.binding, "referentId", document.occurrences[1]!.binding.referentId);
      else if (field === "completeness") Reflect.set(document.completeProperties[0]!, "propertyId", "p.foreign");
      else if (field === "occurrence_inventory") Reflect.set(document, "occurrences", [document.occurrences[1]]);
      else Reflect.set(document.basis, "kind", "qualified_inference");
    } catch (error) { if (!(error instanceof TypeError)) throw error; }
    expect(sourceReferencePropertiesForSpan(query)).toEqual(original);
    expect(sourceReferencePropertyByIdentity({ documents: [document], patternId: document.id, referentId, propertyId: "p.1" })).toEqual(original[0]);
    const other = sourceReferencePropertiesForSpan({ ...query, startCodePoint: f.starts[1]!, endCodePoint: f.starts[1]! + 3 });
    expect(other).toHaveLength(1);
    expect(other[0]!.referentId).not.toBe(referentId);
  });

  it("keeps equal spellings in distinct referents separate after persisted cold hydration", () => {
    const f = fixture(), compiled = f.compile();
    expect(compiled.issues).toEqual([]);
    const restored = sourceReferenceBindingsFromPatterns({ patterns: JSON.parse(JSON.stringify([compiled.pattern])), evidence: [f.evidence], hasher });
    expect(restored.issues).toEqual([]);
    const properties = sourceReferencePropertiesForSpan({ documents: restored.bindings, sourceVersionId: String(f.evidence.sourceVersionId), startCodePoint: 0, endCodePoint: 3 });
    expect(properties).toHaveLength(1);
    expect(properties[0]!.complete).toBe(true);
    expect(properties[0]!.occurrences.map(row => row.propertySpan!.start)).toEqual([f.starts[0], f.starts[2]]);
    expect(properties[0]!.occurrences.every(row => row.binding.referentId === properties[0]!.referentId
      && row.binding.evidenceIds.includes(String(f.evidence.id)) && row.mention.schema === "scce.discourse_mention.v2")).toBe(true);
    expect(sourceReferencePropertiesForSpan({ documents: JSON.parse(JSON.stringify(restored.bindings)), sourceVersionId: String(f.evidence.sourceVersionId), startCodePoint: 0, endCodePoint: 3 })).toEqual([]);
  });

  it("does not turn identity-only or incompletely annotated chains into renameable properties", () => {
    const f = fixture();
    const identityOnly = { ...f.declaration, completeProperties: [], occurrences: f.declaration.occurrences.map(({ propertyId: _property, ...mention }) => mention) };
    const plain = f.compile(identityOnly);
    expect(plain.bindings?.occurrences).toHaveLength(3);
    expect(sourceReferencePropertiesForSpan({ documents: [plain.bindings!], sourceVersionId: String(f.evidence.sourceVersionId), startCodePoint: 0, endCodePoint: 3 })).toEqual([]);
    const incomplete = f.compile({ ...f.declaration, completeProperties: [] });
    expect(sourceReferencePropertiesForSpan({ documents: [incomplete.bindings!], sourceVersionId: String(f.evidence.sourceVersionId), startCodePoint: 0, endCodePoint: 3 })[0]?.complete).toBe(false);
    const unqualified = f.compile({ ...f.declaration, basis: { kind: "qualified_inference", modelId: "model.unverified", modelVersion: "1", qualificationId: "qualification.unverified" } });
    expect(unqualified.pattern).toBeUndefined();
    expect(unqualified.issues).toEqual([{ code: "source.reference.inference_qualification_unavailable" }]);
  });

  it("requires current exact source ownership and refuses changed or split-grapheme coordinates", () => {
    const f = fixture(), pattern = f.compile().pattern!;
    for (const evidence of [[], [{ ...f.evidence, sourceId: "source.foreign" as never }], [{ ...f.evidence, text: `X${f.text.slice(1)}` }], [{ ...f.evidence, status: "candidate" as never }]]) {
      expect(sourceReferenceBindingsFromPatterns({ patterns: [pattern], evidence, hasher }).bindings).toEqual([]);
    }
    expect(sourceReferenceBindingsFromPatterns({ patterns: [{ ...pattern, profileId: "profile.foreign" }], evidence: [f.evidence], hasher }).bindings).toEqual([]);
    const text = "👩🏽‍💻";
    const emoji = fixture(text);
    const split = emoji.compile({ ...emoji.declaration, completeReferentIds: ["r.1"], completeProperties: [],
      occurrences: [{ id: "emoji.partial", referentId: "r.1", startCodePoint: 0, endCodePoint: 1 }] });
    expect(split.pattern).toBeUndefined();
    expect(split.issues[0]?.code).toBe("source.reference.coordinates_changed");
  });
});
