import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { createProgramHydrationContract, hydrationSummary } from "../program-runtime.js";
import {
  SUPPORTED_PROGRAM_REPAIR_FAMILIES,
  TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
  UNUSED_TYPE_IMPORT_REPAIR_FAMILY,
  canonicalTypeScriptCompilerOptionsHash,
  canonicalTypeScriptCodeFixIdentity,
  canonicalTypeScriptDiagnosticIdentity,
  materializeProgramRepair,
  materializeTypeScriptCodeActionRepair
} from "../program-repair-kernel.js";
import type { ArtifactId, ContentHash, FileArtifact, ProgramGraph } from "../types.js";

describe("program repair full-file materialization", () => {
  it("turns a source-bound virtual repair into rehashed full-file ProgramGraph artifacts", () => {
    const hasher = createHasher();
    const source = artifact("src/index.ts", "export const value = (1;\n", hasher);
    const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
      id: "program.repair.fixture",
      language: "typescript",
      packageManager: "pnpm",
      entrypoint: source.path,
      nodes: [{ id: `artifact:${source.path}`, kind: "artifact:source", label: source.path, metadata: { contentHash: source.contentHash } }],
      edges: [],
      files: [source],
      build: { command: "pnpm", args: ["build"], cwd: "." },
      test: { command: "pnpm", args: ["test"], cwd: "." }
    };
    const hydration = createProgramHydrationContract({
      program: graphWithoutHydration,
      sourcePlanId: "program-plan.repair.fixture",
      evidenceIds: ["evidence.repair.fixture"]
    });
    const program: ProgramGraph = {
      ...graphWithoutHydration,
      hydration,
      nodes: [
        ...graphWithoutHydration.nodes,
        { id: "program-hydration", kind: "program_hydration_contract", label: hydration.schema, metadata: hydrationSummary(hydration) }
      ],
      edges: [{ source: "program-plan.repair.fixture", target: "program-hydration", relation: "hydrates_as", weight: 1 }]
    };

    const diagnosticInput = {
      program,
      stderr: "src/index.ts:1:20 syntax error: missing closing delimiter",
      requestText: "Repair the observed syntax error.",
      hasher
    };
    const result = materializeProgramRepair(diagnosticInput);

    expect(result.changedPaths).toEqual([source.path]);
    expect(result.program.files[0]?.content).not.toBe(source.content);
    expect(result.program.files[0]?.contentHash).not.toBe(source.contentHash);
    expect(result.program.hydration?.program.provenanceEvidenceIds).toEqual(["evidence.repair.fixture"]);
    expect(result.program.hydration?.valid).toBe(true);
    expect(result.program.nodes.find(node => node.id === `artifact:${source.path}`)?.metadata)
      .toMatchObject({ contentHash: result.program.files[0]?.contentHash });
    expect(result.program.nodes.filter(node => node.kind === "program_hydration_contract")).toHaveLength(1);
    expect(result.program.nodes.find(node => node.kind === "program_hydration_contract")?.metadata)
      .not.toMatchObject({ source: "stale" });
    expect(result.trace).toMatchObject({
      schema: "scce.program_repair.full_file_materialization.v1",
      sourceProgramId: program.id,
      mutatesRealWorkspace: false,
      validationState: "not_executed"
    });
    expect(result.program.nodes.find(node => node.kind === "program_repair_full_file_materialization")?.metadata)
      .toMatchObject({ schema: "scce.program_repair.full_file_lineage.v1" });

    expect(() => materializeProgramRepair({ ...diagnosticInput, patchSetId: "patchset_forged_arbitrary_bytes" }))
      .toThrow(/internally recomputed repair plan/u);
  });

  it("removes one source-proven unused type-only import while preserving exact CRLF bytes", () => {
    const hasher = createHasher();
    const source = artifact(
      "src/index.ts",
      "import type { Legacy } from \"./legacy.js\";\r\nexport const value = 1;\r\n",
      hasher
    );
    const base = hydratedProgram(source, hasher);

    const result = materializeProgramRepair({
      program: base,
      requestText: "Remove unused type import Legacy from src/index.ts.",
      hasher
    });

    expect(result.changedPaths).toEqual(["src/index.ts"]);
    expect(result.program.files[0]?.content).toBe("export const value = 1;\r\n");
    expect(result.program.nodes.find(node => node.kind === "program_repair_full_file_materialization")?.metadata)
      .toMatchObject({
        schema: "scce.program_repair.full_file_lineage.v1",
        transformations: [{
          operations: [{
            kind: "delete",
            repairFamilyId: UNUSED_TYPE_IMPORT_REPAIR_FAMILY,
            postconditions: expect.arrayContaining([
              { id: "repair.postcondition.typecheck_required", value: "typecheck" }
            ])
          }]
        }]
      });
    expect(SUPPORTED_PROGRAM_REPAIR_FAMILIES).toContainEqual(expect.objectContaining({
      id: UNUSED_TYPE_IMPORT_REPAIR_FAMILY,
      requiredValidationChecks: ["typecheck"]
    }));

    expect(() => materializeProgramRepair({
      program: base,
      requestText: "Remove unused type import Other from src/index.ts.",
      hasher
    })).toThrow(/without exact file content/u);
    const used = artifact(
      "src/index.ts",
      "import type { Legacy } from \"./legacy.js\";\nexport const value: Legacy | null = null;\n",
      hasher
    );
    expect(() => materializeProgramRepair({
      program: hydratedProgram(used, hasher),
      requestText: "Remove unused type import Legacy from src/index.ts.",
      hasher
    })).toThrow(/without exact file content/u);
  });

  it("recomputes compiler code-action output from exact bounded text changes", () => {
    const hasher = createHasher();
    const source = artifact("src/index.ts", "export const value: string = 1;\n", hasher);
    const program = hydratedProgram(source, hasher);
    const config = program.files.find(file => file.path === "tsconfig.json")!;
    const commandSource = program.files.find(file => file.path === "package.json")!;
    const start = source.content.indexOf("string");
    const diagnostic = {
      code: 2322,
      category: "error",
      start,
      length: "string".length,
      message: "Type 'number' is not assignable to type 'string'."
    };
    const compilerOptionsHash = canonicalTypeScriptCompilerOptionsHash({ noEmit: true, strict: true }, hasher);
    const compilerVersion = "5.9.3";
    const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
      path: source.path,
      diagnostic,
      compilerVersion,
      compilerOptionsHash
    }, hasher);
    const textChanges = [{ start, length: "string".length, newText: "number" }];
    const transformation = {
      path: source.path,
      baseArtifactId: String(source.artifactId),
      baseContentHash: String(source.contentHash),
      diagnostic: { ...diagnostic, diagnosticIdentity },
      codeFix: {
        fixName: "changeTypeAnnotation",
        description: "Change the type annotation to number",
        codeFixIdentity: canonicalTypeScriptCodeFixIdentity({
          diagnosticIdentity,
          codeFix: {
            fixName: "changeTypeAnnotation",
            description: "Change the type annotation to number",
            textChanges
          }
        }, hasher),
        textChanges
      },
      compiler: {
        version: compilerVersion,
        tsconfigPath: config.path,
        tsconfigContentHash: String(config.contentHash),
        compilerOptionsHash,
        compilerOptionsSource: "source_observed_tsc_project",
        configDiagnosticCodes: [],
        sourceFileBoundary: "workspace_snapshot_and_typescript_standard_library" as const,
        compilerCommand: {
          executable: "tsc",
          args: ["-p", "tsconfig.json"],
          cwd: ".",
          sourcePath: commandSource.path,
          sourceContentHash: String(commandSource.contentHash)
        }
      }
    };

    const result = materializeTypeScriptCodeActionRepair({
      program,
      transformations: [transformation],
      requestText: "Fix the observed TypeScript error in src/index.ts.",
      hasher
    });

    expect(result.program.files[0]?.content).toBe("export const value: number = 1;\n");
    expect(result.program.nodes.find(node => node.kind === "program_repair_full_file_materialization")?.metadata)
      .toMatchObject({
        transformations: [{
          operations: [{
            repairFamilyId: TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
            codeFixEvidence: {
              fixName: transformation.codeFix.fixName,
              description: transformation.codeFix.description,
              codeFixIdentity: transformation.codeFix.codeFixIdentity
            },
            preconditions: expect.arrayContaining([
              { id: "repair.precondition.typescript_code_fix_identity", value: transformation.codeFix.codeFixIdentity },
              { id: "repair.precondition.tsconfig_content_hash", value: transformation.compiler.tsconfigContentHash },
              { id: "repair.precondition.compiler_command_source_content_hash", value: transformation.compiler.compilerCommand.sourceContentHash }
            ])
          }]
        }]
      });
    expect(() => materializeTypeScriptCodeActionRepair({
      program,
      transformations: [{
        ...transformation,
        codeFix: { ...transformation.codeFix, description: "tampered description" }
      }],
      requestText: "Fix the observed TypeScript error in src/index.ts.",
      hasher
    })).toThrow(/code-action identity is not canonical/u);
    expect(() => materializeTypeScriptCodeActionRepair({
      program,
      transformations: [{
        ...transformation,
        compiler: { ...transformation.compiler, tsconfigContentHash: "" }
      }],
      requestText: "Fix the observed TypeScript error in src/index.ts.",
      hasher
    })).toThrow(/config content hash is required/u);
    expect(() => materializeTypeScriptCodeActionRepair({
      program,
      transformations: [{
        ...transformation,
        compiler: {
          ...transformation.compiler,
          compilerCommand: {
            ...transformation.compiler.compilerCommand,
            sourceContentHash: `sha256_${"0".repeat(64)}`
          }
        }
      }],
      requestText: "Fix the observed TypeScript error in src/index.ts.",
      hasher
    })).toThrow(/compiler command is not bound to an exact ProgramGraph artifact/u);
    expect(() => materializeTypeScriptCodeActionRepair({
      program,
      transformations: [{
        ...transformation,
        codeFix: {
          ...transformation.codeFix,
          textChanges: [
            { start, length: 6, newText: "number" },
            { start: start + 2, length: 1, newText: "x" }
          ]
        }
      }],
      requestText: "Fix the observed TypeScript error in src/index.ts.",
      hasher
    })).toThrow(/overlap/u);
  });

  it("materializes one canonical atomic action across replacements and an absent new source", () => {
    const hasher = createHasher();
    const diagnosticSource = artifact("src/index.ts", "export const value: string = 1;\n", hasher);
    const peer = artifact("src/peer.ts", "export const peer = 1;\n", hasher);
    const program = hydratedProgram(diagnosticSource, hasher, [peer]);
    const config = program.files.find(file => file.path === "tsconfig.json")!;
    const commandSource = program.files.find(file => file.path === "package.json")!;
    const diagnostic = {
      code: 2322,
      category: "error",
      start: diagnosticSource.content.indexOf("string"),
      length: "string".length,
      message: "Type 'number' is not assignable to type 'string'."
    };
    const compilerOptionsHash = canonicalTypeScriptCompilerOptionsHash({ noEmit: true, strict: true }, hasher);
    const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
      path: diagnosticSource.path,
      diagnostic,
      compilerVersion: "5.9.3",
      compilerOptionsHash
    }, hasher);
    const fileChanges = [{
      path: diagnosticSource.path,
      isNewFile: false,
      baseArtifactId: String(diagnosticSource.artifactId),
      baseContentHash: String(diagnosticSource.contentHash),
      textChanges: [{ start: diagnostic.start, length: diagnostic.length, newText: "number" }],
      mediaType: diagnosticSource.mediaType,
      role: diagnosticSource.role
    }, {
      path: peer.path,
      isNewFile: false,
      baseArtifactId: String(peer.artifactId),
      baseContentHash: String(peer.contentHash),
      textChanges: [{ start: peer.content.length, length: 0, newText: "export const repaired = true;\n" }],
      mediaType: peer.mediaType,
      role: peer.role
    }, {
      path: "src/generated.ts",
      isNewFile: true,
      baseArtifactId: null,
      baseContentHash: null,
      textChanges: [{ start: 0, length: 0, newText: "export const generated = true;\n" }],
      mediaType: "text/typescript",
      role: "source" as const
    }];
    const fixName = "atomicCompilerAction";
    const description = "Apply the compiler-owned atomic repair";
    const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
      diagnosticIdentity,
      codeFix: { fixName, description, fileChanges }
    }, hasher);
    const transformation = {
      path: diagnosticSource.path,
      baseArtifactId: String(diagnosticSource.artifactId),
      baseContentHash: String(diagnosticSource.contentHash),
      snapshotHash: `sha256:${hasher.digestHex("exact compiler snapshot")}`,
      diagnostic: { ...diagnostic, diagnosticIdentity },
      codeFix: { fixName, description, codeFixIdentity, fileChanges },
      compiler: {
        version: "5.9.3",
        tsconfigPath: config.path,
        tsconfigContentHash: String(config.contentHash),
        compilerOptionsHash,
        compilerOptionsSource: "source_observed_tsc_project",
        configDiagnosticCodes: [],
        sourceFileBoundary: "workspace_snapshot_and_typescript_standard_library" as const,
        compilerCommand: {
          executable: "tsc",
          args: ["-p", "tsconfig.json"],
          cwd: ".",
          sourcePath: commandSource.path,
          sourceContentHash: String(commandSource.contentHash)
        }
      }
    };

    const result = materializeTypeScriptCodeActionRepair({
      program,
      transformations: [transformation],
      requestText: "Apply the selected atomic TypeScript compiler action.",
      hasher
    });

    expect(result.changedPaths).toEqual(["src/generated.ts", "src/index.ts", "src/peer.ts"]);
    expect(result.program.files.find(file => file.path === "src/index.ts")?.content)
      .toBe("export const value: number = 1;\n");
    expect(result.program.files.find(file => file.path === "src/peer.ts")?.content)
      .toBe("export const peer = 1;\nexport const repaired = true;\n");
    expect(result.program.files.find(file => file.path === "src/generated.ts"))
      .toMatchObject({ role: "source", mediaType: "text/typescript", content: "export const generated = true;\n" });
    const repairNode = result.program.nodes.find(node => node.kind === "program_repair_full_file_materialization");
    const transformations = (repairNode?.metadata as { transformations?: Array<{ operations?: Array<{ codeFixEvidence?: { codeFixIdentity?: string } }> }> })?.transformations ?? [];
    expect(transformations).toHaveLength(3);
    expect(transformations.flatMap(item => item.operations ?? []).every(operation =>
      operation.codeFixEvidence?.codeFixIdentity === codeFixIdentity)).toBe(true);

    expect(() => materializeTypeScriptCodeActionRepair({
      program,
      transformations: [{
        ...transformation,
        codeFix: {
          ...transformation.codeFix,
          fileChanges: transformation.codeFix.fileChanges.map(change => change.path === "src/generated.ts"
            ? { ...change, baseContentHash: String(peer.contentHash) }
            : change)
        }
      }],
      requestText: "Apply the selected atomic TypeScript compiler action.",
      hasher
    })).toThrow(/create must carry a null base identity/u);
  });
});

