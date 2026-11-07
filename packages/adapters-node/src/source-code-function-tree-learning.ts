// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { sourceCodeFunctionConstructionId, type ProgramExpression, type SourceCodeFunctionConstruction } from "@scce/kernel";
import { withRepositorySyntaxTree, type TreeSitterLanguageId } from "./tree-sitter-syntax.js";

interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly namedChildren: readonly SyntaxNode[];
  readonly children: readonly SyntaxNode[];
  readonly parent?: SyntaxNode;
  readonly hasError?: boolean;
  readonly isError?: boolean;
  readonly isMissing?: boolean;
  childForFieldName(name: string): SyntaxNode | null;
}

const TREE_LANGUAGE_BY_FORMAL_LANGUAGE: Readonly<Record<string, TreeSitterLanguageId | undefined>> = {
  python: "python",
  rust: "rust",
  kotlin: "kotlin"
};

/** Lowers only pure callable bodies whose observed numeric behavior matches the shared IR. */
export async function compileTreeSitterSourceCodeFunctions(input: {
  text: string;
  path: string;
  languageId: string;
  sourceHash: string;
}): Promise<SourceCodeFunctionConstruction[]> {
  const treeLanguage = TREE_LANGUAGE_BY_FORMAL_LANGUAGE[input.languageId];
  if (!treeLanguage) return [];
  const parsed = await withRepositorySyntaxTree({ fileId: input.path, languageId: treeLanguage, text: input.text }, root => {
    return lowerRoot({ root: root as unknown as SyntaxNode, ...input });
  });
  return parsed ?? [];
}

function lowerRoot(input: { root: SyntaxNode; text: string; path: string; languageId: string; sourceHash: string }): SourceCodeFunctionConstruction[] {
  const out: SourceCodeFunctionConstruction[] = [];
  for (const node of input.root.namedChildren) {
    if (!callableNode(node.type, input.languageId)) continue;
    if (containsParseRecovery(node)) continue;
    const name = node.childForFieldName("name") ?? (input.languageId === "kotlin" ? node.namedChildren.find(child => child.type === "simple_identifier") : undefined);
    const parametersNode = node.childForFieldName("parameters") ?? node.childForFieldName("function_value_parameters")
      ?? (input.languageId === "kotlin" ? node.namedChildren.find(child => child.type === "function_value_parameters") : undefined);
    const body = node.childForFieldName("body") ?? (input.languageId === "kotlin" ? node.namedChildren.find(child => child.type === "function_body") : undefined);
    if (!name || !parametersNode || !body) continue;
    const parameters = callableParameters(parametersNode, input.languageId);
    if (!parameters || new Set(parameters.map(parameter => parameter.name)).size !== parameters.length) continue;
    const program = expressionFromBody(body, parameters.map(parameter => parameter.name), input.languageId);
    if (!program) continue;
    if (input.languageId !== "python" && !nativeFloatingArithmeticSupported(node, body, parameters, input.languageId)) continue;
    const sourceStart = sourceOffset(input.text, node.startIndex);
    const sourceEnd = sourceOffset(input.text, node.endIndex);
    if (sourceStart === undefined || sourceEnd === undefined || sourceEnd <= sourceStart) continue;
    const sourceText = input.text.slice(sourceStart, sourceEnd);
    const localParameters = parameters.map(parameter => {
      const declarationStart = sourceOffset(input.text, parameter.node.startIndex);
      const declarationEnd = sourceOffset(input.text, parameter.node.endIndex);
      if (declarationStart === undefined || declarationEnd === undefined) return undefined;
      const references: Array<{ start: number; end: number }> = [];
      visit(body, part => {
        if (part.type !== parameter.identifierType || part.text !== parameter.name || isNonReferenceName(part)) return;
        const start = sourceOffset(input.text, part.startIndex);
        const end = sourceOffset(input.text, part.endIndex);
        if (start !== undefined && end !== undefined && start >= sourceStart && end <= sourceEnd) references.push({ start: start - sourceStart, end: end - sourceStart });
      });
      return { name: parameter.name, declarationStart: declarationStart - sourceStart, declarationEnd: declarationEnd - sourceStart, references };
    });
    if (localParameters.some(parameter => !parameter)) continue;
    const callableStart = sourceOffset(input.text, name.startIndex);
    const callableEnd = sourceOffset(input.text, name.endIndex);
    if (callableStart === undefined || callableEnd === undefined || input.text.slice(callableStart, callableEnd) !== name.text) continue;
    const material: Omit<SourceCodeFunctionConstruction, "id"> = {
      schema: "scce.source_code_function_construction.v1",
      languageId: input.languageId,
      sourceHash: input.sourceHash,
      sourceStart,
      sourceEnd,
      sourceText,
      dependencies: [],
      callable: { name: name.text, start: callableStart - sourceStart, end: callableEnd - sourceStart },
      parameters: localParameters as NonNullable<(typeof localParameters)[number]>[],
      expression: program.expression,
      ...(program.bindings.length ? { bindings: program.bindings } : {})
    };
    out.push({ ...material, id: sourceCodeFunctionConstructionId(material) });
  }
  return out;
}

