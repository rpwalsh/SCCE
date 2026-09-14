// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import type { JsonValue, ProgramBehaviorRequirement } from "./types.js";

/** A language-neutral, bounded-arity program expression. */
export type ProgramExpression =
  | { readonly kind: "argument"; readonly index: number }
  | { readonly kind: "literal"; readonly value: number }
  | { readonly kind: "value"; readonly value: JsonValue }
  | { readonly kind: "member"; readonly subject: ProgramExpression; readonly key: string | number }
  | { readonly kind: "sequence"; readonly items: readonly ProgramExpression[] }
  | { readonly kind: "mapping"; readonly entries: readonly { readonly key: string; readonly value: ProgramExpression }[] }
  | { readonly kind: "cardinality"; readonly operand: ProgramExpression }
  | { readonly kind: "equivalent"; readonly left: ProgramExpression; readonly right: ProgramExpression }
  | { readonly kind: "unary"; readonly operator: "negate"; readonly operand: ProgramExpression }
  | {
    readonly kind: "binary";
    readonly operator: "add" | "subtract" | "multiply" | "divide" | "minimum" | "maximum";
    readonly left: ProgramExpression;
    readonly right: ProgramExpression;
  };

export type ProgramTransformationOperator =
  | "argument"
  | "literal"
  | "value"
  | "member"
  | "sequence"
  | "mapping"
  | "cardinality"
  | "equivalent"
  | "negate"
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "minimum"
  | "maximum";

export type ProgramTransformationPrecondition =
  | { readonly kind: "argument_count"; readonly count: number }
  | { readonly kind: "finite_numeric_argument"; readonly index: number }
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
  readonly arguments: readonly number[];
  readonly output: number;
}

