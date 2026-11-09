// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import { evaluateProgramExpressionBindings, type ProgramExpression } from "./program-transformation-search.js";
import type { LanguagePatternRecord, NgramModelRecord } from "./storage.js";
import type { JsonValue, ProgramBehaviorRequirement } from "./types.js";
import { codeLanguageForModelRecord } from "./code-construction.js";
import { isFormalIdentifier } from "./formal-identifiers.js";

export const SOURCE_CODE_FUNCTION_PATTERN_SCHEMA = "scce.source_code_function_pattern.v1" as const;
export const SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID = "scce.source_code_function_projection.v1" as const;

export interface SourceCodeFunctionConstruction {
  schema: "scce.source_code_function_construction.v1";
  id: string;
  languageId: string;
  sourceHash: string;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  dependencies: string[];
  callable: { name: string; start: number; end: number };
  parameters: Array<{ name: string; declarationStart: number; declarationEnd: number; references: Array<{ start: number; end: number }> }>;
  numericAbi?: {
    readonly schema: "scce.source_numeric_callable_abi.v1";
    readonly languageId: "typescript";
    readonly parameters: readonly { readonly start: number; readonly end: number; readonly textHash: string }[];
    readonly result: { readonly start: number; readonly end: number; readonly textHash: string };
  };
  expression: ProgramExpression;
  bindings?: ProgramExpression[];
}

export function sourceCodeFunctionConstructionId(value: Omit<SourceCodeFunctionConstruction, "id">): string {
  return `source.code.function.${createHasher().digestHex(canonicalStringify(value))}`;
}

export interface RealizedSourceCodeFunction {
  text: string;
  constructionId: string;
  sourceRecordId: string;
  sourceRecordKind: "ngram_model" | "language_pattern";
  callableId: string;
  fitRequirementIds: string[];
  reservedRequirementIds: string[];
  sourceHash: string;
}

/** Only source-owned callable syntax is rebound; held-out outcomes never select an implementation. */
export function realizeSourceCodeFunctions(input: {
  records: readonly NgramModelRecord[];
  patterns?: readonly LanguagePatternRecord[];
  languageId: string;
  requirements: readonly ProgramBehaviorRequirement[];
}): RealizedSourceCodeFunction[] {
  const callables = [...new Set(input.requirements.filter(row => row.verificationRole === "fit").map(row => row.callableId))];
  const out: RealizedSourceCodeFunction[] = [];
  const sources = [
    ...input.records.map(record => ({ id: record.id, kind: "ngram_model" as const, metadata: object(record.modelJson), language: codeLanguageForModelRecord(record) })),
    ...(input.patterns ?? []).filter(pattern => object(pattern.patternJson).schema === "scce.source_code_function_pattern.v1")
      .map(pattern => ({ id: pattern.id, kind: "language_pattern" as const, metadata: object(pattern.patternJson), language: object(pattern.patternJson).formalLanguage }))
  ];
  for (const callableId of callables) {
    if (!isFormalIdentifier(callableId)) continue;
    const fit = input.requirements.filter(row => row.callableId === callableId && row.verificationRole === "fit");
    const reserved = input.requirements.filter(row => row.callableId === callableId && row.verificationRole !== "fit");
    const candidates: RealizedSourceCodeFunction[] = [];
    for (const record of sources) {
      const metadata = record.metadata;
      if (metadata.sourceSystem !== "oss_code" || record.language !== input.languageId) continue;
      const constructions = Array.isArray(metadata.codeFunctionConstructions) ? metadata.codeFunctionConstructions : [];
      for (const value of constructions) {
        const construction = admittedConstruction(value, metadata.sourceHash);
        if (!construction || construction.languageId !== input.languageId || !fit.every(row => row.arguments.length === construction.parameters.length)) continue;
        if (!fit.every(row => {
          try { return sameJsonResult(evaluateProgramExpressionBindings(construction.expression, row.arguments, construction.bindings ?? [],
            construction.languageId === "python" ? { numericDomain: "finite-binary64-safe-integer" } : {}), row.expectedResult); }
          catch { return false; }
        })) continue;
        const body = construction.sourceText.slice(0, construction.callable.start) + callableId + construction.sourceText.slice(construction.callable.end);
        candidates.push({ text: [...construction.dependencies, body].join("\n"), constructionId: construction.id, sourceRecordId: record.id, sourceRecordKind: record.kind,
          callableId, fitRequirementIds: fit.map(row => row.id), reservedRequirementIds: reserved.map(row => row.id), sourceHash: construction.sourceHash });
      }
    }
    const distinct = new Map(candidates.map(row => [row.text, row]));
    const selected = [...distinct.values()].sort((a, b) => a.text.length - b.text.length || a.constructionId.localeCompare(b.constructionId))[0];
    if (selected) out.push(selected);
  }
  return out.length === callables.length ? out : [];
}

function admittedConstruction(value: JsonValue, sourceHash: JsonValue | undefined): SourceCodeFunctionConstruction | undefined {
  const row = object(value);
  if (row.schema !== "scce.source_code_function_construction.v1" || typeof sourceHash !== "string" || row.sourceHash !== sourceHash) return undefined;
  const { id, ...material } = row;
  if (typeof id !== "string" || id !== sourceCodeFunctionConstructionId(material as unknown as Omit<SourceCodeFunctionConstruction, "id">)) return undefined;
  const construction = row as unknown as SourceCodeFunctionConstruction;
  if (typeof construction.sourceText !== "string" || !Array.isArray(construction.parameters) || !Array.isArray(construction.dependencies)
    || construction.dependencies.some(row => typeof row !== "string") || !construction.expression) return undefined;
  const callable = construction.callable;
  if (!callable || construction.sourceText.slice(callable.start, callable.end) !== callable.name || !callable.name) return undefined;
  if (construction.sourceEnd - construction.sourceStart !== construction.sourceText.length) return undefined;
  for (const parameter of construction.parameters) {
    if (!parameter.name || construction.sourceText.slice(parameter.declarationStart, parameter.declarationEnd) !== parameter.name || !Array.isArray(parameter.references)) return undefined;
    if (!parameter.references.every(span => construction.sourceText.slice(span.start, span.end) === parameter.name)) return undefined;
  }
  return construction;
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function sameJsonResult(actual: JsonValue | undefined, expected: JsonValue): boolean {
  const pending: Array<[JsonValue | undefined, JsonValue]> = [[actual, expected]];
  const compared = new WeakMap<object, WeakSet<object>>();
  while (pending.length) {
    const [left, right] = pending.pop()!;
    if (left === right) continue;
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
    const prior = compared.get(left);
    if (prior?.has(right)) continue;
    const seen = prior ?? new WeakSet<object>();
    seen.add(right);
    compared.set(left, seen);
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      pending.push([(left as Record<string, JsonValue>)[key], (right as Record<string, JsonValue>)[key]!]);
    }
  }
  return true;
}

export { admittedConstruction as readSourceCodeFunctionConstruction };

export function sourceCodeFunctionPatternId(input:{constructionId:string;profileId:string;sourceVersionId:string},hasher=createHasher()):string {
  return `source.code.function.pattern.${hasher.digestHex(canonicalStringify(input))}`;
}
