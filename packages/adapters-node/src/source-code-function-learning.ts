// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import ts from "typescript";
import { sourceCodeFunctionConstructionId, type SourceCodeFunctionConstruction, type ProgramExpression } from "@scce/kernel";
import { compileTreeSitterSourceCodeFunctions } from "./source-code-function-tree-learning.js";

export const SOURCE_CODE_FUNCTION_COMPILER_RECIPE_ID = "scce.source_code_function_compiler.v3";

export async function compileSourceCodeFunctionsAsync(input: { text: string; path: string; languageId?: string; sourceHash: string }): Promise<SourceCodeFunctionConstruction[]> {
  if (input.languageId === "typescript" || input.languageId === "javascript") return compileSourceCodeFunctions(input);
  return compileTreeSitterSourceCodeFunctions({ ...input, languageId: input.languageId ?? "" });
}

/** The compiler supplies binding coordinates and a bounded pure expression; every emitted code byte belongs to the source. */
export function compileSourceCodeFunctions(input: { text: string; path: string; languageId?: string; sourceHash: string }): SourceCodeFunctionConstruction[] {
  if (input.languageId !== "typescript" && input.languageId !== "javascript") return [];
  const source = ts.createSourceFile(input.path, input.text, ts.ScriptTarget.Latest, true, input.languageId === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: SourceCodeFunctionConstruction[] = [];
  const typeDeclarations = source.statements.filter(statement => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement));
  const callables: Array<{ node: ts.Node; name: ts.Identifier; parameters: readonly ts.ParameterDeclaration[]; body: ts.ConciseBody; type?: ts.TypeNode }> = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && !statement.asteriskToken
      && !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      callables.push({ node: statement, name: statement.name, parameters: statement.parameters, body: statement.body, type: statement.type });
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
      const declaration = statement.declarationList.declarations[0]!;
      const initializer = declaration.initializer;
      if (ts.isIdentifier(declaration.name) && initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        && !initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        && !(ts.isFunctionExpression(initializer) && initializer.asteriskToken)) {
        callables.push({ node: statement, name: declaration.name, parameters: initializer.parameters, body: initializer.body, type: initializer.type });
      }
    }
  }
  for (const callable of callables) {
    const { node, name } = callable;
    if (callable.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.initializer || parameter.questionToken)) continue;
    const names = callable.parameters.map(parameter => (parameter.name as ts.Identifier).text);
    const program = expressionFromBody(callable.body, names);
    if (!program || new Set(names).size !== names.length) continue;
    const sourceStart = node.getStart(source);
    const sourceEnd = node.getEnd();
    const dependencies: string[] = [];
    let unresolvedType = false;
    const seenTypes = new Set<string>();
    const includeType = (type: ts.TypeNode | undefined) => {
      if (!type) return;
      const visit = (part: ts.Node): void => {
        if (ts.isTypeReferenceNode(part) && ts.isIdentifier(part.typeName)) {
          const name = part.typeName.text;
          if (!seenTypes.has(name)) {
            seenTypes.add(name);
            const declaration = typeDeclarations.find(declaration => declaration.name.text === name);
            if (!declaration) { unresolvedType = true; return; }
            ts.forEachChild(declaration, visit);
            dependencies.push(declaration.getText(source));
          }
        }
        ts.forEachChild(part, visit);
      };
      visit(type);
    };
    callable.parameters.forEach(parameter => includeType(parameter.type));
    includeType(callable.type);
    if (unresolvedType) continue;
    const parameters = callable.parameters.map(parameter => {
      const name = parameter.name as ts.Identifier;
      const references: Array<{ start: number; end: number }> = [];
      const visit = (part: ts.Node): void => {
        if (ts.isIdentifier(part) && part.text === name.text && !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part)) {
          references.push({ start: part.getStart(source) - sourceStart, end: part.getEnd() - sourceStart });
        }
        ts.forEachChild(part, visit);
      };
      visit(callable.body);
      return { name: name.text, declarationStart: name.getStart(source) - sourceStart, declarationEnd: name.getEnd() - sourceStart, references };
    });
    const material: Omit<SourceCodeFunctionConstruction, "id"> = {
      schema: "scce.source_code_function_construction.v1", languageId: input.languageId, sourceHash: input.sourceHash,
      sourceStart, sourceEnd, sourceText: input.text.slice(sourceStart, sourceEnd), dependencies,
      callable: { name: name.text, start: name.getStart(source) - sourceStart, end: name.getEnd() - sourceStart },
      parameters, expression: program.expression,
      ...(program.bindings.length ? { bindings: program.bindings } : {})
    };
    out.push({ ...material, id: sourceCodeFunctionConstructionId(material) });
  }
  return out;
}

