// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { buildSurfaceLattice, normalizeSurfaceLatticeSurface, type SurfaceLatticeUnit } from "../surface-lattice.js";
import { buildSegmentationForest } from "../segmentation-forest.js";
import { compileJoinProgram, compileJoinProgramMixture, derivationShape, isJoinProgramGlobalFactors, joinProgramChoices, type JoinProgramChoice } from "../join-program.js";
import { joinProgramMixtureFromStorage, joinProgramMixtureStorageForm } from "../join-program-storage.js";
import { createHasher } from "../primitives.js";

function document(ordinal: number, gap: string, alternatives = 6, pathLimit = alternatives) {
  const documentId = `unicode.${ordinal}`, sourceVersionId = `version.${ordinal}`, leftText = "🧪é", text = `${leftText}${gap}字`;
  const evidenceIds = [`evidence.${ordinal}.a`, `evidence.${ordinal}.b`], base = buildSurfaceLattice({ documentId, sourceVersionId, text, evidenceIds });
  const partition = base.units.filter(unit => unit.overlapClass === "base_partition").sort((left, right) => left.graphemeStart - right.graphemeStart);
  const first = partition[0]!, right = partition.at(-1)!, bridge = partition[2]!;
  const left: SurfaceLatticeUnit = { ...first, id: `left.${ordinal}`, surface: leftText, kind: "lexical", normalized: normalizeSurfaceLatticeSurface(leftText, base.normalizationContract),
    surfaceFormClassId: "class.foreign.left", graphemeEnd: 2, codePointEnd: [...leftText].length, utf16End: leftText.length, byteEnd: Buffer.byteLength(leftText) };
  const units: SurfaceLatticeUnit[] = [left, right, ...Array.from({ length: alternatives }, (_, index) => ({ ...bridge, id: `bridge.${ordinal}.${index}`,
    surface: gap, normalized: gap, overlapClass: index ? "segmentation_alternative" as const : "base_partition" as const,
    utf16Start: leftText.length, utf16End: leftText.length + gap.length, byteStart: Buffer.byteLength(leftText), byteEnd: Buffer.byteLength(leftText + gap),
    codePointStart: [...leftText].length, codePointEnd: [...leftText + gap].length, graphemeStart: 2, graphemeEnd: right.graphemeStart }))];
  const segmentationForest = buildSegmentationForest({ latticeId: base.id, estimatorId: "parallel.exact", units, pathLimit });
  return { documentId, sourceFamilyId: "one.source.family", text, constructionId: "construction.exact", discourseStateId: "discourse.exact",
    lattice: { ...base, units, segmentationForest }, left, right, gap, evidenceIds, sourceVersionId };
}
function context(doc: ReturnType<typeof document>, source: "conditioned" | "structural") {
  const { left, right } = doc, bucket = Math.min(7, Math.floor(left.boundaryAfter.boundaryProbability * 8));
  const prefix = source === "conditioned" ? [left.normalized, right.normalized, left.surfaceFormClassId, right.surfaceFormClassId, left.kind, right.kind]
    : ["mark", "letter", left.kind, right.kind];
  return JSON.stringify([...prefix, left.graphemeEnd - left.graphemeStart, right.graphemeEnd - right.graphemeStart, bucket,
    doc.constructionId, doc.discourseStateId, derivationShape([left, right])]);
}

