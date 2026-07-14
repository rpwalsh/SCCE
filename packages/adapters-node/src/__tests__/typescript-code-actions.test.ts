import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveTypeScriptCodeActionRepair,
  typescriptCodeFixIdentity,
  typescriptCompilerOptionsHash,
  typescriptDiagnosticIdentity,
  type TypeScriptCodeActionSnapshotFile
} from "../typescript-code-actions.js";

describe("TypeScript compiler code actions", () => {
  it("derives a tsconfig-aware single-file repair with exact after bytes and provenance", () => {
    const config = JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Node",
        strict: true,
        noUnusedLocals: true
      },
      include: ["src/**/*.ts"]
    });
    const source = "import type { Marker } from \"./types\";\nexport const value = 1;\n";
    const files = projectFiles({
      "tsconfig.json": config,
      "src/types.ts": "export interface Marker { readonly id: string; }\n",
      "src/value.ts": source
    });
    files.find(file => file.path === "src/value.ts")!.contentHash = hash(source).replace("sha256:", "sha256_");

    const result = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/compiler-action",
      requestedPaths: ["src/value.ts"],
      requestText: "Apply the compiler-owned fix for TS6133 in src/value.ts.",
      files,
      compilerCommand: compilerCommand()
    });

    expect(result?.familyId).toBe("repair.family.typescript.code_action.v1");
    const transformation = result?.transformations.find(item => item.diagnostic.code === 6133);
    expect(transformation).toBeDefined();
    expect(transformation?.path).toBe("src/value.ts");
    expect(transformation?.baseContentHash).toBe(hash(source));
    expect(transformation?.afterContent).toBe("export const value = 1;\n");
    expect(transformation?.afterContentHash).toBe(hash("export const value = 1;\n"));
    expect(transformation?.compiler.tsconfigPath).toBe("tsconfig.json");
    expect(transformation?.compiler.tsconfigContentHash).toBe(hash(config));
    expect(transformation?.compiler.compilerOptionsSource).toBe("source_observed_tsc_project");
    expect(transformation?.compiler.compilerCommand).toMatchObject({
      executable: "tsc",
      args: ["-p", "tsconfig.json"],
      cwd: ".",
      sourcePath: "package.json",
      sourceContentHash: hash(PACKAGE_MANIFEST)
    });
    expect(transformation?.compiler.compilerOptionsHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(transformation?.diagnosticIdentity).toBe(typescriptDiagnosticIdentity({
      path: transformation!.path,
      diagnostic: transformation!.diagnostic,
      compilerVersion: transformation!.compiler.version,
      compilerOptionsHash: transformation!.compiler.compilerOptionsHash
    }));
    expect(transformation?.codeFixIdentity).toBe(typescriptCodeFixIdentity({
      diagnosticIdentity: transformation!.diagnosticIdentity,
      codeFix: transformation!.codeFix
    }));
    expect(typescriptCompilerOptionsHash({ strict: true })).toBe(typescriptCompilerOptionsHash({ strict: true }));
    expectNonOverlapping(transformation!.codeFix.textChanges);
  });

  it("reports and repairs only explicitly requested existing source paths", () => {
    const config = JSON.stringify({ compilerOptions: { noUnusedLocals: true }, include: ["src/**/*.ts"] });
    const files = projectFiles({
      "tsconfig.json": config,
      "src/types.ts": "export interface Marker { readonly id: string; }\n",
      "src/requested.ts": "import type { Marker } from \"./types\";\nexport const requested = 1;\n",
      "src/unrequested.ts": "import type { Marker } from \"./types\";\nexport const unrequested = 2;\n"
    });

    const result = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/request-bound",
      requestedPaths: ["src/requested.ts"],
      requestText: "Fix only src/requested.ts.",
      files,
      compilerCommand: compilerCommand()
    });

    expect(result?.selection.mode).toBe("unselected_candidates");
    expect(result?.selection.candidates.length).toBeGreaterThan(0);
    expect(result?.selection.candidates.every(item => item.path === "src/requested.ts")).toBe(true);
    expect(result?.transformations).toEqual([]);
  });

  it("applies exact diagnostic selectors before candidate bounding", () => {
    const files = projectFiles({
      "tsconfig.json": JSON.stringify({ compilerOptions: { noUnusedLocals: true }, include: ["src/**/*.ts"] }),
      "src/value.ts": "const count = 1;\nconst unused = 2;\nexport const result = coutn;\n"
    });
    const result = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/selector",
      requestedPaths: ["src/value.ts"],
      requestText: "Apply the compiler-owned fix for TS2552.",
      files,
      compilerCommand: compilerCommand(),
      maxEdits: 1
    });

    expect(result?.selection.diagnosticCodes).toEqual([2552]);
    expect(result?.transformations).toHaveLength(1);
    expect(result?.transformations[0]?.diagnostic.code).toBe(2552);
    expect(result?.transformations[0]?.afterContent).toContain("export const result = count;");
  });

  it("preserves CRLF when a compiler action inserts formatted text", () => {
    const source = "const count = 1;\r\nexport const result = coutn;\r\n";
    const result = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/crlf",
      requestedPaths: ["src/value.ts"],
      requestText: "Apply TS2552.",
      files: projectFiles({
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
        "src/value.ts": source
      }),
      compilerCommand: compilerCommand()
    });

    const transformation = result?.transformations.find(item => item.diagnostic.code === 2552);
    expect(transformation?.afterContent).toBe("const count = 1;\r\nexport const result = count;\r\n");
    expect(transformation?.afterContent.replace(/\r\n/gu, "")).not.toContain("\n");
  });

  it("rejects a source-observed tsc lane whose project config cannot be bound", () => {
    const source = "const count = 1;\nexport const result = coutn;\n";
    expect(() => deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/no-config",
      requestedPaths: ["src/value.ts"],
      requestText: "Apply TS2552.",
      files: projectFiles({ "src/value.ts": source }),
      compilerCommand: compilerCommand([])
    })).toThrow(/project config cannot be identified and bound/u);
  });

  it("rejects a snapshot whose claimed content hash does not match its exact bytes", () => {
    expect(() => deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/hash-mismatch",
      requestedPaths: ["src/value.ts"],
      requestText: "Fix it.",
      files: [{ path: "src/value.ts", content: "export const value = 1;\n", contentHash: `sha256:${"0".repeat(64)}` }],
      compilerCommand: compilerCommand()
    })).toThrow(/content hash mismatch/u);
  });

  it("rejects requested paths outside the supplied snapshot boundary", () => {
    expect(() => deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/path-boundary",
      requestedPaths: ["../outside.ts"],
      requestText: "Fix it.",
      files: projectFiles({ "tsconfig.json": "{}", "src/value.ts": "export const value = 1;\n" }),
      compilerCommand: compilerCommand()
    })).toThrow(/invalid workspace-relative path/u);
  });

  it("keeps the production repair family scoped to TypeScript targets", () => {
    expect(() => deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/javascript-target",
      requestedPaths: ["src/value.js"],
      requestText: "Fix the compiler diagnostic.",
      files: projectFiles({ "tsconfig.json": "{}", "src/value.js": "export const value = missing;\n" }),
      compilerCommand: compilerCommand()
    })).toThrow(/not a TypeScript source file/u);
  });

  it("binds --project to a non-default config in the observed package context", () => {
    const source = "const unused = 1;\nexport const value = 2;\n";
    const buildConfig = JSON.stringify({ compilerOptions: { noUnusedLocals: true }, include: ["src/**/*.ts"] });
    const result = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/non-default-config",
      requestedPaths: ["src/value.ts"],
      requestText: "Apply the compiler-owned fix for TS6133.",
      files: projectFiles({
        "tsconfig.json": JSON.stringify({ compilerOptions: { noUnusedLocals: false }, include: ["other/**/*.ts"] }),
        "tsconfig.build.json": buildConfig,
        "src/value.ts": source
      }),
      compilerCommand: compilerCommand(["--project", "tsconfig.build.json"])
    });

    expect(result?.selection.mode).toBe("selected");
    expect(result?.transformations).toHaveLength(1);
    expect(result?.transformations[0]?.compiler.tsconfigPath).toBe("tsconfig.build.json");
    expect(result?.transformations[0]?.compiler.tsconfigContentHash).toBe(hash(buildConfig));
    expect(result?.transformations[0]?.afterContent).toBe("export const value = 2;\n");
  });

  it("rejects requested files outside parsed project fileNames", () => {
    expect(() => deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/outside-project",
      requestedPaths: ["src/value.ts"],
      requestText: "Apply TS2552.",
      files: projectFiles({
        "tsconfig.build.json": JSON.stringify({ include: ["other/**/*.ts"] }),
        "src/value.ts": "const count = 1;\nexport const value = coutn;\n",
        "other/in-project.ts": "export const included = 1;\n"
      }),
      compilerCommand: compilerCommand(["-p", "tsconfig.build.json"])
    })).toThrow(/outside the source-observed tsc project/u);
  });

  it("uses codeFixIdentity as an exact selector for a previously listed candidate", () => {
    const files = projectFiles({
      "tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
      "src/value.ts": "const count = 1;\nexport const value = coutn;\n"
    });
    const unselected = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/identity-selector",
      requestedPaths: ["src/value.ts"],
      requestText: "Please inspect this file.",
      files,
      compilerCommand: compilerCommand()
    });
    const identity = unselected?.selection.candidates.find(candidate => candidate.diagnosticCode === 2552)?.codeFixIdentity;
    expect(identity).toMatch(/^typescript\.code_fix:[0-9a-f]{64}$/u);

    const selected = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/identity-selector",
      requestedPaths: ["src/value.ts"],
      requestText: `Apply codeFixIdentity:${identity}.`,
      files,
      compilerCommand: compilerCommand()
    });
    expect(selected?.selection.mode).toBe("selected");
    expect(selected?.transformations[0]?.codeFixIdentity).toBe(identity);
  });

  it("preserves an official cross-file CodeFixAction as one exact atomic candidate", () => {
    const declaration = "const hidden = 1;\nexport const visible = 2;\n";
    const diagnosticSource = "import { hidden } from \"./a\";\nexport const value = hidden;\n";
    const files = projectFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" },
        include: ["src/**/*.ts"]
      }),
      "src/a.ts": declaration,
      "src/b.ts": diagnosticSource
    });
    const listed = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/cross-file",
      requestedPaths: ["src/b.ts"],
      requestText: "Inspect the compiler diagnostic.",
      files,
      compilerCommand: compilerCommand()
    });

    const candidate = listed?.selection.candidates.find(item => item.diagnosticCode === 2459);
    expect(candidate).toMatchObject({
      path: "src/b.ts",
      fixName: "fixImportNonExportedMember",
      affectedPaths: ["src/a.ts"],
      createPaths: []
    });
    const selected = deriveTypeScriptCodeActionRepair({
      rootPath: "C:/virtual/cross-file",
      requestedPaths: ["src/b.ts"],
      requestText: `Apply codeFixIdentity:${candidate?.codeFixIdentity}.`,
      files,
      compilerCommand: compilerCommand()
    });

    expect(selected?.selection.mode).toBe("selected");
    expect(selected?.transformations).toHaveLength(1);
    const transformation = selected!.transformations[0]!;
    expect(transformation.path).toBe("src/b.ts");
    expect(transformation.afterContent).toBe(diagnosticSource);
    expect(transformation.codeFix.fileChanges).toEqual([expect.objectContaining({
      path: "src/a.ts",
      isNewFile: false,
      baseContentHash: hash(declaration),
      afterContent: "export const hidden = 1;\nexport const visible = 2;\n"
    })]);
    expect(transformation.codeFixIdentity).toBe(typescriptCodeFixIdentity({
      diagnosticIdentity: transformation.diagnosticIdentity,
      codeFix: transformation.codeFix
    }));
  });
});

const PACKAGE_MANIFEST = JSON.stringify({ name: "fixture", scripts: { build: "tsc -p tsconfig.json" } });

function projectFiles(entries: Record<string, string>): TypeScriptCodeActionSnapshotFile[] {
  return snapshotFiles({ "package.json": PACKAGE_MANIFEST, ...entries });
}

function compilerCommand(args: readonly string[] = ["-p", "tsconfig.json"]): {
  executable: string;
  args: readonly string[];
  cwd: string;
  sourcePath: string;
} {
  return { executable: "tsc", args, cwd: ".", sourcePath: "package.json" };
}

function snapshotFiles(entries: Record<string, string>): TypeScriptCodeActionSnapshotFile[] {
  return Object.entries(entries).map(([path, content]) => ({ path, content, contentHash: hash(content) }));
}

function hash(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function expectNonOverlapping(changes: readonly { start: number; length: number }[]): void {
  for (let index = 1; index < changes.length; index++) {
    const previous = changes[index - 1]!;
    const current = changes[index]!;
    expect(current.start).toBeGreaterThanOrEqual(previous.start + previous.length);
  }
}
