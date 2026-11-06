// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { codeRequestSignal, codeSurfaceTokens, createHasher, realizeSourceCodeFunctions, toJsonValue, trainKneserNey, type NgramModelRecord } from "@scce/kernel";
import { compileSourceCodeFunctions } from "../source-code-function-learning.js";

function learned(source: string) {
  const sourceHash = createHasher().digestHex(source);
  const constructions = compileSourceCodeFunctions({ text: source, path: "actual-source.ts", languageId: "typescript", sourceHash });
  const record: NgramModelRecord = { id: "source-model", streamId: "oss_code:actual-source.ts", languageHint: "typescript", maxOrder: 5, discount: 0.75, updatedAt: 1,
    modelJson: toJsonValue({ sourceSystem: "oss_code", sourceHash, formalLanguage: "typescript", codeFunctionConstructions: constructions,
      model: trainKneserNey(codeSurfaceTokens(source), { order: 5 }) }) };
  return { constructions, records: [record] };
}

describe("complete source-owned code constructions", () => {
  it("stores repeated local uses as a binding DAG rather than exponentially duplicating their expressions", () => {
    const sizes = [20, 40, 80].map(count => {
      const declarations = Array.from({ length: count }, (_, index) => {
        const previous = index ? `step${index - 1}` : "input";
        return `const step${index} = (${previous} + ${previous}) / 2;`;
      });
      const source = `export function repeated(input: number): number { ${declarations.join(" ")} return step${count - 1}; }`;
      const memory = learned(source);
      expect(memory.constructions).toHaveLength(1);
      expect(memory.constructions[0]!.bindings).toHaveLength(count);
      expect(memory.constructions[0]!.expression).toEqual({ kind: "argument", index: count });
      const requirements = codeRequestSignal("TypeScript unfoldPulse(1.25)=1.25; unfoldPulse(-7.5)=-7.5").behaviorRequirements;
      const generated = realizeSourceCodeFunctions({ records: memory.records, languageId: "typescript", requirements });
      expect(generated).toHaveLength(1);
      const exports: Record<string, (value: number) => number> = {};
      runInNewContext(ts.transpileModule(generated[0]!.text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
      expect(exports.unfoldPulse?.(3.75)).toBe(3.75);
      return JSON.stringify({ bindings: memory.constructions[0]!.bindings, expression: memory.constructions[0]!.expression }).length;
    });
    expect(sizes[2]! - sizes[1]!).toBe(2 * (sizes[1]! - sizes[0]!));
  });

  it("compares a shared computed result without exponentially serializing it", () => {
    const declarations = Array.from({ length: 80 }, (_, index) => {
      const previous = index ? `step${index - 1}` : "input";
      return `const step${index} = [${previous}, ${previous}];`;
    });
    const memory = learned(`export function expand(input: number) { ${declarations.join(" ")} return step79; }`);
    expect(memory.constructions[0]!.bindings).toHaveLength(declarations.length);
    expect(realizeSourceCodeFunctions({ records: memory.records, languageId: "typescript",
      requirements: codeRequestSignal("TypeScript boundedResult(1)=false").behaviorRequirements })).toEqual([]);
    const comparison = learned(`export function compare(input: number) { ${declarations.join(" ")} return step79 === step79; }`);
    expect(realizeSourceCodeFunctions({ records: comparison.records, languageId: "typescript",
      requirements: codeRequestSignal("TypeScript boundedEquality(1)=true").behaviorRequirements })).toHaveLength(1);
  });

  it("preserves source strict equality and small numeric values while fitting behavior", () => {
    const equality = learned("export function compare(left: unknown, right: unknown) { return left === right; }");
    expect(realizeSourceCodeFunctions({ records: equality.records, languageId: "typescript",
      requirements: codeRequestSignal('TypeScript sameValue({"x":1},{"x":1})=false; sameValue(3,3)=true').behaviorRequirements })).toHaveLength(1);
    const numeric = learned("export function scale(value: number) { return value / 2; }");
    expect(realizeSourceCodeFunctions({ records: numeric.records, languageId: "typescript",
      requirements: codeRequestSignal("TypeScript smallValue(0.000000000002)=0.000000000001").behaviorRequirements })).toHaveLength(1);
    expect(realizeSourceCodeFunctions({ records: numeric.records, languageId: "typescript",
      requirements: codeRequestSignal("TypeScript smallValue(0.000000000002)=0").behaviorRequirements })).toEqual([]);
  });
  it("binds an unseen callable to an observed arrow function and its pure local declarations", () => {
    const source = "export const meanReading = (left: number, right: number): number => { const total = left + right; const count = 2; return total / count; };";
    const memory = learned(source);
    const requirements = codeRequestSignal("TypeScript pulseAverage(2,8)=5; pulseAverage(10,20)=15").behaviorRequirements;
    const generated = realizeSourceCodeFunctions({ records: memory.records, languageId: "typescript", requirements });
    expect(generated).toHaveLength(1);
    expect(generated[0]!.text).toBe(source.replace("meanReading", "pulseAverage"));
    const exports: Record<string, (...args: number[]) => number> = {};
    runInNewContext(ts.transpileModule(generated[0]!.text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
    expect(exports.pulseAverage?.(-8, 4)).toBe(-2);
    expect(exports.pulseAverage?.(100.5, 7.25)).toBe(53.875);
  });

  it("reuses an actual repository function for a new chat callable and independently verifies held-out bounds", async () => {
    const source = await readFile(new URL("../../../kernel/src/functional-cognition.ts", import.meta.url), "utf8");
    const memory = learned(source);
    const observed = memory.constructions.find(row => row.callable.name === "clamp");
    expect(observed).toBeDefined();
    expect(source.slice(observed!.sourceStart, observed!.sourceEnd)).toBe(observed!.sourceText);
    const request = "TypeScript boundReading(-4,0,10)=0; boundReading(7,0,10)=7; boundReading(24,0,10)=10";
    const requirements = codeRequestSignal(request).behaviorRequirements;
    const generated = realizeSourceCodeFunctions({ records: memory.records, languageId: "typescript", requirements });
    expect(generated).toHaveLength(1);
    expect(generated[0]!.constructionId).toBe(observed!.id);
    const context: Record<string, (...args: number[]) => number> = {};
    runInNewContext(ts.transpileModule(generated[0]!.text, { compilerOptions: { module: ts.ModuleKind.None } }).outputText, context);
    expect(context.boundReading?.(15, -3, 8)).toBe(8);
    expect(context.boundReading?.(-7, -3, 8)).toBe(-3);
    expect(context.boundReading?.(2.5, -3, 8)).toBe(2.5);
    expect(realizeSourceCodeFunctions({ records: [], languageId: "typescript", requirements })).toEqual([]);
  });

  it("does not assign an executable meaning to side effects or unresolved external dependencies", () => {
    const memory = learned([
      "function sideEffect(value: number) { console.log(value); return value; }",
      "export const remote = async (value: number) => value;",
      "function unknown(value: number) { return externalService(value); }",
      "function random(value: number) { return Math.random() * value; }"
    ].join("\n"));
    expect(memory.constructions).toEqual([]);
  });
});
