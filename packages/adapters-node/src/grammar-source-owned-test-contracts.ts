// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import path from "node:path";
import type Parser from "web-tree-sitter";
import { withRepositorySyntaxTree } from "./tree-sitter-syntax.js";
import type { SourceOwnedInvocation, SourceOwnedTestCase } from "./source-owned-test-contracts.js";
import { nativeCallableAbiId, nativeMapStateParameter, nativeTypeEvidenceId, type ProgramNativeCallableAbi, type ProgramNativeTypeEvidence, type ProgramNativeLiteral, type JsonValue } from "@scce/kernel";

type Node = Parser.SyntaxNode;
type Language = "python" | "go" | "rust";
export interface GrammarContractFile { path: string; text: string; languageId: Language; sourceHash: string; sourceVersionId: string }
interface Declaration { name: string; start: number; end: number; nativeSignature?: Pick<ProgramNativeCallableAbi, "parameters" | "returnType" | "signatureSpan" | "signatureText" | "declarationSpan" | "packageName"> }
interface Call { name: string; arguments: unknown[]; nativeArguments: ProgramNativeLiteral[]; start: number; end: number; inputStart: number; inputEnd: number }
interface Step { call: Call; assertion?: { expected: unknown; nativeExpected?: ProgramNativeLiteral; nativeResultProjection?: "dereference";
  start: number; end: number; assertionStart: number; assertionEnd: number } }
interface RustScope { root: boolean; imports: Array<{ local: string; name: string }>; localNames: Set<string> }
interface Parsed { file: GrammarContractFile; declarations: Declaration[]; imports: Array<{ local: string; module: string; name?: string }>;
  bindings: Map<string, number>; packageName?: string; traces: Step[][]; rustScopes: Map<Step[], RustScope>;
  rustMacros: Array<{ text: string; start: number; end: number; assertionStart: number; assertionEnd: number; trace: Step[] }> }
const hash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const span = (text: string, start: number, end: number) => ({ start, end, textHash: hash(text.slice(start, end)) });