it("derives exact global counts, deficit probabilities and every Unicode proof from retained branch witnesses", () => {
  const gaps = [" ", "\t", "\r\n", "\u2003", "\u2009", " \t"], documents = gaps.map((gap, index) => document(index, gap));
  const program = compileJoinProgram({ populationId: "global.exact", documents });
  const expected: JoinProgramChoice[] = documents.map(doc => ({ surface: doc.gap, count: 1.000000000002, probability: 1 / documents.length,
    evidenceIds: doc.evidenceIds, evidenceCoordinates: doc.evidenceIds.map(evidenceId => ({ evidenceId, sourceVersionId: doc.sourceVersionId, documentId: doc.documentId,
      byteStart: doc.left.byteEnd, byteEnd: doc.right.byteStart, utf16Start: doc.left.utf16End, utf16End: doc.right.utf16Start, exactSurfaceHash: createHasher().digestHex(doc.gap) }))
  })).sort((left, right) => left.surface.localeCompare(right.surface));
  const snapshot = JSON.stringify(program);
  expect(program.conditionedIndex).toEqual({}); expect(program.structuralIndex).toEqual({});
  expect(snapshot).not.toContain("exactSurfaceHash");
  for (const source of ["conditioned", "structural"] as const) {
    const key = context(documents[0]!, source);
    expect(joinProgramChoices(program, source, key)).toEqual(expected);
    expect(joinProgramChoices(program, source, key, { proofs: false })).toEqual(expected.map(choice => ({ ...choice, evidenceCoordinates: [] })));
    const unknown = JSON.parse(key); unknown[unknown.length - 1] = "derivation.unknown";
    expect(joinProgramChoices(program, source, JSON.stringify(unknown))).toEqual([]);
  }
  expect(JSON.stringify(program)).toBe(snapshot);
  const mixture = compileJoinProgramMixture({ populationModelId: "global.exact", components: [{ populationId: "global.exact", weight: 1, program }] });
  const packed = joinProgramMixtureStorageForm(mixture), restored = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(packed)))!;
  expect(restored).toEqual(mixture);
  expect(joinProgramMixtureFromStorage({ ...mixture, schema: "scce.join_program_mixture.v3" })).toBeUndefined();
  const oldRawChild = structuredClone(mixture); oldRawChild.components[0]!.program.schema = "scce.join_program.v3" as never;
  expect(joinProgramMixtureFromStorage(oldRawChild)).toBeUndefined();
  const oldChild = structuredClone(packed); oldChild.mixture.components[0]!.program.header.schema = "scce.join_program.v3" as never;
  expect(joinProgramMixtureFromStorage(oldChild)).toBeUndefined();
  expect(joinProgramMixtureFromStorage({ ...packed, schema: "scce.join_program_mixture.storage.v2" })).toBeUndefined();
  for (const source of ["conditioned", "structural"] as const) expect(joinProgramChoices(restored.components[0]!.program, source, context(documents[0]!, source))).toEqual(expected);
  expect(joinProgramMixtureStorageForm(restored)).toEqual(packed);
  const limitedDoc = document(0, " \t", 6, 1), limited = compileJoinProgram({ populationId: "limited", documents: [limitedDoc] });
  const retained = limitedDoc.lattice.segmentationForest.paths[0]!.posterior;
  for (const source of ["conditioned", "structural"] as const) expect(joinProgramChoices(limited, source, context(limitedDoc, source))[0]).toMatchObject({ count: retained, probability: retained });
});