interface BehaviorExample {
  readonly id: string;
  readonly arguments: readonly JsonValue[];
  readonly output: JsonValue;
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
const MAX_ARGUMENTS = 3;

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
    const numeric = numericExamples(group.fit);
    const expressions = deduplicateExpressions([
      ...(numeric ? boundedExpressionSearch(numeric, group.arity, maxDepth, beamWidth) : []),
      ...boundedStructuralSearch(group.fit, group.arity)
    ]);
    const byIdentity = new Map<string, ProgramTransformationCandidate>();
    for (const expression of expressions) {
      const stats = behaviorFitStats(expression.expression, group.fit, fitTolerance);
      if (!Number.isFinite(stats.meanSquaredError)) continue;
      const complexity = expressionComplexity(expression.expression);
      const candidate: ProgramTransformationCandidate = {
        id: candidateId(callableId, expression.expression),
        callableId,
        operator: topLevelOperator(expression.expression),
        operands: expressionOperands(expression.expression),
        producedIr: expression.expression,
        preconditions: preconditionsFor(expression.expression, group.arity),
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

/** Evaluates the selected source-neutral IR for bounded JSON arguments. Arrays denote an argument list. */
export function evaluateProgramExpression(expression: ProgramExpression, input: JsonValue | readonly JsonValue[]): JsonValue | undefined {
  const arguments_: JsonValue[] = Array.isArray(input) ? [...input] as JsonValue[] : [input as JsonValue];
  if (!arguments_.length || arguments_.length > MAX_ARGUMENTS) return undefined;
  return evaluateExpression(expression, arguments_);
}

function topLevelOperator(expression: ProgramExpression): ProgramTransformationOperator {
  return expression.kind === "unary" ? expression.operator
    : expression.kind === "binary" ? expression.operator
      : expression.kind;
}

function expressionOperands(expression: ProgramExpression): ProgramExpression[] {
  if (expression.kind === "unary") return [expression.operand];
  if (expression.kind === "binary") return [expression.left, expression.right];
  if (expression.kind === "member") return [expression.subject];
  if (expression.kind === "sequence") return [...expression.items];
  if (expression.kind === "mapping") return expression.entries.map(entry => entry.value);
  if (expression.kind === "cardinality") return [expression.operand];
  if (expression.kind === "equivalent") return [expression.left, expression.right];
  return [];
}

function commutativeOperator(operator: ProgramTransformationOperator): boolean {
  return operator === "add" || operator === "multiply" || operator === "minimum" || operator === "maximum";
}

function groupRequirements(requirements: readonly ProgramBehaviorRequirement[]): Map<string, { fit: BehaviorExample[]; heldOut: string[]; arity: number }> {
  const grouped = new Map<string, { fit: BehaviorExample[]; heldOut: string[]; arity: number }>();
  for (const requirement of requirements) {
    const existing = grouped.get(requirement.callableId);
    if (requirement.verificationRole === "held_out") {
      // Held-out expected values and their input shapes never influence
      // search. Their opaque ids are attached after a fit-derived candidate
      // exists and are verified only by the emitted executable test.
      const group = existing ?? { fit: [], heldOut: [], arity: 0 };
      group.heldOut.push(requirement.id);
      grouped.set(requirement.callableId, group);
      continue;
    }
    if (!requirement.arguments.length || requirement.arguments.length > MAX_ARGUMENTS) continue;
    const arity = requirement.arguments.length;
    const group = existing ?? { fit: [], heldOut: [], arity };
    if (group.arity !== 0 && group.arity !== arity) continue;
    if (group.arity === 0) group.arity = arity;
    grouped.set(requirement.callableId, group);
    group.fit.push({ id: requirement.id, arguments: requirement.arguments, output: requirement.expectedResult });
  }
  for (const group of grouped.values()) group.fit.sort(compareBehaviorExamples);
  return grouped;
}

function numericExamples(examples: readonly BehaviorExample[]): NumericExample[] | undefined {
  const converted: NumericExample[] = [];
  for (const example of examples) {
    const arguments_ = example.arguments.map(numericValue);
    const output = numericValue(example.output);
    if (arguments_.some(value => value === undefined) || output === undefined) return undefined;
    converted.push({ id: example.id, arguments: arguments_ as number[], output });
  }
  return converted;
}

/**
 * Builds structural hypotheses only from paths and shapes present in fit
 * examples. A result may project nested input data, report a collection's
 * cardinality, compare two projected values, or construct a new sequence or
 * mapping from those projections. No held-out argument or result reaches this
 * function, and no callable/domain vocabulary participates in the search.
 */
function boundedStructuralSearch(examples: readonly BehaviorExample[], arity: number): SearchExpression[] {
  if (!examples.length) return [];
  const projections = commonProjectionExpressions(examples, arity);
  const expressions: SearchExpression[] = projections.map(expression => ({ expression, depth: expressionDepth(expression) }));
  const constructed = synthesizeStructuralResult(examples.map(example => example.output), examples, projections);
  if (constructed) expressions.push({ expression: constructed, depth: expressionDepth(constructed) });

  for (const projection of projections) {
    const values = examples.map(example => evaluateExpression(projection, example.arguments));
    if (values.every(value => typeof value === "string" || Array.isArray(value))) {
      expressions.push({ expression: { kind: "cardinality", operand: projection }, depth: expressionDepth(projection) + 1 });
    }
  }

  if (examples.every(example => typeof example.output === "boolean")) {
    const comparable = projections.slice(0, 24);
    for (let left = 0; left < comparable.length; left += 1) {
      for (let right = left; right < comparable.length; right += 1) {
        expressions.push({
          expression: { kind: "equivalent", left: comparable[left]!, right: comparable[right]! },
          depth: Math.max(expressionDepth(comparable[left]!), expressionDepth(comparable[right]!)) + 1
        });
      }
    }
  }
  return deduplicateExpressions(expressions).slice(0, 512);
}

function commonProjectionExpressions(examples: readonly BehaviorExample[], arity: number): ProgramExpression[] {
  const expressions: ProgramExpression[] = [];
  for (let argumentIndex = 0; argumentIndex < arity; argumentIndex += 1) {
    const root: ProgramExpression = { kind: "argument", index: argumentIndex };
    expressions.push(root);
    const paths: Array<readonly (string | number)[]> = [];
    collectJsonPaths(examples[0]!.arguments[argumentIndex], [], paths, 0);
    for (const path of paths) {
      if (!path.length) continue;
      const presentInEveryExample = examples.every(example => valueAtPath(example.arguments[argumentIndex], path) !== undefined);
      if (!presentInEveryExample) continue;
      expressions.push(path.reduce<ProgramExpression>((subject, key) => ({ kind: "member", subject, key }), root));
      if (expressions.length >= 128) return expressions;
    }
  }
  return expressions;
}

function collectJsonPaths(
  value: JsonValue | undefined,
  prefix: readonly (string | number)[],
  output: Array<readonly (string | number)[]>,
  depth: number
): void {
  if (value === undefined || depth >= 4 || output.length >= 128) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 16); index += 1) {
      const path = [...prefix, index];
      output.push(path);
      collectJsonPaths(value[index], path, output, depth + 1);
    }
    return;
  }
  if (!isJsonMapping(value)) return;
  for (const key of Object.keys(value).sort(compareStrings).slice(0, 32)) {
    const path = [...prefix, key];
    output.push(path);
    collectJsonPaths(value[key], path, output, depth + 1);
  }
}

