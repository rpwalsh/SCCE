import { describe, expect, it } from "vitest";
import { createHasher, toJsonValue } from "../primitives.js";
import { hashPatchContent } from "../patch-transaction.js";
import { createProgramHydrationContract } from "../program-runtime.js";
import {
  canonicalTypeScriptCodeFixIdentity,
  canonicalTypeScriptCompilerCommandIdentity,
  canonicalTypeScriptCompilerOptionsHash,
  canonicalTypeScriptDiagnosticIdentity,
  materializeTypeScriptCodeActionRepair
} from "../program-repair-kernel.js";
import type { ArtifactId, ContentHash, FileArtifact, ProgramGraph } from "../types.js";
import {
  createWorkspaceRevisionSnapshot,
  generateWorkspacePatchPlan,
  generateWorkspacePatchPlanFromProgramGraph,
  scoreWorkspacePatchProposal,
  type GenerateWorkspacePatchPlanInput,
  type WorkspaceRevisionFileInput
} from "../workspace-plan-generator.js";

describe("workspace exact-byte plan generation", () => {
  it("converts source-bound ProgramGraph artifacts into the same unauthorized exact-byte plan", () => {
    const sourceBefore = "export function parseLog(line: string) { return line; }\n";
    const snapshot = revision([current("src/log-parser.ts", sourceBefore, "source")]);
    const source = proposed("src/log-parser.ts", "export function parseLog(line: string) { return line.trim(); }\n", "source", snapshot.files[0]!.contentHash).artifact;
    const test = proposed("src/log-parser.test.ts", "import { strict as assert } from \"node:assert\";\nimport test from \"node:test\";\nimport { parseLog } from \"./log-parser.js\";\ntest(\"parseLog trims input\", () => assert.equal(parseLog(\" x \"), \"x\"));\n", "test", null).artifact;
    const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
      id: "program.workspace.log-parser",
      language: "typescript",
      packageManager: "pnpm",
      entrypoint: source.path,
      nodes: [
        {
          id: "blueprint.workspace.log-parser",
          kind: "implementation_blueprint",
          label: "source-bound blueprint",
          metadata: { sourceCoupling: 0.8, unbackedSynthesisRisk: 0.25 }
        },
        {
          id: "repair.workspace.log-parser",
          kind: "program_repair_full_file_materialization",
          label: "source-bound repair",
          metadata: {
            schema: "scce.program_repair.full_file_lineage.v1",
            transformations: [{
              path: source.path,
              baseArtifactId: "artifact.before.log-parser",
              baseContentHash: artifactHash(sourceBefore),
              outputArtifactId: source.artifactId,
              outputContentHash: source.contentHash,
              operationIds: ["repair.operation.trim"],
              evidence: [{ path: source.path, artifactId: "artifact.before.log-parser", contentHash: artifactHash(sourceBefore) }]
            }]
          }
        }
      ],
      edges: [{ source: "repair.workspace.log-parser", target: `artifact:${source.path}`, relation: "materializes_full_file", weight: 1 }],
      files: [source, test],
      build: { command: "pnpm", args: ["build"], cwd: "." },
      test: { command: "pnpm", args: ["test"], cwd: "." }
    };
    const evidenceIds = ["evidence.workspace.source"];
    const program: ProgramGraph = {
      ...graphWithoutHydration,
      hydration: createProgramHydrationContract({
        program: graphWithoutHydration,
        sourcePlanId: "program-plan.workspace.log-parser",
        evidenceIds
      })
    };

    const planningInput = {
      snapshot,
      expectedRevisionId: snapshot.revisionId,
      expectedRevisionHash: snapshot.revisionHash,
      request: {
        requestId: "request.add-log-parser",
        text: "Add a bounded log parser.",
        requestedPaths: [source.path],
        evidenceIds
      },
      program,
      existingDirectoryPaths: ["", "src"],
      verifiedAbsentPaths: [test.path],
      validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["compiler", "typecheck", "tests"] }
    } as const;
    const result = generateWorkspacePatchPlanFromProgramGraph(planningInput);

    expect(result.plan.operations.map(operation => operation.path).sort()).toEqual(["src/log-parser.test.ts", "src/log-parser.ts"]);
    expect(result.programProposalTrace).toMatchObject({
      source: "program-graph-full-file",
      requestId: "request.add-log-parser",
      programId: program.id,
      evidenceIds,
      hydrationValidated: true,
      fullFileMaterialized: true
    });
    expect(result.authorization.granted).toBe(false);
    expect(result.execution.state).toBe("not_executed");
    expect(result.scoreTrace.features.requestedBehaviorCoverage).toBeCloseTo(0.75, 12);
    expect(result.scoreTrace.features.architecturalFit).toBeCloseTo(0.6, 12);
    expect(result.scoreTrace.features.explanationAccuracy).toBeCloseTo(0.75, 12);
    expect(result.scoreTrace.features.fabricatedBehavior).toBeCloseTo(0.25, 12);
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...planningInput, verifiedAbsentPaths: [] }))
      .toThrow(/create target lacks live absence proof/u);
    const staleHydration: ProgramGraph = {
      ...program,
      hydration: {
        ...program.hydration!,
        files: program.hydration!.files.map((file, index) => index === 0
          ? { ...file, artifactId: "artifact_forged_hydration_identity" as ArtifactId }
          : file)
      }
    };
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...planningInput, program: staleHydration }))
      .toThrow(/graph_identity_mismatch/u);
  });

  it("rejects a ProgramGraph request when evidence or a requested artifact is not bound", () => {
    const snapshot = revision([current("README.md", "# Existing\n", "doc")]);
    const source = proposed("src/value.ts", "export const value = 1;\n", "source", null).artifact;
    const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
      id: "program.workspace.value",
      language: "typescript",
      packageManager: "pnpm",
      entrypoint: source.path,
      nodes: [],
      edges: [],
      files: [source],
      build: { command: "pnpm", args: ["build"], cwd: "." },
      test: { command: "pnpm", args: ["test"], cwd: "." }
    };
    const program: ProgramGraph = {
      ...graphWithoutHydration,
      hydration: createProgramHydrationContract({ program: graphWithoutHydration, sourcePlanId: "plan.value", evidenceIds: ["evidence.bound"] })
    };
    const base = {
      snapshot,
      expectedRevisionId: snapshot.revisionId,
      expectedRevisionHash: snapshot.revisionHash,
      program,
      existingDirectoryPaths: ["", "src"],
      verifiedAbsentPaths: [source.path],
      validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["tests"] as const }
    };
    expect(() => generateWorkspacePatchPlanFromProgramGraph({
      ...base,
      request: { requestId: "request.value", text: "Add value.", requestedPaths: [source.path], evidenceIds: ["evidence.other"] }
    })).toThrow(/not bound to the program graph/u);
    expect(() => generateWorkspacePatchPlanFromProgramGraph({
      ...base,
      request: { requestId: "request.value", text: "Add value.", requestedPaths: ["src/missing.ts"], evidenceIds: ["evidence.bound"] }
    })).toThrow(/did not materialize requested full-file artifacts/u);
  });

  it("rejects tampered compiler-repair identities and tsconfig contracts after rehydration", () => {
    const fixture = compilerRepairPlanningFixture();
    expect(generateWorkspacePatchPlanFromProgramGraph(fixture.input).plan.operations)
      .toEqual([expect.objectContaining({ kind: "replace", path: "src/value.ts", content: fixture.after })]);

    const missingCodeFixIdentity = tamperCompilerRepairLineage(fixture.input.program, operation => {
      operation.preconditions = contractRecordsForTest(operation.preconditions)
        .filter(contract => contract.id !== "repair.precondition.typescript_code_fix_identity");
    });
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, program: missingCodeFixIdentity }))
      .toThrow(/code-fix identity is missing, stale, or non-canonical/u);

    const tamperedFix = tamperCompilerRepairLineage(fixture.input.program, operation => {
      const codeFix = recordForTest(operation.codeFixEvidence, "code-fix evidence");
      codeFix.description = "tampered compiler fix description";
    });
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, program: tamperedFix }))
      .toThrow(/code-fix identity is missing, stale, or non-canonical/u);

    const missingConfigContract = tamperCompilerRepairLineage(fixture.input.program, operation => {
      operation.preconditions = contractRecordsForTest(operation.preconditions)
        .filter(contract => contract.id !== "repair.precondition.tsconfig_content_hash");
    });
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, program: missingConfigContract }))
      .toThrow(/tsconfig content-hash precondition is missing or stale/u);

    const staleConfigContract = tamperCompilerRepairLineage(fixture.input.program, operation => {
      const staleHash = artifactHash("stale compiler configuration\n");
      const compiler = recordForTest(operation.compilerContext, "compiler context");
      compiler.tsconfigContentHash = staleHash;
      operation.preconditions = contractRecordsForTest(operation.preconditions).map(contract =>
        contract.id === "repair.precondition.tsconfig_content_hash"
          ? { ...contract, value: staleHash }
          : contract
      );
    });
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, program: staleConfigContract }))
      .toThrow(/tsconfig content hash is stale/u);

    const missingCommandIdentity = tamperCompilerRepairLineage(fixture.input.program, operation => {
      operation.preconditions = contractRecordsForTest(operation.preconditions)
        .filter(contract => contract.id !== "repair.precondition.compiler_command_identity");
    });
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, program: missingCommandIdentity }))
      .toThrow(/compiler-command identity or source-content precondition is missing or stale/u);

    const staleCommandSource = tamperCompilerRepairLineage(fixture.input.program, operation => {
      const compiler = recordForTest(operation.compilerContext, "compiler context");
      const command = recordForTest(compiler.compilerCommand, "compiler command");
      const staleHash = artifactHash("stale command source\n");
      command.sourceContentHash = staleHash;
      const commandIdentity = canonicalTypeScriptCompilerCommandIdentity({
        executable: String(command.executable),
        args: Array.isArray(command.args) ? command.args.map(String) : [],
        cwd: String(command.cwd),
        sourcePath: String(command.sourcePath),
        sourceContentHash: staleHash
      });
      operation.preconditions = contractRecordsForTest(operation.preconditions).map(contract => {
        if (contract.id === "repair.precondition.compiler_command_identity") return { ...contract, value: commandIdentity };
        if (contract.id === "repair.precondition.compiler_command_source_content_hash") return { ...contract, value: staleHash };
        return contract;
      });
    });
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, program: staleCommandSource }))
      .toThrow(/source-observed compiler command is stale or not bound/u);
  });

  it("plans the complete atomic compiler-action closure including a live-proven create", () => {
    const fixture = atomicCompilerRepairPlanningFixture();
    const result = generateWorkspacePatchPlanFromProgramGraph(fixture.input);

    expect(result.plan.operations).toEqual([
      expect.objectContaining({ kind: "replace", path: "src/a.ts", content: fixture.afterPeer }),
      expect.objectContaining({ kind: "create", path: "src/generated.ts", content: fixture.created })
    ]);
    expect(result.authorization).toEqual({ required: true, granted: false, capabilityId: "workspace.patch.apply" });
    expect(result.execution).toEqual({ state: "not_executed", receipt: null });
    expect(result.programProposalTrace.requestedPaths).toEqual(["src/b.ts"]);
    expect(result.programProposalTrace.selectedArtifactPaths).toEqual(expect.arrayContaining([
      "src/a.ts",
      "src/b.ts",
      "src/generated.ts"
    ]));
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, verifiedAbsentPaths: [] }))
      .toThrow(/create target lacks live absence proof/u);
    const truncatedAction = tamperCompilerRepairLineage(fixture.input.program, operation => {
      const codeFix = recordForTest(operation.codeFixEvidence, "atomic code-fix evidence");
      codeFix.fileChanges = (Array.isArray(codeFix.fileChanges) ? codeFix.fileChanges : [])
        .filter(change => recordForTest(change, "atomic file change").path !== "src/generated.ts");
    });
    expect(() => generateWorkspacePatchPlanFromProgramGraph({ ...fixture.input, program: truncatedAction }))
      .toThrow(/atomic code-fix file set|code-fix identity/u);
  });

  it("fails closed when the ProgramGraph leaves every requested file unchanged", () => {
    const snapshot = revision([current("src/value.ts", "export const value = 1;\n", "source")]);
    const source = proposed("src/value.ts", "export const value = 1;\n", "source", snapshot.files[0]!.contentHash).artifact;
    const test = proposed("src/value.test.ts", "test(\"value\", () => { if (1 !== 1) throw new Error(\"value\"); });\n", "test", null).artifact;
    const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
      id: "program.workspace.unchanged",
      language: "typescript",
      packageManager: "pnpm",
      entrypoint: source.path,
      nodes: [],
      edges: [],
      files: [source, test],
      build: { command: "pnpm", args: ["build"], cwd: "." },
      test: { command: "pnpm", args: ["test"], cwd: "." }
    };
    const program: ProgramGraph = {
      ...graphWithoutHydration,
      hydration: createProgramHydrationContract({ program: graphWithoutHydration, sourcePlanId: "plan.unchanged", evidenceIds: ["evidence.bound"] })
    };
    expect(() => generateWorkspacePatchPlanFromProgramGraph({
      snapshot,
      expectedRevisionId: snapshot.revisionId,
      expectedRevisionHash: snapshot.revisionHash,
      request: { requestId: "request.unchanged", text: "Change value.", requestedPaths: [source.path], evidenceIds: ["evidence.bound"] },
      program,
      existingDirectoryPaths: ["", "src"],
      verifiedAbsentPaths: [test.path],
      validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["tests"] }
    })).toThrow(/did not materially change requested full-file artifacts/u);
  });

  it("fails closed when a generated create has no verified parent directory", () => {
    const snapshot = revision([current("README.md", "# Existing\n", "doc")]);
    const doc = proposed("notes/plan.md", "# Plan\n", "doc", null).artifact;
    const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
      id: "program.workspace.missing-parent",
      language: "markdown",
      packageManager: "source-derived",
      entrypoint: doc.path,
      nodes: [],
      edges: [],
      files: [doc],
      build: { command: "source-derived", args: ["build"], cwd: "." },
      test: { command: "source-derived", args: ["test"], cwd: "." }
    };
    const program: ProgramGraph = {
      ...graphWithoutHydration,
      hydration: createProgramHydrationContract({ program: graphWithoutHydration, sourcePlanId: "plan.missing-parent", evidenceIds: ["evidence.bound"] })
    };
    expect(() => generateWorkspacePatchPlanFromProgramGraph({
      snapshot,
      expectedRevisionId: snapshot.revisionId,
      expectedRevisionHash: snapshot.revisionHash,
      request: { requestId: "request.missing-parent", text: "Create notes.", requestedPaths: [doc.path], evidenceIds: ["evidence.bound"] },
      program,
      existingDirectoryPaths: [""],
      verifiedAbsentPaths: [doc.path],
      validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["tests"] }
    })).toThrow(/create parent directory is not present/u);
  });

  it("builds a valid replacement/create PatchTransactionPlan from exact revision bytes", () => {
    const snapshot = revision([
      current("src/value.ts", "export const value = 1;\n", "source"),
      current("package.json", "{\"scripts\":{\"test\":\"vitest run\"}}\n", "config")
    ]);
    const result = generateWorkspacePatchPlan(validInput(snapshot, [
      proposed("src/value.ts", "export const value = 2;\n", "source", snapshot.files[1]!.contentHash),
      proposed("src/value.regression.test.ts", "import { expect, it } from \"vitest\";\nimport { value } from \"./value.js\";\nit(\"value\", () => expect(value).toBe(2));\n", "test", null)
    ]));

    const replace = result.plan.operations.find(operation => operation.path === "src/value.ts");
    expect(replace).toMatchObject({
      kind: "replace",
      beforeContentHash: hashPatchContent("export const value = 1;\n"),
      afterContentHash: hashPatchContent("export const value = 2;\n")
    });
    expect(result.safety.provenAbsentCreatePaths).toEqual(["src/value.regression.test.ts"]);
    expect(result.safety.exactBaseHashPaths).toEqual(["src/value.ts"]);
    expect(result.scoreTrace.score).toBeCloseTo(0.88, 12);
    expect(result.scoreTrace.features.regressionProtection).toBe(0);
    expect(result.scoreTrace.status).toBe("provisional-uncalibrated");
    expect(result.scoreTrace.externalResultsOutrankScore).toBe(true);
    expect(result.authorization).toEqual({ required: true, granted: false, capabilityId: "workspace.patch.apply" });
    expect(result.execution).toEqual({ state: "not_executed", receipt: null });
  });

  it("rejects a stale durable revision id or revision hash", () => {
    const snapshot = revision([current("README.md", "before\n", "doc")]);
    const input = validInput(snapshot, [proposed("README.md", "after\n", "doc", snapshot.files[0]!.contentHash)], ["README.md"]);
    expect(() => generateWorkspacePatchPlan({ ...input, expectedRevisionId: "revision.older" }))
      .toThrow(/stale workspace revision/i);
    expect(() => generateWorkspacePatchPlan({ ...input, expectedRevisionHash: hashPatchContent("another revision") }))
      .toThrow(/stale workspace revision/i);
  });

  it("rejects stale exact file bytes even when snapshot metadata was retained", () => {
    const snapshot = revision([current("README.md", "before\n", "doc")]);
    snapshot.files[0]!.bytes[0] = "x".charCodeAt(0);
    const input = validInput(snapshot, [proposed("README.md", "after\n", "doc", snapshot.files[0]!.contentHash)], ["README.md"]);
    expect(() => generateWorkspacePatchPlan(input)).toThrow(/stale workspace content hash/i);
  });

  it("requires absence for create proposals", () => {
    const snapshot = revision([current("src/existing.ts", "export {};\n", "source")]);
    const input = validInput(snapshot, [proposed("src/existing.ts", "export const value = 1;\n", "source", null)]);
    expect(() => generateWorkspacePatchPlan(input)).toThrow(/creation target is not absent/i);
  });

  it("requires proposed replacement bytes to carry their exact CRLF identity", () => {
    const snapshot = revision([current("src/value.ts", "export const value = 1;\r\n", "source")]);
    const result = generateWorkspacePatchPlan(validInput(snapshot, [
      proposed("src/value.ts", "export const value = 2;\r\n", "source", snapshot.files[0]!.contentHash),
      proposed("src/value.test.ts", "import { expect, it } from \"vitest\";\r\nimport { value } from \"./value.js\";\r\nit(\"value\", () => expect(value).toBe(2));\r\n", "test", null)
    ]));
    const replace = result.plan.operations.find(operation => operation.path === "src/value.ts");
    expect(replace?.kind === "replace" ? replace.content : "").toBe("export const value = 2;\r\n");
    expect(result.safety.preservedLineEndingPaths).toEqual(["src/value.ts"]);
    expect(() => generateWorkspacePatchPlan(validInput(snapshot, [
      proposed("src/value.ts", "export const value = 2;\n", "source", snapshot.files[0]!.contentHash),
      proposed("src/value.test.ts", "import { expect, it } from \"vitest\";\nimport { value } from \"./value.js\";\nit(\"value\", () => expect(value).toBe(2));\n", "test", null)
    ]))).toThrow(/line-ending conversion is not permitted/u);
  });

  it("rejects binary and unsupported-encoding replacement sources", () => {
    const binary = revision([{ path: "src/blob.bin", bytes: new Uint8Array([0, 1, 2]), mediaType: "application/octet-stream", role: "source" }]);
    expect(() => generateWorkspacePatchPlan(validInput(binary, [
      proposed("src/blob.bin", "replacement", "source", binary.files[0]!.contentHash),
      proposed("src/blob.test.ts", "export {};\n", "test", null)
    ], ["src/blob.bin"]))).toThrow(/binary file/i);

    const utf16 = revision([{ path: "src/legacy.ts", bytes: new Uint8Array([0xff, 0xfe, 0x61, 0x62]), mediaType: "text/typescript", role: "source" }]);
    expect(() => generateWorkspacePatchPlan(validInput(utf16, [
      proposed("src/legacy.ts", "export {};\n", "source", utf16.files[0]!.contentHash),
      proposed("src/legacy.test.ts", "export {};\n", "test", null)
    ], ["src/legacy.ts"]))).toThrow(/unsupported text encoding/i);
  });

  it("rejects replacement or deletion of an existing test", () => {
    const snapshot = revision([current("src/value.test.ts", "it(\"old\", () => {});\n", "test")]);
    expect(() => generateWorkspacePatchPlan(validInput(snapshot, [
      proposed("src/value.test.ts", "it.skip(\"old\", () => {});\n", "test", snapshot.files[0]!.contentHash)
    ], ["src/value.test.ts"]))).toThrow(/test weakening rejected/i);

    const deletionInput = validInput(snapshot, [], ["src/value.test.ts"]);
    expect(() => generateWorkspacePatchPlan({
      ...deletionInput,
      deletions: [{ path: "src/value.test.ts", expectedBaseContentHash: snapshot.files[0]!.contentHash }]
    })).toThrow(/test weakening rejected/i);
  });

  it("rejects source behavior changes without a newly created regression test", () => {
    const snapshot = revision([current("src/value.ts", "export const value = 1;\n", "source")]);
    expect(() => generateWorkspacePatchPlan(validInput(snapshot, [
      proposed("src/value.ts", "export const value = 2;\n", "source", snapshot.files[0]!.contentHash)
    ]))).toThrow(/requires a newly created regression test/i);
  });

  it("rejects changing an existing package test command", () => {
    const snapshot = revision([current("package.json", "{\"scripts\":{\"test\":\"vitest run\"}}\n", "config")]);
    expect(() => generateWorkspacePatchPlan(validInput(snapshot, [
      proposed("package.json", "{\"scripts\":{\"test\":\"vitest run --passWithNoTests\"}}\n", "config", snapshot.files[0]!.contentHash)
    ], ["package.json"]))).toThrow(/test weakening rejected/i);
  });

  it("rejects test-control edits and neutralized new regression tests", () => {
    const config = revision([current("vitest.config.ts", "export default { test: {} };\n", "config")]);
    expect(() => generateWorkspacePatchPlan(validInput(config, [
      proposed("vitest.config.ts", "export default { test: { exclude: [\"**/*\"] } };\n", "config", config.files[0]!.contentHash)
    ], ["vitest.config.ts"]))).toThrow(/test weakening rejected/i);

    const source = revision([current("src/value.ts", "export const value = 1;\n", "source")]);
    expect(() => generateWorkspacePatchPlan(validInput(source, [
      proposed("src/value.ts", "export const value = 2;\n", "source", source.files[0]!.contentHash),
      proposed("src/value.test.ts", "it.skip(\"value\", () => {});\n", "test", null)
    ]))).toThrow(/skipped or neutralized/i);

    expect(() => generateWorkspacePatchPlan(validInput(source, [
      proposed("src/value.ts", "export const value = 2;\n", "source", source.files[0]!.contentHash),
      proposed("src/value.test.ts", "import { it } from \"vitest\";\nit(\"value\", () => {});\n", "test", null)
    ]))).toThrow(/register a test and assert behavior/i);

    expect(() => generateWorkspacePatchPlan(validInput(source, [
      proposed("src/value.ts", "export const value = 2;\n", "source", source.files[0]!.contentHash),
      proposed("src/value.test.ts", "// test(\"value\", () => expect(2).toBe(2));\nexport {};\n", "test", null)
    ]))).toThrow(/register a test and assert behavior/i);

    expect(() => generateWorkspacePatchPlan(validInput(source, [
      proposed("src/value.ts", "export const value = 2;\n", "source", source.files[0]!.contentHash),
      proposed("src/value.test.ts", "import { expect, test } from \"vitest\";\nimport { value } from \"./value.js\";\ntest(\"value\", () => expect(true).toBe(true));\n", "test", null)
    ]))).toThrow(/import and assert behavior from a changed source artifact/i);
  });

  it("rejects non-test changes outside the source-grounded requested scope", () => {
    const snapshot = revision([current("README.md", "before\n", "doc")]);
    expect(() => generateWorkspacePatchPlan(validInput(snapshot, [
      proposed("README.md", "after\n", "doc", snapshot.files[0]!.contentHash)
    ], ["docs/OTHER.md"]))).toThrow(/unrelated workspace changes rejected/i);
  });

  it("records every exact Q_patch coefficient including hard penalties", () => {
    const trace = scoreWorkspacePatchProposal({
      requestedBehaviorCoverage: 1,
      exactSourceFit: 1,
      dependencyConsistency: 1,
      regressionProtection: 1,
      architecturalFit: 1,
      locality: 1,
      validationPlanQuality: 1,
      rollbackSafety: 1,
      explanationAccuracy: 1,
      testWeakening: 1,
      staleSourceRisk: 1,
      fabricatedBehavior: 1,
      unrelatedChangeRate: 1
    }, { assessmentId: "assessment.fixture", evidenceIds: ["evidence.fixture"] });
    expect(trace.weightedTerms).toEqual({
      requestedBehaviorCoverage: 0.22,
      exactSourceFit: 0.17,
      dependencyConsistency: 0.14,
      regressionProtection: 0.12,
      architecturalFit: 0.1,
      locality: 0.09,
      validationPlanQuality: 0.07,
      rollbackSafety: 0.05,
      explanationAccuracy: 0.04,
      testWeakening: -1,
      staleSourceRisk: -0.65,
      fabricatedBehavior: -0.55,
      unrelatedChangeRate: -0.35
    });
    expect(trace.score).toBeCloseTo(-1.55, 12);
  });
});

