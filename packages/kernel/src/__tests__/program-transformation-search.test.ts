// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { describe, expect, it } from "vitest";
import {
  evaluateProgramExpression,
  searchProgramTransformations,
  type ProgramTransformationCandidate
} from "../program-transformation-search.js";
import type { ProgramBehaviorRequirement } from "../types.js";

describe("program transformation search", () => {
  it("selects a source-neutral input-dependent IR that generalizes double", () => {
    const result = searchProgramTransformations([
      requirement("double.fit.1", "double", 1, 2, "fit"),
      requirement("double.fit.3", "double", 3, 6, "fit"),
      requirement("double.held-out", "double", 11, 22, "held_out")
    ]);
    const selected = result.selected[0]!;

    expect(selected.callableId).toBe("double");
    expect(["add", "multiply"]).toContain(selected.operator);
    expect(selected.operands).toHaveLength(2);
    expect(selected.provenance).toEqual({
      kind: "fit_requirements",
      fitRequirementIds: ["double.fit.1", "double.fit.3"]
    });
    expect(Number.isFinite(selected.score)).toBe(true);
    expect(selected.predictedFitObligationIds).toEqual(["double.fit.1", "double.fit.3"]);
    expect(selected.heldOutObligationIds).toEqual(["double.held-out"]);
    expect(selected.producedIr.kind).toMatch(/binary|unary/);
    expect(selected.preconditions).toEqual(expect.arrayContaining([
      { kind: "argument_count", count: 1 },
      { kind: "finite_numeric_argument", index: 0 }
    ]));
    expect(evaluateProgramExpression(selected.producedIr, 11)).toBe(22);
  });

  it("keeps every candidate unchanged when only a held-out expected value changes", () => {
    const fit = [
      requirement("double.fit.1", "double", 1, 2, "fit"),
      requirement("double.fit.3", "double", 3, 6, "fit")
    ];
    const honest = searchProgramTransformations([
      ...fit,
      requirement("double.held-out", "double", 11, 22, "held_out")
    ]);
    const changed = searchProgramTransformations([
      ...fit,
      requirement("double.held-out", "double", 11, 901, "held_out")
    ]);

    expect(changed).toEqual(honest);
  });

  it("finds a generic affine relation x*2+1 from fit examples", () => {
    const result = searchProgramTransformations([
      requirement("shift.fit.2", "shift", 2, 5, "fit"),
      requirement("shift.fit.3", "shift", 3, 7, "fit"),
      requirement("shift.held-out", "shift", 9, 19, "held_out")
    ]);
    const selected = result.selected[0]!;

    expect(selected.predictedFitObligationIds).toEqual(["shift.fit.2", "shift.fit.3"]);
    expect(evaluateProgramExpression(selected.producedIr, 9)).toBe(19);
    expect(hasMultiplyAndAdd(selected)).toBe(true);
  });

  it("constructs a new mapping from source-derived nested projections", () => {
    const fit = [
      structuralRequirement("card.fit.1", { identity: { label: "A" }, channels: { primary: "1" } }, { name: "A", contact: "1" }, "fit"),
      structuralRequirement("card.fit.2", { identity: { label: "B" }, channels: { primary: "2" } }, { name: "B", contact: "2" }, "fit"),
      structuralRequirement("card.fit.3", { identity: { label: "C" }, channels: { primary: "3" } }, { name: "C", contact: "3" }, "fit")
    ];
    const honest = searchProgramTransformations([
      ...fit,
      structuralRequirement("card.held-out", { identity: { label: "D" }, channels: { primary: "4" } }, { name: "D", contact: "4" }, "held_out")
    ]);
    const selected = honest.selected[0]!;

    expect(selected.operator).toBe("mapping");
    expect(selected.predictedFitObligationIds).toEqual(["card.fit.1", "card.fit.2", "card.fit.3"]);
    expect(evaluateProgramExpression(selected.producedIr, [{ identity: { label: "D" }, channels: { primary: "4" } }])).toEqual({
      contact: "4",
      name: "D"
    });

    const poisonedHeldOut = searchProgramTransformations([
      ...fit,
      structuralRequirement("card.held-out", { identity: { label: "D" }, channels: { primary: "4" } }, { name: "wrong", contact: "wrong" }, "held_out")
    ]);
    expect(poisonedHeldOut).toEqual(honest);
  });
});

function hasMultiplyAndAdd(candidate: ProgramTransformationCandidate): boolean {
  const operators: string[] = [];
  const visit = (expression: ProgramTransformationCandidate["producedIr"]): void => {
    if (expression.kind === "unary") visit(expression.operand);
    if (expression.kind !== "binary") return;
    operators.push(expression.operator);
    visit(expression.left);
    visit(expression.right);
  };
  visit(candidate.producedIr);
  return operators.includes("multiply") && operators.includes("add");
}

function requirement(
  id: string,
  callableId: string,
  input: number,
  expectedResult: number,
  verificationRole: "fit" | "held_out"
): ProgramBehaviorRequirement {
  return {
    id,
    requestHash: "request.transformation",
    callableId,
    arguments: [input],
    expectedResult,
    verificationRole,
    relationSurface: "=",
    sourceSpan: { charStart: 0, charEnd: 1 }
  };
}

function structuralRequirement(
  id: string,
  input: ProgramBehaviorRequirement["arguments"][number],
  expectedResult: ProgramBehaviorRequirement["expectedResult"],
  verificationRole: "fit" | "held_out"
): ProgramBehaviorRequirement {
  return {
    id,
    requestHash: "request.structural-transformation",
    callableId: "card",
    arguments: [input],
    expectedResult,
    verificationRole,
    relationSurface: "=",
    sourceSpan: { charStart: 0, charEnd: 1 }
  };
}
