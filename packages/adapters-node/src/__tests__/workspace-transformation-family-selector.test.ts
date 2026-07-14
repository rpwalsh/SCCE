import { describe, expect, it } from "vitest";
import {
  TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
  WORKSPACE_TRANSFORMATION_REJECTION,
  buildWorkspaceTaskConstraintGraph,
  canonicalTypeScriptCodeActionPostconditionBindingId,
  canonicalTypeScriptCodeFixIdentity,
  canonicalWorkspaceCompilerCandidateSetId,
  createWorkspaceRevisionSnapshot,
  hashPatchContent,
  selectWorkspaceTransformationFamily,
  workspaceTaskConstraintEvidenceSpanId,
  type BuildWorkspaceTaskConstraintGraphInput,
  type WorkspaceCompilerCodeActionTransformation,
  type WorkspaceCompilerTransformationFamily,
  type WorkspaceConstraintEvidenceSpan,
  type WorkspaceConstraintSemanticProgram,
  type WorkspaceRevisionFileInput,
  type WorkspaceSemanticProgramObservation,
  type WorkspaceTaskConstraintGraph
} from "@scce/kernel";
import {
  deriveTypeScriptCodeActionCandidates,
  type TypeScriptCodeActionCandidateSet,
  type TypeScriptCodeActionSnapshotFile,
  type TypeScriptCodeActionTransformation
} from "../typescript-code-actions.js";

