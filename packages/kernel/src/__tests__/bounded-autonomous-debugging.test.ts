import { describe, expect, it } from "vitest";
import {
  createBoundedDebugSession,
  planDebugAttempt,
  recordDebugAttempt
} from "../bounded-autonomous-debugging.js";
import type { ProgramDiagnostic, RepairOperation } from "../program-repair-kernel.js";
import { createHasher } from "../primitives.js";

// Plan items 191-193: bounded autonomous debugging under explicit
// attempt/wall-clock/mutation budgets, real termination on repeated
// equivalent failure, and a real refusal of an identical repeated patch
// attempt against unchanged diagnostic evidence.

function diagnostic(overrides: Partial<ProgramDiagnostic> = {}): ProgramDiagnostic {
  return { id: "diag.1", class: "type", message: "Cannot find name 'x'.", raw: "error TS2304: Cannot find name 'x'.", confidence: 1, path: "fixture.ts", line: 3, ...overrides };
}

function operation(overrides: Partial<RepairOperation> = {}): RepairOperation {
  return { id: "op.1", kind: "replace", path: "fixture.ts", reason: "declare x", risk: 0.1, ...overrides };
}

const budget = { maxAttempts: 4, maxWallClockMs: 60_000, maxMutatedFiles: 3 };

describe("createBoundedDebugSession (plan item 191)", () => {
  it("rejects a non-positive budget in every dimension", () => {
    expect(() => createBoundedDebugSession({ maxAttempts: 0, maxWallClockMs: 1000, maxMutatedFiles: 1 }, 0)).toThrow();
    expect(() => createBoundedDebugSession({ maxAttempts: 1, maxWallClockMs: 0, maxMutatedFiles: 1 }, 0)).toThrow();
    expect(() => createBoundedDebugSession({ maxAttempts: 1, maxWallClockMs: 1000, maxMutatedFiles: 0 }, 0)).toThrow();
  });

  it("starts with zero attempts and zero mutated files", () => {
    const session = createBoundedDebugSession(budget, 0);
    expect(session.attempts).toEqual([]);
    expect(session.totalMutatedFiles).toBe(0);
  });
});

describe("recordDebugAttempt budget enforcement (plan item 191)", () => {
  it("throws when recording would exceed the attempt budget", () => {
    let session = createBoundedDebugSession({ maxAttempts: 1, maxWallClockMs: 60_000, maxMutatedFiles: 3 }, 0);
    session = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: true, testsSucceeded: true, diagnosticsAfter: []
    }).session;
    expect(() => recordDebugAttempt(session, {
      now: 200, diagnosticsBefore: [diagnostic()], operations: [operation({ id: "op.2" })], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic()]
    })).toThrow();
  });

  it("throws when recording would exceed the wall-clock budget", () => {
    const session = createBoundedDebugSession({ maxAttempts: 5, maxWallClockMs: 1000, maxMutatedFiles: 3 }, 0);
    expect(() => recordDebugAttempt(session, {
      now: 5000, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic()]
    })).toThrow();
  });

  it("throws when the union of mutated files across attempts would exceed the mutation budget", () => {
    let session = createBoundedDebugSession({ maxAttempts: 5, maxWallClockMs: 60_000, maxMutatedFiles: 1 }, 0);
    session = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["a.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic({ id: "diag.2" })]
    }).session;
    expect(() => recordDebugAttempt(session, {
      now: 200, diagnosticsBefore: [diagnostic({ id: "diag.2" })], operations: [operation({ id: "op.2", path: "b.ts" })], mutatedPaths: ["b.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic({ id: "diag.3" })]
    })).toThrow();
  });

  it("resolves when build and tests succeed with zero remaining diagnostics", () => {
    const session = createBoundedDebugSession(budget, 0);
    const { decision } = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: true, testsSucceeded: true, diagnosticsAfter: []
    });
    expect(decision.outcome).toBe("resolved");
  });
});

