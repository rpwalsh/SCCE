// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import ts from "typescript";
import { toJsonValue, type JsonValue, type ProgramNativeCallableAbi, type ProgramNativeLiteral } from "@scce/kernel";
import { createHash } from "node:crypto";
import type { TypeScriptSemanticProgramIndex, TypeScriptSemanticCall, TypeScriptSemanticFile } from "./typescript-semantic-program-index.js";

export const SOURCE_OWNED_TEST_CONTRACT_SCHEMA = "scce.source_owned_test_contract.v1" as const;

export interface SourceOwnedInvocation {
  readonly nativeAbi?: ProgramNativeCallableAbi;
  readonly nativeArguments?: readonly ProgramNativeLiteral[];
  readonly targetSymbolId: string;
  readonly targetName: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly sourceVersionId: string;
  readonly arguments: readonly unknown[];
  readonly inputSpan: { readonly start: number; readonly end: number; readonly textHash: string };
  readonly callSpan: { readonly start: number; readonly end: number; readonly textHash: string };
}

export interface SourceOwnedTestCase {
  readonly nativeAbi?: ProgramNativeCallableAbi;
  readonly nativeExpected?: ProgramNativeLiteral;
  readonly nativeArguments?: readonly ProgramNativeLiteral[];
  readonly nativeResultProjection?: "dereference";
  readonly targetSymbolId: string;
  readonly targetName: string;
  readonly languageId: "typescript" | "javascript" | "python" | "go" | "rust";
  readonly bindingResolverId?: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly sourceVersionId: string;
  readonly testPath: string;
  readonly testHash: string;
  readonly testSourceVersionId: string;
  readonly arguments: readonly unknown[];
  readonly expectedResult: unknown;
  readonly invocations?: readonly SourceOwnedInvocation[];
  readonly inputSpan: { readonly start: number; readonly end: number; readonly textHash: string };
  readonly expectedSpan: { readonly start: number; readonly end: number; readonly textHash: string };
  readonly callSpan: { readonly start: number; readonly end: number; readonly textHash: string };
  readonly assertionSpan: { readonly start: number; readonly end: number; readonly textHash: string };
}

/**
 * Extracts contracts only from a bounded TS semantic index and actual Node test/assert imports.
 * The checker-resolved call target supplies symbol identity; AST literals supply expected values.
 */
