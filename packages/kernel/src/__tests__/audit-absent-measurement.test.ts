// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// An audit record must not invent a measurement it never took. `?? 0` on a field that can be legitimately absent
// turns "we did not check" into "we checked and found nothing", and every reader of the record believes it.
import { describe, expect, it } from "vitest";
import { createAuditEngine } from "../audit.js";
import type { ConstructGraph, ValidationGraph } from "../types.js";

describe("audit records distinguish an absent measurement from a zero one", () => {
  const audit = createAuditEngine();
  const construct = (program?: ConstructGraph["program"]): ConstructGraph => ({
    id: "construct-1" as ConstructGraph["id"],
    episodeId: "episode-1" as ConstructGraph["episodeId"],
    forceVector: {},
    nodes: [{ id: "request", kind: "request", label: "ask", metadata: {} }],
    edges: [],
    artifacts: [],
    ...(program ? { program } : {})
  });
  const emptyProgram: NonNullable<ConstructGraph["program"]> = {
    id: "program-1",
    language: "typescript",
    packageManager: "pnpm",
    entrypoint: "index.ts",
    nodes: [],
    edges: [],
    files: [],
    build: { command: "noop", args: [], cwd: "." },
    test: { command: "noop", args: [], cwd: "." }
  };

  it("reports no program as unknown and an empty program as zero files", () => {
    const withoutProgram = audit.summarizeConstruct({ construct: construct() });
    expect(withoutProgram?.programFiles).toBeNull();

    const withEmptyProgram = audit.summarizeConstruct({ construct: construct(emptyProgram) });
    expect(withEmptyProgram?.programFiles).toBe(0);
  });

  it("reports validation that never ran as unknown, not as zero warnings", () => {
    const unvalidated = audit.summarizeConstruct({ construct: construct() });
    // The record already says `validationPassed: undefined` here. Claiming 0 warnings beside it asserts a clean
    // validation of a construct nothing validated.
    expect(unvalidated?.validationPassed).toBeUndefined();
    expect(unvalidated?.validationWarnings).toBeNull();
  });

  it("reports a validation that ran and warned about nothing as zero", () => {
    const validation: ValidationGraph = {
      id: "validation-1" as ValidationGraph["id"],
      constructId: "construct-1" as ConstructGraph["id"],
      checks: [{ id: "check-1", status: "passed", score: 1, message: "", evidenceIds: [] }],
      passed: true
    };
    const summary = audit.summarizeConstruct({ construct: construct(), validation });
    expect(summary?.validationPassed).toBe(true);
    expect(summary?.validationWarnings).toBe(0);
  });

  it("counts the warnings a validation actually raised", () => {
    const validation: ValidationGraph = {
      id: "validation-2" as ValidationGraph["id"],
      constructId: "construct-1" as ConstructGraph["id"],
      checks: [
        { id: "a", status: "warning", score: 0.5, message: "", evidenceIds: [] },
        { id: "b", status: "passed", score: 1, message: "", evidenceIds: [] },
        { id: "c", status: "warning", score: 0.4, message: "", evidenceIds: [] }
      ],
      passed: false
    };
    expect(audit.summarizeConstruct({ construct: construct(), validation })?.validationWarnings).toBe(2);
  });

  it("keeps the unknowns serializable in the episode report", () => {
    const bundle = audit.bundle({ episodeId: "episode-1" as ConstructGraph["episodeId"], events: [], evidence: [], construct: construct() });
    const report = JSON.parse(JSON.stringify(bundle.report)) as { construct?: Record<string, unknown> };
    expect(report.construct?.programFiles).toBeNull();
    expect(report.construct?.validationWarnings).toBeNull();
    // Absence must not move the risk score: residual risk reads validationPassed, never the warning count.
    expect(bundle.residualRisk).toBe(audit.bundle({
      episodeId: "episode-1" as ConstructGraph["episodeId"],
      events: [],
      evidence: [],
      construct: construct(emptyProgram)
    }).residualRisk);
  });
});
