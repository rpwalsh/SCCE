// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { BuildTestResult, FileArtifact, ProgramGraph } from "@scce/kernel";
import { programResponseReadiness } from "../program-response-readiness.js";

describe("program response readiness", () => {
  it("does not treat a generated scaffold as an implementation without owner behavior obligations", () => {
    const program = fixtureProgram([]);
    const result = successfulBuild(program);

    expect(programResponseReadiness({ program, buildTest: result })).toMatchObject({
      schema: "scce.program.response_readiness.v1",
      status: "not_ready",
      reasonId: "program.readiness.behavior_contract_missing"
    });
  });

  it("keeps source ownership and an executed matching test receipt in the readiness contract", () => {
    const program = fixtureProgram(["owner.program.requirement.1"]);
    const result = successfulBuild(program);

    expect(programResponseReadiness({ program, buildTest: result })).toMatchObject({
      status: "ready",
      reasonId: "program.readiness.verified",
      artifactIds: program.files.map(artifact => String(artifact.artifactId)),
      artifactCount: 2
    });
    expect(programResponseReadiness({ program })).toMatchObject({
      status: "not_ready",
      reasonId: "program.readiness.build_test_not_run"
    });
    expect(programResponseReadiness({
      program,
      buildTest: { ...result, testExecutionReceipt: { ...result.testExecutionReceipt!, status: "skipped" } }
    })).toMatchObject({
      status: "not_ready",
      reasonId: "program.readiness.build_test_not_passed"
    });
  });

  it("does not accept passing generic tests that are not bound to the owner requirements", () => {
    const program = fixtureProgram(["owner.program.requirement.1"]);
    const genericTestProgram = {
      ...program,
      files: program.files.map(file => file.role === "test" ? { ...file, content: "if (answer() !== 42) throw new Error();" } : file)
    };

    expect(programResponseReadiness({ program: genericTestProgram, buildTest: successfulBuild(genericTestProgram) })).toMatchObject({
      status: "not_ready",
      reasonId: "program.readiness.behavior_contract_not_bound_to_test"
    });
  });

  it("rejects artifact sets that differ from the tested ProgramGraph", () => {
    const program = fixtureProgram(["owner.program.requirement.1"]);
    const result = successfulBuild(program);
    const changed = { ...program.files[0]!, contentHash: "sha256_changed" as FileArtifact["contentHash"] };

    expect(programResponseReadiness({ program, buildTest: { ...result, artifacts: [changed] } })).toMatchObject({
      status: "not_ready",
      reasonId: "program.readiness.artifact_set_mismatch"
    });
  });
});

function fixtureProgram(ownerRequirementIds: string[]): ProgramGraph {
  const file: FileArtifact = {
    artifactId: "artifact.program.entry" as FileArtifact["artifactId"],
    path: "src/program.ts",
    mediaType: "text/typescript",
    content: "export function answer(): number { return 42; }\n",
    contentHash: "sha256_program" as FileArtifact["contentHash"],
    role: "source"
  };
  const test: FileArtifact = {
    artifactId: "artifact.program.test" as FileArtifact["artifactId"],
    path: "test/program.test.ts",
    mediaType: "text/typescript",
    content: "import { answer } from '../src/program.js'; if (answer() !== 42) throw new Error('owner.program.requirement.1 failed');\n",
    contentHash: "sha256_test" as FileArtifact["contentHash"],
    role: "test"
  };
  return {
    id: "program.readiness.fixture",
    language: "typescript",
    packageManager: "npm",
    entrypoint: file.path,
    nodes: [],
    edges: [],
    files: [file, test],
    build: { command: "npm", args: ["run", "build"], cwd: "." },
    test: { command: "npm", args: ["test"], cwd: "." },
    hydration: {
      schema: "scce.program.hydration.v1",
      ownerRequirementIds,
      program: {
        programId: "program.readiness.fixture",
        languageId: "language.typescript",
        packageManagerId: "package_manager.npm",
        entrypointPath: file.path,
        buildCommand: { command: "npm", args: ["run", "build"], cwd: "." },
        testCommand: { command: "npm", args: ["test"], cwd: "." },
        nodeCount: 0,
        edgeCount: 0,
        fileCount: 2,
        provenanceEvidenceIds: []
      },
      files: [],
      symbols: [],
      dependencies: [],
      validations: [],
      emissions: [],
      diagnostics: [],
      valid: true
    }
  };
}

function successfulBuild(program: ProgramGraph): BuildTestResult {
  return {
    build: { code: 0, stdout: "", stderr: "", durationMs: 1 },
    test: { code: 0, stdout: "", stderr: "", durationMs: 1 },
    testExecutionReceipt: { command: program.test.command, args: program.test.args, cwd: program.test.cwd, status: "executed" },
    repairAttempted: false,
    repairApplied: false,
    passed: true,
    artifacts: program.files
  };
}
