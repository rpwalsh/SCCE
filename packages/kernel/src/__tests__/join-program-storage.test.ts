// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { JOIN_PROGRAM_SCHEMA, JOIN_PROGRAM_MIXTURE_SCHEMA, compileJoinProgram, compileJoinProgramMixture, renderJoinedSurface, type JoinProgramModel, type JoinProgramMixture } from "../join-program.js";
import { joinProgramMixtureFromStorage, joinProgramMixtureStorageForm } from "../join-program-storage.js";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { canonicalStringify, createHasher } from "../primitives.js";

const names = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;

function fixture(): JoinProgramMixture {
  const choice = { surface: " ", count: 0.125, probability: 1, evidenceIds: ["evidence.owned"], evidenceCoordinates: [{ evidenceId: "evidence.owned", sourceVersionId: "version.owned", documentId: "document.owned", byteStart: 1, byteEnd: 2, utf16Start: 1, utf16End: 2, exactSurfaceHash: "hash.exact" }] };
  const entries = Array.from({ length: 256 }, (_, index): [string, typeof choice[]] => [JSON.stringify([`surface.${index}`, "surface.shared", "surface_form_class.abcdefghijklmnopqrstuvwxyz0123456789", "surface_form_class.abcdefghijklmnopqrstuvwxyz0123456789", "scale.shared", "scale.shared", index, 2, 0.125, "construction.unresolved", "discourse.unresolved", "derivation.unresolved"]), [choice]]);
  const indexes = { conditionedIndex: Object.fromEntries(entries), exactIndex: Object.fromEntries(entries),
    structuralIndex: Object.fromEntries(entries), classIndex: Object.fromEntries(entries),
    localShapeIndex: Object.fromEntries(entries), constructionIndex: Object.fromEntries(entries) };
  const program: JoinProgramModel = { schema: JOIN_PROGRAM_SCHEMA, id: "program.owned", populationId: "population.owned", observations: 256, minimumConfidence: 0,
    ...indexes, exactIndex: { ...indexes.exactIndex, '["alpha","beta"]': [choice] }, backoffReliability: { conditioned: 1, exact: 1, structural: 1, class: 1, local_shape: 1, construction: 1 },
    sourceDocumentIds: ["document.owned"], trainingDocumentIds: ["document.owned"], evaluation: { heldoutDocumentIds: [], selectionDocumentIds: [], observations: 0, exactAccuracy: null, negativeLogLikelihood: null, expectedCalibrationError: null, reconstructionAccuracy: null, whitespaceInsertionErrors: 0, whitespaceDeletionErrors: 0, punctuationErrors: 0, crossScriptAccuracy: null }, audit: {} };
  return { schema: JOIN_PROGRAM_MIXTURE_SCHEMA, id: "mixture.owned", populationModelId: "population_model.owned", minimumConfidence: 0, components: [{ populationId: program.populationId, weight: 1, program }] };
}

function legacy(mixture: JoinProgramMixture) {
  return { schema: "scce.join_program_mixture.storage.v1" as const, mixture: { ...mixture, components: mixture.components.map(component => {
    const { conditionedIndex: _a, exactIndex: _b, structuralIndex: _c, classIndex: _d, localShapeIndex: _e, constructionIndex: _f, ...header } = component.program;
    const first = Object.values(component.program.exactIndex)[0]![0]!;
    return { ...component, program: { header, evidenceIdDictionary: first.evidenceIds, evidenceCoordinateDictionary: first.evidenceCoordinates,
      indexes: Object.fromEntries(names.map(name => [name, Object.entries(component.program[name]).map(([key, choices]) => [key, choices.map(choice => ({ surface: choice.surface, count: choice.count, probability: choice.probability, evidenceIdRefs: [0], evidenceCoordinateRefs: [0] }))])])) } };
  }) } };
}