export function sourceOwnedTestCases(input: {
  readonly program: TypeScriptSemanticProgramIndex;
  readonly sourceVersions: ReadonlyMap<string, { readonly sourceVersionId: string; readonly sourceHash: string }>;
  readonly testVersions: ReadonlyMap<string, { readonly sourceVersionId: string; readonly sourceHash: string }>;
  readonly sourceTexts: ReadonlyMap<string, string>;
}): SourceOwnedTestCase[] {
  const files = new Map(input.program.files.map(file => [file.id, file]));
  const callsByFile = new Map<string, TypeScriptSemanticCall[]>();
  for (const call of input.program.calls) callsByFile.set(call.fileId, [...(callsByFile.get(call.fileId) ?? []), call]);
  const out: SourceOwnedTestCase[] = [];
  for (const relation of input.program.testRelations) {
    if (relation.kindId !== "scce.rel.program.test_call.v1" || !relation.targetSymbolId || !relation.targetFileId) continue;
    const targetSymbolId = relation.targetSymbolId;
    const testFile = files.get(relation.testFileId);
    const targetFile = files.get(relation.targetFileId);
    if (!testFile || !targetFile || (testFile.syntaxKind !== ts.ScriptKind.TS && testFile.syntaxKind !== ts.ScriptKind.TSX && testFile.syntaxKind !== ts.ScriptKind.JS && testFile.syntaxKind !== ts.ScriptKind.JSX)) continue;
    const sourceVersion = input.sourceVersions.get(targetFile.path);
    const testVersion = input.testVersions.get(testFile.path);
    const text = input.sourceTexts.get(testFile.path);
    if (!sourceVersion || !testVersion || !text || !sameContentHash(sourceVersion.sourceHash, targetFile.contentHash) || !sameContentHash(testVersion.sourceHash, testFile.contentHash)) continue;
    const sourceFile = ts.createSourceFile(testFile.path, text, ts.ScriptTarget.Latest, true, testFile.syntaxKind);
    const indexedModules = new Set(input.program.imports.filter(item => item.fileId === testFile.id).map(item => item.moduleSpecifierEvidence));
    if (!indexedModules.has("node:test") || !["node:assert", "node:assert/strict"].some(module => indexedModules.has(module))) continue;
    const importedBindings = nodeTestAndAssertBindings(sourceFile);
    if (!importedBindings.test.size || !importedBindings.assert.size) continue;
    const targetCalls = callsByFile.get(testFile.id) ?? [];
    const declaration = input.program.symbols.find(symbol => symbol.id === targetSymbolId);
    const targetName = declaration?.nameEvidence;
    if (!targetName) continue;
    const boundCall = targetCalls.find(call => call.id === relation.callId && call.targetSymbolId === targetSymbolId);
    if (!boundCall) continue;
    const assertSpans = new Set<number>();
    visit(sourceFile, node => {
      if (!ts.isCallExpression(node) || !insideNodeTestCallback(node, importedBindings.test, sourceFile)
        || !isCanonicalAssertCall(node, importedBindings.assert)) return;
      const [actual, expected] = node.arguments;
      if (!actual || !expected) return;
      const actualCalls: ts.CallExpression[] = [];
      visit(actual, child => { if (ts.isCallExpression(child)) actualCalls.push(child); });
      for (const subject of actualCalls) {
        const call = targetCalls.find(item => item.span.start === subject.getStart(sourceFile) && item.span.end === subject.end && item.targetSymbolId === targetSymbolId);
        if (!call || call.id !== boundCall.id) continue;
        const args = subject.arguments.map(argument => literalValue(argument, sourceFile));
        const result = literalValue(expected, sourceFile);
        if (!args.every(value => value.ok) || !result.ok) continue;
        const trace = ownedInvocationTrace({ subject, assertion: node, sourceFile, text, importedBindings,
          targetCalls, program: input.program, files, sourceVersions: input.sourceVersions });
        if (!trace) continue;
        const inputStart = subject.arguments[0]?.getStart(sourceFile) ?? subject.getStart(sourceFile);
        const inputEnd = subject.arguments.at(-1)?.end ?? subject.end;
        const contract = {
          targetSymbolId,
          targetName,
          bindingResolverId: "scce.source_contract.typescript_checker.v1",
          languageId: targetFile.syntaxKind === ts.ScriptKind.TS || targetFile.syntaxKind === ts.ScriptKind.TSX ? "typescript" as const : "javascript" as const,
          sourcePath: targetFile.path, sourceHash: sourceVersion.sourceHash, sourceVersionId: sourceVersion.sourceVersionId,
          testPath: testFile.path, testHash: testVersion.sourceHash, testSourceVersionId: testVersion.sourceVersionId,
          arguments: args.map(value => value.value), expectedResult: result.value,
          ...(trace.stateful ? { invocations: trace.invocations } : {}),
          inputSpan: exactSpan(text, inputStart, inputEnd), expectedSpan: exactSpan(text, expected.getStart(sourceFile), expected.end),
          callSpan: exactSpan(text, subject.getStart(sourceFile), subject.end),
          assertionSpan: exactSpan(text, node.getStart(sourceFile), node.end)
        } satisfies SourceOwnedTestCase;
        const key = `${testFile.path}:${node.getStart(sourceFile)}:${targetSymbolId}`;
        if (!assertSpans.has(node.getStart(sourceFile))) { assertSpans.add(node.getStart(sourceFile)); out.push(contract); }
        void key;
      }
    });
  }
  return out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.testPath.localeCompare(b.testPath) || a.assertionSpan.start - b.assertionSpan.start);
}
function ownedInvocationTrace(input: {
  subject: ts.CallExpression; assertion: ts.CallExpression; sourceFile: ts.SourceFile; text: string;
  importedBindings: { test: ReadonlySet<string>; assert: ReadonlySet<string> };
  targetCalls: readonly TypeScriptSemanticCall[]; program: TypeScriptSemanticProgramIndex;
  files: ReadonlyMap<string, TypeScriptSemanticFile>;
  sourceVersions: ReadonlyMap<string, { sourceVersionId: string; sourceHash: string }>;
}): { invocations: SourceOwnedInvocation[]; stateful: boolean } | undefined {
  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  for (let parent: ts.Node | undefined = input.assertion.parent; parent; parent = parent.parent) {
    if (!(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) || !ts.isBlock(parent.body)) continue;
    const owner = parent.parent;
    if (ts.isCallExpression(owner) && ts.isIdentifier(owner.expression) && input.importedBindings.test.has(owner.expression.text)) { callback = parent; break; }
  }
  if (!callback || !ts.isBlock(callback.body)) return undefined;
  const invocations: SourceOwnedInvocation[] = [];
  let reached = false, stateful = false;
  for (const statement of callback.body.statements) {
    if (ts.isEmptyStatement(statement)) continue;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
    const expression = statement.expression;
    const assertion = isCanonicalAssertCall(expression, input.importedBindings.assert);
    const subject = assertion ? expression.arguments[0] : expression;
    if (!subject || !ts.isCallExpression(subject) || assertion && !literalValue(expression.arguments[1]!, input.sourceFile).ok) return undefined;
    const call = input.targetCalls.find(row => row.span.start === subject.getStart(input.sourceFile) && row.span.end === subject.end);
    const declarations = call ? input.program.declarations.filter(row => row.symbolId === call.targetSymbolId) : [];
    const owners = declarations.flatMap(row => {
      const file = input.files.get(row.fileId), version = file && input.sourceVersions.get(file.path);
      return file && version && sameContentHash(version.sourceHash, file.contentHash) ? [{ file, version }] : [];
    });
    if (!call || !owners.length || new Set(owners.map(row => row.file.path)).size !== 1) return undefined;
    const targetName = input.program.symbols.find(row => row.id === call.targetSymbolId)?.nameEvidence;
    const args = subject.arguments.map(argument => literalValue(argument, input.sourceFile));
    if (!targetName || !args.every(row => row.ok)) return undefined;
    stateful ||= !assertion;
    if (!reached) {
      const { file, version } = owners[0]!;
      invocations.push({ targetSymbolId: call.targetSymbolId, targetName, sourcePath: file.path,
        sourceHash: version.sourceHash, sourceVersionId: version.sourceVersionId, arguments: args.map(row => row.value),
        inputSpan: exactSpan(input.text, subject.arguments[0]?.getStart(input.sourceFile) ?? subject.getStart(input.sourceFile), subject.arguments.at(-1)?.end ?? subject.end),
        callSpan: exactSpan(input.text, subject.getStart(input.sourceFile), subject.end) });
    }
    if (expression === input.assertion && subject === input.subject) reached = true;
  }
  return reached ? { invocations, stateful } : undefined;
}

