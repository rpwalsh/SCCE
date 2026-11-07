// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { codeRequestSignal, createHasher, realizeSourceCodeFunctions, toJsonValue, type NgramModelRecord } from "@scce/kernel";
import { compileSourceCodeFunctions } from "../source-code-function-learning.js";

describe("source-owned Unicode callable handoff", () => {
  const source = "export function औसत(𐐀बायाँ: number, दायाँ: number): number { return (𐐀बायाँ + दायाँ) / 2; }";
  function records(): NgramModelRecord[] {
    const sourceHash = createHasher().digestHex(source);
    const constructions = compileSourceCodeFunctions({ text: source, path: "observed.ts", languageId: "typescript", sourceHash });
    expect(constructions).toHaveLength(1);
    expect(constructions[0]!.parameters.map(parameter => parameter.name)).toEqual(["𐐀बायाँ", "दायाँ"]);
    return [{ id: "actual-source-ast", streamId: "oss_code:observed.ts", maxOrder: 3, discount: 0.75, languageHint: "typescript", updatedAt: 1,
      modelJson: toJsonValue({ sourceSystem: "oss_code", sourceHash, formalLanguage: "typescript", codeFunctionConstructions: constructions }) }];
  }

  it.each(["गणना", "𐐀मापन"])("realizes %s from actual source syntax and verifies a new input", name => {
    const request = `TypeScript ${name}(2,8)=5; ${name}(10,20)=15; ${name}(-8,4)=-2; ${name}(100,8)=54`;
    const requirements = codeRequestSignal(request).behaviorRequirements;
    expect(requirements.map(row => row.callableId)).toEqual([name, name, name, name]);
    expect(requirements.map(row => row.verificationRole)).toEqual(["fit", "fit", "fit", "held_out"]);
    for (const row of requirements) expect(request.slice(row.sourceSpan.charStart, row.sourceSpan.charEnd)).toContain(`${name}(`);
    const generated = realizeSourceCodeFunctions({ records: records(), languageId: "typescript", requirements });
    expect(generated).toHaveLength(1);
    expect(generated[0]!.text).toBe(source.replace("औसत", name));
    const output = ts.transpileModule(generated[0]!.text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    expect(output.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const exports: Record<string, (left: number, right: number) => number> = {};
    runInNewContext(output.outputText, { exports });
    expect(exports[name]!(100, 8)).toBe(54);
    expect(exports[name]!(7.5, -1.5)).toBe(3);
    expect(realizeSourceCodeFunctions({ records: records(), languageId: "python", requirements })).toEqual([]);
  });

  it.each(["9गणना", "\u093fगणना", "bad-name", "a.値"])("rejects malformed requested callable %s at realization", name => {
    const original = codeRequestSignal("TypeScript valid(2,8)=5").behaviorRequirements;
    expect(realizeSourceCodeFunctions({ records: records(), languageId: "typescript", requirements: original.map(row => ({ ...row, callableId: name })) })).toEqual([]);
  });
});