function expressionFromBody(body: ts.ConciseBody, parameters: readonly string[]): { expression: ProgramExpression; bindings: ProgramExpression[] } | undefined {
  if (!ts.isBlock(body)) {
    const expression = expressionFromSource(body, parameters);
    return expression ? { expression, bindings: [] } : undefined;
  }
  const bindings = new Map<string, ProgramExpression>();
  const expressions: ProgramExpression[] = [];
  for (const [index, statement] of body.statements.entries()) {
    if (ts.isReturnStatement(statement) && statement.expression && index === body.statements.length - 1) {
      const expression = expressionFromSource(statement.expression, parameters, bindings);
      return expression ? { expression, bindings: expressions } : undefined;
    }
    if (!ts.isVariableStatement(statement)) return undefined;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || parameters.includes(declaration.name.text) || bindings.has(declaration.name.text)) return undefined;
      const value = expressionFromSource(declaration.initializer, parameters, bindings);
      if (!value) return undefined;
      bindings.set(declaration.name.text, { kind: "argument", index: parameters.length + expressions.length });
      expressions.push(value);
    }
  }
  return undefined;
}

function expressionFromSource(node: ts.Expression, parameters: readonly string[], bindings: ReadonlyMap<string, ProgramExpression> = new Map()): ProgramExpression | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return expressionFromSource(node.expression, parameters, bindings);
  if (ts.isIdentifier(node)) {
    const bound = bindings.get(node.text);
    if (bound) return bound;
    const index = parameters.indexOf(node.text);
    return index >= 0 ? { kind: "argument", index } : undefined;
  }
  if (ts.isNumericLiteral(node)) return { kind: "literal", value: Number(node.text) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "value", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "value", value: node.kind === ts.SyntaxKind.TrueKeyword };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "value", value: null };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = expressionFromSource(node.operand, parameters, bindings);
    return operand ? { kind: "unary", operator: "negate", operand } : undefined;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "Math" && !parameters.includes("Math") && !bindings.has("Math")) {
    const operator = node.expression.name.text === "min" ? "minimum" : node.expression.name.text === "max" ? "maximum" : undefined;
    const arguments_ = node.arguments.map(argument => expressionFromSource(argument, parameters, bindings));
    if (!operator || !arguments_.length || !arguments_.every((argument): argument is ProgramExpression => argument !== undefined)) return undefined;
    return arguments_.slice(1).reduce<ProgramExpression>((left, right) => ({ kind: "binary", operator, left, right }), arguments_[0]!);
  }
  if (ts.isBinaryExpression(node)) {
    const left = expressionFromSource(node.left, parameters, bindings);
    const right = expressionFromSource(node.right, parameters, bindings);
    if (!left || !right) return undefined;
    const operator = new Map<ts.SyntaxKind, "add" | "subtract" | "multiply" | "divide">([
      [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "subtract"], [ts.SyntaxKind.AsteriskToken, "multiply"], [ts.SyntaxKind.SlashToken, "divide"]
    ]).get(node.operatorToken.kind);
    if (operator) return { kind: "binary", operator, left, right };
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return { kind: "equivalent", left, right };
  }
  if (ts.isConditionalExpression(node)) {
    const condition = expressionFromSource(node.condition, parameters, bindings);
    const whenTrue = expressionFromSource(node.whenTrue, parameters, bindings);
    const whenFalse = expressionFromSource(node.whenFalse, parameters, bindings);
    return condition && whenTrue && whenFalse ? { kind: "conditional", condition, whenTrue, whenFalse } : undefined;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const subject = expressionFromSource(node.expression, parameters, bindings);
    return subject ? { kind: "member", subject, key: node.name.text } : undefined;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const subject = expressionFromSource(node.expression, parameters, bindings);
    const key = ts.isNumericLiteral(node.argumentExpression) ? Number(node.argumentExpression.text) : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
    return subject && key !== undefined ? { kind: "member", subject, key } : undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(element => expressionFromSource(element, parameters, bindings));
    return items.every((item): item is ProgramExpression => item !== undefined) ? { kind: "sequence", items } : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: Array<{ key: string; value: ProgramExpression }> = [];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) return undefined;
      const value = expressionFromSource(property.initializer, parameters, bindings);
      if (!value) return undefined;
      entries.push({ key: property.name.text, value });
    }
    return { kind: "mapping", entries };
  }
  return undefined;
}