describe("workspace transformation-family selector", () => {
  it("selects a real cross-file compiler fix as an exact unexecuted patch transaction", () => {
    const fixture = selectorFixture();
    expect(fixture.candidateSet.snapshotHash).toBe(hashPatchContent([...fixture.revision.files]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      .map(file => `${file.path}\u0000${file.contentHash.slice("sha256:".length)}`)
      .join("\u0000")));
    const result = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [familyFor(fixture)]
    });

    expect(result.rejectedCandidates).toEqual([]);
    expect(result.selected).toMatchObject({
      familyId: TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
      codeFixIdentity: fixture.candidate.codeFixIdentity,
      diagnosticIdentity: fixture.candidate.diagnosticIdentity,
      diagnosticNodeId: fixture.graph.diagnosticNodeIds[0],
      execution: { state: "not_executed" }
    });
    expect(result.selected?.patchPlan.operations).toEqual([expect.objectContaining({
      kind: "replace",
      path: "src/a.ts",
      beforeContentHash: fixture.hashes.get("src/a.ts"),
      content: "export const hidden = 1;\nexport const visible = 2;\n"
    })]);
    expect(result.selected?.edits).toEqual([expect.objectContaining({
      path: "src/a.ts",
      beforeContentHash: fixture.hashes.get("src/a.ts"),
      span: expect.objectContaining({ start: 0, length: 0, end: 0 }),
      diagnosticEvidenceSpanIds: [workspaceTaskConstraintEvidenceSpanId(fixture.diagnosticSpan)],
      symbolEvidenceSpanIds: expect.arrayContaining([workspaceTaskConstraintEvidenceSpanId(fixture.hiddenDeclarationNameSpan)]),
      expectedPostconditionIds: [fixture.postconditionId]
    })]);
    expect(result.rejectedCandidates).toEqual([]);
    expect(result.unresolvedOutcomes).toEqual([]);
  });

  it("refuses an exact edit to a protected test invariant", () => {
    const fixture = selectorFixture();
    const protectedCandidate = candidateWithInsertion(
      fixture,
      fixture.candidate,
      "test/a.test.ts",
      0,
      "/*protected*/ "
    );
    const result = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [familyFor(fixture, [protectedCandidate])]
    });

    expect(result.selected).toBeNull();
    expect(result.rejectedCandidates[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.PROTECTED_INVARIANT);
    expect(result.graphUnresolvedConstraints).toEqual([]);
    expect(result.unresolvedOutcomes[0]?.postconditionId).toBe(fixture.postconditionId);
  });

  it("refuses a family derived from a stale workspace snapshot", () => {
    const fixture = selectorFixture();
    const result = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [{ ...familyFor(fixture), snapshotHash: hashPatchContent("stale revision") }]
    });

    expect(result.selected).toBeNull();
    expect(result.rejectedCandidates[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.SNAPSHOT_STALE);
    expect(result.unresolvedOutcomes[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.NO_ADMISSIBLE_FAMILY);
  });

  it("keeps conflicting exact compiler-family alternatives unresolved", () => {
    const fixture = selectorFixture();
    const alternate = candidateWithInsertion(fixture, fixture.candidate, "src/a.ts", 0, "export /*alternate*/ ");
    const result = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [familyFor(fixture, [fixture.candidate, alternate])]
    });

    expect(result.selected).toBeNull();
    expect(result.rejectedCandidates).toHaveLength(2);
    expect(result.rejectedCandidates.every(candidate => candidate.reasonIds.includes(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_CONFLICT))).toBe(true);
    expect(result.admissibleCandidateIds).toEqual([]);
    expect(result.unresolvedOutcomes[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_CONFLICT);
  });

  it("selects deterministically across duplicate candidate ordering", () => {
    const fixture = selectorFixture();
    const family = familyFor(fixture, [fixture.candidate, fixture.candidate]);
    const forward = selectWorkspaceTransformationFamily({ graph: fixture.graph, revision: fixture.revision, families: [family] });
    const reverse = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [{ ...family, transformations: [...family.transformations].reverse() }]
    });

    expect(reverse).toEqual(forward);
    expect(forward.selected?.candidateId).toBe(fixture.candidate.codeFixIdentity);
    expect(forward.admissibleCandidateIds).toEqual([fixture.candidate.codeFixIdentity]);
  });

  it("preserves the requested outcome when no transformation family is admissible", () => {
    const fixture = selectorFixture();
    const result = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [{ ...familyFor(fixture), familyId: "repair.family.unobserved.v1" }]
    });

    expect(result.selected).toBeNull();
    expect(result.rejectedCandidates[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.FAMILY_UNSUPPORTED);
    expect(result.unresolvedOutcomes).toEqual([expect.objectContaining({
      outcomeNodeId: fixture.graph.requestedOutcomeNodeIds[0],
      postconditionId: fixture.postconditionId,
      candidateIds: [fixture.candidate.codeFixIdentity],
      reasonIds: expect.arrayContaining([
        WORKSPACE_TRANSFORMATION_REJECTION.FAMILY_UNSUPPORTED,
        WORKSPACE_TRANSFORMATION_REJECTION.NO_ADMISSIBLE_FAMILY
      ])
    })]);
  });

  it("never selects from a truncated candidate universe", () => {
    const fixture = selectorFixture();
    const base = familyFor(fixture);
    const family = rebindFamily({
      ...base,
      availableCandidateCount: base.availableCandidateCount + 1,
      truncated: true,
      complete: false
    });
    const result = selectWorkspaceTransformationFamily({ graph: fixture.graph, revision: fixture.revision, families: [family] });
    expect(result.selected).toBeNull();
    expect(result.rejectedCandidates[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_UNIVERSE_INCOMPLETE);
  });

  it("rejects analyzer bindings that do not match the semantic graph", () => {
    const fixture = selectorFixture();
    const base = familyFor(fixture);
    const family = rebindFamily({
      ...base,
      analyzer: { ...base.analyzer, compilerOptionsHash: hashPatchContent("different compiler options") }
    });
    const result = selectWorkspaceTransformationFamily({ graph: fixture.graph, revision: fixture.revision, families: [family] });
    expect(result.selected).toBeNull();
    expect(result.rejectedCandidates[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.ANALYZER_STALE);
  });

  it("rejects mutable postcondition labels outside the canonical code-fix binding", () => {
    const fixture = selectorFixture();
    const candidate = { ...fixture.candidate, postconditionIds: [...fixture.candidate.postconditionIds, "postcondition.forged"] };
    const result = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [familyFor(fixture, [candidate])]
    });
    expect(result.selected).toBeNull();
    expect(result.rejectedCandidates[0]?.reasonIds).toContain(WORKSPACE_TRANSFORMATION_REJECTION.POSTCONDITION_UNBOUND);
  });

  it("rejects graph-index and non-integer evidence tampering", () => {
    const fixture = selectorFixture();
    expect(() => selectWorkspaceTransformationFamily({
      graph: { ...fixture.graph, protectedInvariantNodeIds: [] },
      revision: fixture.revision,
      families: [familyFor(fixture)]
    })).toThrow(/graph identity is invalid/u);
    const first = fixture.graph.evidenceSpans[0]!;
    expect(() => selectWorkspaceTransformationFamily({
      graph: { ...fixture.graph, evidenceSpans: [{ ...first, start: 0.5, end: first.length + 0.5 }, ...fixture.graph.evidenceSpans.slice(1)] },
      revision: fixture.revision,
      families: [familyFor(fixture)]
    })).toThrow(/outside exact source/u);
  });

  it("keeps identical bytes with different compiler proof lineages ambiguous", () => {
    const fixture = selectorFixture();
    const alternate = candidateWithDescription(fixture.candidate, `${fixture.candidate.codeFix.description} alternate`);
    const result = selectWorkspaceTransformationFamily({
      graph: fixture.graph,
      revision: fixture.revision,
      families: [familyFor(fixture, [fixture.candidate, alternate])]
    });
    expect(result.selected).toBeNull();
    expect(result.admissibleCandidateIds).toEqual([]);
    expect(result.rejectedCandidates.every(candidate => candidate.reasonIds.includes(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_AMBIGUITY))).toBe(true);
  });
});

