// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { validateRepositorySyntaxNodes } from "@scce/kernel";
import { describe, expect, it } from "vitest";
import { languageIdForFilePath, parseRepositorySyntax, withRepositorySyntaxTree } from "../tree-sitter-syntax.js";

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

  it("keeps syntax identities stable across revisions and unrelated parse order", async () => {
    const first = await parseRepositorySyntax({
      fileId: "src/stable.ts",
      languageId: "typescript",
      text: "export function stable(): number { return 1; }"
    });
    await parseRepositorySyntax({
      fileId: "src/unrelated.ts",
      languageId: "typescript",
      text: "export const unrelated = () => 0;"
    });
    const revised = await parseRepositorySyntax({
      fileId: "src/stable.ts",
      languageId: "typescript",
      text: "export function stable(): number { return 2; }"
    });

    expect(revised.nodes.map(node => node.id)).toEqual(first.nodes.map(node => node.id));
    expect(revised.nodes.map(node => node.parentId)).toEqual(first.nodes.map(node => node.parentId));
  });

  it("maps file extensions to the real grammar that should parse them", () => {
    expect(languageIdForFilePath("src/foo.ts")).toBe("typescript");
    expect(languageIdForFilePath("src/foo.tsx")).toBe("tsx");
    expect(languageIdForFilePath("src/foo.js")).toBe("javascript");
    expect(languageIdForFilePath("src/foo.rs")).toBe("rust");
    expect(languageIdForFilePath("src/foo.go")).toBe("go");
    expect(languageIdForFilePath("src/foo.java")).toBe("java");
    expect(languageIdForFilePath("src/foo.kt")).toBe("kotlin");
    expect(languageIdForFilePath("src/foo.swift")).toBe("swift");
    expect(languageIdForFilePath("src/foo.c")).toBe("c");
    expect(languageIdForFilePath("src/foo.cpp")).toBe("cpp");
    expect(languageIdForFilePath("src/foo.cs")).toBe("csharp");
    expect(languageIdForFilePath("src/foo.rb")).toBe("ruby");
    expect(languageIdForFilePath("src/foo.php")).toBe("php");
    expect(languageIdForFilePath("src/foo.sh")).toBe("shell");
    expect(languageIdForFilePath("src/foo.RS")).toBe("rust");
    expect(languageIdForFilePath("src/foo.sql")).toBeUndefined();
  });

  it("parses Rust function symbols with non-English identifiers and UTF-8 byte ranges", async () => {
    const text = "// π🙂\nfn caféΔ(值: i32) -> i32 { 值 + 1 }\n";
    const result = await parseRepositorySyntax({ fileId: "src/funk.rs", languageId: "rust", text });
    const fn = result.nodes.find(node => node.kind === "function");
    expect(result.errors).toEqual([]);
    expect(fn?.name).toBe("caféΔ");
    expect(fn?.byteStart).toBe(Buffer.byteLength(text.slice(0, text.indexOf("fn ")), "utf8"));
    expect(fn?.byteEnd).toBe(Buffer.byteLength(text, "utf8") - 1);
    expect(result.nodes.some(node => node.kind === "parameter" && node.name === "值")).toBe(true);
    expect(validateRepositorySyntaxNodes(result.nodes)).toEqual([]);
  });

  it("parses Kotlin declarations and exposes real grammar ranges only for the synchronous callback scope", async () => {
    const text = "// Δ🙂\nfun phoneIndex(value: String): String = value\n";
    const result = await parseRepositorySyntax({ fileId: "src/phone.kt", languageId: "kotlin", text });
    const fn = result.nodes.find(node => node.kind === "function");
    expect(result.errors).toEqual([]);
    expect(fn?.name).toBe("phoneIndex");
    expect(fn?.byteStart).toBe(Buffer.byteLength(text.slice(0, text.indexOf("fun ")), "utf8"));
    expect(result.nodes.some(node => node.kind === "parameter" && node.name === "value")).toBe(true);
    const observed = await withRepositorySyntaxTree({ fileId: "src/phone.kt", languageId: "kotlin", text }, root => {
      const visit = (node: typeof root): number | undefined => node.type === "function_declaration" ? node.startIndex : node.children.map(visit).find(value => value !== undefined);
      return visit(root);
    });
    expect(observed).toBe(text.indexOf("fun "));
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