function revision(files: readonly WorkspaceRevisionFileInput[]) {
  return createWorkspaceRevisionSnapshot({ workspaceId: "workspace.fixture", revisionId: "revision.fixture.1", files });
}

function current(path: string, content: string, role: FileArtifact["role"]): WorkspaceRevisionFileInput {
  return { path, bytes: new TextEncoder().encode(content), mediaType: mediaType(path), role };
}

function proposed(path: string, content: string, role: FileArtifact["role"], expectedBaseContentHash: ReturnType<typeof hashPatchContent> | null) {
  const hash = createHasher().digestHex(content);
  const artifact: FileArtifact = {
    artifactId: `artifact.${hash.slice(0, 16)}` as ArtifactId,
    path,
    mediaType: mediaType(path),
    content,
    contentHash: `sha256_${hash}` as ContentHash,
    role
  };
  return { artifact, expectedBaseContentHash };
}

function artifactHash(content: string): string {
  return `sha256_${createHasher().digestHex(content)}`;
}

function atomicCompilerRepairPlanningFixture(): {
  input: Parameters<typeof generateWorkspacePatchPlanFromProgramGraph>[0];
  afterPeer: string;
  created: string;
} {
  const hasher = createHasher();
  const diagnosticContent = "import { hidden } from \"./a\";\nexport const value = hidden;\n";
  const peerBefore = "const hidden = 1;\n";
  const afterPeer = "export const hidden = 1;\n";
  const created = "export const generated = true;\n";
  const configContent = "{\"compilerOptions\":{\"strict\":true,\"noEmit\":true},\"include\":[\"src/**/*.ts\"]}\n";
  const commandSourceContent = "{\"scripts\":{\"typecheck\":\"tsc -p tsconfig.json\",\"test\":\"vitest run\"}}\n";
  const diagnosticSource = proposed("src/b.ts", diagnosticContent, "source", null).artifact;
  const peer = proposed("src/a.ts", peerBefore, "source", null).artifact;
  const config = proposed("tsconfig.json", configContent, "config", null).artifact;
  const commandSource = proposed("package.json", commandSourceContent, "config", null).artifact;
  const files = [diagnosticSource, peer, config, commandSource];
  const evidenceIds = ["evidence.atomic-compiler-repair.fixture"];
  const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
    id: "program.workspace.atomic-compiler-repair",
    language: "typescript",
    packageManager: "pnpm",
    entrypoint: diagnosticSource.path,
    nodes: [
      {
        id: "blueprint.workspace.atomic-compiler-repair",
        kind: "implementation_blueprint",
        label: "atomic compiler-owned repair",
        metadata: { sourceCoupling: 1, unbackedSynthesisRisk: 0 }
      },
      ...files.map(file => ({
        id: `artifact:${file.path}`,
        kind: `artifact:${file.role}`,
        label: file.path,
        metadata: { contentHash: file.contentHash }
      }))
    ],
    edges: [],
    files,
    build: { command: "tsc", args: ["-p", "tsconfig.json"], cwd: "." },
    test: { command: "vitest", args: ["run"], cwd: "." }
  };
  const baseProgram: ProgramGraph = {
    ...graphWithoutHydration,
    hydration: createProgramHydrationContract({
      program: graphWithoutHydration,
      sourcePlanId: "program-plan.atomic-compiler-repair.fixture",
      evidenceIds
    })
  };
  const diagnostic = {
    code: 2459,
    category: "error",
    start: diagnosticContent.indexOf("hidden"),
    length: "hidden".length,
    message: "Module './a' declares 'hidden' locally, but it is not exported."
  };
  const compilerOptionsHash = canonicalTypeScriptCompilerOptionsHash({ noEmit: true, strict: true }, hasher);
  const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
    path: diagnosticSource.path,
    diagnostic,
    compilerVersion: "5.9.3",
    compilerOptionsHash
  }, hasher);
  const fileChanges = [{
    path: peer.path,
    isNewFile: false,
    baseArtifactId: String(peer.artifactId),
    baseContentHash: String(peer.contentHash),
    textChanges: [{ start: 0, length: 0, newText: "export " }],
    mediaType: peer.mediaType,
    role: peer.role
  }, {
    path: "src/generated.ts",
    isNewFile: true,
    baseArtifactId: null,
    baseContentHash: null,
    textChanges: [{ start: 0, length: 0, newText: created }],
    mediaType: "text/typescript",
    role: "source" as const
  }];
  const fixName = "atomicCompilerAction";
  const description = "Export the local and create the compiler-requested source";
  const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
    diagnosticIdentity,
    codeFix: { fixName, description, fileChanges }
  }, hasher);
  const repaired = materializeTypeScriptCodeActionRepair({
    program: baseProgram,
    requestText: "Apply the selected compiler action for TS2459 in src/b.ts.",
    transformations: [{
      path: diagnosticSource.path,
      baseArtifactId: String(diagnosticSource.artifactId),
      baseContentHash: String(diagnosticSource.contentHash),
      snapshotHash: `sha256:${hasher.digestHex("atomic compiler snapshot")}`,
      diagnostic: { ...diagnostic, diagnosticIdentity },
      codeFix: { fixName, description, codeFixIdentity, fileChanges },
      compiler: {
        version: "5.9.3",
        tsconfigPath: config.path,
        tsconfigContentHash: String(config.contentHash),
        compilerOptionsHash,
        compilerOptionsSource: "source_observed_tsc_project",
        configDiagnosticCodes: [],
        sourceFileBoundary: "workspace_snapshot_and_typescript_standard_library",
        compilerCommand: {
          executable: "tsc",
          args: ["-p", "tsconfig.json"],
          cwd: ".",
          sourcePath: commandSource.path,
          sourceContentHash: String(commandSource.contentHash)
        }
      }
    }],
    hasher
  });
  const snapshot = revision([
    current(diagnosticSource.path, diagnosticContent, "source"),
    current(peer.path, peerBefore, "source"),
    current(config.path, configContent, "config"),
    current(commandSource.path, commandSourceContent, "config")
  ]);
  return {
    afterPeer,
    created,
    input: {
      snapshot,
      expectedRevisionId: snapshot.revisionId,
      expectedRevisionHash: snapshot.revisionHash,
      request: {
        requestId: "request.atomic-compiler-repair.fixture",
        text: "Apply the selected compiler action for TS2459 in src/b.ts.",
        requestedPaths: [diagnosticSource.path],
        evidenceIds
      },
      program: repaired.program,
      existingDirectoryPaths: ["", "src"],
      verifiedAbsentPaths: ["src/generated.ts"],
      validationPlan: {
        validatorId: "trusted-host-pnpm-validate.v1",
        checks: ["compiler", "typecheck", "tests"]
      }
    }
  };
}