/** Only explicit imports or one package/module declaration bind calls; syntax similarity never supplies a target. */
export async function grammarSourceOwnedTestCases(files: readonly GrammarContractFile[],
  snapshot: {knownPaths: readonly string[]; complete: boolean} = {knownPaths: files.map(file=>file.path),complete:true}): Promise<SourceOwnedTestCase[]> {
  const parsed: Parsed[] = [];
  const invalidRustTraces = new Set<Step[]>();
  for (const file of files) {
    if (hash(file.text).replace(/^sha256:/u, "") !== file.sourceHash.replace(/^sha256[:_]/u, "")) continue;
    const item = await withRepositorySyntaxTree({ fileId: file.path, languageId: file.languageId, text: file.text }, root => parseFile(file, root));
    if (item) parsed.push(item);
  }
  // A native type spelling is not a builtin witness when its lexical scope rebinds it.
  for (const item of parsed) for (const declaration of item.declarations) {
    const signature=declaration.nativeSignature;
    if (!signature) continue;
    const scope=item.file.languageId==="go" ? parsed.filter(other=>other.file.languageId==="go" && other.packageName===item.packageName
      && path.posix.dirname(other.file.path)===path.posix.dirname(item.file.path)) : [item];
    const types=[...signature.parameters.map(parameter=>parameter.type),...(signature.returnType?[signature.returnType]:[])];
    if (types.some(type=>(type.text.match(/[\p{L}_][\p{L}\p{M}\p{N}_]*/gu)??[]).some(name=>scope.some(owner=>owner.bindings.has(name))))) declaration.nativeSignature=undefined;
  }
  for (const item of parsed) for (const macro of item.rustMacros) {
    const prefix = "fn __scce_literal_arguments() { let __scce_values = (";
    const expression = await withRepositorySyntaxTree({ fileId: item.file.path, languageId: "rust", text: `${prefix}${macro.text}); }` }, root => {
      if (root.hasError) return undefined;
      const tuple = descendants(root).find(node => node.type === "tuple_expression");
      const values = tuple?.namedChildren;
      if (values?.length !== 2) return undefined;
      const call = parseCall(values[0]!, macro.start - prefix.length), expected = literal(values[1]!);
      return call && expected.ok ? { call, assertion: { expected: expected.value,
        ...(expected.nativeExpected ? { nativeExpected: expected.nativeExpected } : {}),
        start: values[1]!.startIndex + macro.start - prefix.length, end: values[1]!.endIndex + macro.start - prefix.length,
        assertionStart: macro.assertionStart, assertionEnd: macro.assertionEnd } } : undefined;
    });
    if (expression) macro.trace.push(expression); else invalidRustTraces.add(macro.trace);
  }
  const out: SourceOwnedTestCase[] = [];
  for (const item of parsed) for (const trace of item.traces) {
    if (!trace.length || invalidRustTraces.has(trace)) continue;
    const bound: Array<{ step: Step; owner: Parsed; declaration: Declaration }> = [];
    let valid = true;
    for (const step of trace.sort((a, b) => a.call.start - b.call.start)) {
      const target = resolve(item, step.call.name, parsed, item.rustScopes.get(trace), snapshot);
      if (!target) { valid = false; break; }
      bound.push({ step, ...target });
    }
    if (!valid) continue;
    let stateful = false;
    const invocations: SourceOwnedInvocation[] = [];
    for (const { step, owner, declaration } of bound) {
      stateful ||= !step.assertion;
      const targetSymbolId = symbolId(owner.file, declaration);
      const nativeAbi = declaration.nativeSignature && (owner.file.languageId === "go" || owner.file.languageId === "rust")
        ? nativeAbiFor(owner.file, declaration, targetSymbolId) : undefined;
      const invocation: SourceOwnedInvocation = { targetSymbolId, targetName: declaration.name, sourcePath: owner.file.path,
        sourceHash: owner.file.sourceHash, sourceVersionId: owner.file.sourceVersionId, arguments: step.call.arguments,
        inputSpan: span(item.file.text, step.call.inputStart, step.call.inputEnd), callSpan: span(item.file.text, step.call.start, step.call.end),
        ...(nativeAbi ? { nativeAbi } : {}) };
      if (owner.file.languageId === "go" || owner.file.languageId === "rust") Object.assign(invocation, { nativeArguments: step.call.nativeArguments });
      invocations.push(invocation);
      if (!step.assertion) continue;
      out.push({ ...invocation, languageId: owner.file.languageId, bindingResolverId: "scce.source_contract.grammar_static_scope.v1", testPath: item.file.path, testHash: item.file.sourceHash,
        testSourceVersionId: item.file.sourceVersionId, expectedResult: step.assertion.expected,
        ...(step.assertion.nativeExpected ? { nativeExpected: step.assertion.nativeExpected } : {}),
        ...(step.assertion.nativeResultProjection ? { nativeResultProjection: step.assertion.nativeResultProjection } : {}),
        ...(stateful ? { invocations: [...invocations] } : {}),
        expectedSpan: span(item.file.text, step.assertion.start, step.assertion.end),
        assertionSpan: span(item.file.text, step.assertion.assertionStart, step.assertion.assertionEnd) });
    }
  }
  return out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.testPath.localeCompare(b.testPath) || a.assertionSpan.start - b.assertionSpan.start);
}

function symbolId(file: GrammarContractFile, declaration: Declaration): string {
  return `source.symbol.${createHash("sha256").update(JSON.stringify([file.languageId, file.path, file.sourceHash, declaration.start, declaration.end])).digest("hex")}`;
}

