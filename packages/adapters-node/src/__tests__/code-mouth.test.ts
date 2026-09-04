// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { parseTscDiagnostics, runCodeMouth, type CodeMouthPorts } from "../code-mouth.js";

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
});
