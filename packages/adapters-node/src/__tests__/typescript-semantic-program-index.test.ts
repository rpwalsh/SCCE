import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTypeScriptSemanticProgramIndex,
  type TypeScriptSemanticProgramIndexInput
} from "../typescript-semantic-program-index.js";

describe("revision-bound TypeScript semantic program index", () => {
  it("emits compiler symbols, graph edges, diagnostics, config ownership, commands, and observed test relations", async () => {
    const fixture = await createFixture();
    try {
      const index = await buildTypeScriptSemanticProgramIndex(indexInput(fixture.root, fixture.paths));
      expect(index.revisionHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(index.config).toMatchObject({
        kindId: "scce.program.config.typescript.v1",
        path: "tsconfig.json"
      });
      expect(index.config.contentHash).toBe(fileRecord(index, "tsconfig.json").contentHash);

      const greet = index.symbols.find(symbol => symbol.nameEvidence === "greet"
        && symbol.declarationIds.some(id => declarationRecord(index, id).span.path === "src/greet.ts"));
      expect(greet).toBeDefined();
      const greetDeclaration = index.declarations.find(declaration => declaration.symbolId === greet!.id
        && declaration.span.path === "src/greet.ts");
      expect(greetDeclaration).toMatchObject({
        kindId: "scce.program.declaration.v1",
        exported: true,
        nameEvidence: "greet"
      });
      expect(spanText(fixture.entries, greetDeclaration!.nameSpan)).toBe("greet");

      const useReference = index.references.find(reference => reference.targetSymbolId === greet!.id
        && reference.span.path === "src/use.ts"
        && !reference.declarationOccurrence
        && spanText(fixture.entries, reference.span) === "greet");
      expect(useReference).toBeDefined();
      const useCall = index.calls.find(call => call.targetSymbolId === greet!.id && call.span.path === "src/use.ts");
      expect(useCall).toBeDefined();
      expect(spanText(fixture.entries, useCall!.calleeSpan)).toBe("greet");

      const importEdge = index.imports.find(item => item.span.path === "src/use.ts");
      expect(importEdge?.targetFileId).toBe(fileRecord(index, "src/greet.ts").id);
      expect(importEdge?.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kindId: "scce.program.import.binding.named.v1",
          sourceNameEvidence: "greet",
          targetSymbolId: greet!.id
        })
      ]));

      const diagnostic = index.diagnostics.find(item => item.compilerCode === 2322 && item.span?.path === "src/use.ts");
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.originIds).toContain("typescript.diagnostic.origin.semantic.v1");
      expect(diagnostic?.rawMessageEvidence.length).toBeGreaterThan(0);
      expect(diagnostic?.span?.contentHash).toBe(fileRecord(index, "src/use.ts").contentHash);
      expect(spanText(fixture.entries, diagnostic!.span!)).toBe("broken");

      const useFile = fileRecord(index, "src/use.ts");
      expect(index.configOwnership).toContainEqual(expect.objectContaining({
        kindId: "scce.rel.program.config_ownership.v1",
        configId: index.config.id,
        fileId: useFile.id
      }));
      const command = index.commands.find(item => item.sourceNameEvidence === "compile");
      expect(command).toMatchObject({
        kindId: "scce.program.command.package_script.v1",
        rawCommandEvidence: "tsc -p tsconfig.json"
      });
      expect(spanText(fixture.entries, command!.commandSpan)).toBe(JSON.stringify("tsc -p tsconfig.json"));

      const testFile = fileRecord(index, "checks/greet.case.ts");
      expect(testFile.observedTest).toBe(true);
      expect(index.testRelations).toContainEqual(expect.objectContaining({
        kindId: "scce.rel.program.test_call.v1",
        testFileId: testFile.id,
        targetSymbolId: greet!.id,
        targetFileId: fileRecord(index, "src/greet.ts").id
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps revision identity deterministic and changes it with exact source bytes", async () => {
    const fixture = await createFixture();
    try {
      const input = indexInput(fixture.root, fixture.paths);
      const first = await buildTypeScriptSemanticProgramIndex(input);
      const second = await buildTypeScriptSemanticProgramIndex(input);
      expect(second.revisionHash).toBe(first.revisionHash);
      expect(second.files.map(file => [file.path, file.contentHash])).toEqual(first.files.map(file => [file.path, file.contentHash]));

      const changed = fixture.entries["src/greet.ts"]!.replace("hello", "salute");
      await writeFile(path.join(fixture.root, "src", "greet.ts"), changed, "utf8");
      const third = await buildTypeScriptSemanticProgramIndex(input);
      expect(third.revisionHash).not.toBe(first.revisionHash);
      expect(fileRecord(third, "src/greet.ts").contentHash).not.toBe(fileRecord(first, "src/greet.ts").contentHash);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses paths and tsconfig selections outside the explicit snapshot boundary", async () => {
    const fixture = await createFixture();
    try {
      await expect(buildTypeScriptSemanticProgramIndex(indexInput(fixture.root, [...fixture.paths, "../outside.ts"])))
        .rejects.toThrow(/invalid bounded workspace path/u);

      await writeFile(path.join(fixture.root, "tsconfig.json"), JSON.stringify({ files: ["../outside.ts"] }), "utf8");
      await expect(buildTypeScriptSemanticProgramIndex(indexInput(fixture.root, ["tsconfig.json"])))
        .rejects.toThrow(/outside the bounded workspace|outside the explicit bounded snapshot/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createFixture(): Promise<{ root: string; entries: Record<string, string>; paths: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "scce-ts-semantic-index-"));
  const entries: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "semantic-fixture",
      type: "module",
      scripts: {
        compile: "tsc -p tsconfig.json",
        verify: "vitest run"
      }
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true
      },
      include: ["src/**/*.ts", "checks/**/*.ts"]
    }),
    "src/greet.ts": "export function greet(name: string): string { return `hello ${name}`; }\n",
    "src/use.ts": "import { greet } from \"./greet.js\";\nexport const output = greet(\"Ada\");\nexport const broken: string = 42;\n",
    "checks/greet.case.ts": "import { greet } from \"../src/greet.js\";\nexport const observed = greet(\"Case\");\n"
  };
  for (const [workspacePath, content] of Object.entries(entries)) {
    const absolutePath = path.join(root, ...workspacePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return { root, entries, paths: Object.keys(entries).sort() };
}

function indexInput(root: string, workspacePaths: readonly string[]): TypeScriptSemanticProgramIndexInput {
  return {
    workspaceRoot: root,
    tsconfigPath: "tsconfig.json",
    bounds: {
      workspacePaths,
      observedTestPaths: workspacePaths.includes("checks/greet.case.ts") ? ["checks/greet.case.ts"] : [],
      maxFiles: 32,
      maxFileBytes: 64 * 1024,
      maxTotalBytes: 512 * 1024
    }
  };
}

function fileRecord(index: Awaited<ReturnType<typeof buildTypeScriptSemanticProgramIndex>>, workspacePath: string) {
  const file = index.files.find(item => item.path === workspacePath);
  if (!file) throw new Error(`missing fixture index file: ${workspacePath}`);
  return file;
}

function declarationRecord(index: Awaited<ReturnType<typeof buildTypeScriptSemanticProgramIndex>>, id: string) {
  const declaration = index.declarations.find(item => item.id === id);
  if (!declaration) throw new Error(`missing fixture declaration: ${id}`);
  return declaration;
}

function spanText(entries: Readonly<Record<string, string>>, span: { path: string; start: number; end: number }): string {
  const content = entries[span.path];
  if (content === undefined) throw new Error(`missing fixture source: ${span.path}`);
  return content.slice(span.start, span.end);
}