function nativeAbiFor(file: GrammarContractFile, declaration: Declaration, targetSymbolId: string): ProgramNativeCallableAbi | undefined {
  if (!declaration.nativeSignature || file.languageId !== "go" && file.languageId !== "rust") return undefined;
  const content: Omit<ProgramNativeCallableAbi, "id"> = { schema: "scce.program.native_callable_abi.v1", languageId: file.languageId,
    callableName: declaration.name, owner: { targetSymbolId, sourcePath: file.path, sourceHash: file.sourceHash, sourceVersionId: file.sourceVersionId },
    ...declaration.nativeSignature };
  const stateParameter=nativeMapStateParameter(content);
  const owned={...content,...(stateParameter?{stateParameter}:{})};
  return { ...owned, id: nativeCallableAbiId(owned) };
}

function nativeSignature(file: GrammarContractFile, node: Node, packageName?: string): Declaration["nativeSignature"] {
  if (file.languageId !== "go" && file.languageId !== "rust" || node.childForFieldName("type_parameters")) return undefined;
  const body = node.childForFieldName("body"), params = node.childForFieldName("parameters");
  if (!params) return undefined;
  const evidence = (type: Node): ProgramNativeTypeEvidence => ({ id: nativeTypeEvidenceId(file.languageId, type.type, type.text),
    nodeKind: type.type, text: type.text, span: span(file.text, type.startIndex, type.endIndex) });
  const parameters: Array<ProgramNativeCallableAbi["parameters"][number]> = [];
  for (const parameter of params.namedChildren) {
    const name = parameter.childForFieldName(file.languageId === "go" ? "name" : "pattern"), type = parameter.childForFieldName("type");
    if (!name || name.type !== "identifier" || !type || !["parameter", "parameter_declaration"].includes(parameter.type)
      || parameter.namedChildren.filter(child => child.id !== type.id).length !== 1) return undefined;
    parameters.push({ name: name.text, type: evidence(type) });
  }
  const result = node.childForFieldName(file.languageId === "go" ? "result" : "return_type");
  return { parameters, ...(result ? { returnType: evidence(result) } : {}),
    ...(file.languageId === "go" && packageName ? { packageName } : {}),
    signatureText: file.text.slice(node.startIndex, (body?.startIndex ?? node.endIndex)), signatureSpan: span(file.text, node.startIndex, body?.startIndex ?? node.endIndex),
    declarationSpan: span(file.text, node.startIndex, node.endIndex) };
}

function resolve(item: Parsed, name: string, files: readonly Parsed[], rustScope?: RustScope, snapshot?: {knownPaths:readonly string[];complete:boolean}): { owner: Parsed; declaration: Declaration } | undefined {
  const parts = name.split(".");
  if (item.file.languageId === "rust") {
    if (!rustScope) return undefined;
    const imports = rustScope.imports.filter(binding => binding.local === name);
    const qualified = parts.length === 2 && (parts[0] === "crate" || parts[0] === "super" && !rustScope.root);
    const targetName = qualified ? parts[1] : imports.length === 1 && !rustScope.localNames.has(name) ? imports[0]!.name
      : rustScope.root && parts.length === 1 ? name : undefined;
    if (!targetName || item.bindings.get(targetName) !== 1) return undefined;
    const declarations = item.declarations.filter(declaration => declaration.name === targetName);
    return declarations.length === 1 ? { owner: item, declaration: declarations[0]! } : undefined;
  }
  if (item.file.languageId === "go") {
    if (parts.length !== 1 || !snapshot?.complete || snapshot.knownPaths.some(name=>name.endsWith(".go")
      && path.posix.dirname(name)===path.posix.dirname(item.file.path) && !files.some(owner=>owner.file.path===name))) return undefined;
    const packageFiles = files.filter(file => file.file.languageId === "go" && file.packageName === item.packageName
      && path.posix.dirname(file.file.path) === path.posix.dirname(item.file.path));
    if (packageFiles.reduce((sum, file) => sum + (file.bindings.get(name) ?? 0), 0) !== 1) return undefined;
    const matches = packageFiles.flatMap(owner => owner.declarations
        .filter(declaration => declaration.name === name && owner.bindings.get(name) === 1).map(declaration => ({ owner, declaration })));
    return matches.length === 1 && !item.imports.some(binding => binding.local === name) ? matches[0] : undefined;
  }
  const imported = item.imports.filter(binding => binding.local === parts[0]);
  if (imported.length === 1 && item.bindings.get(parts[0]!) === 1) {
    const binding = imported[0]!;
    const targetName = binding.name ?? parts[1];
    if (!targetName || parts.length !== (binding.name ? 1 : 2)) return undefined;
    const targetPaths = item.file.languageId === "python" ? pythonModulePaths(item.file.path, binding.module) : [item.file.path];
    if (!snapshot?.complete || snapshot.knownPaths.some(name=>targetPaths.includes(name) && !files.some(owner=>owner.file.path===name))) return undefined;
    const matches = files.filter(owner => targetPaths.includes(owner.file.path) && owner.file.languageId === item.file.languageId)
      .flatMap(owner => owner.declarations.filter(declaration => declaration.name === targetName && owner.bindings.get(targetName) === 1).map(declaration => ({ owner, declaration })));
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (parts.length !== 1 || item.bindings.get(name) !== 1) return undefined;
  const declarations = item.declarations.filter(declaration => declaration.name === name);
  return declarations.length === 1 ? { owner: item, declaration: declarations[0]! } : undefined;
}

function pythonModulePaths(testPath: string, module: string): string[] {
  const dots = module.match(/^\.+/u)?.[0].length ?? 0;
  if (dots > path.posix.dirname(testPath).split("/").filter(part => part !== "." && part !== "").length) return [];
  let base = dots ? path.posix.dirname(testPath) : ".";
  for (let index = 1; index < dots; index++) base = path.posix.dirname(base);
  const resolved = path.posix.normalize(path.posix.join(base, module.slice(dots).replaceAll(".", "/")));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) return [];
  return [`${resolved}.py`, path.posix.join(resolved, "__init__.py")];
}

