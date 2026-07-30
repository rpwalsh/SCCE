/**
 * Phase 15 (183-184): tree-sitter as SCCE's portable multilingual syntax
 * substrate -- real concrete syntax trees feeding the language-neutral
 * RepositorySyntaxNode contract (repo-syntax-graph.ts). Deliberately
 * syntax-only: no identifier resolution, no types, no call-target
 * resolution happens here. A caller that needs proven symbol identity for
 * TypeScript/JavaScript should still use typescript-semantic-program-index.ts
 * (`resolver: "typescript-compiler"`); anything derived only from this
 * module's output must be tagged `resolver: "tree-sitter-structural"` if
 * turned into a RepositorySemanticEdge, since a parse tree only tells you
 * what a name *looks like*, never what it resolves to.
 *
 * Uses web-tree-sitter (WASM) rather than the native `tree-sitter` binding
 * so this never requires a native build toolchain (node-gyp/MSVC/Python) on
 * whatever machine runs it -- the grammar and runtime are both plain .wasm
 * files loaded once and reused for every parse.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);
import type {
  RepositorySyntaxErrorSpan,
  RepositorySyntaxNode,
  RepositorySyntaxNodeKind,
  RepositorySyntaxParseResult
} from "@scce/kernel";

export type TreeSitterLanguageId = "typescript" | "tsx" | "javascript";

const GRAMMAR_WASM_MODULE_SPECIFIER: Record<TreeSitterLanguageId, string> = {
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm"
};

let parserInitPromise: Promise<void> | undefined;
const loadedLanguages = new Map<TreeSitterLanguageId, Promise<Parser.Language>>();

async function ensureParserInitialized(): Promise<void> {
  if (!parserInitPromise) parserInitPromise = Parser.init();
  await parserInitPromise;
}

async function languageFor(languageId: TreeSitterLanguageId): Promise<Parser.Language> {
  await ensureParserInitialized();
  let pending = loadedLanguages.get(languageId);
  if (!pending) {
    pending = Parser.Language.load(require.resolve(GRAMMAR_WASM_MODULE_SPECIFIER[languageId]));
    loadedLanguages.set(languageId, pending);
  }
  return pending;
}

function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const parseResultCache = new Map<string, RepositorySyntaxParseResult>();

function cacheKey(fileId: string, languageId: TreeSitterLanguageId, hash: string, grammarVersion: string): string {
  return `${fileId}${languageId}${hash}${grammarVersion}`;
}

const DECLARATION_KIND_BY_NODE_TYPE: Partial<Record<string, RepositorySyntaxNodeKind>> = {
  program: "module",
  module: "module",
  namespace_declaration: "namespace",
  internal_module: "namespace",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  method_signature: "method",
  type_alias_declaration: "type",
  import_statement: "import",
  export_statement: "export",
  call_expression: "call",
  comment: "comment"
};

const PARAMETER_NODE_TYPES = new Set(["required_parameter", "optional_parameter", "rest_parameter"]);
const NAME_FIELD_KIND_NODE_TYPES = new Set(["variable_declarator"]);

let nodeSequence = 0;

function nextNodeId(fileId: string): string {
  nodeSequence += 1;
  return `${fileId}#syn${nodeSequence}`;
}

function declarationName(node: Parser.SyntaxNode): string | undefined {
  const named = node.childForFieldName("name");
  if (named) return named.text;
  if (node.type === "import_statement") {
    const source = node.childForFieldName("source");
    return source ? source.text.replace(/^["'`]|["'`]$/g, "") : undefined;
  }
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    return callee?.text;
  }
  return undefined;
}

function classifyNode(node: Parser.SyntaxNode): RepositorySyntaxNodeKind | undefined {
  const declared = DECLARATION_KIND_BY_NODE_TYPE[node.type];
  if (declared) return declared;
  if (PARAMETER_NODE_TYPES.has(node.type)) return "parameter";
  if (NAME_FIELD_KIND_NODE_TYPES.has(node.type)) {
    const value = node.childForFieldName("value");
    if (value && (value.type === "arrow_function" || value.type === "function" || value.type === "function_expression")) return "function";
    return "variable";
  }
  return undefined;
}

/**
 * Real recursive walk of the concrete syntax tree. Emits one
 * RepositorySyntaxNode per node this module knows how to classify
 * (module/namespace/class/interface/function/method/parameter/variable/
 * type/import/export/call/comment) with exact byte ranges from the parser
 * itself -- never a recomputed offset. Nodes this pass doesn't yet
 * classify (bare identifiers, literals, arbitrary expressions) are walked
 * through but not emitted, rather than forced into a fabricated "unknown"
 * node for every leaf in the tree.
 */
function walk(
  node: Parser.SyntaxNode,
  fileId: string,
  languageId: string,
  parentId: string | undefined,
  nodes: RepositorySyntaxNode[],
  errors: RepositorySyntaxErrorSpan[]
): void {
  if (node.isError) {
    errors.push({ fileId, kind: "error", byteStart: node.startIndex, byteEnd: node.endIndex, grammarNodeType: node.type });
  } else if (node.isMissing) {
    errors.push({ fileId, kind: "missing", byteStart: node.startIndex, byteEnd: node.endIndex, grammarNodeType: node.type });
  }

  const kind = node.isError ? undefined : classifyNode(node);
  let ownId = parentId;
  if (kind) {
    const id = nextNodeId(fileId);
    const repositoryNode: RepositorySyntaxNode = {
      id,
      languageId,
      fileId,
      kind,
      name: declarationName(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      parentId,
      childIds: [],
      parseConfidence: node.hasError ? 0.5 : 1,
      source: "tree-sitter"
    };
    nodes.push(repositoryNode);
    if (parentId) {
      const parent = nodes.find(candidate => candidate.id === parentId);
      parent?.childIds.push(id);
    }
    ownId = id;
  }

  for (const child of node.namedChildren) {
    if (!child) continue;
    walk(child, fileId, languageId, ownId, nodes, errors);
  }
}

export async function parseRepositorySyntax(input: {
  fileId: string;
  languageId: TreeSitterLanguageId;
  text: string;
}): Promise<RepositorySyntaxParseResult> {
  const hash = contentHash(input.text);
  const language = await languageFor(input.languageId);
  const grammarVersion = String(language.version);
  const key = cacheKey(input.fileId, input.languageId, hash, grammarVersion);
  const cached = parseResultCache.get(key);
  if (cached) return cached;

  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(input.text);
  if (!tree) {
    const empty: RepositorySyntaxParseResult = {
      fileId: input.fileId,
      languageId: input.languageId,
      contentHash: hash,
      grammarId: GRAMMAR_WASM_MODULE_SPECIFIER[input.languageId],
      grammarVersion,
      nodes: [],
      errors: []
    };
    return empty;
  }

  const nodes: RepositorySyntaxNode[] = [];
  const errors: RepositorySyntaxErrorSpan[] = [];
  walk(tree.rootNode, input.fileId, input.languageId, undefined, nodes, errors);

  const result: RepositorySyntaxParseResult = {
    fileId: input.fileId,
    languageId: input.languageId,
    contentHash: hash,
    grammarId: GRAMMAR_WASM_MODULE_SPECIFIER[input.languageId],
    grammarVersion,
    nodes,
    errors
  };
  parseResultCache.set(key, result);
  return result;
}

export function languageIdForFilePath(path: string): TreeSitterLanguageId | undefined {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs") || path.endsWith(".jsx")) return "javascript";
  return undefined;
}
