// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { buildSegmentationForest, segmentationSurfaceAdjacencies } from "../segmentation-forest.js";
import * as adjacency from "../segmentation-adjacency-factors.js";
import { compileJoinProgram, compileJoinProgramMixture, joinProgramChoices, renderJoinedSurface, type JoinEvidenceCoordinate } from "../join-program.js";
import { joinProgramMixtureFromStorage, joinProgramMixtureStorageForm } from "../join-program-storage.js";
import { createHasher } from "../primitives.js";

afterEach(() => vi.restoreAllMocks());
const coordinateKey = (value: JoinEvidenceCoordinate) => [value.evidenceId, value.sourceVersionId ?? "", value.documentId,
  value.byteStart, value.byteEnd, value.utf16Start, value.utf16End, value.exactSurfaceHash].join("\u001f");

function fixture(text = "\u03b1 \u03b2 \u03b1 \u03b2", documentId = "source.proof") {
  const sourceVersionId = "version.proof", hasher = createHasher();
  const lattice = buildSurfaceLattice({ documentId, sourceVersionId, text, evidenceIds: ["evidence.a", "evidence.b"], hasher });
  lattice.units = lattice.units.filter(unit => unit.overlapClass === "base_partition");
  lattice.segmentationForest = buildSegmentationForest({ latticeId: lattice.id, estimatorId: "proof", units: lattice.units, pathLimit: 1, hasher });
  const bearing = lattice.units.filter(unit => !/^\s+$/u.test(unit.surface));
  const coordinates: JoinEvidenceCoordinate[] = [];
  for (let index = 1; index < bearing.length; index++) {
    const left = bearing[index - 1]!, right = bearing[index]!, surface = text.slice(left.utf16End, right.utf16Start);
    for (const evidenceId of ["evidence.a", "evidence.b"]) coordinates.push({ evidenceId, sourceVersionId, documentId,
      byteStart: left.byteEnd, byteEnd: right.byteStart, utf16Start: left.utf16End, utf16End: right.utf16Start, exactSurfaceHash: hasher.digestHex(surface) });
  }
  coordinates.sort((a, b) => coordinateKey(a).localeCompare(coordinateKey(b)));
  return { text, documentId, lattice, coordinates };
}

it("emits kinds instead of derivable class hashes and recovers the complete eager local-shape proof after a cold round trip", () => {
  const document = fixture(), program = compileJoinProgram({ populationId: "proof", documents: [document] });
  expect(program.localFactors!.documents[0]!.contexts.every(context => context.length === 1)).toBe(true);
  expect(JSON.stringify(program.localFactors)).not.toContain("surface_form_class.");
  expect(Object.values(program.localShapeIndex).flat().every(choice => choice.evidenceCoordinates.length === 0)).toBe(true);
  const snapshot = JSON.stringify(program), key = JSON.stringify(["letter", "letter"]);
  const expected = [{ surface: " ", count: 3, probability: 1, evidenceIds: ["evidence.a", "evidence.b"], evidenceCoordinates: document.coordinates }];
  expect(joinProgramChoices(program, "local_shape", key)).toEqual(expected);
  expect(joinProgramChoices(program, "local_shape", key, { proofs: false })[0]!.evidenceCoordinates).toEqual([]);
  const mixture = compileJoinProgramMixture({ populationModelId: "proof", components: [{ populationId: "proof", weight: 1, program }] });
  const stored = joinProgramMixtureStorageForm(mixture), cold = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(stored)))!;
  expect(joinProgramChoices(cold.components[0]!.program, "local_shape", key)).toEqual(expected);
  const rendered = renderJoinedSurface(["\u03b3", "\u03b4"], mixture);
  expect(rendered.status).toBe("resolved"); expect(rendered.trace[0]!.source).toBe("local_shape");
  expect(rendered.trace[0]!.evidenceCoordinates).toEqual(document.coordinates);
  expect(renderJoinedSurface(["\u03b3", "\u03b4"], cold)).toEqual(rendered);
  expect(JSON.stringify(program)).toBe(snapshot);
  expect(joinProgramMixtureStorageForm(cold)).toEqual(stored);
});