function parseFile(file: GrammarContractFile, root: Node): Parsed | undefined {
  if (root.hasError) return undefined;
  const item: Parsed = { file, declarations: [], imports: [], bindings: new Map(), traces: [], rustScopes: new Map(), rustMacros: [] };
  const bind = (name: string) => item.bindings.set(name, (item.bindings.get(name) ?? 0) + 1);
  if (file.languageId === "python" && descendants(root).some(node => node.type === "wildcard_import")) return item;
  const functionType = file.languageId === "python" ? "function_definition" : file.languageId === "go" ? "function_declaration" : "function_item";
  for (const node of root.namedChildren) {
    if (node.type === functionType) { const name = node.childForFieldName("name"); if (name) { bind(name.text); item.declarations.push({ name: name.text, start: node.startIndex, end: node.endIndex,
      nativeSignature: nativeSignature(file, node, item.packageName) }); } }
    if (node.type === "package_clause") item.packageName = node.namedChildren[0]?.text;
    if (file.languageId === "rust" && ["const_item", "static_item", "struct_item", "enum_item", "type_item"].includes(node.type)) {
      const name = node.childForFieldName("name"); if (name) bind(name.text);
    }
    if (file.languageId === "rust" && node.type === "use_declaration") for (const name of descendants(node).filter(part => part.type === "identifier")) bind(name.text);
    if (file.languageId === "python" && node.type === "import_from_statement") {
      const module = node.childForFieldName("module_name")?.text;
      for (const entry of node.namedChildren.filter(child => child.id !== node.childForFieldName("module_name")?.id)) {
        const name = entry.childForFieldName("name")?.text ?? (entry.type === "dotted_name" ? entry.text : undefined);
        const local = entry.childForFieldName("alias")?.text ?? name;
        if (module && name && local) { item.imports.push({ local, module, name }); bind(local); }
      }
    }
    if (file.languageId === "python" && node.type === "import_statement") for (const entry of node.namedChildren) {
      const module = entry.childForFieldName("name")?.text ?? entry.text, local = entry.childForFieldName("alias")?.text ?? module;
      item.imports.push({ local, module }); bind(local);
    }
    if (file.languageId === "go" && node.type === "import_declaration") for (const spec of descendants(node).filter(child => child.type === "import_spec")) {
      const value = literal(spec.childForFieldName("path"));
      if (value.ok && typeof value.value === "string") { const local = spec.childForFieldName("name")?.text ?? path.posix.basename(value.value); item.imports.push({ local, module: value.value }); bind(local); }
    }
    if (file.languageId === "python" && node.type === "expression_statement") {
      for (const assignment of descendants(node).filter(child => child.type === "assignment" || child.type === "augmented_assignment")) {
        const left = assignment.childForFieldName("left"); if (left) for (const name of descendants(left).filter(child => child.type === "identifier")) bind(name.text);
      }
    }
    if (file.languageId === "python" && (node.type === "class_definition" || node.type === "decorated_definition")) {
      const declaration = node.type === "decorated_definition" ? node.childForFieldName("definition") : node;
      const name = declaration?.childForFieldName("name"); if (name) bind(name.text);
    }
    if (file.languageId === "python" && ["delete_statement", "if_statement", "for_statement", "while_statement", "try_statement", "with_statement"].includes(node.type)) {
      for (const nested of descendants(node)) {
        const binding = nested.type === "function_definition" || nested.type === "class_definition" ? nested.childForFieldName("name")
          : nested.type === "assignment" || nested.type === "augmented_assignment" ? nested.childForFieldName("left") : undefined;
        if (binding) for (const name of descendants(binding).filter(part => part.type === "identifier")) bind(name.text);
        if (node.type === "delete_statement" && nested.type === "identifier") bind(nested.text);
      }
    }
    if (file.languageId === "go" && node.type === "type_declaration") for (const spec of descendants(node).filter(child=>child.type === "type_spec" || child.type === "type_alias")) {
      const name=spec.childForFieldName("name"); if(name) bind(name.text);
    }
    if (file.languageId === "go" && (node.type === "var_declaration" || node.type === "const_declaration")) for (const spec of descendants(node).filter(child => child.type === "var_spec" || child.type === "const_spec")) {
      const name = spec.childForFieldName("name"); if (name) bind(name.text);
    }
  }
  if (file.languageId === "rust") {
    if (descendants(root).some(node => node.type === "macro_definition" && node.childForFieldName("name")?.text === "assert_eq")) return item;
    if (descendants(root).some(node => node.type === "use_declaration" && descendants(node).some(part => part.type === "identifier" && part.text === "assert_eq"))) return item;
    if (descendants(root).some(node => node.type === "use_wildcard" || node.type === "extern_crate_declaration")) return item;
    for (const module of root.namedChildren.filter(node => node.type === "mod_item")) {
      const body = module.childForFieldName("body");
      if (!body) continue;
      rustTraces(item, body, false);
    }
    rustTraces(item, root, true);
  } else for (const fn of root.namedChildren.filter(node => node.type === functionType)) {
    const parameters = fn.childForFieldName("parameters"), body = fn.childForFieldName("body");
    if (!body || !parameters) continue;
    let tester: string | undefined;
    if (file.languageId === "python") { if (parameters.namedChildren.length) continue; }
    else {
      if (!file.path.endsWith("_test.go")) continue;
      const parameter = parameters.namedChildren;
      if (parameter.length !== 1 || parameter[0]!.childForFieldName("type")?.type !== "pointer_type") continue;
      const qualified = parameter.length === 1 ? descendants(parameter[0]!).find(node => node.type === "qualified_type") : undefined;
      const testing = item.imports.find(binding => binding.module === "testing" && binding.local === qualified?.childForFieldName("package")?.text);
      if (!testing || qualified?.childForFieldName("name")?.text !== "T" || !/^Test(?:$|[^a-z])/u.test(fn.childForFieldName("name")?.text ?? "")) continue;
      tester = parameter[0]!.childForFieldName("name")?.text;
    }
    const trace: Step[] = [];
    let valid = true;
    for (const statement of body.namedChildren.filter(node => !isComment(node))) {
      const step = file.languageId === "python" ? pythonStep(statement) : goStep(statement, tester!);
      if (!step || tester && step.call.name.split(".")[0] === tester) { valid = false; break; }
      trace.push(step);
    }
    if (valid && trace.some(step => step.assertion)) item.traces.push(trace);
  }
  return item;
}

