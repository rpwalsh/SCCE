// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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
import { codeLanguageForPath, validateRepositorySyntaxNodes } from "@scce/kernel";

export type TreeSitterLanguageId =
  | "typescript" | "tsx" | "javascript" | "python" | "rust" | "go" | "java" | "kotlin"
  | "swift" | "c" | "cpp" | "csharp" | "ruby" | "php" | "shell";

const GRAMMAR_WASM_MODULE_SPECIFIER: Record<TreeSitterLanguageId, string> = {
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  rust: "tree-sitter-wasms/out/tree-sitter-rust.wasm",
  go: "tree-sitter-wasms/out/tree-sitter-go.wasm",
  java: "tree-sitter-wasms/out/tree-sitter-java.wasm",
  kotlin: "tree-sitter-wasms/out/tree-sitter-kotlin.wasm",
  swift: "tree-sitter-wasms/out/tree-sitter-swift.wasm",
  c: "tree-sitter-wasms/out/tree-sitter-c.wasm",
  cpp: "tree-sitter-wasms/out/tree-sitter-cpp.wasm",
  csharp: "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm",
  ruby: "tree-sitter-wasms/out/tree-sitter-ruby.wasm",
  php: "tree-sitter-wasms/out/tree-sitter-php.wasm",
  shell: "tree-sitter-wasms/out/tree-sitter-bash.wasm"
};

let parserInitPromise: Promise<void> | undefined;
const loadedLanguages = new Map<TreeSitterLanguageId, Promise<Parser.Language>>();
const warmParsers = new Map<TreeSitterLanguageId, Promise<Parser>>();

async function ensureParserInitialized(): Promise<void> {
  parserInitPromise ??= Parser.init();
  try {
    await parserInitPromise;
  } catch (cause) {
    // A failed WASM boot must not poison the process for every later parse.
    // Keep the successful initialization warm, but let a transient load
    // failure retry on the next request.
    parserInitPromise = undefined;
    throw cause;
  }
}

async function languageFor(languageId: TreeSitterLanguageId): Promise<Parser.Language> {
  await ensureParserInitialized();
  let pending = loadedLanguages.get(languageId);
  if (!pending) {
    pending = Parser.Language.load(require.resolve(GRAMMAR_WASM_MODULE_SPECIFIER[languageId]));
    loadedLanguages.set(languageId, pending);
  }
  try {
    return await pending;
  } catch (cause) {
    // Like the runtime boot above, rejected grammar promises are not useful
    // cache entries. Delete only the promise this call observed so a newer
    // concurrent retry cannot be removed by an older failure.
    if (loadedLanguages.get(languageId) === pending) loadedLanguages.delete(languageId);
    throw cause;
  }
}

async function parserFor(languageId: TreeSitterLanguageId): Promise<Parser> {
  const existing = warmParsers.get(languageId);
  if (existing) return existing;
  const pending = languageFor(languageId).then(language => {
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  });
  warmParsers.set(languageId, pending);
  try {
    return await pending;
  } catch (cause) {
    if (warmParsers.get(languageId) === pending) warmParsers.delete(languageId);
    throw cause;
  }
}

/**
 * Synchronously inspect the real grammar tree without retaining a WASM allocation. The callback runs while the
 * parsed tree is alive; `startIndex`/`endIndex` are the parser's UTF-16 code-unit coordinates, and the callback must
 * not return a Promise or retain any syntax node after it returns. The persistent RepositorySyntaxNode contract
 * converts these positions to UTF-8 byte offsets separately.
 */
export async function withRepositorySyntaxTree<T>(input: {
  fileId: string;
  languageId: TreeSitterLanguageId;
  text: string;
}, useRoot: (root: Parser.SyntaxNode) => T): Promise<T | undefined> {
  const parser = await parserFor(input.languageId);
  const tree = parser.parse(input.text);
  if (!tree) return undefined;
  try {
    const result = useRoot(tree.rootNode);
    if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
      throw new Error("repository syntax tree callback must be synchronous");
    }
    return result;
  } finally {
    tree.delete();
  }
}

function utf8ByteOffsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let utf16 = 0;
  let bytes = 0;
  while (utf16 < text.length) {
    offsets[utf16] = bytes;
    const codePoint = text.codePointAt(utf16)!;
    const units = codePoint > 0xffff ? 2 : 1;
    if (units === 2) offsets[utf16 + 1] = bytes;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    utf16 += units;
    offsets[utf16] = bytes;
  }
  return offsets;
}

function byteOffset(offsets: Uint32Array, parserOffset: number): number {
  return offsets[parserOffset] ?? offsets[offsets.length - 1] ?? 0;
}

