// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import ts from 'typescript';

export interface SourceSymbolMatch {
  path: string;
  line: number;
  column: number;
  kind: 'definition' | 'reference';
  role: 'declaration' | 'call' | 'construct' | 'reference';
  syntax: string;
  text: string;
  range: { start: number; end: number; coordinateSpace: 'utf16' };
  enclosingRange: { startLine: number; endLine: number };
}

export function sourceSymbolMatches(input: { path: string; text: string; symbol: string; callsOnly?: boolean }): SourceSymbolMatch[] {
  const source = ts.createSourceFile(input.path, input.text, ts.ScriptTarget.Latest, true);
  const result: SourceSymbolMatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === input.symbol) {
      const definition = isBindingName(node);
      const call = callRole(node);
      if (!input.callsOnly || call) {
        const start = node.getStart(source);
        const location = source.getLineAndCharacterOfPosition(start);
        let owner: ts.Node = node.parent;
        while (owner.parent && !ts.isSourceFile(owner.parent) && !ts.isFunctionLike(owner)
          && !ts.isClassLike(owner) && !ts.isStatement(owner)) owner = owner.parent;
        const ownerStart = source.getLineAndCharacterOfPosition(owner.getStart(source));
        const ownerEnd = source.getLineAndCharacterOfPosition(owner.getEnd());
        const lineStart = source.getPositionOfLineAndCharacter(location.line, 0);
        const nextLine = input.text.indexOf('\n', lineStart);
        result.push({ path: input.path, line: location.line + 1, column: location.character + 1,
          kind: definition ? 'definition' : 'reference', role: definition ? 'declaration' : call ?? 'reference',
          syntax: ts.SyntaxKind[node.parent.kind]!,
          text: input.text.slice(lineStart, nextLine < 0 ? undefined : nextLine).trim().slice(0, 200),
          range: { start, end: node.getEnd(), coordinateSpace: 'utf16' },
          enclosingRange: { startLine: ownerStart.line + 1, endLine: ownerEnd.line + 1 } });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function isBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return parent.name === node;
  if (ts.isNamespaceImport(parent) || ts.isImportClause(parent)) return parent.name === node;
  if (ts.isExportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent)) return parent.name === node;
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)
    || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)
    || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)
    || ts.isEnumMember(parent) || ts.isTypeParameterDeclaration(parent) || ts.isMethodDeclaration(parent)
    || ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isModuleDeclaration(parent))
    && parent.name === node;
}

function callRole(node: ts.Identifier): 'call' | 'construct' | undefined {
  let expression: ts.Node = node;
  if (ts.isPropertyAccessExpression(expression.parent) && expression.parent.name === expression) expression = expression.parent;
  while (ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent)
    || ts.isAsExpression(expression.parent) || ts.isTypeAssertionExpression(expression.parent)) expression = expression.parent;
  if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression) return 'call';
  if (ts.isNewExpression(expression.parent) && expression.parent.expression === expression) return 'construct';
  return undefined;
}
