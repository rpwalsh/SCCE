// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { induceProgramBehaviorRoleConstructions, type ProgramBehaviorRoleObservation } from "../program-behavior-role-induction.js";

describe("program behavior role induction", () => {
  it("compresses recurring topology across unrelated tests and targets without assigning framework meaning", () => {
    const observations = [
      observation("observation.a", "test/a.ts", "symbol.a", "span.a"),
      observation("observation.b", "test/b.ts", "symbol.b", "span.b"),
      observation("observation.c", "test/c.ts", "symbol.c", "span.c")
    ];

    const constructions = induceProgramBehaviorRoleConstructions({ observations });

    expect(constructions).toHaveLength(1);
    expect(constructions[0]).toMatchObject({
      kindId: "scce.program.behavior_role_construction.v1",
      semanticStatus: "structural_unassigned",
      memberObservationIds: ["observation.a", "observation.b", "observation.c"],
      support: { observations: 3, distinctTestFiles: 3, distinctTargets: 3 }
    });
    expect(constructions[0]!.descriptionLength.savingsSymbols).toBeGreaterThan(0);
    expect(JSON.stringify(constructions[0])).not.toMatch(/expect|assert|equal|output/iu);
  });

  it("refuses a one-target repetition and separates different call topologies", () => {
    const sameTarget = [
      observation("observation.a", "test/a.ts", "symbol.a", "span.a"),
      observation("observation.b", "test/b.ts", "symbol.a", "span.b"),
      { ...observation("observation.c", "test/c.ts", "symbol.a", "span.c"), contextDepth: 3 }
    ];

    expect(induceProgramBehaviorRoleConstructions({ observations: sameTarget })).toEqual([]);
  });
});

function observation(id: string, testFileId: string, targetId: string, evidenceSpanId: string): ProgramBehaviorRoleObservation {
  return {
    id,
    testFileId,
    targetId,
    subjectArgumentCount: 1,
    contextDepth: 2,
    contextArgumentCount: 1,
    evidenceSpanIds: [evidenceSpanId]
  };
}