interface SelectorFixture {
  content: Record<string, string>;
  hashes: Map<string, string>;
  revision: ReturnType<typeof createWorkspaceRevisionSnapshot>;
  candidateSet: TypeScriptCodeActionCandidateSet;
  candidate: TypeScriptCodeActionTransformation;
  graph: WorkspaceTaskConstraintGraph;
  diagnosticSpan: WorkspaceConstraintEvidenceSpan;
  hiddenDeclarationNameSpan: WorkspaceConstraintEvidenceSpan;
  postconditionId: string;
}

function selectorFixture(): SelectorFixture {
  const content: Record<string, string> = {
    "package.json": JSON.stringify({ name: "selector-fixture", scripts: { build: "tsc -p tsconfig.json" } }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" },
      include: ["src/**/*.ts", "test/**/*.ts"]
    }),
    "src/a.ts": "const hidden = 1;\nexport const visible = 2;\n",
    "src/b.ts": "import { hidden } from \"./a\";\nexport const value = hidden;\n",
    "test/a.test.ts": "import { visible } from \"../src/a\";\nexport const observed = visible;\n",
    "자료/zeta.txt": "z\n",
    "資料/é.txt": "e\n"
  };
  const revisionInput: WorkspaceRevisionFileInput[] = Object.entries(content).map(([path, source]) => ({
    path,
    bytes: new TextEncoder().encode(source),
    mediaType: path.endsWith(".json") ? "application/json" : "text/typescript",
    role: path.startsWith("test/") ? "test" : path.endsWith(".json") ? "config" : "source"
  }));
  revisionInput.push({
    path: "assets/opaque.bin",
    bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
    mediaType: "application/octet-stream",
    role: "doc"
  });
  const revision = createWorkspaceRevisionSnapshot({
    workspaceId: "workspace.selector.fixture",
    revisionId: "workspace.selector.fixture:1",
    files: revisionInput
  });
  const hashes = new Map(revision.files.map(file => [file.path, file.contentHash]));
  const snapshotFiles: TypeScriptCodeActionSnapshotFile[] = Object.entries(content).map(([path, source]) => ({
    path,
    content: source,
    contentHash: hashes.get(path)!
  }));
  const semanticRevisionHash = hashPatchContent(`semantic:${revision.revisionHash}`);
  const candidateSet = deriveTypeScriptCodeActionCandidates({
    rootPath: "C:/virtual/selector-fixture",
    requestedPaths: ["src/b.ts"],
    files: snapshotFiles,
    workspaceManifest: revision.files.map(file => ({ path: file.path, contentHash: file.contentHash })),
    semanticAnalyzer: {
      analyzerId: "analyzer.typescript",
      semanticRevisionHash
    },
    compilerCommand: { executable: "tsc", args: ["-p", "tsconfig.json"], cwd: ".", sourcePath: "package.json" }
  });
  if (!candidateSet) throw new Error("compiler candidate fixture is absent");
  const candidate = candidateSet.transformations.find(item => item.diagnostic.code === 2459 && item.codeFix.fixName === "fixImportNonExportedMember");
  if (!candidate) throw new Error("cross-file compiler candidate fixture is absent");

  const full = (path: string) => exactSpan(path, content[path]!, hashes.get(path)!, 0, content[path]!.length);
  const token = (path: string, value: string, occurrence = 0) => {
    let start = -1;
    let cursor = 0;
    for (let index = 0; index <= occurrence; index += 1) {
      start = content[path]!.indexOf(value, cursor);
      if (start < 0) throw new Error("fixture token is absent");
      cursor = start + value.length;
    }
    return exactSpan(path, content[path]!, hashes.get(path)!, start, value.length);
  };
  const diagnosticSpan = exactSpan(
    candidate.path,
    content[candidate.path]!,
    hashes.get(candidate.path)!,
    candidate.diagnostic.start,
    candidate.diagnostic.length
  );
  const hiddenDeclarationNameSpan = token("src/a.ts", "hidden");
  const files = Object.keys(content).map(path => ({
    id: `file.${path}`,
    path,
    contentHash: hashes.get(path)!,
    charLength: content[path]!.length,
    compilerOwned: path.endsWith(".ts"),
    observedTest: path.startsWith("test/"),
    span: full(path)
  }));
  const configSpan = full("tsconfig.json");
  const program: WorkspaceConstraintSemanticProgram = {
    revisionHash: semanticRevisionHash,
    config: {
      id: "config.ts",
      path: "tsconfig.json",
      contentHash: hashes.get("tsconfig.json")!,
      compilerVersion: candidateSet.analyzer.analyzerVersion,
      compilerOptionsHash: candidateSet.analyzer.compilerOptionsHash,
      span: configSpan
    },
    files,
    symbols: [{ id: "symbol.hidden", declarationIds: ["declaration.hidden"] }],
    declarations: [{
      id: "declaration.hidden",
      fileId: "file.src/a.ts",
      symbolId: "symbol.hidden",
      span: exactSpan("src/a.ts", content["src/a.ts"]!, hashes.get("src/a.ts")!, 0, content["src/a.ts"]!.indexOf("\n")),
      nameSpan: hiddenDeclarationNameSpan
    }],
    references: [{
      id: "reference.b.hidden",
      fileId: "file.src/b.ts",
      targetSymbolId: "symbol.hidden",
      declarationOccurrence: false,
      span: diagnosticSpan
    }],
    imports: [{
      id: "import.b.a",
      fileId: "file.src/b.ts",
      targetFileId: "file.src/a.ts",
      span: exactSpan("src/b.ts", content["src/b.ts"]!, hashes.get("src/b.ts")!, 0, content["src/b.ts"]!.indexOf("\n")),
      moduleSpecifierSpan: token("src/b.ts", "\"./a\""),
      bindings: [{ span: diagnosticSpan, targetSymbolId: "symbol.hidden" }]
    }],
    calls: [],
    diagnostics: [{
      id: "diagnostic.compiler.2459",
      compilerCode: candidate.diagnostic.code,
      compilerCategory: compilerCategoryCode(candidate.diagnostic.category),
      originIds: [candidate.diagnosticIdentity],
      rawMessageEvidence: candidate.diagnostic.message,
      messageHash: hashPatchContent(candidate.diagnostic.message),
      span: diagnosticSpan
    }],
    configOwnership: ["src/a.ts", "src/b.ts", "test/a.test.ts"].map(path => ({
      id: `ownership.${path}`,
      configId: "config.ts",
      fileId: `file.${path}`,
      configSpan,
      fileSpan: full(path)
    })),
    commands: [{
      id: "command.build",
      sourceFileId: "file.package.json",
      sourceNameEvidence: "build",
      rawCommandEvidence: "tsc -p tsconfig.json",
      nameSpan: token("package.json", '"build"'),
      commandSpan: token("package.json", '"tsc -p tsconfig.json"')
    }],
    testRelations: []
  };
  const observation: WorkspaceSemanticProgramObservation<WorkspaceConstraintSemanticProgram> = {
    schema: "scce.workspace_kernel.semantic_program_observation.v1",
    id: "observation.selector.fixture",
    workspace: { id: revision.workspaceId, corpusId: "corpus.selector.fixture", rootPath: "/fixture" },
    workspaceRevision: {
      workspaceId: revision.workspaceId,
      revisionId: revision.revisionId,
      revisionHash: revision.revisionHash,
      workspaceUpdatedAt: 1
    },
    analyzer: { id: candidateSet.analyzer.analyzerId, version: candidateSet.analyzer.analyzerVersion },
    semanticRevisionHash: program.revisionHash,
    program,
    execution: { state: "not_executed" },
    audit: {}
  };
  const postconditionId = candidate.postconditionIds[0]!;
  const graphInput: BuildWorkspaceTaskConstraintGraphInput = {
    revision,
    observation,
    request: {
      requestId: "request.selector.fixture",
      text: "ignored",
      requestedPaths: ["src/b.ts"],
      evidenceIds: ["evidence.selector.fixture"]
    },
    programContext: {
      patchPlans: [{
        plannerInputId: "planner.selector.fixture",
        workspaceTaskId: "task.selector.fixture",
        workspaceTaskRecordId: "task-record.selector.fixture",
        affectedFiles: ["src/a.ts", "src/b.ts"],
        evidenceSpanIds: ["evidence.selector.fixture"]
      }]
    },
    requestedOutcomes: [{
      id: "outcome.selector.fixture",
      postconditionId,
      affectedPath: "src/b.ts",
      evidenceSpanIds: [workspaceTaskConstraintEvidenceSpanId(diagnosticSpan)]
    }],
    validationPlan: { validatorId: "validator.selector.fixture", checks: ["compiler"] },
    validationCommandBindings: [{ id: "binding.compiler", checkId: "compiler", commandId: "command.build" }]
  };
  const graph = buildWorkspaceTaskConstraintGraph(graphInput);
  if (graph.unresolvedConstraints.length > 0) throw new Error("selector graph fixture is unresolved");
  return { content, hashes, revision, candidateSet, candidate, graph, diagnosticSpan, hiddenDeclarationNameSpan, postconditionId };
}

