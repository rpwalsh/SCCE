// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CODE_LINE_SYMBOL,
  codeBracketBalance,
  codeCommentProse,
  codeIdentifierTokens,
  codeSurfaceTokens,
  codeTrainingSurface,
  renderCodeTokens
} from "../code-surface.js";
import { codeLanguageForPath } from "../code-request.js";
import {
  generateLearnedCodeRepairs,
  generateLearnedCodeSurface,
  learnedCodeRepairOperation,
  codeModelsFromRecords
} from "../code-construction.js";
import { LEARNED_CODE_CONSTRUCTION_REPAIR_FAMILY, SUPPORTED_PROGRAM_REPAIR_FAMILIES } from "../program-repair-kernel.js";
import { kneserNeyProbability, predictKneserNey, trainKneserNey } from "../kneser-ney.js";
import { toJsonValue } from "../primitives.js";

const CORPUS = `interface Row { label: string; }
export function show(row: Row): string {
  return row.label;
}
export function name(value: Row): string {
  return value.label;
}
interface Point { x: number; y: number; }
export function origin(): Point {
  return { x: 0, y: 0 };
}
export function shift(p: Point): Point {
  return { x: p.x, y: p.y };
}
export function add(left: number, right: number): number {
  return left + right;
}
export const total = add(1, 2);
`;

function corpusModel(order = 5) {
  return trainKneserNey(codeSurfaceTokens(CORPUS), { order, discount: 0.75, vocabularyLimit: 8192 });
}

describe("code as a learnable surface", () => {
  it("keeps the token sequence a generator has to compose from", () => {
    expect(codeSurfaceTokens("const a = f(b);")).toEqual(["const", "a", "=", "f", "(", "b", ")", ";"]);
  });

  it("reads a delimited literal as one symbol so its contents are not learned as code", () => {
    expect(codeSurfaceTokens('x("a b c");')).toEqual(["x", "(", '"a b c"', ")", ";"]);
  });

  it("reads an operator run as one symbol", () => {
    expect(codeSurfaceTokens("a => b")).toEqual(["a", "=>", "b"]);
    expect(codeSurfaceTokens("A::b")).toEqual(["A", "::", "b"]);
  });

  it("carries line structure as a symbol rather than dropping it with the whitespace", () => {
    expect(codeSurfaceTokens("a;\nb;")).toEqual(["a", ";", CODE_LINE_SYMBOL, "b", ";"]);
  });

  it("round-trips a statement back to something a compiler accepts", () => {
    const source = "return row.label;";
    expect(renderCodeTokens(codeSurfaceTokens(source))).toBe(source);
  });

  it("renders calls and indexing without spurious separation", () => {
    expect(renderCodeTokens(codeSurfaceTokens("const x = f(a, b)[0];"))).toBe("const x = f(a, b)[0];");
  });

  it("reports bracket balance, which is the one structural check every language shares", () => {
    expect(codeBracketBalance(codeSurfaceTokens("f(a)")).open).toEqual([]);
    expect(codeBracketBalance(codeSurfaceTokens("f(a")).open).toEqual([")"]);
    expect(codeBracketBalance(codeSurfaceTokens("a)")).underflow).toBe(true);
  });

  it("never reads a preprocessor directive as a comment", () => {
    const source = "#include <stdio.h>\n// a real comment\nint main(void) { return 0; }";
    expect(codeCommentProse(source)).toEqual(["a real comment"]);
    expect(codeSurfaceTokens(source)).toContain("include");
  });

  it("names the identifiers a request or a file puts in play", () => {
    expect(codeIdentifierTokens(codeSurfaceTokens("row.label = 3;"))).toEqual(["row", "label"]);
  });

  it("projects a whole file to a training surface", () => {
    expect(codeTrainingSurface("const a = 1;")).toBe("const a = 1 ;");
    expect(codeTrainingSurface("a;\nb;")).toBe("a ; ⏎ b ;");
  });

  it("names the formal language of a path from the same table the request signal reads", () => {
    expect(codeLanguageForPath("src/main.ts")).toBe("typescript");
    expect(codeLanguageForPath("lib/thing.py")).toBe("python");
    expect(codeLanguageForPath("notes.md")).toBeUndefined();
  });
});

describe("kneser-ney count lookups", () => {
  // `toString` and `constructor` are ordinary identifiers in code; reading them off a plain count object
  // reached Object.prototype and returned a function where a count belonged.
  it("does not read Object.prototype members as counts", () => {
    const model = trainKneserNey(codeSurfaceTokens('const s = Buffer.from(b).toString("utf8");\nclass A { constructor(x) { this.x = x; } }'), {
      order: 4,
      discount: 0.75,
      vocabularyLimit: 4096
    });
    for (const context of [["toString"], ["constructor"], ["valueOf"], ["hasOwnProperty"]]) {
      const probability = kneserNeyProbability(model, context, "(");
      expect(Number.isFinite(probability)).toBe(true);
      expect(probability).toBeGreaterThan(0);
      expect(() => predictKneserNey(model, context, 4)).not.toThrow();
    }
  });
});

