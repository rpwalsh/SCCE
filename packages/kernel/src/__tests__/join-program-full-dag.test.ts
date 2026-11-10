// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { buildSegmentationForest } from "../segmentation-forest.js";
import { buildSurfaceLattice, type SurfaceLatticeUnit } from "../surface-lattice.js";
import { compileJoinProgram, compileJoinProgramMixture, derivationShape, renderJoinedSurface, joinProgramChoices } from "../join-program.js";
import { joinProgramMixtureFromStorage, joinProgramMixtureStorageForm } from "../join-program-storage.js";

function binaryDocument(blocks: number, pathLimit: number, documentId = "binary") {
  const text = "\u03b1\u03b2".repeat(blocks), base = buildSurfaceLattice({ documentId, text, evidenceIds: [`evidence.${documentId}`] });
  const graphemes = base.units.filter(unit => unit.overlapClass === "base_partition").sort((a, b) => a.graphemeStart - b.graphemeStart);
  const units: SurfaceLatticeUnit[] = [];
  for (let index = 0; index < blocks; index++) {
    const pair = graphemes.slice(index * 2, index * 2 + 2).map(unit => ({ ...unit,
      boundaryBefore: { ...unit.boundaryBefore, boundaryProbability: unit.graphemeStart % 2 === 0 ? 1 : 0.5 },
      boundaryAfter: { ...unit.boundaryAfter, boundaryProbability: unit.graphemeEnd % 2 === 0 ? 1 : 0.5 } }));
    const [left, right] = pair as [SurfaceLatticeUnit, SurfaceLatticeUnit];
    units.push(left, right, { ...left, id: `whole.${index}`, surface: "\u03b1\u03b2", normalized: "\u03b1\u03b2", kind: "lexical",
      surfaceFormClassId: "class.whole", overlapClass: "segmentation_alternative", boundaryAfter: right.boundaryAfter,
      utf16End: right.utf16End, byteEnd: right.byteEnd, codePointEnd: right.codePointEnd, graphemeEnd: right.graphemeEnd });
  }
  const segmentationForest = buildSegmentationForest({ latticeId: base.id, estimatorId: "binary.proof", units, pathLimit });
  return { documentId, text, lattice: { ...base, units, segmentationForest } };
}

function bridgeDocument(documentId: string, gap = " ") {
  const text = `\u03b1${gap}\u03b2`, base = buildSurfaceLattice({ documentId, text, evidenceIds: [`evidence.${documentId}`] });
  const parts = base.units.filter(unit => unit.overlapClass === "base_partition").sort((a, b) => a.graphemeStart - b.graphemeStart);
  const bridge = parts[1]!;
  const units = [parts[0]!, parts[2]!, ...Array.from({ length: 6 }, (_, index): SurfaceLatticeUnit => ({ ...bridge,
    id: `bridge.${index}`, overlapClass: index ? "segmentation_alternative" : "base_partition" }))];
  const segmentationForest = buildSegmentationForest({ latticeId: base.id, estimatorId: "rounding.proof", units, pathLimit: 6 });
  return { documentId, text, lattice: { ...base, units, segmentationForest } };
}

function conditionedRows(program: ReturnType<typeof compileJoinProgram>, document: ReturnType<typeof binaryDocument>) {
  const byId = new Map(document.lattice.units.map(unit => [unit.id, unit])), rows = new Map<string, ReturnType<typeof joinProgramChoices>>();
  for (const path of document.lattice.segmentationForest.paths) {
    if (!(path.posterior > 0)) continue;
    const units = path.unitIds.map(id => byId.get(id)!).filter(unit => /\S/u.test(unit.surface));
    for (let index = 1; index < units.length; index++) {
      const left = units[index - 1]!, right = units[index]!;
      const key = JSON.stringify([left.normalized, right.normalized, left.surfaceFormClassId, right.surfaceFormClassId, left.kind, right.kind,
        Math.max(1, left.graphemeEnd - left.graphemeStart), Math.max(1, right.graphemeEnd - right.graphemeStart),
        Math.min(7, Math.max(0, Math.floor(left.boundaryAfter.boundaryProbability * 8))), "construction.unresolved", "discourse.unresolved", derivationShape(units)]);
      rows.set(key, joinProgramChoices(program, "conditioned", key));
    }
  }
  return rows;
}