function sameContentHash(left: string, right: string): boolean { return left.replace(/^sha256[:_]/u, "").toLowerCase() === right.replace(/^sha256[:_]/u, "").toLowerCase(); }

function nodeTestAndAssertBindings(sourceFile: ts.SourceFile): { test: Set<string>; assert: Set<string> } {
  const test = new Set<string>(); const assert = new Set<string>(); const shadowed = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (module !== "node:test" && module !== "node:assert" && module !== "node:assert/strict") continue;
    const clause = statement.importClause;
    const into = module === "node:test" ? test : assert;
    if (clause?.name) into.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) into.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if ((module === "node:test" && (imported === "test" || imported === "it"))
          || (module !== "node:test" && ["strictEqual", "deepStrictEqual"].includes(imported))) into.add(element.name.text);
      }
    }
  }
  // Conservatively reject a binding shadowed by any local declaration.
  visit(sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) shadowed.add(node.name.text);
    if (ts.isFunctionDeclaration(node) && node.name) shadowed.add(node.name.text);
  });
  for (const name of shadowed) { test.delete(name); assert.delete(name); }
  return { test, assert };
}

function isCanonicalAssertCall(node: ts.CallExpression, imports: ReadonlySet<string>): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return imports.has(expression.text) && ["strictEqual", "deepStrictEqual"].includes(expression.text) && node.arguments.length === 2;
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression) || !imports.has(expression.expression.text)) return false;
  return ["strictEqual", "deepStrictEqual"].includes(expression.name.text) && node.arguments.length === 2;
}
function insideNodeTestCallback(node: ts.Node, bindings: ReadonlySet<string>, sourceFile: ts.SourceFile): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent && parent !== sourceFile; child = parent, parent = parent.parent) {
    if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression) || !bindings.has(parent.expression.text)) continue;
    return parent.arguments.some(argument => argument === child || argument.pos <= node.pos && argument.end >= node.end);
  }
  return false;
}
function literalValue(node: ts.Expression, sourceFile: ts.SourceFile): { ok: true; value: unknown } | { ok: false } {
  if (ts.isParenthesizedExpression(node)) return literalValue(node.expression, sourceFile);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.text };
  if (ts.isNumericLiteral(node)) { const value = Number(node.text); return Number.isFinite(value) ? { ok: true, value } : { ok: false }; }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return { ok: true, value: -Number(node.operand.text) };
  if (ts.isArrayLiteralExpression(node)) { const values = node.elements.map(element => literalValue(element, sourceFile)); return values.every(value => value.ok) ? { ok: true, value: values.map(value => value.value) } : { ok: false }; }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return { ok: false };
      const value = literalValue(property.initializer, sourceFile); if (!value.ok) return value; out[property.name.text] = value.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false };
}
function visit(node: ts.Node, fn: (node: ts.Node) => void): void { fn(node); node.forEachChild(child => visit(child, fn)); }
function exactSpan(text: string, start: number, end: number) { return { start, end, textHash: `sha256:${createHash("sha256").update(text.slice(start, end), "utf8").digest("hex")}` }; }