function compilerRepairPlanningFixture(): {
  input: Parameters<typeof generateWorkspacePatchPlanFromProgramGraph>[0];
  after: string;
} {
  const hasher = createHasher();
  const before = "const count = 1;\nexport const value = coutn;\n";
  const after = "const count = 1;\nexport const value = count;\n";
  const configContent = "{\"compilerOptions\":{\"strict\":true,\"noEmit\":true},\"include\":[\"src/**/*.ts\"]}\n";
  const commandSourceContent = "{\"scripts\":{\"typecheck\":\"tsc -p tsconfig.json\",\"test\":\"vitest run\"}}\n";
  const source = proposed("src/value.ts", before, "source", null).artifact;
  const config = proposed("tsconfig.json", configContent, "config", null).artifact;
  const commandSource = proposed("package.json", commandSourceContent, "config", null).artifact;
  const evidenceIds = ["evidence.compiler-repair.fixture"];
  const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
    id: "program.workspace.compiler-repair",
    language: "typescript",
    packageManager: "pnpm",
    entrypoint: source.path,
    nodes: [
      {
        id: "blueprint.workspace.compiler-repair",
        kind: "implementation_blueprint",
        label: "compiler-owned repair",
        metadata: { sourceCoupling: 1, unbackedSynthesisRisk: 0 }
      },
      ...[source, config, commandSource].map(file => ({
        id: `artifact:${file.path}`,
        kind: `artifact:${file.role}`,
        label: file.path,
        metadata: { contentHash: file.contentHash }
      }))
    ],
    edges: [],
    files: [source, config, commandSource],
    build: { command: "tsc", args: ["-p", "tsconfig.json"], cwd: "." },
    test: { command: "vitest", args: ["run"], cwd: "." }
  };
  const baseProgram: ProgramGraph = {
    ...graphWithoutHydration,
    hydration: createProgramHydrationContract({
      program: graphWithoutHydration,
      sourcePlanId: "program-plan.compiler-repair.fixture",
      evidenceIds
    })
  };
  const diagnostic = {
    code: 2552,
    category: "error",
    start: before.indexOf("coutn"),
    length: "coutn".length,
    message: "Cannot find name 'coutn'. Did you mean 'count'?"
  };
  const compilerOptionsHash = canonicalTypeScriptCompilerOptionsHash({ noEmit: true, strict: true }, hasher);
  const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
    path: source.path,
    diagnostic,
    compilerVersion: "5.9.3",
    compilerOptionsHash
  }, hasher);
  const textChanges = [{ start: diagnostic.start, length: diagnostic.length, newText: "count" }];
  const fixName = "spelling";
  const description = "Change spelling to 'count'";
  const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
    diagnosticIdentity,
    codeFix: { fixName, description, textChanges }
  }, hasher);
  const repaired = materializeTypeScriptCodeActionRepair({
    program: baseProgram,
    requestText: "Apply the compiler-owned fix for TS2552 in src/value.ts.",
    transformations: [{
      path: source.path,
      baseArtifactId: String(source.artifactId),
      baseContentHash: String(source.contentHash),
      diagnostic: { ...diagnostic, diagnosticIdentity },
      codeFix: { fixName, description, codeFixIdentity, textChanges },
      compiler: {
        version: "5.9.3",
        tsconfigPath: config.path,
        tsconfigContentHash: String(config.contentHash),
        compilerOptionsHash,
        compilerOptionsSource: "source_observed_tsc_project",
        configDiagnosticCodes: [],
        sourceFileBoundary: "workspace_snapshot_and_typescript_standard_library",
        compilerCommand: {
          executable: "tsc",
          args: ["-p", "tsconfig.json"],
          cwd: ".",
          sourcePath: commandSource.path,
          sourceContentHash: String(commandSource.contentHash)
        }
      }
    }],
    hasher
  });
  const snapshot = revision([
    current(source.path, before, "source"),
    current(config.path, configContent, "config"),
    current(commandSource.path, commandSourceContent, "config")
  ]);
  const input: Parameters<typeof generateWorkspacePatchPlanFromProgramGraph>[0] = {
    snapshot,
    expectedRevisionId: snapshot.revisionId,
    expectedRevisionHash: snapshot.revisionHash,
    request: {
      requestId: "request.compiler-repair.fixture",
      text: "Apply the compiler-owned fix for TS2552 in src/value.ts.",
      requestedPaths: [source.path],
      evidenceIds
    },
    program: repaired.program,
    existingDirectoryPaths: ["", "src"],
    verifiedAbsentPaths: [],
    validationPlan: {
      validatorId: "trusted-host-pnpm-validate.v1",
      checks: ["compiler", "typecheck", "tests"]
    }
  };
  return { input, after };
}