describe("lossless join storage v2", () => {
  it("cold-restores one portable local law without materializing exact or class pair tables", () => {
    const documentId = "document.factor.owned", text = "cat chased mouse. dog chased mouse. \u732b\t\u{1f469}\u200d\u{1f52c}\u0000\u00e9 e\u0301.";
    const lattice = buildSurfaceLattice({ documentId, sourceVersionId: "version.factor.owned" as never,
      text, evidenceIds: ["evidence.factor.owned" as never] });
    const program = compileJoinProgram({ populationId: "population.factor.owned", documents: [{ documentId, text, lattice }] });
    const mixture = compileJoinProgramMixture({ populationModelId: "population.factor.owned", components: [{ populationId: program.populationId, weight: 1, program }] });
    expect(program.localFactors).toBeDefined();
    expect(program.exactIndex).toEqual({}); expect(program.classIndex).toEqual({});
    const stored = joinProgramMixtureStorageForm(mixture, { immutable: true });
    expect(stored.mixture.components[0]!.program.header.localFactors).toEqual(program.localFactors);
    expect(stored.mixture.components[0]!.program.indexes.exactIndex).toEqual([]);
    expect(stored.mixture.components[0]!.program.indexes.classIndex).toEqual([]);
    expect(JSON.stringify(stored).match(/"scce.join_program_local_factors.v1"/gu)).toHaveLength(1);
    expect(() => Object.assign(stored.mixture.components[0]!.program.header.localFactors!, { mutation: true })).toThrow();
    const restored = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(stored)))!;
    expect(restored).toEqual(mixture);
    const digest = (value: unknown) => createHasher().digestHex(canonicalStringify(value));
    expect(digest(restored)).toBe(digest(mixture));
    const before = canonicalStringify(restored);
    const expected = renderJoinedSurface(["cat", "chased"], mixture);
    expect(expected).toMatchObject({ status: "resolved", text: "cat chased" });
    for (let index = 0; index < 3; index++) expect(renderJoinedSurface(["cat", "chased"], restored)).toEqual(expected);
    const unicode = renderJoinedSurface(["\u732b", "\u{1f469}\u200d\u{1f52c}"], restored);
    expect(unicode).toEqual(renderJoinedSurface(["\u732b", "\u{1f469}\u200d\u{1f52c}"], mixture));
    expect(unicode).toMatchObject({ status: "resolved", text: "\u732b\t\u{1f469}\u200d\u{1f52c}" });
    expect(canonicalStringify(restored)).toBe(before);
    expect(expected.trace.flatMap(step => step.evidenceIds)).toContain("evidence.factor.owned");
    expect(expected.trace.flatMap(step => step.evidenceCoordinates)).toEqual(expect.arrayContaining([expect.objectContaining({
      documentId, sourceVersionId: "version.factor.owned", evidenceId: "evidence.factor.owned", utf16Start: 3, utf16End: 4
    })]));
    const mixed = structuredClone(mixture);
    mixed.components[0]!.program.exactIndex = fixture().components[0]!.program.exactIndex;
    expect(joinProgramMixtureFromStorage(mixed)).toBeUndefined();
    const mixedStored = structuredClone(stored);
    mixedStored.mixture.components[0]!.program.indexes.classIndex.push(["forbidden", []]);
    expect(joinProgramMixtureFromStorage(mixedStored)).toBeUndefined();
  });

  it("validates local factors on both raw and packed cold reads", () => {
    const raw = fixture();
    Object.assign(raw.components[0]!.program, { localFactors: { schema: "unknown.factor" } });
    expect(joinProgramMixtureFromStorage(raw)).toBeUndefined();
    expect(() => joinProgramMixtureStorageForm(raw)).toThrow("invalid");
    const stored = structuredClone(joinProgramMixtureStorageForm(fixture()));
    Object.assign(stored.mixture.components[0]!.program.header, { localFactors: { schema: "unknown.factor" } });
    expect(joinProgramMixtureFromStorage(stored)).toBeUndefined();
  });

  it("serializes each distinct key atom once instead of every index occurrence", () => {
    const stringify=vi.spyOn(JSON,"stringify");
    try {
      const stored=joinProgramMixtureStorageForm(fixture());
      expect(stored.mixture.components[0]!.program.keyAtomDictionary).toContain("scale.shared");
      expect(stringify.mock.calls.filter(([value])=>value==="scale.shared")).toHaveLength(1);
    } finally { stringify.mockRestore(); }
  });
  it("compacts one shared choice once across repeated keys and all indexes", () => {
    const mixture = fixture();
    const choice = Object.values(mixture.components[0]!.program.exactIndex)[0]![0]!;
    const evidenceRefs = vi.spyOn(choice.evidenceIds, "map");
    try {
      const stored = joinProgramMixtureStorageForm(mixture);
      expect(evidenceRefs).toHaveBeenCalledTimes(1);
      expect(stored.mixture.components[0]!.program.choiceDictionary).toHaveLength(1);
      expect(joinProgramMixtureFromStorage(stored)).toEqual(mixture);
    } finally { evidenceRefs.mockRestore(); }
  });
  it("reuses its immutable packed product while revalidating mutable copies", () => {
    const mixture = fixture();
    const stored = joinProgramMixtureStorageForm(mixture, { immutable: true });
    expect(joinProgramMixtureStorageForm(stored)).toBe(stored);
    expect(() => { stored.mixture.components[0]!.program.choiceDictionary[0]![3].push(99); }).toThrow();
    expect(joinProgramMixtureFromStorage(stored)).toEqual(mixture);
    const copy = structuredClone(stored);
    expect(joinProgramMixtureStorageForm(copy)).not.toBe(copy);
    expect(joinProgramMixtureStorageForm(copy)).toEqual(stored);
    copy.mixture.components[0]!.program.choiceDictionary[0]![3].push(99);
    expect(() => joinProgramMixtureStorageForm(copy)).toThrow("invalid");
  });
  it("retains separate components even when their population identities coincide", () => {
    const mixture = fixture();
    mixture.components.push({ ...mixture.components[0]!, weight: 0.25 });
    expect(joinProgramMixtureFromStorage(joinProgramMixtureStorageForm(mixture))).toEqual(mixture);
  });
  it("interns repeated key atoms and choices across all six indexes and repacks v1 without retraining", () => {
    const mixture = fixture();
    const old = legacy(mixture);
    const stored = joinProgramMixtureStorageForm(old);
    expect(joinProgramMixtureFromStorage(old)).toEqual(mixture);
    expect(joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(stored)))).toEqual(mixture);
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(Buffer.byteLength(JSON.stringify(old)) * 0.3);
    expect(stored.mixture.components[0]!.program.choiceDictionary).toHaveLength(1);
    expect(JSON.stringify(joinProgramMixtureStorageForm(stored))).toBe(JSON.stringify(stored));
    expect(renderJoinedSurface(["alpha", "beta"], joinProgramMixtureFromStorage(stored)!)).toEqual(renderJoinedSurface(["alpha", "beta"], mixture));
    const reversed = structuredClone(mixture);
    for (const name of names) reversed.components[0]!.program[name] = Object.fromEntries(Object.entries(reversed.components[0]!.program[name]).reverse());
    expect(JSON.stringify(joinProgramMixtureStorageForm(reversed))).toBe(JSON.stringify(stored));
    const restored = joinProgramMixtureFromStorage(stored)!;
    const left = Object.values(restored.components[0]!.program.conditionedIndex)[0]![0]!;
    const right = Object.values(restored.components[0]!.program.structuralIndex)[0]![0]!;
    expect(left).not.toBe(right);
    expect(left.evidenceIds).not.toBe(right.evidenceIds);
  });

  it("rejects ambiguous legacy index keys instead of overwriting an earlier entry", () => {
    const old = legacy(fixture());
    const program = old.mixture.components[0]!.program;
    program.indexes.exactIndex!.push(program.indexes.exactIndex![0]!);
    expect(joinProgramMixtureFromStorage(old)).toBeUndefined();
  });

  it("preserves Unicode, NUL, numeric atoms, noncanonical JSON and prototype-like raw keys exactly", () => {
    const mixture = fixture();
    const program = mixture.components[0]!.program;
    const choice = Object.values(program.exactIndex)[0]![0]!;
    const keys = ["__proto__", "constructor", "", "0", "\u0000", "[-0]", "[1e3]", '["\\u0061"]', '[ 1, "x" ]', JSON.stringify(["🐾é\u0000", 123, true, false, null])];
    for (const key of keys) Object.defineProperty(program.exactIndex, key, { value: [{ ...choice, surface: "\u0000雪" }], enumerable: true, configurable: true, writable: true });
    const restored = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(joinProgramMixtureStorageForm(mixture))))!;
    expect(restored).toEqual(mixture);
    for (const key of keys) expect(Object.hasOwn(restored.components[0]!.program.exactIndex, key)).toBe(true);
  });

  it.each(["atom_ref", "choice_ref", "evidence_ref", "coordinate_ref", "duplicate_key", "duplicate_atom", "duplicate_choice", "duplicate_evidence", "duplicate_coordinate", "nonfinite"])("rejects malformed v2 storage: %s", corruption => {
    const stored = structuredClone(joinProgramMixtureStorageForm(fixture()));
    const program = stored.mixture.components[0]!.program;
    if (corruption === "atom_ref") program.indexes.conditionedIndex[0]![0] = [-1];
    if (corruption === "choice_ref") program.indexes.conditionedIndex[0]![1] = [program.choiceDictionary.length];
    if (corruption === "evidence_ref") program.choiceDictionary[0]![3] = [0.5];
    if (corruption === "coordinate_ref") program.choiceDictionary[0]![4] = [Number.MAX_SAFE_INTEGER];
    if (corruption === "duplicate_key") program.indexes.exactIndex.push(program.indexes.exactIndex[0]!);
    if (corruption === "duplicate_atom") program.keyAtomDictionary.push(program.keyAtomDictionary[0]!);
    if (corruption === "duplicate_choice") program.choiceDictionary.push(program.choiceDictionary[0]!);
    if (corruption === "duplicate_evidence") program.evidenceIdDictionary.push(program.evidenceIdDictionary[0]!);
    if (corruption === "duplicate_coordinate") program.evidenceCoordinateDictionary.push(program.evidenceCoordinateDictionary[0]!);
    if (corruption === "nonfinite") program.choiceDictionary[0]![1] = Infinity;
    expect(joinProgramMixtureFromStorage(stored)).toBeUndefined();
  });
});
