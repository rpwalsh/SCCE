/**
 * Phase 15 wiring: combines the already-real, already-tested
 * issue-to-symbol localizer (issue-symbol-localization.ts, plan items
 * 185-186) and import-graph affected-test predictor
 * (affected-test-prediction.ts, plan items 189-190) into one function
 * reachable from a live turn, given real repo file contents supplied by
 * the caller (the kernel package has no filesystem access of its own --
 * an adapter layer must read the real files and pass their text in).
 * Returns undefined when no repo files are supplied so this never
 * fabricates repository context for a turn that isn't actually
 * code-shaped.
 *
 * A file may optionally carry pre-computed `syntaxNodes` (real
 * tree-sitter output from packages/adapters-node's tree-sitter-syntax.ts).
 * When present, those drive localization for that file instead of the
 * regex extractor -- the regex extractor stays the honest fallback for
 * files without a syntax parse, and it is still run for embedded SQL DDL
 * (`extractSqlTableSymbols`) regardless, since tree-sitter's TS/JS grammar
 * has no notion of SQL inside a template-literal string.
 */

import { extractFileSymbols, extractSqlTableSymbols, localizeIssueToSymbols, type SourceSymbol, type SourceSymbolKind, type SymbolLocalizationCandidate } from "./issue-symbol-localization.js";
import { predictAffectedTests } from "./affected-test-prediction.js";
import { resolveTreeSitterStructuralEdges } from "./repo-semantic-resolver.js";
import type { RepositorySemanticEdge, RepositorySyntaxNode, RepositorySyntaxNodeKind } from "./repo-syntax-graph.js";

export interface RepoCognitionFile {
  path: string;
  text: string;
  syntaxNodes?: RepositorySyntaxNode[];
}

export interface RepoCognitionResult {
  filesConsidered: number;
  symbolLocalization: SymbolLocalizationCandidate[];
  changedFilePaths: string[];
  affectedTests: string[];
  /** Real cross-referenced call edges over any supplied syntaxNodes, always resolver-tagged; [] when no file supplied syntaxNodes. */
  semanticEdges: RepositorySemanticEdge[];
}

const SYNTAX_KIND_TO_SOURCE_SYMBOL_KIND: Partial<Record<RepositorySyntaxNodeKind, SourceSymbolKind>> = {
  class: "class",
  interface: "interface",
  function: "function",
  method: "function",
  type: "type",
  variable: "const"
};

function lineNumberAtByteOffset(text: string, byteOffset: number): number {
  let line = 1;
  const bound = Math.min(byteOffset, text.length);
  for (let index = 0; index < bound; index++) if (text[index] === "\n") line++;
  return line;
}

/**
 * Converts real tree-sitter declaration nodes into the same SourceSymbol
 * shape the regex extractor produces, so both feed the identical,
 * already-tested localizeIssueToSymbols scorer. Byte offsets are treated as
 * JS string indices here -- exact for ASCII source (the overwhelming
 * majority of real code); a file with non-ASCII text before a declaration
 * will see a line-number/context drift tree-sitter's UTF-8 byte offsets
 * don't share with JS's UTF-16 indices. Known, honest limitation, not
 * silently assumed correct.
 */
function symbolsFromSyntaxNodes(path: string, text: string, syntaxNodes: readonly RepositorySyntaxNode[]): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  for (const node of syntaxNodes) {
    const kind = SYNTAX_KIND_TO_SOURCE_SYMBOL_KIND[node.kind];
    if (!kind || !node.name) continue;
    symbols.push({
      id: `${path}#${node.name}`,
      kind,
      name: node.name,
      path,
      lineStart: lineNumberAtByteOffset(text, node.byteStart),
      lineEnd: lineNumberAtByteOffset(text, node.byteEnd),
      context: text.slice(node.byteStart, node.byteEnd)
    });
  }
  return symbols;
}

const DIFF_CHANGED_PATH_PATTERNS: RegExp[] = [
  /^diff --git a\/(\S+) b\/(\S+)/m,
  /^\+\+\+ b\/(\S+)/m,
  /^--- a\/(\S+)/m
];

/**
 * Extracts changed file paths from a unified diff embedded in the request
 * text, if one is present. Only paths that actually match a supplied repo
 * file are kept -- an unrecognized path is dropped rather than guessed at.
 */
export function changedFilePathsFromRequestText(requestText: string, knownPaths: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const pattern of DIFF_CHANGED_PATH_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of requestText.matchAll(globalPattern)) {
      for (const group of match.slice(1)) {
        if (group && knownPaths.has(group)) found.add(group);
      }
    }
  }
  return [...found].sort();
}

export function repoCognitionForTurn(input: {
  requestText: string;
  files: readonly RepoCognitionFile[];
}): RepoCognitionResult | undefined {
  if (!input.files.length) return undefined;

  const symbols = input.files.flatMap(file => file.syntaxNodes
    ? [...symbolsFromSyntaxNodes(file.path, file.text, file.syntaxNodes), ...extractSqlTableSymbols(file.path, file.text)]
    : extractFileSymbols(file.path, file.text));
  const symbolLocalization = localizeIssueToSymbols(input.requestText, symbols, { limit: 10 });
  const semanticEdges = resolveTreeSitterStructuralEdges(input.files.flatMap(file => file.syntaxNodes ?? []));

  const allFilePaths = input.files.map(file => file.path);
  const knownPaths = new Set(allFilePaths);
  const changedFilePaths = changedFilePathsFromRequestText(input.requestText, knownPaths);
  const textByPath = new Map(input.files.map(file => [file.path, file.text]));
  const affectedTests = changedFilePaths.length
    ? predictAffectedTests({
      allFilePaths,
      readFile: path => textByPath.get(path),
      changedFilePaths
    })
    : [];

  return {
    filesConsidered: input.files.length,
    symbolLocalization,
    changedFilePaths,
    affectedTests,
    semanticEdges
  };
}