function tamperCompilerRepairLineage(
  program: ProgramGraph,
  mutate: (operation: Record<string, unknown>) => void
): ProgramGraph {
  let changed = false;
  const nodes = program.nodes
    .filter(node => node.kind !== "program_hydration_contract")
    .map(node => {
      if (node.kind !== "program_repair_full_file_materialization") return node;
      const metadata = recordForTest(JSON.parse(JSON.stringify(node.metadata)), "repair lineage metadata");
      const transformations = Array.isArray(metadata.transformations) ? metadata.transformations : [];
      const transformation = recordForTest(transformations[0], "repair transformation");
      const operations = Array.isArray(transformation.operations) ? transformation.operations : [];
      const operation = recordForTest(operations[0], "repair operation");
      mutate(operation);
      changed = true;
      return { ...node, metadata: toJsonValue(metadata) };
    });
  if (!changed) throw new Error("compiler repair fixture has no repair lineage operation");
  const { hydration: _hydration, ...programWithoutHydration } = program;
  const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
    ...programWithoutHydration,
    nodes,
    edges: program.edges.filter(edge => edge.relation !== "hydrates_as")
  };
  return {
    ...graphWithoutHydration,
    hydration: createProgramHydrationContract({
      program: graphWithoutHydration,
      sourcePlanId: "program-plan.compiler-repair.tampered",
      evidenceIds: program.hydration?.program.provenanceEvidenceIds ?? []
    })
  };
}

function recordForTest(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing`);
  return value as Record<string, unknown>;
}

function contractRecordsForTest(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("repair contracts are missing");
  return value.map((item, index) => recordForTest(item, `repair contract ${index}`));
}

function validInput(
  snapshot: ReturnType<typeof revision>,
  proposedFiles: GenerateWorkspacePatchPlanInput["proposedFiles"],
  requestedPaths = ["src/value.ts"]
): GenerateWorkspacePatchPlanInput {
  return {
    snapshot,
    expectedRevisionId: snapshot.revisionId,
    expectedRevisionHash: snapshot.revisionHash,
    proposedFiles,
    requestedPaths,
    assessment: {
      assessmentId: "assessment.fixture",
      evidenceIds: ["evidence.request.fixture", "evidence.program-graph.fixture"],
      requestedBehaviorCoverage: 1,
      dependencyConsistency: 1,
      architecturalFit: 1,
      explanationAccuracy: 1,
      fabricatedBehavior: 0
    },
    validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["compiler", "typecheck", "tests"] }
  };
}

function mediaType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  return "text/typescript";
}
