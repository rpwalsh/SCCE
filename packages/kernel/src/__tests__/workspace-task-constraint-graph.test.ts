import { describe, expect, it } from "vitest";
import { hashPatchContent } from "../patch-transaction.js";
import type { WorkspaceSemanticProgramObservation } from "../workspace-kernel-context.js";
import {
  buildWorkspaceTaskConstraintGraph,
  workspaceTaskConstraintEvidenceSpanId,
  type BuildWorkspaceTaskConstraintGraphInput,
  type WorkspaceConstraintEvidenceSpan,
  type WorkspaceConstraintSemanticProgram
} from "../workspace-task-constraint-graph.js";
import { createWorkspaceRevisionSnapshot, type WorkspaceRevisionFileInput } from "../workspace-plan-generator.js";

describe("workspace task constraint graph", () => {
  it("builds deterministic multi-file diagnostic context with exact config, test, and command dependencies", () => {
    const fixture = graphFixture();
    const input = taskInput(fixture);
    const first = buildWorkspaceTaskConstraintGraph(input);
    const second = buildWorkspaceTaskConstraintGraph({
      ...input,
      request: { ...input.request, text: "이 문장은 제약 조건으로 해석되지 않는다." }
    });

    expect(second).toEqual(first);
    expect(first.id).toMatch(/^task_constraint_graph_[0-9a-f]{40}$/u);
    expect(first.nodes.every(node => /^tc_node_[0-9a-f]{40}$/u.test(node.id))).toBe(true);
    expect(first.workspaceRevision).toEqual({
      workspaceId: fixture.revision.workspaceId,
      revisionId: fixture.revision.revisionId,
      revisionHash: fixture.revision.revisionHash
    });
    expect(first.analyzerRevision.semanticRevisionHash).toBe(fixture.observation.semanticRevisionHash);
    expect(first.execution).toEqual({ state: "not_executed" });
    expect(first.unresolvedConstraints).toEqual([]);

    const affectedPaths = pathsFor(first, first.affectedFileNodeIds);
    expect(affectedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(first.affectedSymbolNodeIds).toHaveLength(1);
    expect(first.diagnosticNodeIds).toHaveLength(1);
    expect(first.requestedOutcomeNodeIds).toHaveLength(1);
    expect(first.admissibleValidationCommandNodeIds).toHaveLength(2);
    expect(first.nodes.filter(node => node.kindId === "scce.task.dependency.config.v1")).toHaveLength(2);
    expect(first.nodes.filter(node => node.kindId === "scce.task.dependency.test.v1")).toHaveLength(1);
    expect(first.edges.map(edge => edge.relationId)).toEqual(expect.arrayContaining([
      "scce.rel.program.file_has_diagnostic.v1",
      "scce.rel.task.file_requires_config.v1",
      "scce.rel.task.target_has_test_dependency.v1",
      "scce.rel.task.request_requires_validation.v1"
    ]));
    expect(first.evidenceSpans.every(span => /^sha256:[0-9a-f]{64}$/u.test(span.contentHash)
      && /^sha256:[0-9a-f]{64}$/u.test(span.textHash))).toBe(true);
    expect((first.audit as { requestTextUsed?: boolean }).requestTextUsed).toBe(false);
  });

  it("leaves an explicitly requested test mutable unless preservation explicitly protects it", () => {
    const fixture = graphFixture();
    const testSpan = fixture.program.files.find(file => file.path === "test/a.test.ts")!.span;
    const graph = buildWorkspaceTaskConstraintGraph({
      revision: fixture.revision,
      observation: fixture.observation,
      request: {
        requestId: "request.protected",
        text: "arbitrary surface",
        requestedPaths: ["test/a.test.ts"],
        evidenceIds: ["evidence.protected"]
      },
      requestedOutcomes: [{
        id: "outcome.protected.opaque",
        postconditionId: "postcondition.protected.opaque",
        affectedPath: "test/a.test.ts",
        evidenceSpanIds: [workspaceTaskConstraintEvidenceSpanId(testSpan)]
      }],
      validationPlan: { validatorId: "validator.opaque", checks: ["tests"] },
      validationCommandBindings: [{ id: "binding.tests", checkId: "tests", commandId: "command.verify" }]
    });

    expect(graph.protectedInvariantNodeIds).toHaveLength(0);
    expect(graph.unresolvedConstraints).not.toContainEqual(expect.objectContaining({
      reasonId: "scce.constraint.reason.protected_target_conflict.v1",
      path: "test/a.test.ts"
    }));

    const protectedGraph = buildWorkspaceTaskConstraintGraph({
      revision: fixture.revision,
      observation: fixture.observation,
      request: {
        requestId: "request.protected",
        text: "arbitrary surface",
        requestedPaths: ["test/a.test.ts"],
        evidenceIds: ["evidence.protected"]
      },
      preservation: {
        protectedFilePaths: ["test/a.test.ts"],
        protectedSourcePaths: [],
        protectedEvidenceSpanIds: []
      },
      requestedOutcomes: [{
        id: "outcome.protected.opaque",
        postconditionId: "postcondition.protected.opaque",
        affectedPath: "test/a.test.ts",
        evidenceSpanIds: [workspaceTaskConstraintEvidenceSpanId(testSpan)]
      }],
      validationPlan: { validatorId: "validator.opaque", checks: ["tests"] },
      validationCommandBindings: [{ id: "binding.tests", checkId: "tests", commandId: "command.verify" }]
    });
    expect(protectedGraph.unresolvedConstraints).toContainEqual(expect.objectContaining({
      reasonId: "scce.constraint.reason.protected_target_conflict.v1",
      path: "test/a.test.ts"
    }));
    expect(protectedGraph.nodes.find(node => node.id === protectedGraph.protectedInvariantNodeIds[0])).toMatchObject({
      kindId: "scce.task.invariant.protected_file.v1",
      path: "test/a.test.ts",
      contentHashes: [fixture.revision.files.find(file => file.path === "test/a.test.ts")!.contentHash]
    });
  });

  it("refuses mismatched durable and analyzer revisions", () => {
    const fixture = graphFixture();
    const input = taskInput(fixture);
    const workspaceMismatch = {
      ...fixture.observation,
      workspaceRevision: { ...fixture.observation.workspaceRevision, revisionHash: hashPatchContent("forged workspace revision") }
    };
    expect(() => buildWorkspaceTaskConstraintGraph({ ...input, observation: workspaceMismatch }))
      .toThrow(/workspace revision does not match/u);

    const analyzerMismatch = {
      ...fixture.observation,
      semanticRevisionHash: hashPatchContent("forged analyzer revision")
    };
    expect(() => buildWorkspaceTaskConstraintGraph({ ...input, observation: analyzerMismatch }))
      .toThrow(/analyzer revision is mismatched/u);
  });
});

function taskInput(fixture: ReturnType<typeof graphFixture>): BuildWorkspaceTaskConstraintGraphInput {
  return {
    revision: fixture.revision,
    observation: fixture.observation,
    request: {
      requestId: "request.multi-file",
      text: "This prose is deliberately not a constraint source.",
      requestedPaths: ["src/b.ts"],
      evidenceIds: ["evidence.task.opaque"]
    },
    programContext: {
      patchPlans: [{
        plannerInputId: "planner.opaque",
        workspaceTaskId: "task.opaque",
        workspaceTaskRecordId: "task-record.opaque",
        affectedFiles: ["src/a.ts", "src/b.ts"],
        evidenceSpanIds: ["evidence.task.opaque"]
      }]
    },
    requestedOutcomes: [{
      id: "outcome.opaque",
      postconditionId: "postcondition.opaque",
      affectedPath: "src/b.ts",
      evidenceSpanIds: [workspaceTaskConstraintEvidenceSpanId(fixture.program.diagnostics[0]!.span!)]
    }],
    validationPlan: { validatorId: "validator.opaque", checks: ["compiler", "tests"] },
    validationCommandBindings: [
      { id: "binding.compiler", checkId: "compiler", commandId: "command.compile" },
      { id: "binding.tests", checkId: "tests", commandId: "command.verify" }
    ]
  };
}

function graphFixture(): {
  revision: ReturnType<typeof createWorkspaceRevisionSnapshot>;
  program: WorkspaceConstraintSemanticProgram;
  observation: WorkspaceSemanticProgramObservation<WorkspaceConstraintSemanticProgram>;
} {
  const content = {
    "package.json": JSON.stringify({ scripts: { compile: "tsc -p tsconfig.json", verify: "vitest run" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts", "test/**/*.ts"] }),
    "src/a.ts": "export function target(value: string): string { return value; }\n",
    "src/b.ts": "import { target } from \"./a.js\";\nexport const result: number = target(\"x\");\n",
    "test/a.test.ts": "import { target } from \"../src/a.js\";\nexport const observed = target(\"case\");\n"
  } as const;
  const revisionFiles: WorkspaceRevisionFileInput[] = Object.entries(content).map(([path, source]) => ({
    path,
    bytes: new TextEncoder().encode(source),
    mediaType: path.endsWith(".json") ? "application/json" : "text/typescript",
    role: path.startsWith("test/") ? "test" : path.endsWith(".json") ? "config" : "source"
  }));
  const revision = createWorkspaceRevisionSnapshot({
    workspaceId: "workspace.constraint.fixture",
    revisionId: "workspace.constraint.fixture:7",
    files: revisionFiles
  });
  const hashes = new Map(revision.files.map(file => [file.path, file.contentHash]));
  const full = (path: keyof typeof content) => exactSpan(path, content[path], hashes.get(path)!, 0, content[path].length);
  const token = (path: keyof typeof content, value: string, occurrence = 0) => {
    let start = -1;
    let cursor = 0;
    for (let index = 0; index <= occurrence; index += 1) {
      start = content[path].indexOf(value, cursor);
      if (start < 0) throw new Error(`fixture token is absent: ${path}:${value}`);
      cursor = start + value.length;
    }
    return exactSpan(path, content[path], hashes.get(path)!, start, value.length);
  };
  const files = ["package.json", "tsconfig.json", "src/a.ts", "src/b.ts", "test/a.test.ts"].map(path => ({
    id: `file.${path}`,
    path,
    contentHash: hashes.get(path)!,
    charLength: content[path as keyof typeof content].length,
    compilerOwned: path.endsWith(".ts"),
    observedTest: path === "test/a.test.ts",
    span: full(path as keyof typeof content)
  }));
  const configSpan = full("tsconfig.json");
  const targetDeclarationSpan = exactSpan("src/a.ts", content["src/a.ts"], hashes.get("src/a.ts")!, 0, content["src/a.ts"].length - 1);
  const targetNameSpan = token("src/a.ts", "target");
  const bTargetSpan = token("src/b.ts", "target", 1);
  const testTargetSpan = token("test/a.test.ts", "target", 1);
  const bCallSpan = token("src/b.ts", "target(\"x\")");
  const testCallSpan = token("test/a.test.ts", "target(\"case\")");
  const diagnosticSpan = token("src/b.ts", "result");
  const packageCompileName = token("package.json", JSON.stringify("compile"));
  const packageCompileCommand = token("package.json", JSON.stringify("tsc -p tsconfig.json"));
  const packageVerifyName = token("package.json", JSON.stringify("verify"));
  const packageVerifyCommand = token("package.json", JSON.stringify("vitest run"));
  const program: WorkspaceConstraintSemanticProgram = {
    revisionHash: hashPatchContent("semantic revision fixture"),
    config: { id: "config.ts", path: "tsconfig.json", contentHash: hashes.get("tsconfig.json")!, span: configSpan },
    files,
    symbols: [{ id: "symbol.target", declarationIds: ["declaration.target"] }],
    declarations: [{ id: "declaration.target", fileId: "file.src/a.ts", symbolId: "symbol.target", span: targetDeclarationSpan, nameSpan: targetNameSpan }],
    references: [
      { id: "reference.b.target", fileId: "file.src/b.ts", targetSymbolId: "symbol.target", declarationOccurrence: false, span: bTargetSpan },
      { id: "reference.test.target", fileId: "file.test/a.test.ts", targetSymbolId: "symbol.target", declarationOccurrence: false, span: testTargetSpan }
    ],
    imports: [
      { id: "import.b.a", fileId: "file.src/b.ts", targetFileId: "file.src/a.ts", span: full("src/b.ts"), moduleSpecifierSpan: token("src/b.ts", "\"./a.js\""), bindings: [] },
      { id: "import.test.a", fileId: "file.test/a.test.ts", targetFileId: "file.src/a.ts", span: full("test/a.test.ts"), moduleSpecifierSpan: token("test/a.test.ts", "\"../src/a.js\""), bindings: [] }
    ],
    calls: [
      { id: "call.b.target", fileId: "file.src/b.ts", targetSymbolId: "symbol.target", span: bCallSpan, calleeSpan: bTargetSpan },
      { id: "call.test.target", fileId: "file.test/a.test.ts", targetSymbolId: "symbol.target", span: testCallSpan, calleeSpan: testTargetSpan }
    ],
    diagnostics: [{
      id: "diagnostic.2322",
      compilerCode: 2322,
      compilerCategory: 1,
      originIds: ["typescript.diagnostic.origin.semantic.v1"],
      messageHash: hashPatchContent("diagnostic evidence"),
      span: diagnosticSpan
    }],
    configOwnership: ["src/a.ts", "src/b.ts", "test/a.test.ts"].map(path => ({
      id: `ownership.${path}`,
      configId: "config.ts",
      fileId: `file.${path}`,
      configSpan,
      fileSpan: full(path as keyof typeof content)
    })),
    commands: [
      { id: "command.compile", sourceFileId: "file.package.json", sourceNameEvidence: "compile", rawCommandEvidence: "tsc -p tsconfig.json", nameSpan: packageCompileName, commandSpan: packageCompileCommand },
      { id: "command.verify", sourceFileId: "file.package.json", sourceNameEvidence: "verify", rawCommandEvidence: "vitest run", nameSpan: packageVerifyName, commandSpan: packageVerifyCommand }
    ],
    testRelations: [{
      id: "test-relation.target",
      testFileId: "file.test/a.test.ts",
      targetFileId: "file.src/a.ts",
      targetSymbolId: "symbol.target",
      evidenceSpan: testCallSpan
    }]
  };
  const observation: WorkspaceSemanticProgramObservation<WorkspaceConstraintSemanticProgram> = {
    schema: "scce.workspace_kernel.semantic_program_observation.v1",
    id: "observation.constraint.fixture",
    workspace: { id: revision.workspaceId, corpusId: "corpus.constraint.fixture", rootPath: "/fixture" },
    workspaceRevision: {
      workspaceId: revision.workspaceId,
      revisionId: revision.revisionId,
      revisionHash: revision.revisionHash,
      workspaceUpdatedAt: 7
    },
    analyzer: { id: "analyzer.opaque", version: "revision.opaque" },
    semanticRevisionHash: program.revisionHash,
    program,
    execution: { state: "not_executed" },
    audit: {}
  };
  return { revision, program, observation };
}

function exactSpan(
  path: string,
  content: string,
  contentHash: string,
  start: number,
  length: number
): WorkspaceConstraintEvidenceSpan {
  const end = start + length;
  const startLocation = lineColumn(content, start);
  const endLocation = lineColumn(content, end);
  return {
    path,
    contentHash,
    start,
    length,
    end,
    startLine: startLocation.line,
    startColumn: startLocation.column,
    endLine: endLocation.line,
    endColumn: endLocation.column,
    textHash: hashPatchContent(content.slice(start, end))
  };
}

function lineColumn(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < position; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

function pathsFor(graph: ReturnType<typeof buildWorkspaceTaskConstraintGraph>, ids: readonly string[]): string[] {
  const selected = new Set(ids);
  return graph.nodes.filter(node => selected.has(node.id)).map(node => node.path).filter((path): path is string => Boolean(path)).sort();
}