function callableNode(type: string, languageId: string): boolean {
  return (languageId === "python" && type === "function_definition")
    || (languageId === "rust" && type === "function_item")
    || (languageId === "kotlin" && type === "function_declaration");
}

function callableParameters(node: SyntaxNode, languageId: string): Array<{ name: string; node: SyntaxNode; identifierType: string; declaredType?: string }> | undefined {
  const allowed = languageId === "python"
    ? new Set(["identifier", "typed_parameter"])
    : languageId === "rust" ? new Set(["parameter"])
      : new Set(["parameter", "function_value_parameter"]);
  const parameters: Array<{ name: string; node: SyntaxNode; identifierType: string; declaredType?: string }> = [];
  for (const parameter of node.namedChildren) {
    if (!allowed.has(parameter.type)) return undefined;
    const name = parameter.type === "identifier" ? parameter : parameter.childForFieldName("name")
      ?? parameter.childForFieldName("pattern") ?? parameter.namedChildren[0];
    if (!name || (name.type !== "identifier" && name.type !== "simple_identifier")) return undefined;
    const type = parameter.childForFieldName("type") ?? (languageId === "kotlin" ? parameter.namedChildren.find(child => child !== name) : undefined);
    parameters.push({ name: name.text, node: name, identifierType: name.type, ...(type ? { declaredType: type.text } : {}) });
  }
  return parameters;
}

function nativeFloatingArithmeticSupported(callable: SyntaxNode, body: SyntaxNode, parameters: readonly { name: string; declaredType?: string }[], languageId: string): boolean {
  const environment = new Map<string, "floating" | "integer" | "unknown">();
  const floatingType = languageId === "rust" ? "f64" : "Double";
  for (const parameter of parameters) environment.set(parameter.name, parameter.declaredType === floatingType ? "floating" : "unknown");
  let hasArithmetic = false;
  const inspect = (node: SyntaxNode): boolean => {
    if (isArithmeticNode(node, languageId)) {
      hasArithmetic = true;
      const operands = arithmeticOperands(node);
      if (!operands.length || operands.some(operand => numericType(operand, environment, languageId) !== "floating")) return false;
    }
    for (const child of node.namedChildren) if (!inspect(child)) return false;
    return true;
  };
  for (const statement of statementsIn(body, languageId)) {
    const local = localBinding(statement, languageId);
    if (local) {
      if (!inspect(local.value)) return false;
      const inferred = numericType(local.value, environment, languageId);
      if (local.declaredType && local.declaredType !== floatingType && inferred === "floating" && containsArithmeticNode(local.value, languageId)) return false;
      environment.set(local.name, local.declaredType === floatingType ? "floating" : local.declaredType ? "unknown" : inferred);
      continue;
    }
    if (!inspect(statement)) return false;
  }
  if (!hasArithmetic) return true;
  const result = terminalExpression(body, languageId);
  if (!result || numericType(result, environment, languageId) !== "floating") return false;
  const declaredReturnType = returnType(callable, languageId);
  if (languageId === "rust" && declaredReturnType !== floatingType) return false;
  return declaredReturnType === undefined || declaredReturnType === floatingType;
}

