// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProgramDiagnostic, RepairOperation } from "@scce/kernel";
import { runCodeMouth } from "../code-mouth.js";
import { createWorkspaceCodeMouthPorts } from "../workspace-code-mouth-ports.js";
import { treeSitterRepairSpans } from "../tree-sitter-repair-spans.js";
import { checkerDiagnostics } from "../tree-sitter-code-mouth-ports.js";
import { trustedHostPatchValidationProvider } from "../structured-patch-validation.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
  expect(path.basename(root)).toMatch(/^scce-code-ports-/u);
  await rm(root, { recursive: true, force: true });
} });

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-code-ports-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return root;
}

describe("shared workspace code ports", () => {
  it("keeps the file's language at the CLI and HTTP boundary and refuses a missing language capability", async () => {
    const root = await fixture({ "main.go": "package main\nfunc main() {}\n", "unknown.klingon": "opaque source" });
    const go = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "main.go" });
    expect((await go.retrieve("main.go")).language).toBe("go");
    const unknown = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "unknown.klingon" });
    expect((await unknown.retrieve("unknown.klingon")).language).toBe("unknown");
    expect(await unknown.verify("unknown.klingon")).toMatchObject({ buildSucceeded: false, testsRun: false, diagnostics: [expect.objectContaining({ message: expect.stringContaining("no grammar") })] });
  });

  it("applies every same-revision range in a multi-file repair and restores exact original bytes", async () => {
    const original = "first = 1\r\nsecond = 2\r\nthird = 3\r\n";
    const root = await fixture({ "source.py": original, "other.py": "answer = 0\npreserved = 1\r\n" });
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "source.py" });
    const replace = (name: string, line: number, content: string): RepairOperation => ({ id: `${name}:${line}`, kind: "replace", path: name, startLine: line, endLine: line, content, reason: "source-owned replacement", risk: 0 });
    const rollback = await ports.apply([replace("source.py", 1, "first = 10"), replace("source.py", 3, "third = 30"), replace("other.py", 1, "answer = 42")]);
    expect(await readFile(path.join(root, "source.py"), "utf8")).toBe("first = 10\r\nsecond = 2\r\nthird = 30\r\n");
    expect(await readFile(path.join(root, "other.py"), "utf8")).toBe("answer = 42\npreserved = 1\r\n");
    await rollback();
    expect(await readFile(path.join(root, "source.py"), "utf8")).toBe(original);
    expect(await readFile(path.join(root, "other.py"), "utf8")).toBe("answer = 0\npreserved = 1\r\n");
    await expect(ports.apply([replace("../escape.py", 1, "unowned")])).rejects.toThrow(/escapes/u);
    expect((await readdir(root)).sort()).toEqual(["other.py", "source.py"]);
  });

  it("rolls back a compiling hypothesis when the real project tests reject its behavior", async () => {
    const root = await fixture({ "application.cjs": "exports.value = 1;\n", "contract.cjs": "if(require('./application.cjs').value!==2)throw Error('behavior contract');\n" });
    let offers = 0;
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "application.cjs", learnedProposer: {
      availableModelCount: async () => 1, lastCandidates: () => [],
      propose: async () => offers++ ? undefined : { surface: "exports.value = 3;", source: "learned_construction", operations: [{ id: "wrong-behavior", kind: "replace", path: "application.cjs", startLine: 1, endLine: 1, content: "exports.value = 3;", reason: "candidate under test", risk: 0 }] }
    }, projectValidation: { policy: { schemaVersion: "scce.patch-validation-policy.v1", id: "application-behavior.v1", timeoutMs: 10_000,
      maxOutputBytes: 10_000, maxWorkspaceBytes: 10_000, maxWorkspaceFiles: 8, commands: [
        { executable: process.execPath, argv: ["--check", "application.cjs"], checkIds: ["compiler"] },
        { executable: process.execPath, argv: ["contract.cjs"], checkIds: ["tests"] }
      ] } } });
    const before = await ports.verify("application.cjs");
    expect(before).toMatchObject({ buildSucceeded: true, testsRun: true, testsSucceeded: false });
    const result = await runCodeMouth({ request: "repair", targetPath: "application.cjs", ports });
    expect(result.outcome).not.toBe("resolved");
    expect(result.appliedOperations).toEqual([]);
    expect(await readFile(path.join(root, "application.cjs"), "utf8")).toBe("exports.value = 1;\n");
    expect(ports.projectVerification()).toBeUndefined();
  });

  it("rolls back when the configured project verifier becomes unavailable after application", async () => {
    const root = await fixture({ "application.cjs": "exports.value = 1;\n" });
    let verifications = 0;
    let offers = 0;
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "application.cjs", learnedProposer: {
      availableModelCount: async () => 1, lastCandidates: () => [],
      propose: async () => offers++ ? undefined : { surface: "exports.value = 2;", operations: [{ id: "unproven", kind: "replace", path: "application.cjs", startLine: 1, endLine: 1, content: "exports.value = 2;", reason: "candidate under test", risk: 0 }] }
    }, projectValidation: {
      provider: { ...trustedHostPatchValidationProvider, execute: async input => {
        if (verifications++) throw new Error("configured runner is unavailable");
        return trustedHostPatchValidationProvider.execute(input);
      } },
      policy: { schemaVersion: "scce.patch-validation-policy.v1", id: "unavailable-runner.v1", timeoutMs: 10_000,
        maxOutputBytes: 10_000, maxWorkspaceBytes: 10_000, maxWorkspaceFiles: 8,
        commands: [{ executable: process.execPath, argv: ["--check", "application.cjs"], checkIds: ["compiler"] }] }
    } });
    const result = await runCodeMouth({ request: "repair", targetPath: "application.cjs", ports });
    expect(result.outcome).not.toBe("resolved");
    expect(result.appliedOperations).toEqual([]);
    expect(await readFile(path.join(root, "application.cjs"), "utf8")).toBe("exports.value = 1;\n");
    expect(ports.projectVerification()).toBeUndefined();
  });
});

