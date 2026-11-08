// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { compileSourceReferenceBindingPattern, sourceReferenceBindingsFromPatterns, sourceReferencePropertiesForSpan,
  type SourceReferenceBindingDeclaration } from "../source-reference-bindings.js";
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
