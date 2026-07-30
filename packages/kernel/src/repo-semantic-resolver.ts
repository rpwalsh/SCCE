/**
 * Phase 15 (183-184): the first semantic-edge resolver consuming
 * RepositorySyntaxNode output. Purely name-based cross-referencing over
 * tree-sitter's own parse -- never resolved identity -- so every edge this
 * produces is honestly tagged resolver: "tree-sitter-structural" and its
 * confidence never reaches 1, even for a unique name match (a same-named
 * but unrelated declaration in another file is always possible). A real
 * compiler/language-server resolver (typescript-semantic-program-index.ts's
 * TS-compiler-backed references/calls, tagged "typescript-compiler")
 * should always be preferred over this one where it is available; this
 * exists for the languages and files that resolver doesn't cover.
 */

import type { RepositorySemanticEdge, RepositorySyntaxNode, RepositorySyntaxNodeKind } from "./repo-syntax-graph.js";

const DECLARATION_KINDS: ReadonlySet<RepositorySyntaxNodeKind> = new Set(["function", "method", "class", "interface", "type"]);

/**
 * Real, bounded structural cross-referencing: every `call` node's name is
 * matched against every declaration node sharing that exact name anywhere
 * in the supplied node set (which may span multiple files). A unique match
 * scores higher than an ambiguous one, but neither is ever reported as
 * proven -- only isResolvedSemanticEdge()-false "candidate-reference" style
 * evidence for a human or a stronger resolver to confirm.
 */
export function resolveTreeSitterStructuralEdges(nodes: readonly RepositorySyntaxNode[]): RepositorySemanticEdge[] {
  const declarationsByName = new Map<string, RepositorySyntaxNode[]>();
  for (const node of nodes) {
    if (!node.name || !DECLARATION_KINDS.has(node.kind)) continue;
    const bucket = declarationsByName.get(node.name) ?? [];
    bucket.push(node);
    declarationsByName.set(node.name, bucket);
  }

  const edges: RepositorySemanticEdge[] = [];
  for (const node of nodes) {
    if (node.kind !== "call" || !node.name) continue;
    const candidates = (declarationsByName.get(node.name) ?? []).filter(declaration => declaration.id !== node.id);
    for (const candidate of candidates) {
      edges.push({
        sourceId: node.id,
        targetId: candidate.id,
        relation: "calls",
        confidence: candidates.length === 1 ? 0.6 : 0.35,
        resolver: "tree-sitter-structural"
      });
    }
  }
  return edges;
}