describe("planDebugAttempt (plan item 193: responds to new diagnostic evidence)", () => {
  it("permits a novel first attempt", () => {
    const session = createBoundedDebugSession(budget, 0);
    const plan = planDebugAttempt(session, [diagnostic()], [operation()]);
    expect(plan.permitted).toBe(true);
  });

  it("refuses an identical patch proposed twice against the exact same diagnostic state", () => {
    let session = createBoundedDebugSession(budget, 0);
    session = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic()]
    }).session;
    // Same diagnostics, same operation id -> genuinely nothing new was learned.
    const plan = planDebugAttempt(session, [diagnostic()], [operation()]);
    expect(plan.permitted).toBe(false);
    expect(plan.reason).toMatch(/identical patch already attempted/);
  });

  it("permits a genuinely different patch hypothesis against the same diagnostic state", () => {
    let session = createBoundedDebugSession(budget, 0);
    session = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic()]
    }).session;
    const plan = planDebugAttempt(session, [diagnostic()], [operation({ id: "op.2", reason: "import x instead" })]);
    expect(plan.permitted).toBe(true);
  });

  it("refuses once the attempt budget is exhausted, even for a genuinely novel hypothesis", () => {
    let session = createBoundedDebugSession({ maxAttempts: 1, maxWallClockMs: 60_000, maxMutatedFiles: 3 }, 0);
    session = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic()]
    }).session;
    const plan = planDebugAttempt(session, [diagnostic()], [operation({ id: "op.2" })]);
    expect(plan.permitted).toBe(false);
    expect(plan.reason).toMatch(/budget exhausted/);
  });
});

describe("repeated equivalent failure terminates the loop (plan item 192)", () => {
  it("stops rather than looping indefinitely when the exact same diagnostics recur after real patch attempts", () => {
    let session = createBoundedDebugSession({ maxAttempts: 10, maxWallClockMs: 60_000, maxMutatedFiles: 5 }, 0);
    let decision;
    ({ session, decision } = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic()], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic({ id: "diag.stuck" })]
    }));
    expect(decision.outcome).toBe("continue");
    ({ session, decision } = recordDebugAttempt(session, {
      now: 200, diagnosticsBefore: [diagnostic({ id: "diag.stuck" })], operations: [operation({ id: "op.2" })], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic({ id: "diag.stuck" })]
    }));
    // Same diagnosticsAfter signature two attempts in a row: a real patch was
    // tried and the failure is genuinely unchanged -- must terminate, not
    // continue consuming the remaining 8 attempts of budget.
    expect(decision.outcome).toBe("stopped_repeated_failure");
  });

  it("keeps going when each attempt's diagnostics genuinely differ from the last (real progress or a real new symptom)", () => {
    let session = createBoundedDebugSession({ maxAttempts: 10, maxWallClockMs: 60_000, maxMutatedFiles: 5 }, 0);
    let decision;
    ({ session, decision } = recordDebugAttempt(session, {
      now: 100, diagnosticsBefore: [diagnostic({ id: "diag.a" }), diagnostic({ id: "diag.b" })], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: [diagnostic({ id: "diag.b" })]
    }));
    expect(decision.outcome).toBe("continue");
    ({ session, decision } = recordDebugAttempt(session, {
      now: 200, diagnosticsBefore: [diagnostic({ id: "diag.b" })], operations: [operation({ id: "op.2" })], mutatedPaths: ["fixture.ts"],
      buildSucceeded: true, testsSucceeded: true, diagnosticsAfter: []
    }));
    expect(decision.outcome).toBe("resolved");
  });
});

describe("real determinism: identical inputs produce identical signatures", () => {
  it("the same diagnostics/operations always hash to the same signature regardless of array order", () => {
    const hasher = createHasher();
    let sessionA = createBoundedDebugSession(budget, 0);
    let sessionB = createBoundedDebugSession(budget, 0);
    const a = recordDebugAttempt(sessionA, {
      now: 100, hasher, diagnosticsBefore: [diagnostic({ id: "x" }), diagnostic({ id: "y" })], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: []
    }).session;
    const b = recordDebugAttempt(sessionB, {
      now: 100, hasher, diagnosticsBefore: [diagnostic({ id: "y" }), diagnostic({ id: "x" })], operations: [operation()], mutatedPaths: ["fixture.ts"],
      buildSucceeded: false, testsSucceeded: false, diagnosticsAfter: []
    }).session;
    expect(a.attempts[0]!.diagnosticsBeforeSignature).toBe(b.attempts[0]!.diagnosticsBeforeSignature);
  });
});
