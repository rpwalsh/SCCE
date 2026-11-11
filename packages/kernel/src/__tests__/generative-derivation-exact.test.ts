// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { buildConstructionAlgebra, deriveGenerativeStructure, realizeDerivation, searchBestDerivation, searchTargetConditionedDerivation } from "../generative-derivation-runtime.js";
import { REVERSIBLE_CONSTRUCTION_SCHEMA, type ReversibleConstruction } from "../reversible-construction.js";

function construction(id: string, relationId: string, text: string, evidenceIds = [`evidence.${id}`], argument?: {type: string; start: number; end: number}): ReversibleConstruction {
  const portId = `${id}.port`, slotId = `${id}.slot`;
  return {
    schema: REVERSIBLE_CONSTRUCTION_SCHEMA, id, seriesId: `${id}.series`, planId: `${id}.plan`, promotionModelId: `${id}.promotion`, profileId: "profile.exact",
    graph: {hyperedgeIds: [`${id}.edge`], relationNodeIds: [`${id}.relation`], ports: [{id: portId, graphTargetId: `${id}.target`, kind: "relation", relationId, relationNodeId: `${id}.relation`, hyperedgeId: `${id}.edge`, ...(argument ? {roleId: argument.type} : {}), boundary: Boolean(argument), surfaceSlotIds: argument ? [slotId] : [], evidenceIds}], boundaryPortIds: argument ? [portId] : []},
    surface: {latticeId: `${id}.lattice`, sourceFamilyId: `${id}.family`, sourceVersionId: `${id}.version`, sourceUtf16Start: 0, sourceUtf16End: text.length, sourceSurface: text, slots: argument ? [{id: slotId, surfaceUnitId: `${id}.unit`, occurrenceId: `${id}.occurrence`, surfaceFormClassId: `${id}.form`, graphPortIds: [portId], relativeUtf16Start: argument.start, relativeUtf16End: argument.end, observedSurface: text.slice(argument.start, argument.end), evidence: []}] : [], boundarySlotIds: argument ? [slotId] : []},
    discourseConditions: {status: "unconditioned", requiredStateIds: [], excludedStateIds: []}, populationPosterior: [], support: {inductionSourceFamilyIds: [`${id}.family`], independentHeldoutSourceFamilyIds: [], heldoutCoverage: 1, cycleRecall: 1, exactAnchorsPreserved: true, unsupportedAdditionCount: 0, transportMass: 1}, provenance: {supportId: `${id}.support`, targetIndexId: `${id}.targets`, evidenceAllocationId: `${id}.allocation`, evidenceIds}, calibration: {modelId: `${id}.calibration`, status: "insufficient_data", probability: null}, creationSnapshot: {id: "snapshot.exact", createdAt: 1}, executableDirections: ["interpretation", "realization"], audit: {}
  };
}
const algebraFor = (...constructions: ReversibleConstruction[]) => buildConstructionAlgebra({constructions, maxRecursionDepth: 3});

