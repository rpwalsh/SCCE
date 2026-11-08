// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { parseTscDiagnostics, runCodeMouth, type CodeMouthPorts, type CodeMouthVerification } from "../code-mouth.js";

function ports(script: Array<{ diagnostics: string[] }>): { ports: CodeMouthPorts; applied: string[]; rolledBack: number } {
  const state = { applied: [] as string[], rolledBack: 0, verifyCalls: 0 };
  const ports: CodeMouthPorts = {
    retrieve: async targetPath => ({ targetPath, targetText: "export const a = 1;", symbols: ["a"], imports: [], language: "typescript" }),
    propose: async ({ attempt }) => ({ operations: [{ id: `op:${attempt}`, risk: 0.3, kind: "insert", path: "x.ts", content: `// attempt ${attempt}`, reason: "test" }], surface: `attempt ${attempt}` }),
    apply: async operations => { state.applied.push(...operations.map(operation => operation.id)); return async () => { state.rolledBack++; }; },
    verify: async () => {
      const step = script[Math.min(state.verifyCalls++, script.length - 1)]!;
      return { buildSucceeded: step.diagnostics.length === 0, testsSucceeded: true, diagnostics: step.diagnostics.map((message, index) => ({ id: `d${index}:${message}`, raw: message, confidence: 1, class: "type" as const, message })) };
    }
  };
  return { ports, applied: state.applied, get rolledBack() { return state.rolledBack; } };
}