it("counts the exact enumerated local adjacency law once while retaining only measured global shape mass", () => {
  const document = binaryDocument(3, 8), expected = new Map<string, number>(), classes = new Map<string, number>();
  const byId = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  expect(document.lattice.segmentationForest.paths).toHaveLength(8);
  for (const path of document.lattice.segmentationForest.paths) for (let index = 1; index < path.unitIds.length; index++) {
    const left = byId.get(path.unitIds[index - 1]!)!, right = byId.get(path.unitIds[index]!)!, key = JSON.stringify([left.normalized, right.normalized]);
    expected.set(key, (expected.get(key) ?? 0) + path.posterior);
    const classKey = JSON.stringify([left.surfaceFormClassId, right.surfaceFormClassId, left.kind, right.kind,
      Math.min(7, Math.max(0, Math.floor(left.boundaryAfter.boundaryProbability * 8)))]);
    classes.set(classKey, (classes.get(classKey) ?? 0) + path.posterior);
  }
  const complete = compileJoinProgram({ populationId: "proof", documents: [document] });
  for (const [key, count] of expected) expect(joinProgramChoices(complete, "exact", key).reduce((sum, choice) => sum + choice.count, 0)).toBeCloseTo(count, 10);
  for (const [key, count] of classes) expect(joinProgramChoices(complete, "class", key).reduce((sum, choice) => sum + choice.count, 0)).toBeCloseTo(count, 10);
  expect(complete.observations).toBeCloseTo(3.5, 10);
  const limitedDocument = binaryDocument(3, 1);
  const limited = compileJoinProgram({ populationId: "proof", documents: [limitedDocument] });
  expect(limited.exactIndex).toEqual(complete.exactIndex);
  expect(limited.classIndex).toEqual(complete.classIndex);
  expect(limited.localFactors).toEqual(complete.localFactors);
  for (const key of expected.keys()) expect(joinProgramChoices(limited, "exact", key)).toEqual(joinProgramChoices(complete, "exact", key));
  for (const key of classes.keys()) expect(joinProgramChoices(limited, "class", key)).toEqual(joinProgramChoices(complete, "class", key));
  expect(limited.localShapeIndex).toEqual(complete.localShapeIndex);
  expect(limited.observations).toEqual(complete.observations);
  expect([...conditionedRows(limited, limitedDocument).values()].some(choices => choices.length > 0 && choices.reduce((sum, choice) => sum + choice.probability, 0) < 1)).toBe(true);
});

it("learns genuine local joins from 41 binary blocks even when every bounded full path has zero represented mass", () => {
  const document = binaryDocument(41, 16), forest = document.lattice.segmentationForest;
  expect(forest.paths).toHaveLength(16);
  expect((forest.audit as Record<string, unknown>).materializedStates).toBe(1 + forest.graphemeCount * forest.pathLimit);
  expect(document.lattice.units).toHaveLength(41 * 3);
  expect(forest.paths.every(path => path.posterior === 0)).toBe(true);
  const program = compileJoinProgram({ populationId: "proof", documents: [document] });
  expect(program.observations).toBeCloseTo(41 * 1.5 - 1, 9);
  const key = JSON.stringify(["\u03b1", "\u03b2"]), snapshot = JSON.stringify(program);
  expect(joinProgramChoices(program, "exact", key)[0]!.count).toBeCloseTo(41 / 2, 9);
  expect(program.exactIndex).toEqual({});
  expect(program.classIndex).toEqual({});
  expect(program.localFactors!.documents[0]!.units).toHaveLength(document.lattice.units.length);
  expect(program.localFactors!.documents[0]!.graph.arcs).toHaveLength(document.lattice.units.length);
  expect(program.conditionedIndex).toEqual({});
  expect(program.structuralIndex).toEqual({});
  const mixture = compileJoinProgramMixture({ populationModelId: "proof", components: [{ populationId: "proof", weight: 1, program }] });
  expect(renderJoinedSurface(["\u03b1", "\u03b2"], mixture)).toMatchObject({ status: "resolved", text: "\u03b1\u03b2" });
  expect(joinProgramChoices(program, "exact", key).every(choice => choice.count > 0 && choice.probability > 0)).toBe(true);
  expect(JSON.stringify(program)).toBe(snapshot);
  expect(forest.paths).toHaveLength(16);
});

it("includes full local mass from documents with zero retained global mass in each global context denominator", () => {
  const positive = { ...binaryDocument(3, 1, "positive"), sourceFamilyId: "one.family" };
  const zero = { ...binaryDocument(41, 16, "zero"), sourceFamilyId: "one.family" };
  expect(zero.lattice.segmentationForest.paths.every(path => path.posterior === 0)).toBe(true);
  const single = compileJoinProgram({ populationId: "mass", documents: [positive] });
  const combined = compileJoinProgram({ populationId: "mass", documents: [positive, zero] });
  const [key, expected] = [...conditionedRows(single, positive)][0]!;
  expect(expected[0]!.count).toBe(0.25); expect(expected[0]!.probability).toBeCloseTo(0.5, 15);
  const choices = joinProgramChoices(combined, "conditioned", key);
  expect(choices[0]!.count).toBe(expected[0]!.count);
  expect(choices[0]!.probability).toBeCloseTo(0.25 / 10.5, 15);
  expect(choices[0]!.evidenceCoordinates).toEqual(expected[0]!.evidenceCoordinates);
});