function returnType(callable: SyntaxNode, languageId: string): string | undefined {
  if (languageId === "rust") return callable.childForFieldName("return_type")?.text;
  const parameters = callable.namedChildren.find(child => child.type === "function_value_parameters");
  const body = callable.namedChildren.find(child => child.type === "function_body");
  return callable.namedChildren.find(child => child !== parameters && child !== body && child.type !== "simple_identifier")?.text;
}

function terminalExpression(body: SyntaxNode, languageId: string): SyntaxNode | undefined {
  if (languageId === "rust") {
    const terminal = body.namedChildren.at(-1);
    if (terminal?.type === "return_expression") return terminal.namedChildren.at(-1);
    return terminal;
  }
  if (languageId === "kotlin") {
    const content = body.type === "function_body" ? body.namedChildren[0] : body;
    if (!content) return undefined;
    if (content.type !== "block" && content.type !== "statements") return content;
    const terminal = content.namedChildren.at(-1);
    if (terminal?.type === "jump_expression" && terminal.children.some(child => child.type === "return")) return terminal.namedChildren.at(-1);
  }
  return undefined;
}

function statementsIn(body: SyntaxNode, languageId: string): readonly SyntaxNode[] {
  if (languageId === "kotlin" && body.type === "function_body" && body.namedChildren.length === 1) {
    const content = body.namedChildren[0]!;
    if (content.type === "statements" || content.type === "block") return content.namedChildren;
  }
  return body.namedChildren;
}

function localBinding(statement: SyntaxNode, languageId: string): { name: string; declaredType?: string; value: SyntaxNode } | undefined {
  if (languageId === "rust" && statement.type === "let_declaration") {
    const name = statement.childForFieldName("pattern");
    const value = statement.childForFieldName("value");
    const type = statement.childForFieldName("type");
    return name?.type === "identifier" && value ? { name: name.text, ...(type ? { declaredType: type.text } : {}), value } : undefined;
  }
  if (languageId === "kotlin" && statement.type === "property_declaration") {
    const declaration = statement.namedChildren.find(child => child.type === "variable_declaration");
    const name = declaration?.namedChildren.find(child => child.type === "simple_identifier");
    const type = declaration?.namedChildren.find(child => child !== name);
    const value = statement.childForFieldName("value") ?? statement.namedChildren.find(child => child !== declaration && child.type !== "binding_pattern_kind");
    return name && value ? { name: name.text, ...(type ? { declaredType: type.text } : {}), value } : undefined;
  }
  return undefined;
}

function isArithmeticNode(node: SyntaxNode, languageId: string): boolean {
  return languageId === "python" ? node.type === "binary_operator" || node.type === "unary_operator"
    : node.type === "binary_expression" || node.type === "additive_expression" || node.type === "multiplicative_expression"
      || node.type === "unary_expression";
}

function containsArithmeticNode(node: SyntaxNode, languageId: string): boolean {
  return isArithmeticNode(node, languageId) || node.namedChildren.some(child => containsArithmeticNode(child, languageId));
}

function arithmeticOperands(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "unary_operator" || node.type === "unary_expression") return node.namedChildren.slice(-1);
  const left = node.childForFieldName("left") ?? node.namedChildren[0];
  const right = node.childForFieldName("right") ?? node.namedChildren.at(-1);
  return left && right && left !== right ? [left, right] : [];
}