function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// Results retain every emitted syntax node, so an unbounded revision cache
// grows with the lifetime of the server. Map insertion order gives us a small
// process-local LRU without putting cache policy into cognition.
const MAX_PARSE_RESULT_CACHE_ENTRIES = 256;
const parseResultCache = new Map<string, RepositorySyntaxParseResult>();

function cachedParseResult(key: string): RepositorySyntaxParseResult | undefined {
  const cached = parseResultCache.get(key);
  if (!cached) return undefined;
  parseResultCache.delete(key);
  parseResultCache.set(key, cached);
  return cached;
}

function cacheParseResult(key: string, result: RepositorySyntaxParseResult): void {
  parseResultCache.set(key, result);
  while (parseResultCache.size > MAX_PARSE_RESULT_CACHE_ENTRIES) {
    const oldest = parseResultCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    parseResultCache.delete(oldest);
  }
}

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
  import_declaration: "import",
  import_header: "import",
  export_statement: "export",
  call_expression: "call",
  method_invocation: "call",
  comment: "comment",
  line_comment: "comment",
  block_comment: "comment",
  // Python (tree-sitter-python): a different grammar, same RepositorySyntaxNodeKind vocabulary.
  class_definition: "class",
  function_definition: "function",
  import_from_statement: "import",
  call: "call",
  // These grammar node names normalize syntax only; they do not assert symbol identity.
  function_item: "function",
  method_declaration: "method",
  struct_item: "class",
  struct_specifier: "class",
  class_specifier: "class",
  trait_item: "interface",
  protocol_declaration: "interface",
  impl_item: "namespace",
  mod_item: "module",
  use_declaration: "import",
  type_declaration: "type",
  type_spec: "type",
  enum_declaration: "type",
  enum_item: "type",
  formal_parameter: "parameter",
  parameter_declaration: "parameter",
  object_declaration: "class",
  class: "class",
  method: "method"
};

const PARAMETER_NODE_TYPES = new Set([
  "required_parameter", "optional_parameter", "rest_parameter", "parameter",
  "typed_parameter", "default_parameter", "typed_default_parameter"
]);
const NAME_FIELD_KIND_NODE_TYPES = new Set(["variable_declarator", "property_declaration", "let_declaration", "variable_declaration", "var_declaration"]);
const ASSIGNMENT_NODE_TYPES = new Set(["assignment"]);

function nextNodeId(fileId: string, sequence: { value: number }): string {
  sequence.value += 1;
  return `${fileId}#syn${sequence.value}`;
}

