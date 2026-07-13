import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { hashPatchContent } from "../patch-transaction.js";
import { createProgramHydrationContract } from "../program-runtime.js";
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
