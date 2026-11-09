// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import ts from "typescript";
import { toJsonValue, type JsonValue, type ProgramNativeCallableAbi, type ProgramNativeLiteral, type SourceVersionId, type EvidenceSpan, type LanguagePatternRecord, createHasher, canonicalStringify } from "@scce/kernel";
import { createHash } from "node:crypto";
import type { TypeScriptSemanticProgramIndex, TypeScriptSemanticCall, TypeScriptSemanticFile } from "./typescript-semantic-program-index.js";

export const SOURCE_OWNED_TEST_CONTRACT_SCHEMA = "scce.source_owned_test_contract.v1" as const;
export const SOURCE_OWNED_ASSERTION_FRAMEWORK_MODULES = Object.freeze(["vitest", "node:test", "node:assert", "node:assert/strict"] as const);

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
 * Extracts contracts only from a bounded TS semantic index and actual Node or Vitest test/assert imports.
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
    if (!sameContentHash(`sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`, testFile.contentHash)) continue;
    const sourceFile = ts.createSourceFile(testFile.path, text, ts.ScriptTarget.Latest, true, testFile.syntaxKind);
    const indexedImports = input.program.imports.filter(item => item.fileId === testFile.id);
    const indexedModules = new Set(indexedImports.map(item => item.moduleSpecifierEvidence));
    if (!indexedModules.has("vitest") && (!indexedModules.has("node:test") || !["node:assert", "node:assert/strict"].some(module => indexedModules.has(module)))) continue;
    const canonicalVitestModule = !indexedImports.some(item => item.moduleSpecifierEvidence === "vitest" && item.targetFileId);
    const importedBindings = testAndAssertionBindings(sourceFile, canonicalVitestModule);
    if (!importedBindings.test.size) continue;
    const targetCalls = callsByFile.get(testFile.id) ?? [];
    const declaration = input.program.symbols.find(symbol => symbol.id === targetSymbolId);
    const targetName = declaration?.nameEvidence;
    if (!targetName) continue;
    const boundCall = targetCalls.find(call => call.id === relation.callId && call.targetSymbolId === targetSymbolId);
    if (!boundCall) continue;
    const assertSpans = new Set<number>();
    visit(sourceFile, node => {
      if (!ts.isCallExpression(node)) return;
      const assertion = exactAssertion(node, importedBindings, sourceFile);
      if (!assertion || !testCallback(node, importedBindings)) return;
      const { actual, expected } = assertion;
      const actualCalls = ts.isCallExpression(actual) ? [actual] : [];
      for (const subject of actualCalls) {
        const call = targetCalls.find(item => item.span.start === subject.getStart(sourceFile) && item.span.end === subject.end && item.targetSymbolId === targetSymbolId);
        if (!call || call.id !== boundCall.id) continue;
        const args = subject.arguments.map(argument => literalValue(argument, sourceFile));
        if (importedBindings.expect.size && !args.every(value => value.ok && exactJsonLiteral(value.value))) continue;
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
  importedBindings: AssertionBindings;
  targetCalls: readonly TypeScriptSemanticCall[]; program: TypeScriptSemanticProgramIndex;
  files: ReadonlyMap<string, TypeScriptSemanticFile>;
  sourceVersions: ReadonlyMap<string, { sourceVersionId: string; sourceHash: string }>;
}): { invocations: SourceOwnedInvocation[]; stateful: boolean } | undefined {
  const callback = testCallback(input.assertion, input.importedBindings);
  if (!callback || !ts.isBlock(callback.body)) return undefined;
  const invocations: SourceOwnedInvocation[] = [];
  let reached = false, stateful = false;
  for (const statement of callback.body.statements) {
    if (ts.isEmptyStatement(statement)) continue;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
    const expression = statement.expression;
    const assertion = exactAssertion(expression, input.importedBindings, input.sourceFile);
    const subject = assertion ? assertion.actual : expression;
    if (!ts.isCallExpression(subject)) return undefined;
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
    if (input.importedBindings.expect.size && !args.every(row => exactJsonLiteral(row.value))) return undefined;
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

interface AssertionBindings {
  test: Set<string>; suites: Set<string>; vitestTest: Set<string>;
  assertNamespaces: Set<string>; assertMethods: Set<string>; expect: Set<string>;
}
function testAndAssertionBindings(sourceFile: ts.SourceFile, canonicalVitestModule: boolean): AssertionBindings {
  const bindings: AssertionBindings = { test: new Set(), suites: new Set(), vitestTest: new Set(), assertNamespaces: new Set(), assertMethods: new Set(), expect: new Set() };
  const hooks = new Set<string>(), mocks = new Set<string>(), shadowed = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const module = statement.moduleSpecifier.text, clause = statement.importClause;
    if (module !== "node:test" && module !== "node:assert" && module !== "node:assert/strict" && module !== "vitest") continue;
    if (module === "vitest" && !canonicalVitestModule) continue;
    if (clause?.name && module !== "vitest") (module === "node:test" ? bindings.test : bindings.assertNamespaces).add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) && module !== "vitest") {
      (module === "node:test" ? bindings.test : bindings.assertNamespaces).add(clause.namedBindings.name.text);
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text, local = element.name.text;
      if ((module === "node:test" || module === "vitest") && (imported === "test" || imported === "it")) {
        bindings.test.add(local); if (module === "vitest") bindings.vitestTest.add(local);
      }
      if ((module === "node:test" || module === "vitest") && imported === "describe") bindings.suites.add(local);
      if ((module === "node:assert" || module === "node:assert/strict") && (imported === "strictEqual" || imported === "deepStrictEqual")) bindings.assertMethods.add(local);
      if (module === "vitest" && imported === "expect") bindings.expect.add(local);
      if (module === "vitest" && imported === "vi") mocks.add(local);
      if (module === "vitest" && ["beforeEach", "afterEach", "beforeAll", "afterAll"].includes(imported)) hooks.add(local);
    }
  }
  const names = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) shadowed.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) names(element.name);
  };
  let customized = false;
  visit(sourceFile, node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) names(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) shadowed.add(node.name.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) shadowed.add(node.left.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && hooks.has(node.expression.text)) customized = true;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && bindings.expect.has(node.expression.text)) customized = true;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && mocks.has(node.expression.text)) customized = true;
    if (ts.isIdentifier(node) && (bindings.expect.has(node.text) || mocks.has(node.text)) && !ts.isImportSpecifier(node.parent)
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node && bindings.expect.has(node.text))) customized = true;
  });
  for (const group of Object.values(bindings)) for (const name of shadowed) group.delete(name);
  if (customized) { for (const name of bindings.vitestTest) bindings.test.delete(name); bindings.expect.clear(); }
  return bindings;
}
function exactAssertion(node: ts.CallExpression, bindings: AssertionBindings, sourceFile: ts.SourceFile): { actual: ts.Expression; expected: ts.Expression } | undefined {
  const expression = node.expression;
  if (node.arguments.length === 2 && (ts.isIdentifier(expression) && bindings.assertMethods.has(expression.text)
    || ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && bindings.assertNamespaces.has(expression.expression.text)
      && (expression.name.text === "strictEqual" || expression.name.text === "deepStrictEqual"))) {
    const expected = node.arguments[1]!;
    return literalValue(expected, sourceFile).ok ? { actual: node.arguments[0]!, expected } : undefined;
  }
  if (node.arguments.length !== 1 || !ts.isPropertyAccessExpression(expression) || !ts.isCallExpression(expression.expression)) return undefined;
  const expect = expression.expression;
  if (!ts.isIdentifier(expect.expression) || !bindings.expect.has(expect.expression.text) || expect.arguments.length !== 1) return undefined;
  if (expression.name.text !== "toBe" && expression.name.text !== "toStrictEqual") return undefined;
  const expected = node.arguments[0]!, value = literalValue(expected, sourceFile);
  if (!value.ok || !exactJsonLiteral(value.value) || expression.name.text === "toBe" && value.value !== null && typeof value.value === "object") return undefined;
  return { actual: expect.arguments[0]!, expected };
}
function exactJsonLiteral(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value === "string") return !value.includes("\u0000");
  if (Array.isArray(value)) return value.every(exactJsonLiteral);
  if (value && typeof value === "object") return Object.values(value).every(exactJsonLiteral);
  return value === null || typeof value === "boolean";
}
function testCallback(node: ts.Node, bindings: AssertionBindings): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent)) continue;
    const owner = parent.parent;
    if (!ts.isBlock(parent.body) || !ts.isCallExpression(owner) || !ts.isIdentifier(owner.expression) || !bindings.test.has(owner.expression.text)) return undefined;
    if (!bindings.vitestTest.has(owner.expression.text)) return parent;
    if (owner.arguments[1] !== parent || owner.arguments.length !== 2 || !literalTestName(owner.arguments[0])) return undefined;
    if (parent.parameters.length || parent.asteriskToken || parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
    let registration: ts.Node = owner;
    while (true) {
      if (!ts.isExpressionStatement(registration.parent)) return undefined;
      const container: ts.Node = registration.parent.parent;
      if (ts.isSourceFile(container)) return parent;
      if (!ts.isBlock(container) || !(ts.isArrowFunction(container.parent) || ts.isFunctionExpression(container.parent))) return undefined;
      const suite: ts.ArrowFunction | ts.FunctionExpression = container.parent;
      const call: ts.Node = suite.parent;
      if (suite.parameters.length || suite.asteriskToken || suite.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !bindings.suites.has(call.expression.text)
        || call.arguments[1] !== suite || call.arguments.length !== 2 || !literalTestName(call.arguments[0])) return undefined;
      registration = call;
    }
  }
  return undefined;
}
function literalTestName(node: ts.Expression | undefined): boolean { return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)); }
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
      if (property.name.text === "__proto__" || Object.prototype.hasOwnProperty.call(out, property.name.text)) return { ok: false };
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