function familyFor(
  fixture: SelectorFixture,
  transformations: readonly WorkspaceCompilerCodeActionTransformation[] = [fixture.candidate]
): WorkspaceCompilerTransformationFamily {
  const contract = {
    familyId: fixture.candidateSet.familyId,
    snapshotHash: fixture.candidateSet.snapshotHash,
    analyzedSnapshotHash: fixture.candidateSet.analyzedSnapshotHash,
    availableCandidateCount: transformations.length,
    truncated: false,
    complete: true,
    analyzer: fixture.candidateSet.analyzer,
    transformations
  };
  return { ...contract, candidateSetId: canonicalWorkspaceCompilerCandidateSetId(contract) };
}

function rebindFamily(family: WorkspaceCompilerTransformationFamily): WorkspaceCompilerTransformationFamily {
  const { candidateSetId: _candidateSetId, ...contract } = family;
  return { ...contract, candidateSetId: canonicalWorkspaceCompilerCandidateSetId(contract) };
}

function candidateWithDescription(
  candidate: TypeScriptCodeActionTransformation,
  description: string
): TypeScriptCodeActionTransformation {
  const codeFix = { ...candidate.codeFix, description };
  const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({ diagnosticIdentity: candidate.diagnosticIdentity, codeFix }) as `typescript.code_fix:${string}`;
  const postconditionBindingId = canonicalTypeScriptCodeActionPostconditionBindingId(codeFixIdentity, candidate.diagnostic.code) as `typescript.code_fix_postconditions:${string}`;
  return { ...candidate, codeFix, codeFixIdentity, postconditionBindingId };
}

