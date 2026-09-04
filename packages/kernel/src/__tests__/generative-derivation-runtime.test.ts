// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  buildConstructionAlgebra,
  constructionOperator,
  deriveGenerativeStructure,
  operatorsForTargetPart,
  realizeDerivation,
  searchTargetConditionedDerivation,
  semanticTargetFromGraph
} from "../generative-derivation-runtime.js";
import { REVERSIBLE_CONSTRUCTION_SCHEMA, type ReversibleConstruction } from "../reversible-construction.js";

/**
 * The ceiling test.
 *
 * A finite-library recombinator can only emit a structure some learned
 * construction already described. A recursively closed algebra can emit a
 * structure no construction described, by composing them. These tests
 * require the second behavior specifically: the realized surface must be
 * one that does NOT appear in any input construction.
 */
describe("recursive generative derivation (ceiling break)", () => {
  /**
   * Two learned constructions:
   *   discover : ENTITY -> EVENT      "the scientist discovered <thing>"
   *   cause    : EVENT  -> RELATION   "because <event> the tower fell"
   * `cause` has an open argument of type EVENT; `discover` produces EVENT.
   * Neither construction's own surface contains the other's.
   */
  const construction = (input: {
    id: string;
    relationId: string;
    surface: string;
    argument?: { roleId: string; start: number; end: number };
    evidenceIds: string[];
  }): ReversibleConstruction => {
    const portId = `${input.id}.port.arg`;
    const slotId = `${input.id}.slot.arg`;
    return {
      schema: REVERSIBLE_CONSTRUCTION_SCHEMA,
      id: input.id,
      seriesId: `${input.id}.series`,
      planId: `${input.id}.plan`,
      promotionModelId: `${input.id}.promotion`,
      profileId: "profile.test",
      graph: {
        hyperedgeIds: [`${input.id}.hyperedge`],
        relationNodeIds: [`${input.id}.relation`],
        ports: [{
          id: portId,
          graphTargetId: `${input.id}.target`,
          kind: "participant",
          relationId: input.relationId,
          relationNodeId: `${input.id}.relation`,
          hyperedgeId: `${input.id}.hyperedge`,
          ...(input.argument ? { roleId: input.argument.roleId } : {}),
          boundary: Boolean(input.argument),
          surfaceSlotIds: input.argument ? [slotId] : [],
          evidenceIds: input.evidenceIds
        }],
        boundaryPortIds: input.argument ? [portId] : []
      },
      surface: {
        latticeId: `${input.id}.lattice`,
        sourceFamilyId: "family.test",
        sourceVersionId: `${input.id}.sv`,
        sourceUtf16Start: 0,
        sourceUtf16End: input.surface.length,
        sourceSurface: input.surface,
        slots: input.argument ? [{
          id: slotId,
          surfaceUnitId: `${input.id}.unit`,
          occurrenceId: `${input.id}.occurrence`,
          surfaceFormClassId: `${input.id}.formclass`,
          graphPortIds: [portId],
          relativeUtf16Start: input.argument.start,
          relativeUtf16End: input.argument.end,
          observedSurface: input.surface.slice(input.argument.start, input.argument.end),
          evidence: []
        }] : [],
        boundarySlotIds: input.argument ? [slotId] : []
      },
      discourseConditions: {}
    } as unknown as ReversibleConstruction;
  };

  // "because SOMEEVENT the tower fell" -- open EVENT argument at [8,17)
  const causeConstruction = construction({
    id: "cause",
    relationId: "relation.cause",
    surface: "because SOMEEVENT the tower fell",
    argument: { roleId: "relation.event", start: 8, end: 17 },
    evidenceIds: ["evidence.cause.1", "evidence.cause.2"]
  });
  // "the scientist discovered the flaw" -- produces relation.event
  const discoverConstruction = construction({
    id: "discover",
    relationId: "relation.event",
    surface: "the scientist discovered the flaw",
    evidenceIds: ["evidence.discover.1"]
  });

  it("reads a learned construction as a typed operator with real argument and result types", () => {
    const operator = constructionOperator(causeConstruction);
    expect(operator).toBeDefined();
    expect(operator!.resultType).toBe("relation.cause");
    expect(operator!.argumentTypes).toEqual([{ portId: "cause.port.arg", type: "relation.event" }]);
    // A construction with no open boundary port is a saturated value, not a function.
    expect(constructionOperator(discoverConstruction)!.argumentTypes).toEqual([]);
  });

  it("closes a finite construction set under composition, producing composites", () => {
    const algebra = buildConstructionAlgebra({
      constructions: [causeConstruction, discoverConstruction],
      maxRecursionDepth: 3
    });
    expect(algebra.composed.length).toBeGreaterThan(0);
    const composite = algebra.composed[0]!;
    expect(composite.baseConstructionId).toBe("cause");
    expect(composite.ports[0]!.childConstructionId).toBe("discover");
    expect(composite.depth).toBe(1);
  });

  it("refuses to compose a type that no construction produces", () => {
    const mismatched = construction({
      id: "mismatch",
      relationId: "relation.other",
      surface: "although SOMETHING nothing happened",
      argument: { roleId: "relation.nonexistent", start: 9, end: 18 },
      evidenceIds: ["evidence.mismatch.1"]
    });
    const algebra = buildConstructionAlgebra({ constructions: [mismatched], maxRecursionDepth: 3 });
    expect(algebra.composed).toEqual([]);
  });

  it("THE CEILING BREAK: realizes a surface that appears in no input construction", () => {
    const algebra = buildConstructionAlgebra({
      constructions: [causeConstruction, discoverConstruction],
      maxRecursionDepth: 3
    });
    const composite = algebra.composed[0]!;
    const realized = realizeDerivation({ constructionId: composite.id, algebra });

    // The composite realization substitutes the child's surface into the
    // parent's open slot -- a homomorphism, not a lookup.
    expect(realized).toBe("because the scientist discovered the flaw the tower fell");

    // And that exact surface is in neither learned construction.
    expect(causeConstruction.surface.sourceSurface).not.toContain(realized);
    expect(discoverConstruction.surface.sourceSurface).not.toContain(realized);
    expect(realized).not.toBe(causeConstruction.surface.sourceSurface);
    expect(realized).not.toBe(discoverConstruction.surface.sourceSurface);
  });

  it("searches the packed derivation forest and returns a licensed best derivation", () => {
    const result = deriveGenerativeStructure({
      constructions: [causeConstruction, discoverConstruction],
      maxRecursionDepth: 3
    });
    expect(result.bestConstructionId).toBeDefined();
    expect(Number.isFinite(result.bestScore)).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    // The derivation carries the real evidence that licensed it.
    expect(result.evidenceIds.length).toBeGreaterThan(0);
    expect(result.chart.cells.size).toBeGreaterThan(0);
  });

  it("an empty construction set derives nothing rather than inventing a structure", () => {
    const result = deriveGenerativeStructure({ constructions: [], maxRecursionDepth: 3 });
    expect(result.text).toBe("");
    expect(result.bestConstructionId).toBeUndefined();
  });

  it("reads a real semantic target from the turn's own graph hyperedges", () => {
    const target = semanticTargetFromGraph({
      graph: {
        hyperedges: [{
          schema: "scce.hyperedge.v2",
          id: "hyperedge.cause.1",
          relationId: "relation.cause",
          participantPorts: [
            { portId: "p1", roleId: "relation.event", nodeId: "node.a", valueKind: "observable.string", realization: "observed", evidenceIds: ["evidence.cause.1"] },
            { portId: "p2", roleId: "role.omitted", nodeId: null, valueKind: "observable.string", realization: "omitted", evidenceIds: [] }
          ],
          memberNodeIds: ["node.a"],
          qualifiers: {}, modality: {},
          evidenceIds: ["evidence.cause.1"],
          weightVector: {}, temporalScope: {}, provenanceRefs: [], createdAt: 1, updatedAt: 1
        }]
      } as never
    });
    expect(target.parts).toHaveLength(1);
    expect(target.parts[0]!.relationId).toBe("relation.cause");
    // An omitted port is not something the turn asserts.
    expect(target.parts[0]!.roles).toEqual([{ roleId: "relation.event", valueKind: "observable.string" }]);
  });

  it("admits only operators that can genuinely express a target part", () => {
    const algebra = buildConstructionAlgebra({
      constructions: [causeConstruction, discoverConstruction],
      maxRecursionDepth: 2
    });
    const causePart = { id: "part.1", relationId: "relation.cause", roles: [{ roleId: "relation.event", valueKind: "observable.string" }], evidenceIds: ["evidence.cause.1"] };
    const eligible = operatorsForTargetPart(causePart, algebra.operators);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.every(operator => operator.resultType === "relation.cause")).toBe(true);
    // Nothing producing a different relation may express this part.
    expect(eligible.some(operator => operator.resultType === "relation.event")).toBe(false);
  });

  it("target-conditioned search covers the requested parts and realizes through the join program", () => {
    const algebra = buildConstructionAlgebra({
      constructions: [causeConstruction, discoverConstruction],
      maxRecursionDepth: 2
    });
    const target = {
      parts: [
        { id: "part.cause", relationId: "relation.cause", roles: [{ roleId: "relation.event", valueKind: "observable.string" }], evidenceIds: ["evidence.cause.1"] },
        { id: "part.event", relationId: "relation.event", roles: [], evidenceIds: ["evidence.discover.1"] }
      ],
      audit: {}
    };
    const result = searchTargetConditionedDerivation({ target, algebra });
    // It expressed the requested structure, not merely something cheap.
    expect(result.coveredPartIds.length).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.audit)).toContain("join-program");
  });

  it("enumerates every type-compatible composition rather than the first one found", () => {
    // Two distinct constructions both produce relation.event, so the single
    // open argument of `cause` has two legitimate fillers. A greedy `.find`
    // admits one composite; full enumeration must offer both.
    const secondEvent = construction({
      id: "observe",
      relationId: "relation.event",
      surface: "the engineer observed the crack",
      evidenceIds: ["evidence.observe.1"]
    });
    const algebra = buildConstructionAlgebra({
      constructions: [causeConstruction, discoverConstruction, secondEvent],
      maxRecursionDepth: 1
    });
    const depthOne = algebra.composed.filter(record => record.depth === 1 && record.baseConstructionId === "cause");
    expect(depthOne.length).toBe(2);
    const children = depthOne.map(record => record.ports[0]!.childConstructionId).sort();
    expect(children).toEqual(["discover", "observe"]);
  });
});