it("retains parallel branches as sparse decisions and rejects missing, redundant, unused or mixed factor witnesses", () => {
  const doc = document(0, " \t\r\n", 32), program = compileJoinProgram({ populationId: "parallel", documents: [doc] });
  const factors = program.globalFactors!, paths = factors.documents[0]!;
  expect(paths.paths).toHaveLength(32);
  expect(paths.baseChoices).toHaveLength(1);
  expect(paths.paths.reduce((sum, path) => sum + path[1].length, paths.baseChoices.length)).toBe(32);
  expect(paths.paths[0]![1]).toEqual([]);
  expect(isJoinProgramGlobalFactors(factors, program.localFactors!)).toBe(true);
  const mixture = compileJoinProgramMixture({ populationModelId: "parallel", components: [{ populationId: "parallel", weight: 1, program }] });
  const corruptions = [
    (value: typeof factors) => { value.documents[0]!.baseChoices = []; },
    (value: typeof factors) => { value.documents[0]!.paths[1]![1] = [...value.documents[0]!.baseChoices]; },
    (value: typeof factors) => { value.documents[0]!.paths[1]![1] = [999999]; },
    (value: typeof factors) => { value.documents[0]!.paths[1]![0] = 0; },
    (value: typeof factors) => { value.documents[0]!.normalizedOverrides = [[999999, "unknown"]]; },
    (value: typeof factors) => { value.documents[0]!.paths.push(structuredClone(value.documents[0]!.paths[0]!)); }
  ];
  for (const corrupt of corruptions) {
    const raw = structuredClone(mixture); corrupt(raw.components[0]!.program.globalFactors!);
    expect(joinProgramMixtureFromStorage(raw)).toBeUndefined();
    const cold = structuredClone(joinProgramMixtureStorageForm(mixture)); corrupt(cold.mixture.components[0]!.program.header.globalFactors!);
    expect(joinProgramMixtureFromStorage(cold)).toBeUndefined();
  }
  const mixed = structuredClone(mixture); mixed.components[0]!.program.conditionedIndex["forged"] = [];
  expect(joinProgramMixtureFromStorage(mixed)).toBeUndefined();
  const mixedCold = structuredClone(joinProgramMixtureStorageForm(mixture)); mixedCold.mixture.components[0]!.program.indexes.structuralIndex.push(["forged", []]);
  expect(joinProgramMixtureFromStorage(mixedCold)).toBeUndefined();
});

it("keeps construction and discourse contexts distinct including explicitly empty IDs", () => {
  const a = { ...document(0, " "), constructionId: "", discourseStateId: "" }, b = document(1, "\t");
  const program = compileJoinProgram({ populationId: "scopes", documents: [a, b] });
  for (const source of ["conditioned", "structural"] as const) {
    expect(joinProgramChoices(program, source, context(a, source)).map(choice => choice.surface)).toEqual([a.gap]);
    expect(joinProgramChoices(program, source, context(b, source)).map(choice => choice.surface)).toEqual([b.gap]);
    const unknown = JSON.parse(context(a, source)); unknown[unknown.length - 2] = "discourse.unknown";
    expect(joinProgramChoices(program, source, JSON.stringify(unknown))).toEqual([]);
  }
});

it("owns its numeric witness index without retaining mutable caller path decisions", () => {
  const doc = document(0, "\r\n"), program = compileJoinProgram({ populationId: "snapshot", documents: [doc] });
  const key = context(doc, "conditioned"), original = structuredClone(joinProgramChoices(program, "conditioned", key));
  program.globalFactors!.documents[0]!.baseChoices = [];
  expect(joinProgramChoices(program, "conditioned", key)).toEqual(original);
  expect(isJoinProgramGlobalFactors(program.globalFactors, program.localFactors!)).toBe(false);
});

it("preserves nonderivable normalized unit labels without inventing a source-normalized alias", () => {
  const doc = document(0, "\t"); doc.left.normalized = "opaque.normalized.🧪";
  const program = compileJoinProgram({ populationId: "custom.label", documents: [doc] }), key = context(doc, "conditioned");
  expect(program.globalFactors!.documents[0]!.normalizedOverrides).toHaveLength(1);
  const choices = joinProgramChoices(program, "conditioned", key);
  expect(choices[0]!.surface).toBe(doc.gap); expect(choices[0]!.evidenceIds).toEqual(doc.evidenceIds);
  const sourceAlias = JSON.parse(key); sourceAlias[0] = normalizeSurfaceLatticeSurface(doc.left.surface, doc.lattice.normalizationContract);
  expect(joinProgramChoices(program, "conditioned", JSON.stringify(sourceAlias))).toEqual([]);
  const mixture = compileJoinProgramMixture({ populationModelId: "custom.label", components: [{ populationId: "custom.label", weight: 1, program }] });
  const cold = joinProgramMixtureFromStorage(JSON.parse(JSON.stringify(joinProgramMixtureStorageForm(mixture))))!;
  expect(joinProgramChoices(cold.components[0]!.program, "conditioned", key)).toEqual(choices);
});