function declarationName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "import_from_statement") {
    const moduleName = node.childForFieldName("module_name");
    return moduleName?.text;
  }
  if (node.type === "assignment") {
    const left = node.childForFieldName("left");
    return left && left.type === "identifier" ? left.text : undefined;
  }
  if (node.type === "typed_parameter") {
    return node.namedChild(0)?.text;
  }
  if (node.type === "parameter") {
    return node.childForFieldName("pattern")?.text
      ?? node.namedChildren.find(child => child.type === "simple_identifier" || child.type === "identifier")?.text
      ?? node.namedChild(0)?.text;
  }
  if (node.type === "function_declaration") {
    return node.namedChildren.find(child => child.type === "simple_identifier")?.text
      ?? node.childForFieldName("name")?.text
      ?? node.namedChild(0)?.text;
  }
  const named = node.childForFieldName("name");
  if (named) return named.text;
  if (node.type === "import_statement") {
    const source = node.childForFieldName("source");
    return source ? source.text.replace(/^["'`]|["'`]$/g, "") : undefined;
  }
  if (node.type === "call_expression" || node.type === "call") {
    const callee = node.childForFieldName("function");
    return callee?.text;
  }
  return undefined;
}

function classifyNode(node: Parser.SyntaxNode): RepositorySyntaxNodeKind | undefined {
  const declared = DECLARATION_KIND_BY_NODE_TYPE[node.type];
  if (declared) return declared;
  if (PARAMETER_NODE_TYPES.has(node.type)) return "parameter";
  if (ASSIGNMENT_NODE_TYPES.has(node.type)) {
    const left = node.childForFieldName("left");
    return left && left.type === "identifier" ? "variable" : undefined;
  }
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
 * type/import/export/call/comment) with exact UTF-8 byte ranges mapped once
 * from the parser's native UTF-16 positions. Nodes this pass doesn't yet
 * classify (bare identifiers, literals, arbitrary expressions) are walked
 * through but not emitted, rather than forced into a fabricated "unknown"
 * node for every leaf in the tree.
 */
function walk(
  node: Parser.SyntaxNode,
  fileId: string,
  languageId: string,
  parentId: string | undefined,
  byteOffsets: Uint32Array,
  nodes: RepositorySyntaxNode[],
  nodeById: Map<string, RepositorySyntaxNode>,
  sequence: { value: number },
  errors: RepositorySyntaxErrorSpan[]
): void {
  if (node.isError) {
    errors.push({ fileId, kind: "error", byteStart: byteOffset(byteOffsets, node.startIndex), byteEnd: byteOffset(byteOffsets, node.endIndex), grammarNodeType: node.type });
  } else if (node.isMissing) {
    errors.push({ fileId, kind: "missing", byteStart: byteOffset(byteOffsets, node.startIndex), byteEnd: byteOffset(byteOffsets, node.endIndex), grammarNodeType: node.type });
  }

  const kind = node.isError ? undefined : classifyNode(node);
  let ownId = parentId;
  if (kind) {
    const id = nextNodeId(fileId, sequence);
    const repositoryNode: RepositorySyntaxNode = {
      id,
      languageId,
      fileId,
      kind,
      name: declarationName(node),
      byteStart: byteOffset(byteOffsets, node.startIndex),
      byteEnd: byteOffset(byteOffsets, node.endIndex),
      parentId,
      childIds: [],
      parseConfidence: node.hasError ? 0.5 : 1,
      source: "tree-sitter"
    };
    nodes.push(repositoryNode);
    nodeById.set(id, repositoryNode);
    if (parentId) {
      // The recursive walk used to scan every node emitted so far for every
      // child, making a large source file quadratic before any reasoning ran.
      const parent = nodeById.get(parentId);
      parent?.childIds.push(id);
    }
    ownId = id;
  }

  // Walks every child, not just namedChildren: a MISSING recovery node for
  // an anonymous grammar token (e.g. a missing ")") is itself unnamed, so a
  // named-only traversal would silently skip exactly the recovery data
  // "treat syntax errors as data" depends on.
  for (const child of node.children) {
    if (!child) continue;
    walk(child, fileId, languageId, ownId, byteOffsets, nodes, nodeById, sequence, errors);
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
  const cached = cachedParseResult(key);
  if (cached) return cached;

  // The grammar and parser are process-warm. Parsing itself is synchronous,
  // so calls cannot interleave while one parser is inside WASM.
  const parser = await parserFor(input.languageId);
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
  const nodeById = new Map<string, RepositorySyntaxNode>();
  const sequence = { value: 0 };
  const errors: RepositorySyntaxErrorSpan[] = [];
  const byteOffsets = utf8ByteOffsets(input.text);
  try {
    walk(tree.rootNode, input.fileId, input.languageId, undefined, byteOffsets, nodes, nodeById, sequence, errors);
  } finally {
    // Cache the source-neutral result, not a live WASM tree. Keeping each tree
    // alive leaked linear WASM memory across file revisions in a warm server.
    tree.delete();
  }

  // Structural problems a grammar integration can produce and nothing downstream would notice: a node ending before
  // it starts, or naming a parent that is not in the set. `validateRepositorySyntaxNodes` checks exactly those and
  // had no caller, so a malformed tree became repo cognition -- symbol ranges, call graphs, patch targets -- unchallenged.
  //
  // Thrown rather than folded into `errors`, which means something else: that field is parser-recovery spans, the
  // grammar's report about malformed source, and is kept because malformed code is still evidence. A node set that
  // contradicts itself is not evidence about the file, it is a defect in this walk, and a caller cannot use it for
  // a symbol range or a patch target whatever it does with the error list.
  const structuralProblems = validateRepositorySyntaxNodes(nodes);
  if (structuralProblems.length) {
    throw new Error(`syntax parse produced a structurally invalid node set for ${input.fileId}: ${structuralProblems.slice(0, 4).join("; ")}`);
  }
  const result: RepositorySyntaxParseResult = {
    fileId: input.fileId,
    languageId: input.languageId,
    contentHash: hash,
    grammarId: GRAMMAR_WASM_MODULE_SPECIFIER[input.languageId],
    grammarVersion,
    nodes,
      errors
  };
  cacheParseResult(key, result);
  return result;
}

export function languageIdForFilePath(path: string): TreeSitterLanguageId | undefined {
  const extension = /\.([^.\\/]+)$/u.exec(path.trim())?.[1]?.toLocaleLowerCase();
  if (extension === "tsx") return "tsx";
  if (extension === "pyi") return "python";
  const language = codeLanguageForPath(path);
  return language && Object.hasOwn(GRAMMAR_WASM_MODULE_SPECIFIER, language)
    ? language as TreeSitterLanguageId
    : undefined;
}