describe("code mouth loop", () => {
  it.each([
    { testsRun: false, testsSucceeded: true, scope: "compiler_only", status: "passed", recordedTests: null },
    { testsRun: true, testsSucceeded: true, scope: "executed_tests", status: "passed", recordedTests: true },
    { testsRun: undefined, testsSucceeded: true, scope: "unknown", status: "unknown", recordedTests: null },
    { testsRun: true, testsSucceeded: false, scope: "executed_tests", status: "failed", recordedTests: false }
  ])("records verification scope without inferring test execution: $scope / $status", async row => {
    const fixture = ports([{ diagnostics: ["TS1 initial"] }]);
    const propose = fixture.ports.propose;
    fixture.ports.propose = input => input.attempt === 1 ? propose(input) : Promise.resolve(undefined);
    let calls = 0;
    fixture.ports.verify = async () => ++calls === 1
      ? { buildSucceeded: false, testsSucceeded: true, testsRun: false,
        diagnostics: [{ id: "initial", raw: "TS1 initial", class: "type", confidence: 1, message: "TS1 initial" }] }
      : { buildSucceeded: true, testsSucceeded: row.testsSucceeded, testsRun: row.testsRun,
        diagnostics: row.testsSucceeded ? [] : [{ id: "tests.failed", raw: "configured test failed", class: "runtime", path: "x.ts", confidence: 1, message: "configured test failed" }] };
    const result = await runCodeMouth({ request: "explicit test proposal", targetPath: "x.ts", ports: fixture.ports, maxAttempts: 1 });
    expect(result.verification).toMatchObject({ scope: row.scope, status: row.status, testsRun: row.testsRun ?? null,
      buildSucceeded: true, testsSucceeded: row.recordedTests });
    if (row.testsRun !== true) expect(result.decision?.reason).not.toContain("tests succeeded");
    if (!row.testsSucceeded) {
      expect(result.outcome).not.toBe("resolved");
      expect(fixture.applied).toEqual(["op:1"]);
      expect(fixture.rolledBack).toBe(1);
      expect(result.appliedOperations).toEqual([]);
    }
  });

  it("does not reuse passed verification when the next verification cannot finish", async () => {
    const fixture = ports([{ diagnostics: [] }]);
    let calls = 0;
    fixture.ports.verify = async (): Promise<CodeMouthVerification> => {
      if (++calls > 1) throw new Error("verifier timed out");
      return { buildSucceeded: true, testsRun: true, testsSucceeded: true, diagnostics: [] };
    };
    const result = await runCodeMouth({ request: "explicit test proposal", targetPath: "x.ts", ports: fixture.ports, maxAttempts: 1 });
    expect(result.outcome).toBe("stopped");
    expect(result.verification).toEqual({ schema: "scce.code_mouth_verification.v1", scope: "unknown", status: "unknown",
      buildSucceeded: null, testsRun: null, testsSucceeded: null });
    expect(fixture.rolledBack).toBe(1);
    expect(result.appliedOperations).toEqual([]);
  });

  it("keeps only a patch that passes the gate and rolls back the ones that do not", async () => {
    const fixture = ports([{ diagnostics: ["TS2304 baseline"] }, { diagnostics: ["TS2304 still"] }, { diagnostics: [] }]);
    const result = await runCodeMouth({ request: "add reverse", targetPath: "x.ts", ports: fixture.ports, maxAttempts: 3 });
    expect(result.outcome).toBe("resolved");
    expect(result.attempts).toBe(2);
    expect(fixture.applied).toEqual(["op:1", "op:2"]);
    expect(fixture.rolledBack).toBe(1);
    expect(result.appliedOperations.map(operation => operation.id)).toEqual(["op:2"]);
  });

  it("refuses when no proposer exists instead of inventing code", async () => {
    const fixture = ports([{ diagnostics: [] }]);
    fixture.ports.propose = async () => undefined;
    const result = await runCodeMouth({ request: "add reverse", targetPath: "x.ts", ports: fixture.ports });
    expect(result.outcome).toBe("no_proposal");
    expect(fixture.applied).toEqual([]);
  });

  it("stops inside the attempt budget when every attempt fails the gate", async () => {
    const fixture = ports([{ diagnostics: ["TS1 a"] }, { diagnostics: ["TS1 b"] }, { diagnostics: ["TS1 c"] }, { diagnostics: ["TS1 d"] }]);
    const result = await runCodeMouth({ request: "x", targetPath: "x.ts", ports: fixture.ports, maxAttempts: 2 });
    expect(["stopped", "budget_exhausted"]).toContain(result.outcome);
    expect(fixture.rolledBack).toBe(result.attempts);
    expect(result.appliedOperations).toEqual([]);
  });

  it("parses tsc diagnostics into program diagnostics", () => {
    const parsed = parseTscDiagnostics("src/a.ts(3,7): error TS2304: Cannot find name 'foo'.\nsrc/b.ts(1,1): error TS1005: ';' expected.", "/root");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ class: "type", patternId: "TS2304", line: 3, column: 7 });
    expect(parsed[1]).toMatchObject({ class: "syntax", patternId: "TS1005" });
  });

  it("replans against the accepted source after a repair makes partial progress", async () => {
    const initial = "export const a = missingA;\nexport const b = missingB;\n";
    let source = initial;
    const observedSources: string[] = [];
    const repairPorts: CodeMouthPorts = {
      retrieve: async targetPath => ({ targetPath, targetText: source, symbols: [], imports: [], language: "typescript" }),
      propose: async ({ context, attempt }) => {
        observedSources.push(context.targetText);
        const surface = context.targetText.replace(attempt === 1 ? "missingA" : "missingB", String(attempt));
        return {
          surface,
          operations: [{ id: `repair:${attempt}`, risk: 0.1, kind: "replace", path: "x.ts", startLine: 1, endLine: 2, content: surface, reason: "resolve current diagnostic" }]
        };
      },
      apply: async operations => {
        const before = source;
        source = operations[0]!.content!;
        return async () => { source = before; };
      },
      verify: async () => {
        const diagnostics = ["missingA", "missingB"].filter(name => source.includes(name)).map(name => ({
          id: name, raw: name, message: name, path: "x.ts", class: "type" as const, confidence: 1
        }));
        return { buildSucceeded: diagnostics.length === 0, testsSucceeded: true, diagnostics };
      }
    };

    const result = await runCodeMouth({ request: "resolve the build errors", targetPath: "x.ts", ports: repairPorts, maxAttempts: 2 });

    expect(result.outcome).toBe("resolved");
    expect(result.appliedOperations).toHaveLength(2);
    expect(observedSources).toEqual([initial, initial.replace("missingA", "1")]);
    expect(source).toBe("export const a = 1;\nexport const b = 2;\n");
  });
});
