// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgramDiagnostic, RepairOperation } from "@scce/kernel";
import { codeSurfaceTokens, generateLearnedBehaviorCodeRepairs, learnedCodeRepairOperations, trainKneserNey } from "@scce/kernel";
import { runCodeMouth } from "../code-mouth.js";
import { createWorkspaceCodeMouthPorts } from "../workspace-code-mouth-ports.js";
import { treeSitterRepairSpans, treeSitterSyntaxInsertionSites } from "../tree-sitter-repair-spans.js";
import { checkerDiagnostics } from "../tree-sitter-code-mouth-ports.js";
import { trustedHostPatchValidationProvider } from "../structured-patch-validation.js";
import { findCodeVerifierCapability } from "../code-verifier-discovery.js";

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
    const root = await fixture({ "main.go": "package main\nfunc main() {}\n", "unknown.klingon": "opaque source", "unknown.cob": "opaque source", "unknown.lisp": "opaque source" });
    const go = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "main.go" });
    expect((await go.retrieve("main.go")).language).toBe("go");
    for (const target of ["unknown.klingon", "unknown.cob", "unknown.lisp"]) {
      const unknown = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: target });
      expect((await unknown.retrieve(target)).language).toBe("unknown");
      expect(await unknown.verify(target)).toMatchObject({ buildSucceeded: false, testsRun: false, diagnostics: [expect.objectContaining({ message: expect.stringContaining("no grammar") })] });
    }
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

  it("applies joined corpus hypotheses without rewriting untouched mixed line endings", async () => {
    const source = "initial = 0\r\n# unchanged\nvalues = {}\r\nvalues[key] += amount\n";
    const targetText = source.replace("initial = 0", "initial = 1").replace("+=", "-=");
    const root = await fixture({ "source.py": targetText });
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "source.py" });
    const candidates = generateLearnedBehaviorCodeRepairs({ models: [trainKneserNey(codeSurfaceTokens(source), { order: 5, discount: 0.75 })],
      languageId: "python", targetPath: "source.py", targetText, failureObservationId: "actual.fixture.failed-contract",
      sites: [{ start: targetText.indexOf("1\r"), length: 1, grammarNodeType: "integer" }, { start: targetText.indexOf("-="), length: 2, grammarNodeType: "-=" }] });
    const rollback = await ports.apply(learnedCodeRepairOperations(candidates[0]!, "source.py"));
    expect(await readFile(path.join(root, "source.py"), "utf8")).toBe(source);
    await rollback();
    expect(await readFile(path.join(root, "source.py"), "utf8")).toBe(targetText);
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

  it.for(["unavailable", "deadline"] as const)("restores actual source when the bare native verification boundary is %s", async (failure, context) => {
    if ((await findCodeVerifierCapability("go")).status !== "available") context.skip();
    const source = "package application\nvar Value = 1\n";
    const root = await fixture({ "application.go": source });
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "application.go", learnedProposer: {
      availableModelCount: async () => 1, lastCandidates: () => [],
      propose: async () => ({ surface: "var Value = 2", operations: [{ id: "pending-native-proof", kind: "replace", path: "application.go",
        startLine: 2, endLine: 2, content: "var Value = 2", reason: "candidate awaiting native proof", risk: 0 }] })
    } });
    const nativeVerify = ports.verify;
    let verifications = 0;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      ports.verify = async target => {
        if (verifications++) {
          if (failure === "unavailable") throw Error("native verifier unavailable after application");
          now.mockReturnValue(4_000);
        }
        const verified = await nativeVerify(target);
        expect(verified.buildSucceeded).toBe(true);
        return verified;
      };
      const result = await runCodeMouth({ request: "repair", targetPath: "application.go", ports, maxWallClockMs: 1_000 });
      expect(result).toMatchObject({ outcome: "stopped", appliedOperations: [] });
      expect(result.reason).toContain("rolled back");
      expect(result.reason).toContain(failure === "deadline" ? "wall-clock" : "native verifier unavailable");
      expect(await readFile(path.join(root, "application.go"), "utf8")).toBe(source);
    } finally { now.mockRestore(); }
  });

  it("surfaces both failures when an interrupted verifier cannot roll back over a concurrent source edit", async () => {
    const root = await fixture({ "application.cjs": "exports.value = 1;\n" });
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "application.cjs", learnedProposer: {
      availableModelCount: async () => 1, lastCandidates: () => [],
      propose: async () => ({ surface: "exports.value = 2;", operations: [{ id: "pending-candidate", kind: "replace", path: "application.cjs",
        startLine: 1, endLine: 1, content: "exports.value = 2;", reason: "candidate awaiting proof", risk: 0 }] })
    } });
    let verifications = 0;
    const verify = ports.verify;
    ports.verify = async target => {
      if (!verifications++) return verify(target);
      await writeFile(path.join(root, "application.cjs"), "exports.value = 9; // concurrent owner edit\n");
      throw Error("checker disconnected");
    };
    const failure = await runCodeMouth({ request: "repair", targetPath: "application.cjs", ports }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain("rollback could not complete");
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0].message).toBe("checker disconnected");
    expect(await readFile(path.join(root, "application.cjs"), "utf8")).toBe("exports.value = 9; // concurrent owner edit\n");
  });

  it("keeps the actual source revision's failed-test receipt across rejected behavioral hypotheses", async () => {
    const root = await fixture({ "application.cjs": "exports.value = 1;\n", "contract.cjs": "if(require('./application.cjs').value!==2)throw Error('behavior contract');\n" });
    const observations: Array<string | undefined> = [];
    let offers = 0;
    const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: root, targetPath: "application.cjs", learnedProposer: {
      availableModelCount: async () => 1, lastCandidates: () => [],
      propose: async ({ context, diagnostics }) => {
        observations.push(context.behavioralFailure?.observationId);
        expect(diagnostics).toEqual([]);
        const value = offers++ ? 2 : 3;
        return { surface: `exports.value = ${value};`, source: "learned_construction", operations: [{ id: `candidate.${value}`, kind: "replace", path: "application.cjs", startLine: 1, endLine: 1, content: `exports.value = ${value};`, reason: "candidate under test", risk: 0 }] };
      }
    }, projectValidation: { policy: { schemaVersion: "scce.patch-validation-policy.v1", id: "behavior-search.v1", timeoutMs: 10_000,
      maxOutputBytes: 10_000, maxWorkspaceBytes: 10_000, maxWorkspaceFiles: 8, commands: [
        { executable: process.execPath, argv: ["--check", "application.cjs"], checkIds: ["compiler"] },
        { executable: process.execPath, argv: ["contract.cjs"], checkIds: ["tests"] }
      ] } } });
    expect(await runCodeMouth({ request: "repair", targetPath: "application.cjs", ports })).toMatchObject({ outcome: "resolved", attempts: 2 });
    expect(observations).toEqual([expect.stringMatching(/^sha256:/u), observations[0]]);
    expect(await readFile(path.join(root, "application.cjs"), "utf8")).toBe("exports.value = 2;\n");
  });
});

