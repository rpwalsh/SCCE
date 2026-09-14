// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import type { ProgramBehaviorRequirement } from "./types.js";

/** A language-neutral, one-argument arithmetic expression. */
export type ProgramExpression =
  | { readonly kind: "argument"; readonly index: 0 }
  | { readonly kind: "literal"; readonly value: number }
  | { readonly kind: "unary"; readonly operator: "negate"; readonly operand: ProgramExpression }
  | {
    readonly kind: "binary";
    readonly operator: "add" | "subtract" | "multiply" | "divide";
    readonly left: ProgramExpression;
    readonly right: ProgramExpression;
  };

export type ProgramTransformationOperator = "argument" | "literal" | "negate" | "add" | "subtract" | "multiply" | "divide";

export type ProgramTransformationPrecondition =
  | { readonly kind: "argument_count"; readonly count: 1 }
  | { readonly kind: "finite_numeric_argument"; readonly index: 0 }
  | { readonly kind: "finite_numeric_result" }
  | { readonly kind: "nonzero_denominator"; readonly expression: ProgramExpression };

export interface ProgramTransformationCandidate {
  readonly id: string;
  readonly callableId: string;
  readonly operator: ProgramTransformationOperator;
  readonly operands: readonly ProgramExpression[];
  readonly producedIr: ProgramExpression;
  readonly preconditions: readonly ProgramTransformationPrecondition[];
  readonly predictedFitObligationIds: readonly string[];
  readonly heldOutObligationIds: readonly string[];
  /** Lower is better. It combines fit error with a tiny complexity tie-break. */
  readonly score: number;
  readonly fitMeanSquaredError: number;
  readonly complexity: number;
  readonly provenance: {
    readonly kind: "fit_requirements";
    readonly fitRequirementIds: readonly string[];
  };
}

export interface ProgramTransformationSearchOptions {
  readonly maxDepth?: number;
  readonly beamWidth?: number;
  readonly maxCandidatesPerCallable?: number;
  readonly fitTolerance?: number;
}

export interface ProgramTransformationSearchResult {
  readonly candidates: readonly ProgramTransformationCandidate[];
  readonly selected: readonly ProgramTransformationCandidate[];
}

interface NumericExample {
  readonly id: string;
  readonly input: number;
  readonly output: number;
}

interface SearchExpression {
  readonly expression: ProgramExpression;
  readonly depth: number;
}

interface FitStats {
  readonly meanSquaredError: number;
  readonly predictedIds: readonly string[];
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_BEAM_WIDTH = 96;
const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_FIT_TOLERANCE = 1e-9;
const EPSILON = 1e-12;
const ARGUMENT: ProgramExpression = { kind: "argument", index: 0 };

/**
 * Searches a small, inspectable arithmetic transformation space independently
 * for each callable. Only fit requirements enter the expression search,
 * scoring, beam ordering, or candidate identity. Held-out rows contribute
 * their opaque ids to a candidate for later evaluation; their expected values
 * are deliberately never read.
 */
export function searchProgramTransformations(
  requirements: readonly ProgramBehaviorRequirement[],
  options: ProgramTransformationSearchOptions = {}
): ProgramTransformationSearchResult {
  const maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 0, 6);
  const beamWidth = boundedInteger(options.beamWidth ?? DEFAULT_BEAM_WIDTH, 1, 512);
  const maxCandidates = boundedInteger(options.maxCandidatesPerCallable ?? DEFAULT_MAX_CANDIDATES, 1, 2048);
  const fitTolerance = Number.isFinite(options.fitTolerance) && (options.fitTolerance ?? 0) >= 0
    ? options.fitTolerance!
    : DEFAULT_FIT_TOLERANCE;
  const grouped = groupRequirements(requirements);
  const candidates: ProgramTransformationCandidate[] = [];
  const selected: ProgramTransformationCandidate[] = [];

  for (const callableId of [...grouped.keys()].sort(compareStrings)) {
    const group = grouped.get(callableId)!;
    if (!group.fit.length) continue;
    const expressions = boundedExpressionSearch(group.fit, maxDepth, beamWidth);
    const byIdentity = new Map<string, ProgramTransformationCandidate>();
    for (const expression of expressions) {
      const stats = fitStats(expression.expression, group.fit, fitTolerance);
      if (!Number.isFinite(stats.meanSquaredError)) continue;
      const complexity = expressionComplexity(expression.expression);
      const candidate: ProgramTransformationCandidate = {
        id: candidateId(callableId, expression.expression),
        callableId,
        operator: topLevelOperator(expression.expression),
        operands: expressionOperands(expression.expression),
        producedIr: expression.expression,
        preconditions: preconditionsFor(expression.expression),
        predictedFitObligationIds: stats.predictedIds,
        heldOutObligationIds: group.heldOut.slice().sort(compareStrings),
        score: cleanNumber(stats.meanSquaredError + complexity * 1e-9),
        fitMeanSquaredError: cleanNumber(stats.meanSquaredError),
        complexity,
        provenance: {
          kind: "fit_requirements",
          fitRequirementIds: group.fit.map(example => example.id)
        }
      };
      byIdentity.set(candidate.id, candidate);
    }

    const ranked = [...byIdentity.values()].sort(compareCandidates).slice(0, maxCandidates);
    candidates.push(...ranked);
    if (ranked.length) selected.push(ranked[0]!);
  }

