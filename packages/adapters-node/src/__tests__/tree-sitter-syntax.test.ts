import { validateRepositorySyntaxNodes } from "@scce/kernel";
import { describe, expect, it } from "vitest";
import { languageIdForFilePath, parseRepositorySyntax } from "../tree-sitter-syntax.js";

describe("tree-sitter syntax substrate (Phase 15, 183-184)", () => {
  it("extracts real declarations, an import, and a call with exact byte ranges", async () => {
    const text = [
      "import { helper } from \"./helper.js\";",
      "",
      "export class Widget {",
      "  render(x: number): number {",
      "    return helper(x);",
      "  }",
      "}"
    ].join("\n");

    const result = await parseRepositorySyntax({ fileId: "src/widget.ts", languageId: "typescript", text });

    expect(result.errors).toEqual([]);
    expect(validateRepositorySyntaxNodes(result.nodes)).toEqual([]);

    const importNode = result.nodes.find(node => node.kind === "import");
    expect(importNode?.name).toBe("./helper.js");
    expect(text.slice(importNode!.byteStart, importNode!.byteEnd)).toContain("import { helper }");

    const classNode = result.nodes.find(node => node.kind === "class");
    expect(classNode?.name).toBe("Widget");
    expect(text.slice(classNode!.byteStart, classNode!.byteEnd)).toContain("class Widget");

    const methodNode = result.nodes.find(node => node.kind === "method");
    expect(methodNode?.name).toBe("render");
    expect(methodNode?.parentId).toBe(classNode?.id);

    const parameterNode = result.nodes.find(node => node.kind === "parameter");
    expect(parameterNode?.parentId).toBe(methodNode?.id);

    const callNode = result.nodes.find(node => node.kind === "call");
    expect(callNode?.name).toBe("helper");
    expect(text.slice(callNode!.byteStart, callNode!.byteEnd)).toBe("helper(x)");
  });

  it("classifies a const-assigned arrow function as a function, not a plain variable", async () => {
    const text = "export const add = (a: number, b: number): number => a + b;";
    const result = await parseRepositorySyntax({ fileId: "src/add.ts", languageId: "typescript", text });
    const fn = result.nodes.find(node => node.name === "add");
    expect(fn?.kind).toBe("function");
  });

  it("extracts an interface and a type alias by name", async () => {
    const text = [
      "export interface Point { x: number; y: number; }",
      "export type PointList = Point[];"
    ].join("\n");
    const result = await parseRepositorySyntax({ fileId: "src/point.ts", languageId: "typescript", text });
    expect(result.nodes.find(node => node.kind === "interface")?.name).toBe("Point");
    expect(result.nodes.find(node => node.kind === "type")?.name).toBe("PointList");
  });

  it("recovers from malformed code: keeps real nodes before the break and records the error as data instead of throwing", async () => {
    const text = [
      "export function ok(): number {",
      "  return 1;",
      "}",
      "",
      "const broken = ;"
    ].join("\n");

    const result = await parseRepositorySyntax({ fileId: "src/broken.ts", languageId: "typescript", text });

    expect(result.nodes.some(node => node.kind === "function" && node.name === "ok")).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every(error => error.fileId === "src/broken.ts")).toBe(true);
  });

  it("caches identical content+language+grammar-version parses rather than reparsing", async () => {
    const text = "export function cached(): number { return 1; }";
    const first = await parseRepositorySyntax({ fileId: "src/cached.ts", languageId: "typescript", text });
    const second = await parseRepositorySyntax({ fileId: "src/cached.ts", languageId: "typescript", text });
    expect(second).toBe(first);
  });

  it("maps file extensions to the real grammar that should parse them", () => {
    expect(languageIdForFilePath("src/foo.ts")).toBe("typescript");
    expect(languageIdForFilePath("src/foo.tsx")).toBe("tsx");
    expect(languageIdForFilePath("src/foo.js")).toBe("javascript");
    expect(languageIdForFilePath("src/foo.rs")).toBeUndefined();
  });

  it("parses real JavaScript (no TypeScript-only syntax) through the javascript grammar", async () => {
    const text = "function greet(name) { return \"hi \" + name; }";
    const result = await parseRepositorySyntax({ fileId: "src/greet.js", languageId: "javascript", text });
    expect(result.nodes.find(node => node.kind === "function")?.name).toBe("greet");
  });

  it("proves language-neutrality: real Python source produces the same RepositorySyntaxNodeKind vocabulary via a different grammar", async () => {
    const text = [
      "import os",
      "from typing import List",
      "",
      "class Widget:",
      "    def render(self, x):",
      "        return helper(x)",
      "",
      "def helper(x):",
      "    return x",
      "",
      "value = helper(1)"
    ].join("\n");

    const result = await parseRepositorySyntax({ fileId: "src/widget.py", languageId: "python", text });

    expect(result.errors).toEqual([]);
    expect(result.nodes.find(node => node.kind === "import" && node.name === "os")).toBeDefined();
    expect(result.nodes.find(node => node.kind === "import" && node.name === "typing")).toBeDefined();
    const classNode = result.nodes.find(node => node.kind === "class");
    expect(classNode?.name).toBe("Widget");
    const methodNode = result.nodes.find(node => node.kind === "function" && node.name === "render");
    expect(methodNode?.parentId).toBe(classNode?.id);
    const topLevelFunction = result.nodes.find(node => node.kind === "function" && node.name === "helper");
    expect(topLevelFunction).toBeDefined();
    expect(topLevelFunction?.parentId).not.toBe(classNode?.id);
    const callNode = result.nodes.find(node => node.kind === "call" && node.name === "helper");
    expect(callNode).toBeDefined();
    expect(result.nodes.find(node => node.kind === "variable" && node.name === "value")).toBeDefined();
  });

  it("recovers from malformed Python: keeps real nodes before the break and records the error as data", async () => {
    const text = [
      "def ok():",
      "    return 1",
      "",
      "def broken(:",
      "    pass"
    ].join("\n");

    const result = await parseRepositorySyntax({ fileId: "src/broken.py", languageId: "python", text });

    expect(result.nodes.some(node => node.kind === "function" && node.name === "ok")).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("maps .py/.pyi extensions to the python grammar", () => {
    expect(languageIdForFilePath("src/foo.py")).toBe("python");
    expect(languageIdForFilePath("src/foo.pyi")).toBe("python");
  });
});
