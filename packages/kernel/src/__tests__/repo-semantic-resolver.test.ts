import { describe, expect, it } from "vitest";
import { resolveTreeSitterStructuralEdges } from "../repo-semantic-resolver.js";
import type { RepositorySyntaxNode } from "../repo-syntax-graph.js";

function node(partial: Partial<RepositorySyntaxNode> & Pick<RepositorySyntaxNode, "id" | "kind">): RepositorySyntaxNode {
  return {
    languageId: "typescript",
    fileId: "src/fixture.ts",
    byteStart: 0,
    byteEnd: 1,
    childIds: [],
    parseConfidence: 1,
    source: "tree-sitter",
    ...partial
  };
}

describe("tree-sitter structural semantic-edge resolver (Phase 15, 183-184)", () => {
  it("links a call to its unique matching declaration with resolver tree-sitter-structural, never at full confidence", () => {
    const declaration = node({ id: "n1", kind: "function", name: "fitSparseRanking", fileId: "src/sparse-ranking.ts" });
    const call = node({ id: "n2", kind: "call", name: "fitSparseRanking", fileId: "src/caller.ts" });
    const edges = resolveTreeSitterStructuralEdges([declaration, call]);

    expect(edges).toEqual([{ sourceId: "n2", targetId: "n1", relation: "calls", confidence: 0.6, resolver: "tree-sitter-structural" }]);
    expect(edges[0]!.confidence).toBeLessThan(1);
  });

  it("scores an ambiguous multi-declaration name match lower than a unique one", () => {
    const declarationA = node({ id: "a", kind: "function", name: "helper", fileId: "src/one.ts" });
    const declarationB = node({ id: "b", kind: "method", name: "helper", fileId: "src/two.ts" });
    const call = node({ id: "c", kind: "call", name: "helper", fileId: "src/caller.ts" });
    const edges = resolveTreeSitterStructuralEdges([declarationA, declarationB, call]);

    expect(edges).toHaveLength(2);
    expect(edges.every(edge => edge.confidence === 0.35)).toBe(true);
    expect(edges.map(edge => edge.targetId).sort()).toEqual(["a", "b"]);
  });

  it("produces no edge for a call whose name matches nothing declared", () => {
    const call = node({ id: "c", kind: "call", name: "neverDeclared" });
    expect(resolveTreeSitterStructuralEdges([call])).toEqual([]);
  });

  it("never links a call to itself even if somehow present in the declaration set", () => {
    const selfNode = node({ id: "same", kind: "call", name: "recurse" });
    expect(resolveTreeSitterStructuralEdges([selfNode])).toEqual([]);
  });
});