export function sourceOwnedTestContractProjections(cases: readonly SourceOwnedTestCase[], sourceUriBase: string): Map<string, JsonValue[]> {
  const result = new Map<string, JsonValue[]>(), grouped = new Map<string, SourceOwnedTestCase[]>();
  for (const item of cases) grouped.set(item.sourcePath, [...(grouped.get(item.sourcePath) ?? []), item]);
  for (const [sourcePath, values] of grouped) {
    if (values.length < 2) continue;
    const bySymbol = new Map<string, typeof values>();
    for (const value of values) bySymbol.set(value.targetSymbolId, [...(bySymbol.get(value.targetSymbolId) ?? []), value]);
    const contracts: JsonValue[] = [];
    for (const [targetSymbolId, symbolCases] of bySymbol) {
      if (symbolCases.length < 2) continue;
      contracts.push(toJsonValue({
        schema: "scce.source_owned_test_contract.v1",
        repositoryFamily: sourceUriBase,
        sourcePath,
        sourceHash: symbolCases[0]!.sourceHash,
        sourceVersionId: symbolCases[0]!.sourceVersionId,
        formalLanguage: symbolCases[0]!.languageId,
        targetSymbolId,
        targetName: symbolCases[0]!.targetName,
        bindingResolverIds: [...new Set(symbolCases.map(row => row.bindingResolverId).filter(Boolean))],
        ...(symbolCases.some(row => row.nativeAbi || row.invocations?.some(invocation => invocation.nativeAbi))
          ? { nativeAbiRecipe: "scce.source_owned_native_abi.v2" } : {}),
        cases: symbolCases
      }));
    }
    if (contracts.length) result.set(sourcePath, contracts);
  }
  return result;
}