function candidateWithInsertion(
  fixture: SelectorFixture,
  candidate: TypeScriptCodeActionTransformation,
  path: string,
  start: number,
  newText: string
): TypeScriptCodeActionTransformation {
  const before = fixture.content[path]!;
  const afterContent = before.slice(0, start) + newText + before.slice(start);
  const fileChanges = [{
    path,
    isNewFile: false,
    baseContentHash: fixture.hashes.get(path)!,
    textChanges: [{ start, length: 0, newText }],
    afterContent,
    afterContentHash: hashPatchContent(afterContent)
  }];
  const codeFix = {
    ...candidate.codeFix,
    textChanges: [],
    fileChanges
  };
  const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
    diagnosticIdentity: candidate.diagnosticIdentity,
    codeFix
  }) as `typescript.code_fix:${string}`;
  const postconditionBindingId = canonicalTypeScriptCodeActionPostconditionBindingId(codeFixIdentity, candidate.diagnostic.code) as `typescript.code_fix_postconditions:${string}`;
  return { ...candidate, codeFix, codeFixIdentity, postconditionBindingId };
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

function compilerCategoryCode(value: string): number {
  if (value === "warning") return 0;
  if (value === "error") return 1;
  if (value === "suggestion") return 2;
  if (value === "message") return 3;
  throw new Error("unexpected compiler category");
}