function numericType(node: SyntaxNode, environment: ReadonlyMap<string, "floating" | "integer" | "unknown">, languageId: string): "floating" | "integer" | "unknown" {
  if (["identifier", "simple_identifier"].includes(node.type)) return environment.get(node.text) ?? "unknown";
  if (["float", "float_literal", "real_literal"].includes(node.type)) return "floating";
  if (["integer", "integer_literal", "decimal_integer_literal"].includes(node.type)) return "integer";
  if (["parenthesized_expression", "parenthesized", "expression"].includes(node.type) && node.namedChildren.length === 1) {
    return numericType(node.namedChildren[0]!, environment, languageId);
  }
  if (["unary_operator", "unary_expression"].includes(node.type)) {
    const operand = node.namedChildren.at(-1);
    return operand ? numericType(operand, environment, languageId) : "unknown";
  }
  if (isArithmeticNode(node, languageId)) {
    const [left, right] = arithmeticOperands(node);
    if (!right) return left ? numericType(left, environment, languageId) : "unknown";
    const leftType = numericType(left!, environment, languageId);
    const rightType = numericType(right, environment, languageId);
    return leftType === "floating" && rightType === "floating" ? "floating"
      : leftType === "integer" && rightType === "integer" ? "integer"
        : "unknown";
  }
  return "unknown";
}

function containsParseRecovery(node: SyntaxNode): boolean {
  if (node.isError || node.isMissing || node.hasError) return true;
  return node.children.some(child => containsParseRecovery(child));
}

function expressionFromBody(body: SyntaxNode, parameters: readonly string[], languageId: string): { expression: ProgramExpression; bindings: ProgramExpression[] } | undefined {
  if (languageId === "kotlin" && body.type === "function_body" && body.namedChildren.length === 1) {
    const content = body.namedChildren[0]!;
    if (content.type === "statements" || content.type === "block") return expressionFromBody(content, parameters, languageId);
    if (content.type !== "block") {
      const expression = expressionFromNode(content, parameters, new Map(), languageId);
      return expression ? { expression, bindings: [] } : undefined;
    }
    return expressionFromBody(content, parameters, languageId);
  }
  const statements = body.namedChildren;
  const bindings = new Map<string, ProgramExpression>();
  const expressions: ProgramExpression[] = [];
  for (const [index, statement] of statements.entries()) {
    const executable = languageId === "python" && statement.type === "expression_statement" && statement.namedChildren.length === 1
      ? statement.namedChildren[0]!
      : statement;
    const assignment = assignmentParts(executable, languageId);
    if (assignment) {
      if (index === statements.length - 1 || parameters.includes(assignment.name) || bindings.has(assignment.name)) return undefined;
      const expression = expressionFromNode(assignment.value, parameters, bindings, languageId);
      if (!expression) return undefined;
      bindings.set(assignment.name, { kind: "argument", index: parameters.length + expressions.length });
      expressions.push(expression);
      continue;
    }
    const returnValue = returnedExpression(statement, languageId);
    if (!returnValue && languageId === "rust" && index === statements.length - 1 && statement.type !== "expression_statement") {
      const expression = expressionFromNode(statement, parameters, bindings, languageId);
      if (expression) return { expression, bindings: expressions };
    }
    if (!returnValue || index !== statements.length - 1) return undefined;
    const expression = expressionFromNode(returnValue, parameters, bindings, languageId);
    return expression ? { expression, bindings: expressions } : undefined;
  }
  return undefined;
}

function assignmentParts(statement: SyntaxNode, languageId: string): { name: string; value: SyntaxNode } | undefined {
  if (languageId === "python" && statement.type === "assignment") {
    const left = statement.childForFieldName("left");
    const value = statement.childForFieldName("right");
    return left?.type === "identifier" && value ? { name: left.text, value } : undefined;
  }
  if (languageId === "rust" && statement.type === "let_declaration") {
    const pattern = statement.childForFieldName("pattern");
    const value = statement.childForFieldName("value");
    return pattern?.type === "identifier" && value ? { name: pattern.text, value } : undefined;
  }
  if (languageId === "kotlin" && statement.type === "property_declaration") {
    const declaration = statement.namedChildren.find(child => child.type === "variable_declaration");
    const name = declaration?.namedChildren[0];
    const value = statement.childForFieldName("value") ?? statement.namedChildren.at(-1);
    return name?.type === "simple_identifier" && value && value !== declaration ? { name: name.text, value } : undefined;
  }
  return undefined;
}