function hydratedProgram(
  source: FileArtifact,
  hasher: ReturnType<typeof createHasher>,
  additionalFiles: readonly FileArtifact[] = []
): ProgramGraph {
  const config = artifact("tsconfig.json", "{\"compilerOptions\":{\"strict\":true,\"noEmit\":true},\"include\":[\"src/**/*.ts\"]}\n", hasher, "config");
  const commandSource = artifact("package.json", "{\"scripts\":{\"typecheck\":\"tsc -p tsconfig.json\",\"test\":\"vitest run\"}}\n", hasher, "config");
  const files = [source, ...additionalFiles, config, commandSource];
  const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
    id: `program.repair.${hasher.digestHex(source.content).slice(0, 16)}`,
    language: "typescript",
    packageManager: "pnpm",
    entrypoint: source.path,
    nodes: files.map(file => ({ id: `artifact:${file.path}`, kind: `artifact:${file.role}`, label: file.path, metadata: { contentHash: file.contentHash } })),
    edges: [],
    files,
    build: { command: "tsc", args: ["-p", "tsconfig.json"], cwd: "." },
    test: { command: "vitest", args: ["run"], cwd: "." }
  };
  const hydration = createProgramHydrationContract({
    program: graphWithoutHydration,
    sourcePlanId: "program-plan.repair.fixture",
    evidenceIds: ["evidence.repair.fixture"]
  });
  return {
    ...graphWithoutHydration,
    hydration,
    nodes: [
      ...graphWithoutHydration.nodes,
      { id: "program-hydration", kind: "program_hydration_contract", label: hydration.schema, metadata: hydrationSummary(hydration) }
    ],
    edges: [{ source: "program-plan.repair.fixture", target: "program-hydration", relation: "hydrates_as", weight: 1 }]
  };
}

function artifact(path: string, content: string, hasher: ReturnType<typeof createHasher>, role: FileArtifact["role"] = "source"): FileArtifact {
  const digest = hasher.digestHex(content);
  return {
    artifactId: `artifact_${digest.slice(0, 24)}` as ArtifactId,
    path,
    mediaType: "text/typescript",
    content,
    contentHash: `sha256_${digest}` as ContentHash,
    role
  };
}