function synthesizeStructuralResult(
  outputs: readonly JsonValue[],
  examples: readonly BehaviorExample[],
  projections: readonly ProgramExpression[]
): ProgramExpression | undefined {
  for (const projection of projections) {
    if (examples.every((example, index) => jsonEqual(evaluateExpression(projection, example.arguments), outputs[index]))) return projection;
  }
  if (outputs.every(output => jsonEqual(output, outputs[0]))) return { kind: "value", value: outputs[0]! };
  if (outputs.every(Array.isArray)) {
    const sequences = outputs as readonly JsonValue[][];
    const length = sequences[0]!.length;
    if (length > 32 || !sequences.every(sequence => sequence.length === length)) return undefined;
    const items: ProgramExpression[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = synthesizeStructuralResult(sequences.map(sequence => sequence[index]!), examples, projections);
      if (!item) return undefined;
      items.push(item);
    }
    return { kind: "sequence", items };
  }
  if (outputs.every(isJsonMapping)) {
    const mappings = outputs as readonly Record<string, JsonValue>[];
    const keys = Object.keys(mappings[0]!).sort(compareStrings);
    if (keys.length > 32 || !mappings.every(mapping => jsonEqual(Object.keys(mapping).sort(compareStrings), keys))) return undefined;
    const entries: Array<{ key: string; value: ProgramExpression }> = [];
    for (const key of keys) {
      const value = synthesizeStructuralResult(mappings.map(mapping => mapping[key]!), examples, projections);
      if (!value) return undefined;
      entries.push({ key, value });
    }
    return { kind: "mapping", entries };
  }
  return undefined;
}

function valueAtPath(value: JsonValue | undefined, path: readonly (string | number)[]): JsonValue | undefined {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cursor) || key < 0 || key >= cursor.length) return undefined;
      cursor = cursor[key];
    } else {
      if (Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) return undefined;
      cursor = cursor[key];
    }
  }
  return cursor;
}

function boundedExpressionSearch(examples: readonly NumericExample[], arity: number, maxDepth: number, beamWidth: number): SearchExpression[] {
  const constants = derivedFitConstants(examples);
  const leaves: SearchExpression[] = [
    ...Array.from({ length: arity }, (_, index) => ({ expression: { kind: "argument", index } as ProgramExpression, depth: 0 })),
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
        for (const operator of ["add", "subtract", "multiply", "divide", "minimum", "maximum"] as const) {
          // These four operators have the same denotation under swapped
          // operands. One canonical orientation prevents a growing beam from
          // scoring duplicate behavioral hypotheses.
          if (commutativeOperator(operator) && expressionKey(left.expression) > expressionKey(right.expression)) continue;
          next.push({ expression: { kind: "binary", operator, left: left.expression, right: right.expression }, depth });
        }
      }
    }
    const ranked = rankExpressions(deduplicateExpressions(next), examples).slice(0, beamWidth);
    all.push(...ranked);
    previousDepth = ranked;
    beam = beam.concat(ranked);
    if (!ranked.length) break;
    if (numericFitStats(ranked[0]!.expression, examples, DEFAULT_FIT_TOLERANCE).meanSquaredError <= EPSILON) break;
  }
  return deduplicateExpressions(beam);
}