describe("composing a repair from learned code", () => {
  it("writes the corrected member access without reading any compiler suggestion", () => {
    const target = "interface Row { label: string; }\n\nexport function show(row: Row): string {\n  return row.labell;\n}\n";
    const candidates = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: target,
      diagnostics: [{
        id: "TS2551",
        class: "type",
        path: "src/main.ts",
        line: 4,
        column: 14,
        message: "Property 'labell' does not exist on type 'Row'.",
        raw: "",
        confidence: 0.95
      }],
      requiredSymbols: ["label", "row"]
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.content).toBe("  return row.label;");
    expect(candidates[0]!.id.startsWith("candidate:generated:code:")).toBe(true);
    // The score carries the boosts; the reported probability must not.
    expect(candidates[0]!.averageLogProbability).toBeLessThan(0);
  });

  it("proposes nothing when the language was never learned", () => {
    expect(generateLearnedCodeRepairs({
      models: [],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: "export const a = 1;\n",
      diagnostics: [{ id: "d", class: "type", line: 1, column: 1, message: "", raw: "", confidence: 1 }]
    })).toEqual([]);
  });

  it("proposes nothing when the diagnostics locate nothing in the file", () => {
    expect(generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: "export const a = 1;\n",
      diagnostics: [{ id: "d", class: "type", line: 99, column: 1, message: "", raw: "", confidence: 1 }]
    })).toEqual([]);
  });

  it("carries the learned family, not a compiler-owned one", () => {
    const candidate = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: "interface Row { label: string; }\n\nexport function show(row: Row): string {\n  return row.labell;\n}\n",
      diagnostics: [{ id: "TS2551", class: "type", line: 4, column: 14, message: "", raw: "", confidence: 0.95 }]
    })[0]!;
    const operation = learnedCodeRepairOperation(candidate, "src/main.ts");
    expect(operation.repairFamilyId).toBe(LEARNED_CODE_CONSTRUCTION_REPAIR_FAMILY);
    expect(operation.kind).toBe("replace");
    expect(operation.startLine).toBe(4);
    expect(SUPPORTED_PROGRAM_REPAIR_FAMILIES.some(family => family.id === LEARNED_CODE_CONSTRUCTION_REPAIR_FAMILY)).toBe(true);
  });

  it("declares its own validation checks rather than inheriting a compiler family's", () => {
    const family = SUPPORTED_PROGRAM_REPAIR_FAMILIES.find(item => item.id === LEARNED_CODE_CONSTRUCTION_REPAIR_FAMILY)!;
    expect(family.mutationClass).toBe("program.mutation.learned_construction_repair");
    expect(family.requiredValidationChecks).toContain("compiler");
  });
});

describe("composing code for a request that names no file", () => {
  it("closes every bracket it opens", () => {
    const composed = generateLearnedCodeSurface({
      models: [corpusModel()],
      languageId: "typescript",
      requestText: "write a function that returns a Point",
      requiredSymbols: ["Point", "origin"]
    });
    expect(composed).toBeDefined();
    expect(composed!.text.trim().length).toBeGreaterThan(0);
    expect(codeBracketBalance(codeSurfaceTokens(composed!.text)).underflow).toBe(false);
  });

  it("composes nothing when the language was never learned", () => {
    expect(generateLearnedCodeSurface({
      models: [],
      languageId: "rust",
      requestText: "write a function"
    })).toBeUndefined();
  });
});

describe("finding the code corpus in a hydrated language memory", () => {
  const model = corpusModel();

  it("selects models by the formal language their corpus recorded", () => {
    const records = [{
      id: "m1",
      streamId: "corpus:oss_code:src/main.ts",
      languageHint: "script:Latin;direction:ltr",
      maxOrder: 5,
      discount: 0.75,
      modelJson: toJsonValue({ formalLanguage: "typescript", model: model as unknown as never }),
      updatedAt: 0
    }];
    expect(codeModelsFromRecords(records, "typescript")).toHaveLength(1);
    expect(codeModelsFromRecords(records, "python")).toHaveLength(0);
  });

  it("falls back to the language of the path in the stream id", () => {
    const records = [{
      id: "m2",
      streamId: "corpus:oss_code:lib/thing.py",
      languageHint: "script:Latin;direction:ltr",
      maxOrder: 5,
      discount: 0.75,
      modelJson: toJsonValue({ model: model as unknown as never }),
      updatedAt: 0
    }];
    expect(codeModelsFromRecords(records, "python")).toHaveLength(1);
    expect(codeModelsFromRecords(records, "typescript")).toHaveLength(0);
  });

  it("ignores a record that carries no model", () => {
    expect(codeModelsFromRecords([{
      id: "m3",
      streamId: "corpus:oss_code:src/main.ts",
      languageHint: "script:Latin;direction:ltr",
      maxOrder: 5,
      discount: 0.75,
      modelJson: toJsonValue({ formalLanguage: "typescript" }),
      updatedAt: 0
    }], "typescript")).toHaveLength(0);
  });
});
