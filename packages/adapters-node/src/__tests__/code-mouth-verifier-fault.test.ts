// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ProgramDiagnostic } from "@scce/kernel";
import { createTypeScriptCodeMouthPorts, runCodeMouth, type CodeMouthPorts, type CodeMouthVerification } from "../code-mouth.js";
import { createWorkspaceCodeMouthPorts } from "../workspace-code-mouth-ports.js";

const roots: string[] = [], observations: unknown[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const diagnostic = (id: string, file = "target.ts"): ProgramDiagnostic => ({ id, class: "type", path: file, message: id, raw: id, confidence: 1 });
afterEach(async () => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("scce-verifier-fault-")) throw Error("invalid fixture cleanup path");
  await rm(root, { recursive: true, force: true });
} });
afterAll(async () => {
  if (process.env.SCCE_VERIFIER_FAULT_RECEIPT) await writeFile(process.env.SCCE_VERIFIER_FAULT_RECEIPT, JSON.stringify({
    schema: "scce.code_mouth_verifier_fault_controls.v1", baselineRevision: "554c6d4",
    authorship: "manually supplied verifier faults and candidate edits; not SCCE generation quality", observations
  }, null, 2));
});

async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(path.join(path.resolve(tmpdir()), "scce-verifier-fault-")); roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