function derivedFitConstants(examples: readonly NumericExample[]): number[] {
  const values = new Set<number>();
  for (const example of examples) {
    for (const argument of example.arguments) values.add(cleanNumber(argument));
    values.add(cleanNumber(example.output));
  }
  for (let left = 0; left < examples.length; left += 1) {
    for (let right = left + 1; right < examples.length; right += 1) {
      for (let argumentIndex = 0; argumentIndex < examples[left]!.arguments.length; argumentIndex += 1) {
        values.add(cleanNumber(examples[right]!.arguments[argumentIndex]! - examples[left]!.arguments[argumentIndex]!));
      }
      values.add(cleanNumber(examples[right]!.output - examples[left]!.output));
    }
  }
  return [...values].filter(Number.isFinite).sort((left, right) => left - right);
}

function rankExpressions(expressions: readonly SearchExpression[], examples: readonly NumericExample[]): SearchExpression[] {
  return expressions.slice().sort((left, right) => {
    const leftError = numericFitStats(left.expression, examples, DEFAULT_FIT_TOLERANCE).meanSquaredError;
    const rightError = numericFitStats(right.expression, examples, DEFAULT_FIT_TOLERANCE).meanSquaredError;
    const errorDelta = leftError - rightError;
    if (Math.abs(errorDelta) > EPSILON) return errorDelta;
    const complexityDelta = expressionComplexity(left.expression) - expressionComplexity(right.expression);
    return complexityDelta || compareStrings(expressionKey(left.expression), expressionKey(right.expression));
  });
}

function numericFitStats(expression: ProgramExpression, examples: readonly NumericExample[], tolerance: number): FitStats {
  let squaredError = 0;
  const predictedIds: string[] = [];
  for (const example of examples) {
    const prediction = evaluateExpression(expression, example.arguments);
    if (typeof prediction !== "number" || !Number.isFinite(prediction)) return { meanSquaredError: Number.POSITIVE_INFINITY, predictedIds: [] };
    const error = prediction - example.output;
    squaredError += error * error;
    const scale = Math.max(1, Math.abs(prediction), Math.abs(example.output));
    if (Math.abs(error) <= tolerance * scale) predictedIds.push(example.id);
  }
  return { meanSquaredError: squaredError / examples.length, predictedIds };
}

function behaviorFitStats(expression: ProgramExpression, examples: readonly BehaviorExample[], tolerance: number): FitStats {
  let loss = 0;
  const predictedIds: string[] = [];
  for (const example of examples) {
    const prediction = evaluateExpression(expression, example.arguments);
    if (prediction === undefined) return { meanSquaredError: Number.POSITIVE_INFINITY, predictedIds: [] };
    if (typeof prediction === "number" && typeof example.output === "number") {
      const error = prediction - example.output;
      loss += error * error;
      const scale = Math.max(1, Math.abs(prediction), Math.abs(example.output));
      if (Math.abs(error) <= tolerance * scale) predictedIds.push(example.id);
    } else if (jsonEqual(prediction, example.output)) {
      predictedIds.push(example.id);
    } else {
      loss += 1;
    }
  }
  return { meanSquaredError: loss / examples.length, predictedIds };
}