function rustTraces(item: Parsed, body: Node, root: boolean): void {
  const scope: RustScope = { root, imports: [], localNames: new Set(body.namedChildren.filter(node => node.type === "function_item")
    .map(node => node.childForFieldName("name")?.text).filter((name): name is string => Boolean(name))) };
  for (const use of body.namedChildren.filter(node => node.type === "use_declaration")) {
    const argument = use.childForFieldName("argument");
    if (argument?.type === "scoped_identifier" && ["super", "crate"].includes(argument.childForFieldName("path")?.text ?? "")) {
      const name = argument.childForFieldName("name")?.text;
      if (name) scope.imports.push({ local: name, name });
    } else {
      for (const name of descendants(use).filter(node => node.type === "identifier")) scope.localNames.add(name.text);
    }
  }
  let test = false;
  for (const node of body.namedChildren) {
    if (node.type === "attribute_item") { test ||= node.namedChildren[0]?.text === "test"; continue; }
    if (node.type !== "function_item" || !test) { if (!isComment(node)) test = false; continue; }
    test = false;
    const block = node.childForFieldName("body"), parameters = node.childForFieldName("parameters");
    if (!block || parameters?.namedChildren.length) continue;
    const trace: Step[] = [], macros: Parsed["rustMacros"] = [];
    let valid = true;
    for (const statement of block.namedChildren.filter(node => !isComment(node))) {
      const expression = statement.type === "expression_statement" ? statement.namedChildren[0] : statement;
      if (expression?.type === "macro_invocation" && expression.childForFieldName("macro")?.text === "assert_eq") {
        const tokens = expression.namedChildren.find(node => node.type === "token_tree");
        if (!tokens) { valid = false; break; }
        macros.push({ text: item.file.text.slice(tokens.startIndex + 1, tokens.endIndex - 1), start: tokens.startIndex + 1,
          end: tokens.endIndex - 1, assertionStart: expression.startIndex, assertionEnd: expression.endIndex, trace });
      } else {
        const call = expression && parseCall(expression);
        if (!call) { valid = false; break; }
        trace.push({ call });
      }
    }
    if (valid && macros.length) { item.traces.push(trace); item.rustMacros.push(...macros); item.rustScopes.set(trace, scope); }
  }
}