it("chooses stronger calibrated local evidence over a weak global factor and cold-preserves unresolved shape mass", () => {
  const document = binaryDocument(3, 1), program = compileJoinProgram({ populationId: "proof", documents: [document] });
  const byId = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  const units = document.lattice.segmentationForest.paths[0]!.unitIds.map(id => byId.get(id)!);
  const context = { units: units.map(unit => ({ surfaceFormClassId: unit.surfaceFormClassId, scaleId: unit.kind,
    graphemeWidth: unit.graphemeEnd - unit.graphemeStart })), boundaries: units.slice(0, -1).map(unit => ({
      boundaryProbability: unit.boundaryAfter.boundaryProbability, derivationShapeId: derivationShape(units) })) };
  const mixture = compileJoinProgramMixture({ populationModelId: "proof", components: [{ populationId: "proof", weight: 1, program }] });
  const rendered = renderJoinedSurface(units.map(unit => unit.surface), mixture, context);
  expect(rendered.status).toBe("resolved");
  expect(rendered.trace.every(step => step.source === "exact")).toBe(true);
  expect(renderJoinedSurface(units.map(unit => unit.surface), joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(joinProgramMixtureStorageForm(mixture))))!, context)).toEqual(rendered);
  const calibrated = { ...mixture, minimumConfidence: 0, components: mixture.components.map(component => ({ ...component,
    program: { ...component.program, backoffReliability: { conditioned: 0.9, exact: 0.1, structural: 0, class: 0, local_shape: 0, construction: 0 } } })) };
  const measured = renderJoinedSurface(units.map(unit => unit.surface), calibrated, context);
  expect(measured.trace.every(step => step.source === "conditioned" && step.support > 0.1)).toBe(true);
  const globals = { ...mixture, minimumConfidence: 0, components: mixture.components.map(component => ({ ...component,
    program: { ...component.program, backoffReliability: { conditioned: 1, structural: 1, exact: 0, class: 0, local_shape: 0, construction: 0 } } })) };
  const partial = renderJoinedSurface(units.map(unit => unit.surface), globals, context);
  expect(partial.trace.some(step => step.support > 0 && step.support < 1 && step.unresolvedPopulationMass > 0)).toBe(true);
  for (const step of partial.trace) expect(step.support + step.unresolvedPopulationMass).toBeCloseTo(1, 10);
  expect(renderJoinedSurface(units.map(unit => unit.surface), joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(joinProgramMixtureStorageForm(globals))))!, context)).toEqual(partial);
});

it("calibrates and evaluates disjoint families against full local mass without double-counting retained paths", () => {
  const documents = Array.from({ length: 10 }, (_, index) => binaryDocument(2, 1, `family.${index}`));
  const program = compileJoinProgram({ populationId: "proof", documents });
  expect(program.observations).toBeCloseTo(program.trainingDocumentIds.length * 2, 9);
  expect(program.evaluation.observations).toBeCloseTo(program.evaluation.heldoutDocumentIds.length * 2, 9);
  expect(program.evaluation.exactAccuracy).toBe(1);
  expect(program.evaluation.reconstructionAccuracy).toBe(1);
  expect(program.evaluation.whitespaceInsertionErrors).toBe(0);
  expect(program.evaluation.whitespaceDeletionErrors).toBe(0);
});

it("requires the canonical full-DAG measure instead of silently relearning from a detached path summary", () => {
  const document = binaryDocument(2, 1);
  expect(() => compileJoinProgram({ populationId: "proof", documents: [{ ...document, lattice: { ...document.lattice,
    segmentationForest: { ...document.lattice.segmentationForest } } }] })).toThrow("canonical full-DAG adjacency measure");
});

it("bounds rounded retained mass by exact pair mass during evaluation and global probability normalization", () => {
  const documents = Array.from({ length: 10 }, (_, index) => bridgeDocument(`rounding.${index}`));
  const forest = documents[0]!.lattice.segmentationForest;
  expect(forest.paths).toHaveLength(6);
  expect(forest.paths.reduce((sum, path) => sum + path.posterior, 0)).toBeGreaterThan(1);
  const program = compileJoinProgram({ populationId: "proof", documents });
  expect(program.evaluation.observations).toBe(program.evaluation.heldoutDocumentIds.length);
  expect(program.evaluation.exactAccuracy).toBe(1);
  const varied = [" ", "\t", "\n", "\r", "\u2003", "\u2009"].map((gap, index) => ({ ...bridgeDocument(`gap.${index}`, gap), sourceFamilyId: "one.family" }));
  const uncertain = compileJoinProgram({ populationId: "proof", documents: varied });
  const rows = conditionedRows(uncertain, varied[0]!);
  expect(rows.size).toBe(1);
  expect([...rows.values()][0]).toHaveLength(varied.length);
  for (const choices of rows.values()) expect(choices.reduce((sum, choice) => sum + choice.probability, 0)).toBeLessThanOrEqual(1);
});