describe("compiler-located shared grammar holes", () => {
  it.each([
    { file: "ledger.go", text: "// π🙂\npackage ledger\nfunc total() int { return balnces }\n" },
    { file: "Ledger.java", text: "// π🙂\nclass Ledger { int total() { return balnces; } }\n" },
    { file: "ledger.rs", text: "// π🙂\nfn total() -> i32 { balnces }\n" }
  ])("bounds only the defective syntax leaf in $file", async ({ file, text }) => {
    const start = text.indexOf("balnces");
    const before = text.slice(0, start).split("\n");
    const diagnostic: ProgramDiagnostic = { id: "observed", class: "type", path: file, line: before.length, column: before.at(-1)!.length + 1, message: "compiler observation", raw: "", confidence: 1 };
    const spans = await treeSitterRepairSpans({ targetPath: file, text, diagnostics: [diagnostic] });
    expect(spans).toEqual([{ start, length: "balnces".length, diagnosticId: "observed" }]);
    expect(await treeSitterRepairSpans({ targetPath: file, text, diagnostics: [{ ...diagnostic, column: undefined }] })).toEqual([]);
  });

  it("reads Java caret columns and Rust location lines without rebinding another source file to the target", () => {
    const root = path.resolve(tmpdir(), "scce-location-fixture");
    const java = checkerDiagnostics({ code: 1, stdout: "", stderr: "Ledger.java:10: error: cannot find symbol\n   balnces.merge();\n   ^\n" }, "Main.java", "java", root);
    expect(java).toMatchObject([{ path: path.join(root, "Ledger.java"), line: 10, column: 4 }]);
    const rust = checkerDiagnostics({ code: 1, stdout: "", stderr: "error[E0425]: cannot find value\n --> src/ledger.rs:7:4\n  |\n" }, "src/main.rs", "rust", root);
    expect(rust).toMatchObject([{ path: path.join(root, "src/ledger.rs"), line: 7, column: 4, message: "error[E0425]: cannot find value" }]);
  });
});
