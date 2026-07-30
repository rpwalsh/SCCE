import { describe, expect, it } from "vitest";
import { changedFilePathsFromRequestText, repoCognitionForTurn } from "../repo-cognition.js";
import type { RepositorySyntaxNode } from "../repo-syntax-graph.js";

describe("repo cognition for a live turn (Phase 15 wiring)", () => {
  const sourceFile = {
    path: "src/sparse-ranking.ts",
    text: [
      "// Fits a sparse FTRL ranker over labeled candidate features.",
      "export function fitSparseRanking(features: string[], labels: number[]): number {",
      "  return features.length + labels.length;",
      "}"
    ].join("\n")
  };
  const testFile = {
    path: "src/__tests__/sparse-ranking.test.ts",
    text: [
      "import { fitSparseRanking } from \"../sparse-ranking.js\";",
      "test(\"fits\", () => { fitSparseRanking([], []); });"
    ].join("\n")
  };
  const unrelatedFile = {
    path: "src/primitives.ts",
    text: "export function clamp01(value: number): number { return value; }"
  };

  it("returns undefined when no repo files are supplied -- never fabricates repo context", () => {
    expect(repoCognitionForTurn({ requestText: "fitSparseRanking looks wrong", files: [] })).toBeUndefined();
  });

  it("localizes an issue description to the real symbol it names, given real repo files", () => {
    const result = repoCognitionForTurn({
      requestText: "fitSparseRanking returns the wrong count when labels is empty.",
      files: [sourceFile, testFile, unrelatedFile]
    });
    expect(result).toBeDefined();
    expect(result!.filesConsidered).toBe(3);
    expect(result!.symbolLocalization[0]!.symbol.name).toBe("fitSparseRanking");
    expect(result!.symbolLocalization[0]!.symbol.path).toBe("src/sparse-ranking.ts");
    expect(result!.semanticEdges).toEqual([]);
  });

  it("uses supplied tree-sitter syntaxNodes for localization instead of the regex extractor, and reports real semantic edges", () => {
    const declarationText = "export function fitSparseRanking(x) { return x; }";
    const declarationNodes: RepositorySyntaxNode[] = [{
      id: "src/sparse-ranking.ts#syn1",
      languageId: "typescript",
      fileId: "src/sparse-ranking.ts",
      kind: "function",
      name: "fitSparseRanking",
      byteStart: 0,
      byteEnd: declarationText.length,
      childIds: [],
      parseConfidence: 1,
      source: "tree-sitter"
    }];
    const callerText = "fitSparseRanking(1);";
    const callerNodes: RepositorySyntaxNode[] = [{
      id: "src/caller.ts#syn1",
      languageId: "typescript",
      fileId: "src/caller.ts",
      kind: "call",
      name: "fitSparseRanking",
      byteStart: 0,
      byteEnd: callerText.length,
      childIds: [],
      parseConfidence: 1,
      source: "tree-sitter"
    }];

    const result = repoCognitionForTurn({
      requestText: "fitSparseRanking returns the wrong value",
      files: [
        { path: "src/sparse-ranking.ts", text: declarationText, syntaxNodes: declarationNodes },
        { path: "src/caller.ts", text: callerText, syntaxNodes: callerNodes }
      ]
    });

    expect(result!.symbolLocalization[0]!.symbol.name).toBe("fitSparseRanking");
    expect(result!.symbolLocalization[0]!.symbol.kind).toBe("function");
    expect(result!.semanticEdges).toEqual([{
      sourceId: "src/caller.ts#syn1",
      targetId: "src/sparse-ranking.ts#syn1",
      relation: "calls",
      confidence: 0.6,
      resolver: "tree-sitter-structural"
    }]);
  });

  it("predicts the real affected test when the request embeds a diff touching the changed file", () => {
    const diffRequest = [
      "Please review this change:",
      "diff --git a/src/sparse-ranking.ts b/src/sparse-ranking.ts",
      "--- a/src/sparse-ranking.ts",
      "+++ b/src/sparse-ranking.ts",
      "@@ -1,1 +1,1 @@",
      "-export function fitSparseRanking(features: string[], labels: number[]): number {",
      "+export function fitSparseRanking(features: string[], labels: number[]): number | undefined {"
    ].join("\n");
    const result = repoCognitionForTurn({ requestText: diffRequest, files: [sourceFile, testFile, unrelatedFile] });
    expect(result!.changedFilePaths).toEqual(["src/sparse-ranking.ts"]);
    expect(result!.affectedTests).toEqual(["src/__tests__/sparse-ranking.test.ts"]);
  });

  it("predicts no affected tests when the request text has no diff at all", () => {
    const result = repoCognitionForTurn({
      requestText: "How does fitSparseRanking work?",
      files: [sourceFile, testFile, unrelatedFile]
    });
    expect(result!.changedFilePaths).toEqual([]);
    expect(result!.affectedTests).toEqual([]);
  });

  it("drops a diff-mentioned path that does not match any supplied repo file rather than guessing", () => {
    const knownPaths = new Set(["src/sparse-ranking.ts"]);
    const paths = changedFilePathsFromRequestText(
      "diff --git a/src/some-other-file.ts b/src/some-other-file.ts\n--- a/src/some-other-file.ts\n+++ b/src/some-other-file.ts",
      knownPaths
    );
    expect(paths).toEqual([]);
  });
});