describe("compiler-located shared grammar holes", () => {
  it.each([
    { file: "ledger.go", source: "package main\nfunc total(value int) int { return value\n}\n", missing: "}" },
    { file: "Ledger.java", source: "class Ledger { static int total(int value) { return value; }\n}\n", missing: "}" },
    { file: "ledger.rs", source: "fn total(value: i32) -> i32 { value\n}\n", missing: "}" },
    { file: "ledger.cpp", source: "int total(int value) { return value;\n}\n", missing: "}" },
    { file: "Ledger.cs", source: "class Ledger { static int Total(int value) { return value; }\n}\n", missing: "}" },
    { file: "ledger.py", source: "def total(value):\n    return int(value)\n", missing: ")" }
  ])("retains lexical insertion boundaries inside real grammar recovery in $file", async ({ file, source, missing }) => {
    const start = source.lastIndexOf(missing);
    const text = source.slice(0, start) + source.slice(start + 1);
    const sites = await treeSitterSyntaxInsertionSites({ targetPath: file, text });
    expect(sites).toContainEqual(expect.objectContaining({ start, length: 0 }));
    expect(sites.every(site => site.length === 0)).toBe(true);
    expect(await treeSitterSyntaxInsertionSites({ targetPath: file, text: source })).toEqual([]);
  });

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
    const goTest = checkerDiagnostics({ code: 1, stdout: "--- FAIL: TestTotals (0.00s)\n ledger_test.go:3: wrong result\n", stderr: "" }, "ledger.go", "go", root);
    expect(goTest).toMatchObject([{ path: path.join(root, "ledger_test.go"), line: 3 }]);
    expect(goTest).toHaveLength(1);
    const javaTest = checkerDiagnostics({ code: 1, stdout: "", stderr: "Exception in thread main\n at LedgerTest.main(LedgerTest.java:1)\n" }, "Ledger.java", "java", root);
    expect(javaTest).toMatchObject([{ path: path.join(root, "LedgerTest.java"), line: 1 }]);
    const rustTest = checkerDiagnostics({ code: 1, stdout: "thread 'grouped_entries' (35116) panicked at tests\\ledger.rs:2:93:\n", stderr: "" }, "src/ledger.rs", "rust", root);
    expect(rustTest).toMatchObject([{ path: path.join(root, "tests/ledger.rs"), line: 2, column: 93 }]);
    const pythonTest = checkerDiagnostics({ code: 1, stdout: "", stderr: '  File "ledger_test.py", line 3, in test_grouping\n    assert False\nAssertionError\n' }, "ledger.py", "python", root);
    expect(pythonTest).toMatchObject([{ path: path.join(root, "ledger_test.py"), line: 3 }]);
  });
});