function pythonStep(node: Node): Step | undefined {
  if (node.type === "assert_statement") {
    const comparison = node.namedChildren[0];
    if (comparison?.type !== "comparison_operator" || comparison.namedChildren.length !== 2 || comparison.children.filter(child => !child.isNamed).map(child => child.text).join("") !== "==") return undefined;
    const call = parseCall(comparison.namedChildren[0]!), value = literal(comparison.namedChildren[1]);
    return call && value.ok ? { call, assertion: { expected: value.value, start: comparison.namedChildren[1]!.startIndex,
      end: comparison.namedChildren[1]!.endIndex, assertionStart: node.startIndex, assertionEnd: node.endIndex } } : undefined;
  }
  const expression = node.type === "expression_statement" ? node.namedChildren[0] : undefined;
  const call = expression && parseCall(expression); return call ? { call } : undefined;
}

function goStep(node: Node, tester: string): Step | undefined {
  if (node.type !== "if_statement") { const expression = node.type === "expression_statement" ? node.namedChildren[0] : undefined; const call = expression && parseCall(expression); return call ? { call } : undefined; }
  const condition = node.childForFieldName("condition"), block = node.childForFieldName("consequence");
  if (node.childForFieldName("initializer") || node.childForFieldName("alternative") || condition?.type !== "binary_expression"
    || condition.childForFieldName("operator")?.text !== "!=" || block?.namedChildren.length !== 1) return undefined;
  const failure = block.namedChildren[0]!.namedChildren[0], selector = failure?.childForFieldName("function");
  if (failure?.type !== "call_expression" || selector?.type !== "selector_expression" || selector.childForFieldName("operand")?.text !== tester
    || !["Fatal", "Fatalf", "Error", "Errorf"].includes(selector.childForFieldName("field")?.text ?? "")) return undefined;
  const actual = condition.childForFieldName("left"), dereference = actual?.type === "unary_expression" && actual.children[0]?.text === "*";
  const call = actual && parseCall(dereference ? actual.namedChildren[0]! : actual), expected = condition.childForFieldName("right"), value = literal(expected);
  return call && expected && value.ok ? { call, assertion: { expected: value.value, start: expected.startIndex, end: expected.endIndex,
    ...(value.nativeExpected ? { nativeExpected: value.nativeExpected } : {}),
    ...(dereference ? { nativeResultProjection: "dereference" as const } : {}),
    assertionStart: node.startIndex, assertionEnd: node.endIndex } } : undefined;
}