function evaluateExpression(expression: ProgramExpression, arguments_: readonly JsonValue[]): JsonValue | undefined {
  switch (expression.kind) {
    case "argument": return arguments_[expression.index];
    case "literal": return expression.value;
    case "value": return expression.value;
    case "member": {
      const subject = evaluateExpression(expression.subject, arguments_);
      if (subject === null || typeof subject !== "object") return undefined;
      if (typeof expression.key === "number") {
        return Array.isArray(subject) ? subject[expression.key] : undefined;
      }
      return !Array.isArray(subject) && Object.prototype.hasOwnProperty.call(subject, expression.key)
        ? subject[expression.key]
        : undefined;
    }
    case "sequence": {
      const values: JsonValue[] = [];
      for (const item of expression.items) {
        const value = evaluateExpression(item, arguments_);
        if (value === undefined) return undefined;
        values.push(value);
      }
      return values;
    }
    case "mapping": {
      const entries: Array<[string, JsonValue]> = [];
      for (const entry of expression.entries) {
        const resolved = evaluateExpression(entry.value, arguments_);
        if (resolved === undefined) return undefined;
        entries.push([entry.key, resolved]);
      }
      return Object.fromEntries(entries) as Record<string, JsonValue>;
    }
    case "cardinality": {
      const value = evaluateExpression(expression.operand, arguments_);
      return typeof value === "string" || Array.isArray(value) ? value.length : undefined;
    }
    case "equivalent": {
      const left = evaluateExpression(expression.left, arguments_);
      const right = evaluateExpression(expression.right, arguments_);
      return left === undefined || right === undefined ? undefined : jsonEqual(left, right);
    }
    case "unary": {
      const operand = evaluateExpression(expression.operand, arguments_);
      return typeof operand === "number" ? finiteOrUndefined(-operand) : undefined;
    }
    case "binary": {
      const left = evaluateExpression(expression.left, arguments_);
      const right = evaluateExpression(expression.right, arguments_);
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      if (expression.operator === "add") return finiteOrUndefined(left + right);
      if (expression.operator === "subtract") return finiteOrUndefined(left - right);
      if (expression.operator === "multiply") return finiteOrUndefined(left * right);
      if (expression.operator === "divide") return Math.abs(right) <= EPSILON ? undefined : finiteOrUndefined(left / right);
      return expression.operator === "minimum" ? Math.min(left, right) : Math.max(left, right);
    }
  }
}

function preconditionsFor(expression: ProgramExpression, arity: number): readonly ProgramTransformationPrecondition[] {
  const preconditions: ProgramTransformationPrecondition[] = [{ kind: "argument_count", count: arity }];
  if (usesNumericOperators(expression)) {
    preconditions.push(
      ...Array.from({ length: arity }, (_, index) => ({ kind: "finite_numeric_argument" as const, index })),
      { kind: "finite_numeric_result" }
    );
  }
  collectDenominatorPreconditions(expression, preconditions);
  return preconditions;
}

function usesNumericOperators(expression: ProgramExpression): boolean {
  if (expression.kind === "unary" || expression.kind === "binary") return true;
  if (expression.kind === "member") return usesNumericOperators(expression.subject);
  if (expression.kind === "sequence") return expression.items.some(usesNumericOperators);
  if (expression.kind === "mapping") return expression.entries.some(entry => usesNumericOperators(entry.value));
  if (expression.kind === "cardinality") return usesNumericOperators(expression.operand);
  if (expression.kind === "equivalent") return usesNumericOperators(expression.left) || usesNumericOperators(expression.right);
  return false;
}