  return { candidates, selected };
}

/** Evaluates the selected source-neutral IR for a numeric argument. */
export function evaluateProgramExpression(expression: ProgramExpression, input: number): number | undefined {
  if (!Number.isFinite(input)) return undefined;
  return evaluateExpression(expression, input);
}

function topLevelOperator(expression: ProgramExpression): ProgramTransformationOperator {
  return expression.kind === "unary" ? expression.operator
    : expression.kind === "binary" ? expression.operator
      : expression.kind;
}

function expressionOperands(expression: ProgramExpression): ProgramExpression[] {
  if (expression.kind === "unary") return [expression.operand];
  if (expression.kind === "binary") return [expression.left, expression.right];
  return [];
}

function groupRequirements(requirements: readonly ProgramBehaviorRequirement[]): Map<string, { fit: NumericExample[]; heldOut: string[] }> {
  const grouped = new Map<string, { fit: NumericExample[]; heldOut: string[] }>();
  for (const requirement of requirements) {
    const group = grouped.get(requirement.callableId) ?? { fit: [], heldOut: [] };
    grouped.set(requirement.callableId, group);
    if (requirement.verificationRole === "held_out") {
      // No held-out values enter search, ranking, or candidate identity.
      group.heldOut.push(requirement.id);
      continue;
    }
    const input = requirement.arguments.length === 1 ? numericValue(requirement.arguments[0]) : undefined;
    const output = numericValue(requirement.expectedResult);
    if (input !== undefined && output !== undefined) group.fit.push({ id: requirement.id, input, output });
  }
  for (const group of grouped.values()) group.fit.sort(compareExamples);
  return grouped;
}

function boundedExpressionSearch(examples: readonly NumericExample[], maxDepth: number, beamWidth: number): SearchExpression[] {
  const constants = derivedFitConstants(examples);
  const leaves: SearchExpression[] = [
    { expression: ARGUMENT, depth: 0 },
    ...constants.map(value => ({ expression: { kind: "literal", value } as ProgramExpression, depth: 0 }))
  ];
  const all: SearchExpression[] = deduplicateExpressions(leaves);
  let beam = rankExpressions(all, examples).slice(0, beamWidth);
  let previousDepth = beam;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next: SearchExpression[] = [];
    for (const child of previousDepth) {
      next.push({ expression: { kind: "unary", operator: "negate", operand: child.expression }, depth });
    }
    const operands = all.filter(item => item.depth < depth);
    for (const left of operands) {
      for (const right of operands) {
        const actualDepth = Math.max(left.depth, right.depth) + 1;
        if (actualDepth !== depth) continue;
        for (const operator of ["add", "subtract", "multiply", "divide"] as const) {
          next.push({ expression: { kind: "binary", operator, left: left.expression, right: right.expression }, depth });
        }
      }
    }
    const ranked = rankExpressions(deduplicateExpressions(next), examples).slice(0, beamWidth);
    all.push(...ranked);
    previousDepth = ranked;
    beam = beam.concat(ranked);
    if (!ranked.length) break;
    if (fitStats(ranked[0]!.expression, examples, DEFAULT_FIT_TOLERANCE).meanSquaredError <= EPSILON) break;
  }
  return deduplicateExpressions(beam);
}

function derivedFitConstants(examples: readonly NumericExample[]): number[] {
  const values = new Set<number>();
  for (const example of examples) {
    values.add(cleanNumber(example.input));
    values.add(cleanNumber(example.output));
  }
  for (let left = 0; left < examples.length; left += 1) {
    for (let right = left + 1; right < examples.length; right += 1) {
      values.add(cleanNumber(examples[right]!.input - examples[left]!.input));
      values.add(cleanNumber(examples[right]!.output - examples[left]!.output));
    }
  }
  return [...values].filter(Number.isFinite).sort((left, right) => left - right);
}

function rankExpressions(expressions: readonly SearchExpression[], examples: readonly NumericExample[]): SearchExpression[] {
  return expressions.slice().sort((left, right) => {
    const leftError = fitStats(left.expression, examples, DEFAULT_FIT_TOLERANCE).meanSquaredError;
    const rightError = fitStats(right.expression, examples, DEFAULT_FIT_TOLERANCE).meanSquaredError;
    const errorDelta = leftError - rightError;
    if (Math.abs(errorDelta) > EPSILON) return errorDelta;
    const complexityDelta = expressionComplexity(left.expression) - expressionComplexity(right.expression);
    return complexityDelta || compareStrings(expressionKey(left.expression), expressionKey(right.expression));
  });
}