describe("exact proof-carrying derivation realization", () => {
  it("preserves outer whitespace, CRLF, tabs, combining marks, astral Unicode and valid empty literals", () => {
    for (const text of [" \t💠 e\u0301\r\n  ", "", "\r\n\t"]) {
      const leaf = construction("leaf", "relation.leaf", text);
      expect(realizeDerivation({constructionId: leaf.id, algebra: algebraFor(leaf)})).toMatchObject({status: "resolved", text, evidenceIds: ["evidence.leaf"]});
    }
  });

  it("realizes the selected nested children exactly with parent-owned punctuation and ownership", () => {
    const leaf = construction("leaf", "relation.leaf", " \tβ e\u0301\r\n ");
    const middle = construction("middle", "relation.middle", "{\r\n\tX\r\n}", undefined, {type: "relation.leaf", start: 4, end: 5});
    const outer = construction("outer", "relation.outer", "💠[Y]\r\n", undefined, {type: "relation.middle", start: 3, end: 4});
    const algebra = algebraFor(outer, middle, leaf);
    const selected = algebra.composed.find(row => row.baseConstructionId === outer.id && row.ports.some(port => algebra.registry.composed[port.childConstructionId]?.baseConstructionId === middle.id))!;
    const result = realizeDerivation({constructionId: selected.id, algebra});
    expect(result).toMatchObject({status: "resolved", text: `💠[{\r\n\t${leaf.surface.sourceSurface}\r\n}]\r\n`});
    if (result.status !== "resolved") throw new Error(result.status);
    expect(result.evidenceIds.sort()).toEqual(["evidence.leaf", "evidence.middle", "evidence.outer"]);
    expect(result.derivation.children[0]?.derivation.children[0]?.derivation.source).toMatchObject({sourceFamilyId: "leaf.family", sourceVersionId: "leaf.version"});
    expect(result.outputMappings).toContainEqual(expect.objectContaining({
      kind: "child", constructionId: selected.id, portId: "outer.port", outputUtf16Start: 3
    }));
    expect(result.outputMappings.filter(mapping => mapping.kind === "literal").map(mapping =>
      result.text.slice(mapping.outputUtf16Start, mapping.outputUtf16End)).join("")).toBe(result.text);
  });

  it("does not invent delimiters between discontinuous spans", () => {
    const leaf = construction("dis", "relation.dis", "A\tB\r\nC");
    leaf.surface.discontinuous = {id: "dis.order", spans: [{id: "tail", order: 0, utf16Start: 2, utf16End: 6, portIds: []}, {id: "head", order: 1, utf16Start: 0, utf16End: 2, portIds: []}]};
    expect(realizeDerivation({constructionId: leaf.id, algebra: algebraFor(leaf)})).toMatchObject({status: "resolved", text: "B\r\nCA\t"});
  });

  it("substitutes every selected occurrence of the same typed port", () => {
    const parent = construction("twice", "relation.twice", "X\tX", undefined, {type: "relation.leaf", start: 0, end: 1});
    parent.surface.slots.push({...parent.surface.slots[0]!, id: "twice.slot.second", relativeUtf16Start: 2, relativeUtf16End: 3});
    const leaf = construction("leaf", "relation.leaf", "β");
    const algebra = algebraFor(parent, leaf);
    expect(realizeDerivation({constructionId: algebra.composed[0]!.id, algebra})).toMatchObject({status: "resolved", text: "β\tβ"});
  });

  it("accepts a zero-length insertion span", () => {
    const parent = construction("insert", "relation.insert", "[]", undefined, {type: "relation.leaf", start: 1, end: 1});
    const leaf = construction("leaf", "relation.leaf", "");
    const algebra = algebraFor(parent, leaf);
    expect(realizeDerivation({constructionId: algebra.composed[0]!.id, algebra})).toMatchObject({status: "resolved", text: "[]"});
  });

  it("rejects absent children, unknown constructions, invalid spans and split surrogate coordinates explicitly", () => {
    const leaf = construction("leaf", "relation.leaf", "β");
    const parent = construction("parent", "relation.parent", "A💠B", undefined, {type: "relation.leaf", start: 2, end: 3});
    const algebra = algebraFor(parent, leaf);
    expect(realizeDerivation({constructionId: parent.id, algebra})).toMatchObject({status: "unresolved-binding"});
    expect(realizeDerivation({constructionId: "missing", algebra})).toMatchObject({status: "unsupported-construction"});
    expect(realizeDerivation({constructionId: algebra.composed[0]!.id, algebra})).toMatchObject({status: "invalid-span"});
    algebra.operators.get(parent.id)!.surface.slots[0]!.end = 100;
    expect(realizeDerivation({constructionId: algebra.composed[0]!.id, algebra})).toMatchObject({status: "invalid-span"});
  });

  it("rejects cycles, exhausted budgets and unavailable evidence distinctly", () => {
    const leaf = construction("leaf", "relation.leaf", "β");
    const parent = construction("parent", "relation.parent", "[X]", undefined, {type: "relation.leaf", start: 1, end: 2});
    const algebra = algebraFor(parent, leaf), composite = algebra.composed[0]!;
    expect(realizeDerivation({constructionId: composite.id, algebra, maxDepth: 0})).toMatchObject({status: "resource-exhausted"});
    expect(realizeDerivation({constructionId: leaf.id, algebra, maxOutputUtf16: 0})).toMatchObject({status: "resource-exhausted"});
    expect(realizeDerivation({constructionId: leaf.id, algebra, isEvidenceSupported: () => false})).toMatchObject({status: "evidence-unavailable"});
    composite.ports[0]!.childConstructionId = composite.id;
    expect(realizeDerivation({constructionId: composite.id, algebra})).toMatchObject({status: "cycle"});
  });

  it("realizes the selected chart operator rather than the first operator for its coverage", () => {
    const weak = construction("weak", "relation.same", "FIRST WEAK OUTPUT", ["evidence.weak"]);
    const strong = construction("strong", "relation.same", "SELECTED STRONG OUTPUT", ["evidence.strong.1", "evidence.strong.2", "evidence.strong.3"]);
    const target = {parts: [{id: "part.same", relationId: "relation.same", roles: [], evidenceIds: [...weak.provenance.evidenceIds, ...strong.provenance.evidenceIds]}], audit: {}};
    const result = searchTargetConditionedDerivation({target, algebra: algebraFor(weak, strong)});
    expect(result.text).toBe(strong.surface.sourceSurface);
    expect(result.evidenceIds).toEqual(strong.provenance.evidenceIds);
    expect(result.selectedDerivation?.operatorIds).toEqual([strong.id]);
    expect(result.selectedDerivation?.ruleIds).toContain("atom.part.same::strong");
    expect(result.alternatives).toContainEqual(expect.objectContaining({constructionId: weak.id, text: weak.surface.sourceSurface}));
  });

  it("keeps different operators distinct when they share the same evidence", () => {
    const first = construction("first", "relation.same", " \tfirst\r\n", ["evidence.shared"]), second = construction("second", "relation.same", "second", ["evidence.shared"]);
    const result = searchTargetConditionedDerivation({target: {parts: [{id: "part.same", relationId: "relation.same", roles: [], evidenceIds: ["evidence.shared"]}], audit: {}}, algebra: algebraFor(first, second)});
    expect(result.text).toBe(first.surface.sourceSurface);
    expect(result.selectedDerivation?.operatorIds).toEqual([first.id]);
    expect(result.alternatives).toContainEqual(expect.objectContaining({constructionId: second.id, text: second.surface.sourceSurface}));
  });

  it("rejects unsupported leaves even alongside unrelated supported target parts", () => {
    const unsupported = construction("unsupported", "relation.unsupported", "UNSUPPORTED", []), supported = construction("supported", "relation.supported", "SUPPORTED");
    const algebra = algebraFor(unsupported, supported);
    expect(searchBestDerivation({algebra: algebraFor(unsupported)})).toMatchObject({text: "", evidenceIds: [], realization: {status: "evidence-unavailable"}});
    const result = searchTargetConditionedDerivation({target: {parts: [{id: "a", relationId: "relation.unsupported", roles: [], evidenceIds: []}, {id: "b", relationId: "relation.supported", roles: [], evidenceIds: ["evidence.supported"]}], audit: {}}, algebra});
    expect(result.coveredPartIds).toEqual(["b"]);
    expect(result.text).toBe("SUPPORTED");
    expect(result.evidenceIds).toEqual(["evidence.supported"]);
  });

  it("never concatenates independently licensed target parts without one owning construction", () => {
    const first = construction("first", "relation.first", "FIRST");
    const second = construction("second", "relation.second", "SECOND");
    const result = searchTargetConditionedDerivation({
      target: {parts: [
        {id: "part.first", relationId: "relation.first", roles: [], evidenceIds: ["evidence.first"]},
        {id: "part.second", relationId: "relation.second", roles: [], evidenceIds: ["evidence.second"]}
      ], audit: {}},
      algebra: algebraFor(first, second)
    });
    expect([first.surface.sourceSurface, second.surface.sourceSurface]).toContain(result.text);
    expect(result.text).not.toContain(`${first.surface.sourceSurface} ${second.surface.sourceSurface}`);
    expect(result.text).not.toContain(`${second.surface.sourceSurface} ${first.surface.sourceSurface}`);
    expect(result.coveredPartIds).toHaveLength(1);
  });

  it("requires target evidence to be owned by the selected construction", () => {
    const constructionWithOtherEvidence = construction("other", "relation.same", "UNRELATED", ["evidence.other"]);
    const result = searchTargetConditionedDerivation({
      target: {parts: [{id: "part.same", relationId: "relation.same", roles: [], evidenceIds: ["evidence.target"]}], audit: {}},
      algebra: algebraFor(constructionWithOtherEvidence)
    });
    expect(result.text).toBe("");
    expect(result.evidenceIds).toEqual([]);
    expect(result.realization).toMatchObject({status: "evidence-unavailable"});
  });

  it("carries selected nested child evidence through the existing diagnostic entry point", () => {
    const parent = construction("parent", "relation.parent", "[X]\r\n", undefined, {type: "relation.leaf", start: 1, end: 2});
    const leaf = construction("leaf", "relation.leaf", "\tβ\t");
    const result = deriveGenerativeStructure({constructions: [parent, leaf]});
    expect(result.text).toBe("[\tβ\t]\r\n");
    expect(result.realization.status).toBe("resolved");
    expect(result.evidenceIds.sort()).toEqual(["evidence.leaf", "evidence.parent"]);
  });
});