function parseCall(node: Node, offset = 0): Call | undefined {
  if (!["call", "call_expression"].includes(node.type)) return undefined;
  const callee = node.childForFieldName("function"), args = node.childForFieldName("arguments");
  if (!callee || !args || !["identifier", "attribute", "selector_expression", "scoped_identifier"].includes(callee.type)) return undefined;
  const values = args.namedChildren.map(literal);
  if (!values.every(value => value.ok)) return undefined;
  return { name: callee.text.replaceAll("::", "."), arguments: values.map(value => value.value),
    nativeArguments: values.map(value => value.nativeExpected ?? { kind: "value", value: value.value as JsonValue }), start: node.startIndex + offset, end: node.endIndex + offset,
    inputStart: (args.namedChildren[0]?.startIndex ?? node.startIndex) + offset,
    inputEnd: (args.namedChildren.at(-1)?.endIndex ?? node.endIndex) + offset };
}

function literal(node: Node | null | undefined): { ok: true; value: unknown; nativeExpected?: ProgramNativeLiteral } | { ok: false } {
  if (!node) return { ok: false };
  if (node.type === "scoped_identifier" && node.text === "::std::option::Option::None") return { ok: true, value: null, nativeExpected: { kind: "none" } };
  if (node.type === "call_expression" && node.childForFieldName("function")?.text === "::std::option::Option::Some") {
    const args = node.childForFieldName("arguments")?.namedChildren;
    const inner = args?.length === 1 ? literal(args[0]) : undefined;
    return inner?.ok ? { ok: true, value: inner.value, nativeExpected: { kind: "some", value: inner.nativeExpected ?? { kind: "value", value: inner.value as JsonValue } } } : { ok: false };
  }
  if (["integer", "int_literal", "integer_literal", "float", "float_literal"].includes(node.type)) {
    const text = node.text.replaceAll("_", "");
    if (node.type === "integer" && /^0[0-9]+$/u.test(text) && /[1-9]/u.test(text)) return { ok: false };
    const value = node.type === "int_literal" && /^0[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : Number(text);
    return Number.isFinite(value) && (!["integer", "int_literal", "integer_literal"].includes(node.type) || Number.isSafeInteger(value))
      ? { ok: true, value, nativeExpected: { kind: "value", value, nativeNumberKind: ["integer", "int_literal", "integer_literal"].includes(node.type) ? "integer" : "float" } } : { ok: false };
  }
  if (["unary_expression", "unary_operator"].includes(node.type) && node.children[0]?.text === "-") {
    const value = literal(node.namedChildren[0]); return value.ok && typeof value.value === "number" ? { ok: true, value: -value.value,
      nativeExpected: { kind: "value", value: -value.value, ...(value.nativeExpected?.kind === "value" ? { nativeNumberKind: value.nativeExpected.nativeNumberKind,
        ...(value.value===0 && value.nativeExpected.nativeNumberKind==="float" ? {nativeNegativeZero:true as const}: {}) } : {}) } } : { ok: false };
  }
  if (["true", "false", "boolean_literal"].includes(node.type)) return { ok: true, value: node.text === "true" || node.text === "True" };
  if (["none", "nil"].includes(node.type)) return { ok: true, value: null };
  if (["string", "string_literal", "interpreted_string_literal", "raw_string_literal"].includes(node.type)) {
    const text = node.text;
    if (text.startsWith('"') && text.endsWith('"') && !text.startsWith('"""')) { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } }
    if ((text.startsWith("'") && text.endsWith("'") && !text.includes("\\") && !text.startsWith("'''")) || text.startsWith("`") && text.endsWith("`")) return { ok: true, value: text.slice(1, -1) };
  }
  if (["list", "array_expression"].includes(node.type)) { const values = node.namedChildren.map(literal); return values.every(value => value.ok) ? { ok: true, value: values.map(value => value.value) } : { ok: false }; }
  return { ok: false };
}
function descendants(root: Node): Node[] { const out: Node[] = []; const visit = (node: Node) => { out.push(node); for (const child of node.namedChildren) visit(child); }; visit(root); return out; }
function isComment(node: Node): boolean { return ["comment", "line_comment", "block_comment"].includes(node.type); }