function fitStats(expression: ProgramExpression, examples: readonly NumericExample[], tolerance: number): FitStats {
  let squaredError = 0;
  const predictedIds: string[] = [];
  for (const example of examples) {
    const prediction = evaluateExpression(expression, example.input);
    if (prediction === undefined) return { meanSquaredError: Number.POSITIVE_INFINITY, predictedIds: [] };
    const error = prediction - example.output;
    squaredError += error * error;
    const scale = Math.max(1, Math.abs(prediction), Math.abs(example.output));
    if (Math.abs(error) <= tolerance * scale) predictedIds.push(example.id);
  }
  return { meanSquaredError: squaredError / examples.length, predictedIds };
}

function evaluateExpression(expression: ProgramExpression, input: number): number | undefined {
  switch (expression.kind) {
    case "argument": return input;
    case "literal": return expression.value;
    case "unary": {
      const operand = evaluateExpression(expression.operand, input);
      return operand === undefined ? undefined : finiteOrUndefined(-operand);
    }
    case "binary": {
      const left = evaluateExpression(expression.left, input);
      const right = evaluateExpression(expression.right, input);
      if (left === undefined || right === undefined) return undefined;
      if (expression.operator === "add") return finiteOrUndefined(left + right);
      if (expression.operator === "subtract") return finiteOrUndefined(left - right);
      if (expression.operator === "multiply") return finiteOrUndefined(left * right);
      return Math.abs(right) <= EPSILON ? undefined : finiteOrUndefined(left / right);
    }
  }
}

function preconditionsFor(expression: ProgramExpression): readonly ProgramTransformationPrecondition[] {
  const preconditions: ProgramTransformationPrecondition[] = [
    { kind: "argument_count", count: 1 },
    { kind: "finite_numeric_argument", index: 0 },
    { kind: "finite_numeric_result" }
  ];
  collectDenominatorPreconditions(expression, preconditions);
  return preconditions;
}

function collectDenominatorPreconditions(expression: ProgramExpression, output: ProgramTransformationPrecondition[]): void {
  if (expression.kind === "unary") {
    collectDenominatorPreconditions(expression.operand, output);
  } else if (expression.kind === "binary") {
    collectDenominatorPreconditions(expression.left, output);
    collectDenominatorPreconditions(expression.right, output);
    if (expression.operator === "divide") output.push({ kind: "nonzero_denominator", expression: expression.right });
  }
}

function compareCandidates(left: ProgramTransformationCandidate, right: ProgramTransformationCandidate): number {
  const fitDelta = left.fitMeanSquaredError - right.fitMeanSquaredError;
  return (Math.abs(fitDelta) > DEFAULT_FIT_TOLERANCE ? fitDelta : 0)
    || left.complexity - right.complexity
    || multiplicationCount(right.producedIr) - multiplicationCount(left.producedIr)
    || compareStrings(expressionKey(left.producedIr), expressionKey(right.producedIr))
    || compareStrings(left.id, right.id);
}

function multiplicationCount(expression: ProgramExpression): number {
  if (expression.kind === "binary") {
    return (expression.operator === "multiply" ? 1 : 0)
      + multiplicationCount(expression.left)
      + multiplicationCount(expression.right);
  }
  if (expression.kind === "unary") return multiplicationCount(expression.operand);
  return 0;
}

function deduplicateExpressions(expressions: readonly SearchExpression[]): SearchExpression[] {
  const byKey = new Map<string, SearchExpression>();
  for (const item of expressions) if (!byKey.has(expressionKey(item.expression))) byKey.set(expressionKey(item.expression), item);
  return [...byKey.values()];
}

function expressionComplexity(expression: ProgramExpression): number {
  if (expression.kind === "argument" || expression.kind === "literal") return 1;
  if (expression.kind === "unary") return 1 + expressionComplexity(expression.operand);
  return 1 + expressionComplexity(expression.left) + expressionComplexity(expression.right);
}

function expressionKey(expression: ProgramExpression): string {
  if (expression.kind === "argument") return "a0";
  if (expression.kind === "literal") return `l(${numberKey(expression.value)})`;
  if (expression.kind === "unary") return `u:${expression.operator}(${expressionKey(expression.operand)})`;
  // Keep algebraically useful multiplicative forms ahead of repeated-addition
  // equivalents when fit error and tree size tie. This is only a deterministic
  // search-order preference; it never reads held-out outcomes.
  const operatorRank = expression.operator === "multiply" ? "0" : expression.operator === "add" ? "1" : expression.operator === "subtract" ? "2" : "3";
  return `b${operatorRank}:${expression.operator}(${expressionKey(expression.left)},${expressionKey(expression.right)})`;
}

function candidateId(callableId: string, expression: ProgramExpression): string {
  const input = `${callableId}\u0000${expressionKey(expression)}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `program.transformation.${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function compareExamples(left: NumericExample, right: NumericExample): number {
  return compareStrings(left.id, right.id) || left.input - right.input || left.output - right.output;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? cleanNumber(value) : undefined;
}

function cleanNumber(value: number): number {
  return Object.is(value, -0) || Math.abs(value) <= EPSILON ? 0 : value;
}

function numberKey(value: number): string {
  return String(cleanNumber(value));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