describe("explicit verifier fault controls", () => {
  it.each([
    { name: "unreported build failure", buildSucceeded: false, testsRun: false, testsSucceeded: true },
    { name: "unreported executed-test failure", buildSucceeded: true, testsRun: true, testsSucceeded: false }
  ])("rolls back $name even when all diagnostics disappear", async fault => {
    const original = "export const value = missing;\r\n", candidate = "export const value = 1;\r\n";
    let source = original, verifications = 0, rollbacks = 0;
    const ports: CodeMouthPorts = {
      retrieve: async targetPath => ({ targetPath, targetText: source, symbols: [], imports: [], language: "typescript" }),
      propose: async ({ attempt }) => attempt === 1 ? { surface: candidate, operations: [{
        id: "manual-fault-control", kind: "replace", path: "target.ts", startLine: 1, endLine: 2, content: candidate,
        risk: 0, reason: "manually crafted verifier control"
      }] } : undefined,
      apply: async () => { const before = source; source = candidate; return async () => { source = before; rollbacks++; }; },
      verify: async () => ++verifications === 1
        ? { buildSucceeded: false, testsRun: false, testsSucceeded: true, diagnostics: [diagnostic("initial")] }
        : { ...fault, diagnostics: [] }
    };
    const result = await runCodeMouth({ ports, request: "manual verifier fault control", targetPath: "target.ts", maxAttempts: 1 });
    observations.push({ control: fault.name, fault: { ...fault, diagnostics: [] }, result, rollbacks,
      originalSha256: hash(original), candidateSha256: hash(candidate), afterSha256: hash(source) });
    expect(result.outcome).not.toBe("resolved");
    expect(result.verification.status).toBe("failed");
    expect(result.appliedOperations).toEqual([]);
    expect(source).toBe(original);
    expect(rollbacks).toBe(1);
  });

  it("rolls back a manual candidate through the normal Clang factory when compiler lookup fails", async () => {
    const original = "int value(void) { return 1; }\r\n", candidate = "int value(void) { return 2; }\r\n";
    const root = await workspace({ "target.c": original });
    const native = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "target.c" });
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      const failed = await native.verify("target.c");
      expect(failed).toMatchObject({ buildSucceeded: false, testsRun: false, testsSucceeded: true, diagnostics: [] });
      const result = await runCodeMouth({ request: "manual verifier fault control", targetPath: "target.c", maxAttempts: 1,
        ports: { ...native, propose: async ({ attempt }) => attempt === 1 ? { surface: candidate, operations: [{
          id: "manual-unavailable-compiler-control", kind: "replace", path: "target.c", startLine: 1, endLine: 1,
          content: candidate.trimEnd(), risk: 0, reason: "manually crafted verifier control"
        }] } : undefined } });
      const after = await readFile(path.join(root, "target.c"), "utf8");
      observations.push({ control: "normal C factory with compiler PATH unavailable", failed, result,
        originalSha256: hash(original), candidateSha256: hash(candidate), afterSha256: hash(after) });
      expect(result.outcome).not.toBe("resolved");
      expect(result.verification.status).toBe("failed");
      expect(result.appliedOperations).toEqual([]);
      expect(after).toBe(original);
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });

  it("reports a real TypeScript driver failure as a diagnostic before it reaches the loop", async () => {
    const root = await workspace({ "target.ts": "export const value = 1;\n" });
    const result = await createTypeScriptCodeMouthPorts({ workspaceRoot: root }).verify("target.ts");
    expect(result).toMatchObject({ buildSucceeded: false, testsRun: false, testsSucceeded: true,
      diagnostics: [{ id: "tsc:unavailable", raw: expect.stringContaining("TS5058") }] });
  });

  it("retains a target-only real compiler repair with explicitly reported unrelated build errors", async () => {
    const original = "export const count = 1;\nexport const value = coutn;\n";
    const unrelated = "export const other: number = 'preserved unrelated defect';\n";
    const root = await workspace({ "src/target.ts": original, "src/other.ts": unrelated,
      "package.json": JSON.stringify({ private: true, scripts: { typecheck: "tsc -p tsconfig.json" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", types: [] }, include: ["src/**/*.ts"] }) });
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "src/target.ts" });
    const result = await runCodeMouth({ ports, request: "TS2552 fixName:spelling", targetPath: "src/target.ts", maxAttempts: 1 });
    expect(result.outcome, JSON.stringify(result)).toBe("resolved");
    expect(result.proposalSources).toEqual(["compiler_owned"]);
    expect(result.finalDiagnostics).toEqual([expect.objectContaining({ patternId: "TS2322", path: path.join(root, "src/other.ts") })]);
    expect(result.verification).toMatchObject({ status: "failed", buildSucceeded: false, testsRun: false });
    expect(await readFile(path.join(root, "src/target.ts"), "utf8")).toBe(original.replace("coutn", "count"));
    expect(await readFile(path.join(root, "src/other.ts"), "utf8")).toBe(unrelated);
  });

  it("keeps reported multi-step compiler progress while configured tests cannot run until it builds", async () => {
    const states = ["export const a = missingA;\nexport const b = missingB;\n", "export const a = 1;\nexport const b = missingB;\n", "export const a = 1;\nexport const b = 2;\n"];
    let source = states[0]!, state = 0, rollbacks = 0;
    const observed: string[] = [];
    const ports: CodeMouthPorts = {
      retrieve: async targetPath => ({ targetPath, targetText: source, symbols: [], imports: [], language: "typescript" }),
      propose: async ({ context, attempt }) => {
        observed.push(context.targetText);
        const candidate = states[attempt]!;
        return { surface: candidate, operations: [{ id: `manual-progress:${attempt}`, kind: "replace", path: "target.ts",
          startLine: 1, endLine: 3, content: candidate, reason: "manually crafted progress control", risk: 0 }] };
      },
      apply: async operations => { const before = source, beforeState = state; source = operations[0]!.content!; state++;
        return async () => { source = before; state = beforeState; rollbacks++; }; },
      verify: async (): Promise<CodeMouthVerification> => ({ buildSucceeded: state === 2, testsRun: state === 2, testsSucceeded: state === 2,
        diagnostics: state === 0 ? [diagnostic("missingA"), diagnostic("missingB")] : state === 1 ? [diagnostic("missingB")] : [] })
    };
    const result = await runCodeMouth({ ports, request: "manual verifier progress control", targetPath: "target.ts", maxAttempts: 2 });
    expect(result.outcome).toBe("resolved");
    expect(result.appliedOperations).toHaveLength(2);
    expect(observed).toEqual(states.slice(0, 2));
    expect(source).toBe(states[2]);
    expect(rollbacks).toBe(0);
    expect(result.verification).toMatchObject({ scope: "executed_tests", status: "passed", testsRun: true, testsSucceeded: true });
  });
});