/** Declaration-only document fences retain their original UTF-16 source coordinates. */
export async function grammarSourceOwnedNativeDeclarations(file: Omit<GrammarContractFile,"languageId">): Promise<ProgramNativeCallableAbi[]> {
  if(hash(file.text).replace(/^sha256:/u,"")!==file.sourceHash.replace(/^sha256[:_]/u,""))return [];
  const out:ProgramNativeCallableAbi[]=[];
  for(const languageId of ["go","rust"] as const){
    const matches=[...file.text.matchAll(/^```(go|rust)[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gmu)].filter(match=>match[1]===languageId);
    if(!matches.length)continue;
    const chars: string[] = file.text.split("").map(char=>char==="\n"||char==="\r"?char:" ");
    for(const match of matches){const start=match.index!+match[0].indexOf("\n")+1;for(let i=0;i<match[2]!.length;i++)chars[start+i]=match[2]![i]!;}
    const masked=chars.join("");
    const declarations=await withRepositorySyntaxTree({fileId:file.path,languageId,text:masked},root=>{
      if(root.hasError)return [];
      const allowed=languageId==="rust"?["function_signature_item"]:["package_clause","function_declaration"];
      if(root.namedChildren.some(node=>!isComment(node)&&!allowed.includes(node.type)))return [];
      const packageName=languageId==="go"?root.namedChildren.find(node=>node.type==="package_clause")?.namedChildren[0]?.text:undefined;
      const nodes=root.namedChildren.filter(node=>node.type==="function_signature_item"||node.type==="function_declaration");
      const names=nodes.map(node=>node.childForFieldName("name")?.text);
      if(new Set(names).size!==names.length)return [];
      let invalid=false;
      const owned=nodes.flatMap(node=>{
        if(node.childForFieldName("body")){invalid=true;return [];}
        const name=node.childForFieldName("name")?.text;
        const typedFile={...file,languageId},nativeSignature_=nativeSignature(typedFile,node,packageName);
        if(!name||!nativeSignature_){invalid=true;return [];}
        const types=[...nativeSignature_.parameters.map(p=>p.type),...(nativeSignature_.returnType?[nativeSignature_.returnType]:[])];
        // Bare standard map aliases need an import witness; document declarations use fully qualified maps.
        if(languageId==="rust"&&types.some(type=>/(?:^|[^:\p{L}\p{N}_])(?:HashMap|BTreeMap)\s*</u.test(type.text))){invalid=true;return [];}
        const declaration={name,start:node.startIndex,end:node.endIndex,nativeSignature:nativeSignature_};
        const abi=nativeAbiFor(typedFile,declaration,symbolId(typedFile,declaration));return abi?[abi]:[];
      });
      return invalid?[]:owned;
    });
    out.push(...(declarations ?? []));
  }
  return out;
}