it("does not traverse broad local-shape proof pairs when stronger exact evidence wins", () => {
  const document = fixture(), other = fixture("\u03b3\u03b4", "source.other");
  const program = compileJoinProgram({ populationId: "proof", documents: [document, other].map(document => ({ ...document, sourceFamilyId: "proof.family" })) });
  expect(program.localShapeIndex[JSON.stringify(["letter", "letter"])]!.every(choice => choice.probability < 1)).toBe(true);
  const original = adjacency.createSegmentationAdjacencyQuery, selections: Array<{ left: number; right: number; bearing: number }> = [];
  vi.spyOn(adjacency, "createSegmentationAdjacencyQuery").mockImplementation((factors, bearing) => {
    const query = original(factors, bearing);
    return { pairs(selection) {
      selections.push({ left: selection?.leftArcIndices?.size ?? bearing.size, right: selection?.rightArcIndices?.size ?? bearing.size, bearing: bearing.size });
      return query.pairs(selection);
    } };
  });
  const mixture = compileJoinProgramMixture({ populationModelId: "proof", components: [{ populationId: "proof", weight: 1, program }] });
  const rendered = renderJoinedSurface(["\u03b1", "\u03b2"], mixture);
  expect(rendered.status).toBe("resolved"); expect(rendered.trace[0]!.source).toBe("exact");
  expect(selections.length).toBeGreaterThan(0);
  expect(selections.every(selection => selection.left < selection.bearing && selection.right < selection.bearing)).toBe(true);
});

it("retains an explicit genuinely foreign class label instead of silently deriving a replacement", () => {
  const document = fixture(), first = document.lattice.units.find(unit => unit.surface === "\u03b1")!;
  first.surfaceFormClassId = "class.foreign";
  const program = compileJoinProgram({ populationId: "proof", documents: [document] });
  expect(program.localFactors!.documents[0]!.contexts).toContainEqual([first.kind, "class.foreign"]);
  const right = document.lattice.units.find(unit => unit.surface === "\u03b2")!;
  const key = JSON.stringify([first.surfaceFormClassId, right.surfaceFormClassId, first.kind, right.kind,
    Math.min(7, Math.max(0, Math.floor(first.boundaryAfter.boundaryProbability * 8)))]);
  const expected = joinProgramChoices(program, "class", key);
  expect(expected[0]!.count).toBe(1);
  const mixture = compileJoinProgramMixture({ populationModelId: "proof", components: [{ populationId: "proof", weight: 1, program }] });
  const cold = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(joinProgramMixtureStorageForm(mixture))))!;
  expect(joinProgramChoices(cold.components[0]!.program, "class", key)).toEqual(expected);
});


it("recovers fixed-construction proofs from their owning factor documents only", () => {
  const first = { ...fixture(), constructionId: "construction.a" };
  const second = { ...fixture(), documentId: "source.other", constructionId: "construction.b" };
  const program = compileJoinProgram({ populationId: "proof", documents: [first, second] });
  const key = JSON.stringify([first.constructionId, "letter", "letter"]);
  expect(program.constructionIndex[key]![0]!.evidenceCoordinates).toEqual([]);
  expect(joinProgramChoices(program, "construction", key)[0]!.evidenceCoordinates).toEqual(first.coordinates);
  const mixture = compileJoinProgramMixture({ populationModelId: "proof", components: [{ populationId: "proof", weight: 1, program }] });
  const cold = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(joinProgramMixtureStorageForm(mixture))))!;
  expect(joinProgramChoices(cold.components[0]!.program, "construction", key)).toEqual(joinProgramChoices(program, "construction", key));
});