function collectDenominatorPreconditions(expression: ProgramExpression, output: ProgramTransformationPrecondition[]): void {
  if (expression.kind === "unary") {
    collectDenominatorPreconditions(expression.operand, output);
  } else if (expression.kind === "binary") {
    collectDenominatorPreconditions(expression.left, output);
    collectDenominatorPreconditions(expression.right, output);
    if (expression.operator === "divide") output.push({ kind: "nonzero_denominator", expression: expression.right });
  } else if (expression.kind === "member") {
    collectDenominatorPreconditions(expression.subject, output);
  } else if (expression.kind === "sequence") {
    for (const item of expression.items) collectDenominatorPreconditions(item, output);
  } else if (expression.kind === "mapping") {
    for (const entry of expression.entries) collectDenominatorPreconditions(entry.value, output);
  } else if (expression.kind === "cardinality") {
    collectDenominatorPreconditions(expression.operand, output);
  } else if (expression.kind === "equivalent") {
    collectDenominatorPreconditions(expression.left, output);
    collectDenominatorPreconditions(expression.right, output);
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
  if (expression.kind === "member") return multiplicationCount(expression.subject);
  if (expression.kind === "sequence") return expression.items.reduce((sum, item) => sum + multiplicationCount(item), 0);
  if (expression.kind === "mapping") return expression.entries.reduce((sum, entry) => sum + multiplicationCount(entry.value), 0);
  if (expression.kind === "cardinality") return multiplicationCount(expression.operand);
  if (expression.kind === "equivalent") return multiplicationCount(expression.left) + multiplicationCount(expression.right);
  return 0;
}

function deduplicateExpressions(expressions: readonly SearchExpression[]): SearchExpression[] {
  const byKey = new Map<string, SearchExpression>();
  for (const item of expressions) if (!byKey.has(expressionKey(item.expression))) byKey.set(expressionKey(item.expression), item);
  return [...byKey.values()];
}

function expressionComplexity(expression: ProgramExpression): number {
  if (expression.kind === "argument" || expression.kind === "literal" || expression.kind === "value") return 1;
  if (expression.kind === "unary") return 1 + expressionComplexity(expression.operand);
  if (expression.kind === "member") return 1 + expressionComplexity(expression.subject);
  if (expression.kind === "sequence") return 1 + expression.items.reduce((sum, item) => sum + expressionComplexity(item), 0);
  if (expression.kind === "mapping") return 1 + expression.entries.reduce((sum, entry) => sum + expressionComplexity(entry.value), 0);
  if (expression.kind === "cardinality") return 1 + expressionComplexity(expression.operand);
  if (expression.kind === "equivalent") return 1 + expressionComplexity(expression.left) + expressionComplexity(expression.right);
  return 1 + expressionComplexity(expression.left) + expressionComplexity(expression.right);
}

function expressionKey(expression: ProgramExpression): string {
  if (expression.kind === "argument") return `a${expression.index}`;
  if (expression.kind === "literal") return `l(${numberKey(expression.value)})`;
  if (expression.kind === "value") return `v(${stableJson(expression.value)})`;
  if (expression.kind === "member") return `m(${expressionKey(expression.subject)},${stableJson(expression.key)})`;
  if (expression.kind === "sequence") return `s(${expression.items.map(expressionKey).join(",")})`;
  if (expression.kind === "mapping") return `o(${expression.entries.map(entry => `${stableJson(entry.key)}:${expressionKey(entry.value)}`).join(",")})`;
  if (expression.kind === "cardinality") return `c(${expressionKey(expression.operand)})`;
  if (expression.kind === "equivalent") return `e(${expressionKey(expression.left)},${expressionKey(expression.right)})`;
  if (expression.kind === "unary") return `u:${expression.operator}(${expressionKey(expression.operand)})`;
  // Keep algebraically useful multiplicative forms ahead of repeated-addition
  // equivalents when fit error and tree size tie. This is only a deterministic
  // search-order preference; it never reads held-out outcomes.
  const operatorRank = expression.operator === "multiply" ? "0"
    : expression.operator === "add" ? "1"
      : expression.operator === "subtract" ? "2"
        : expression.operator === "divide" ? "3"
          : expression.operator === "minimum" ? "4" : "5";
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
  const id = compareStrings(left.id, right.id);
  if (id) return id;
  const arity = left.arguments.length - right.arguments.length;
  if (arity) return arity;
  for (let index = 0; index < left.arguments.length; index += 1) {
    const delta = left.arguments[index]! - right.arguments[index]!;
    if (delta) return delta;
  }
  return left.output - right.output;
}

function compareBehaviorExamples(left: BehaviorExample, right: BehaviorExample): number {
  return compareStrings(left.id, right.id)
    || compareStrings(stableJson([...left.arguments]), stableJson([...right.arguments]))
    || compareStrings(stableJson(left.output), stableJson(right.output));
}

function expressionDepth(expression: ProgramExpression): number {
  if (expression.kind === "argument" || expression.kind === "literal" || expression.kind === "value") return 0;
  if (expression.kind === "unary" || expression.kind === "member" || expression.kind === "cardinality") {
    const operand = expression.kind === "member" ? expression.subject : expression.operand;
    return expressionDepth(operand) + 1;
  }
  if (expression.kind === "sequence") return 1 + Math.max(0, ...expression.items.map(expressionDepth));
  if (expression.kind === "mapping") return 1 + Math.max(0, ...expression.entries.map(entry => expressionDepth(entry.value)));
  return 1 + Math.max(expressionDepth(expression.left), expressionDepth(expression.right));
}

function isJsonMapping(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return left === undefined || right === undefined ? left === right : stableJson(left) === stableJson(right);
}

function stableJson(value: JsonValue | string | number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort(compareStrings).map(key => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
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