function returnedExpression(statement: SyntaxNode, languageId: string): SyntaxNode | undefined {
  const returnTypes = languageId === "python" ? new Set(["return_statement"])
    : languageId === "rust" ? new Set(["return_expression"])
      : new Set(["return_expression"]);
  if (returnTypes.has(statement.type)) return statement.namedChildren[0];
  if (languageId === "rust" && statement.type === "expression_statement") {
    const child = statement.namedChildren[0];
    if (child?.type === "return_expression") return child.namedChildren[0];
  }
  if (languageId === "kotlin" && statement.type === "return_expression") return statement.namedChildren[0];
  if (languageId === "kotlin" && statement.type === "jump_expression" && statement.children.some(child => child.type === "return")) return statement.namedChildren.at(-1);
  return undefined;
}

function expressionFromNode(node: SyntaxNode, parameters: readonly string[], bindings: ReadonlyMap<string, ProgramExpression>, languageId: string): ProgramExpression | undefined {
  if (["parenthesized_expression", "parenthesized", "expression", "value_expression"].includes(node.type) && node.namedChildren.length === 1) {
    return expressionFromNode(node.namedChildren[0]!, parameters, bindings, languageId);
  }
  if (["identifier", "simple_identifier"].includes(node.type)) {
    const binding = bindings.get(node.text);
    if (binding) return binding;
    const index = parameters.indexOf(node.text);
    return index >= 0 ? { kind: "argument", index } : undefined;
  }
  if (["integer", "float", "integer_literal", "float_literal", "decimal_integer_literal", "real_literal"].includes(node.type)) {
    const value = Number(node.text);
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? { kind: "literal", value } : undefined;
  }
  if (["unary_operator", "unary_expression"].includes(node.type)) {
    const operand = node.namedChildren.at(-1);
    const operator = node.children.find(child => child.endIndex <= (operand?.startIndex ?? node.endIndex) && child.text.trim().length > 0);
    if (operator?.text === "-" && operand) {
      const lowered = expressionFromNode(operand, parameters, bindings, languageId);
      return lowered ? { kind: "unary", operator: "negate", operand: lowered } : undefined;
    }
    return undefined;
  }
  if (["binary_operator", "binary_expression", "additive_expression", "multiplicative_expression"].includes(node.type)) {
    const left = node.childForFieldName("left") ?? node.namedChildren[0];
    const right = node.childForFieldName("right") ?? node.namedChildren.at(-1);
    if (!left || !right || left === right) return undefined;
    const operator = node.children.find(child => child.startIndex >= left.endIndex && child.endIndex <= right.startIndex && child.text.trim().length > 0);
    const irOperator = operator?.text === "+" ? "add" : operator?.text === "-" ? "subtract"
      : operator?.text === "*" ? "multiply" : operator?.text === "/" ? "divide" : undefined;
    const loweredLeft = expressionFromNode(left, parameters, bindings, languageId);
    const loweredRight = expressionFromNode(right, parameters, bindings, languageId);
    return irOperator && loweredLeft && loweredRight ? { kind: "binary", operator: irOperator, left: loweredLeft, right: loweredRight } : undefined;
  }
  if (languageId === "python" && node.type === "tuple") {
    const items = node.namedChildren.map(child => expressionFromNode(child, parameters, bindings, languageId));
    return items.length && items.every((item): item is ProgramExpression => item !== undefined) ? { kind: "sequence", items } : undefined;
  }
  return undefined;
}

function isNonReferenceName(node: SyntaxNode): boolean {
  const parent = node.parent;
  return parent?.childForFieldName("name") === node || parent?.childForFieldName("attribute") === node;
}

function visit(node: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
  visitor(node);
  for (const child of node.namedChildren) visit(child, visitor);
}

function sourceOffset(text: string, offset: number): number | undefined {
  return Number.isInteger(offset) && offset >= 0 && offset <= text.length ? offset : undefined;
}