it("reuses lattice whitespace normalization for multiline exact and canonical class queries", () => {
  const text = "\u03b1\n  \u03b2 \u03b3", documentId = "source.multiline", lattice = buildSurfaceLattice({ documentId, text, evidenceIds: ["evidence.multiline"] });
  const multiline = lattice.units.find(unit => unit.surface === "\u03b1\n  \u03b2")!;
  expect(multiline).toBeDefined();
  const right = lattice.units.find(unit => unit.surface === "\u03b3")!;
  lattice.units = lattice.units.filter(unit => unit.overlapClass === "base_partition" || unit.id === multiline.id);
  lattice.segmentationForest = buildSegmentationForest({ latticeId: lattice.id, estimatorId: "multiline", units: lattice.units, pathLimit: 1 });
  const program = compileJoinProgram({ populationId: "proof", documents: [{ text, documentId, lattice }] });
  expect(program.localFactors!.documents[0]!.contexts.every(context => context.length === 1)).toBe(true);
  const key = JSON.stringify([multiline.normalized, right.normalized]);
  const exact = joinProgramChoices(program, "exact", key);
  expect(exact.length).toBeGreaterThan(0);
  const classKey = JSON.stringify([multiline.surfaceFormClassId, right.surfaceFormClassId, multiline.kind, right.kind,
    Math.min(7, Math.max(0, Math.floor(multiline.boundaryAfter.boundaryProbability * 8)))]);
  expect(joinProgramChoices(program, "class", classKey)).toEqual(exact);
});


it("preserves genuine code-symbol source bounds inside an extended grapheme cluster", () => {
  const text = "\u09ae\u09b2\u09cd\u09b2\u09bf z", documentId = "source.partial", lattice = buildSurfaceLattice({ documentId, text, evidenceIds: ["evidence.partial"] });
  const left = lattice.units.find(unit => unit.kind === "code_symbol")!, right = lattice.units.find(unit => unit.surface === "z")!;
  expect(left.surface).toBe("\u09ae\u09b2");
  const bearing = new Set(lattice.units.filter(unit => !/^\s+$/u.test(unit.surface)).map(unit => unit.id));
  const pair = [...segmentationSurfaceAdjacencies(lattice.segmentationForest, bearing)].find(pair => pair.leftUnitId === left.id && pair.rightUnitId === right.id)!;
  expect(pair.posterior).toBeGreaterThan(0);
  const program = compileJoinProgram({ populationId: "proof", documents: [{ text, documentId, lattice }] });
  expect(program.localFactors!.documents[0]!.contexts.every(context => context.length === 1)).toBe(true);
  const surface = text.slice(left.utf16End, right.utf16Start), expected = [{ surface, count: Number(pair.posterior.toFixed(12)), probability: 1,
    evidenceIds: ["evidence.partial"], evidenceCoordinates: [{ evidenceId: "evidence.partial", documentId, byteStart: left.byteEnd, byteEnd: right.byteStart,
      utf16Start: left.utf16End, utf16End: right.utf16Start, exactSurfaceHash: createHasher().digestHex(surface) }] }];
  const key = JSON.stringify([left.normalized, right.normalized]);
  expect(joinProgramChoices(program, "exact", key)).toEqual(expected);
  expect(program.localFactors!.documents[0]!.units.some(unit => unit?.length === 5)).toBe(true);
  const classKey = JSON.stringify([left.surfaceFormClassId, right.surfaceFormClassId, left.kind, right.kind,
    Math.min(7, Math.max(0, Math.floor(left.boundaryAfter.boundaryProbability * 8)))]);
  expect(joinProgramChoices(program, "class", classKey)).toEqual(expected);
  const mixture = compileJoinProgramMixture({ populationModelId: "proof", components: [{ populationId: "proof", weight: 1, program }] });
  const cold = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(joinProgramMixtureStorageForm(mixture))))!;
  expect(joinProgramChoices(cold.components[0]!.program, "exact", key)).toEqual(expected);
});