export function sourceOwnedAssertionPatterns(input: {
  contracts: JsonValue | undefined; metadata: JsonValue; sourceSystem: string; profileId: string; sourceVersionId: SourceVersionId;
  originalSourceVersionId: SourceVersionId; evidence: readonly EvidenceSpan[]; hasher: ReturnType<typeof createHasher>; updatedAt: number;
}): LanguagePatternRecord[] {
  const metadata = jsonRecord(input.metadata);
  const contracts = input.contracts;
  const evidenceIds = input.evidence.filter(span => span.status === "promoted" && span.sourceVersionId === input.sourceVersionId).map(span => span.id);
  if (!Array.isArray(contracts) || !evidenceIds.length) return [];
  const patterns: LanguagePatternRecord[] = [];
  for (const value of contracts) {
    const row = jsonRecord(value);
    if (row.schema !== "scce.source_owned_test_contract.v1" || row.sourceVersionId !== input.sourceVersionId
      || row.sourceHash !== metadata.sourceHash || typeof row.sourcePath !== "string" || typeof row.formalLanguage !== "string"
      || typeof row.repositoryFamily !== "string" || typeof row.targetSymbolId !== "string" || !Array.isArray(row.cases) || row.cases.length < 2) continue;
    const material = { ...row, sourceSystem: input.sourceSystem };
    const id = `source.code.assertion.pattern.${input.hasher.digestHex(canonicalStringify({ profileId: input.profileId, sourceVersionId: input.sourceVersionId, material })).slice(0, 40)}`;
    patterns.push({ id, profileId: input.profileId, patternKind: "source_code_assertion_contract", support: row.cases.length, entropy: 0,
      patternJson: material, evidenceIds, updatedAt: input.updatedAt });
  }
  return patterns;
}


function jsonRecord(value:JsonValue|undefined):Record<string,JsonValue>{return value && typeof value==="object" && !Array.isArray(value)?value as Record<string,JsonValue>:{};}
