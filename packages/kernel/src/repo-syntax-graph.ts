/**
 * Phase 15 (183-184): the shared, pure data contract for repository
 * structural understanding. Deliberately split in two:
 *
 *  - RepositorySyntaxNode: what a parser actually saw in the text --
 *    declarations, imports, calls, references, byte-exact ranges. Cheap,
 *    language-agnostic, and honest about being *syntax*, not resolved
 *    meaning.
 *  - RepositorySemanticEdge: a claimed relationship between two syntax
 *    nodes (defines/references/imports/calls/...), always tagged with
 *    `resolver` naming exactly which real system produced it. A
 *    tree-sitter-structural edge is an unresolved candidate (this token
 *    looks like a call to that name); a typescript-compiler edge is an
 *    actually-resolved symbol relationship. Keeping these separate means
 *    a parser's syntactic guess can never be mistaken for a proven symbol
 *    relationship just because it lives in the same graph.
 *
 * This module only defines the contract. Real producers live where their
 * I/O/native dependencies belong: tree-sitter-based syntax extraction and
 * the TypeScript-compiler-based semantic resolver both live in
 * packages/adapters-node/src, not here -- this package stays pure.
 */

export type RepositorySyntaxNodeKind =
  | "module"
  | "namespace"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "parameter"
  | "variable"
  | "type"
  | "import"
  | "export"
  | "call"
  | "reference"
  | "literal"
  | "comment"
  | "unknown";

export interface RepositorySyntaxNode {
  id: string;
  languageId: string;
  fileId: string;
  kind: RepositorySyntaxNodeKind;
  name?: string;
  byteStart: number;
  byteEnd: number;
  charStart?: number;
  charEnd?: number;
  parentId?: string;
  childIds: string[];
  /** 1 for a grammar-certain node; lower for an ERROR/MISSING-adjacent recovery node. */
  parseConfidence: number;
  source: "tree-sitter";
}

export type RepositorySyntaxErrorKind = "error" | "missing";

/** A parser-recovery span kept as data rather than discarded (malformed code is still evidence). */
export interface RepositorySyntaxErrorSpan {
  fileId: string;
  kind: RepositorySyntaxErrorKind;
  byteStart: number;
  byteEnd: number;
  /** The grammar's own node type name at this span (e.g. "ERROR", the missing node's expected type). */
  grammarNodeType: string;
}

export interface RepositorySyntaxParseResult {
  fileId: string;
  languageId: string;
  contentHash: string;
  grammarId: string;
  grammarVersion: string;
  nodes: RepositorySyntaxNode[];
  errors: RepositorySyntaxErrorSpan[];
}

export type RepositorySemanticRelation =
  | "defines"
  | "references"
  | "imports"
  | "exports"
  | "calls"
  | "implements"
  | "extends"
  | "reads"
  | "writes"
  | "tests"
  | "candidate-reference";

export type RepositorySemanticResolver =
  | "typescript-compiler"
  | "language-server"
  | "tree-sitter-structural"
  | "cross-file-inference";

export interface RepositorySemanticEdge {
  sourceId: string;
  targetId: string;
  relation: RepositorySemanticRelation;
  /** In [0,1]. A tree-sitter-structural candidate must never be reported at 1 -- it is not proven. */
  confidence: number;
  resolver: RepositorySemanticResolver;
}

const UNRESOLVED_RESOLVERS: ReadonlySet<RepositorySemanticResolver> = new Set(["tree-sitter-structural", "cross-file-inference"]);

/**
 * True only for edges whose resolver actually resolved identity (compiler
 * or language server) -- never a tree-sitter/cross-file guess, however
 * high its confidence score happens to be. Callers that need "is this a
 * real symbol relationship, not just a plausible one" should gate on this,
 * not on a confidence threshold alone.
 */
export function isResolvedSemanticEdge(edge: RepositorySemanticEdge): boolean {
  return !UNRESOLVED_RESOLVERS.has(edge.resolver);
}

/** Real structural validation: every child/parent id an edge/node references must exist in the same node set. */
export function validateRepositorySyntaxNodes(nodes: readonly RepositorySyntaxNode[]): string[] {
  const problems: string[] = [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    if (node.byteEnd < node.byteStart) problems.push(`node ${node.id} has byteEnd < byteStart`);
    if (node.parentId && !byId.has(node.parentId)) problems.push(`node ${node.id} references missing parentId ${node.parentId}`);
    for (const childId of node.childIds) {
      if (!byId.has(childId)) problems.push(`node ${node.id} references missing childId ${childId}`);
    }
  }
  return problems;
}
