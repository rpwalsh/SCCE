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
import { applicableCodeConstructions, induceCodeConstructions, realizeCodeConstruction } from "../code-construction-grammar.js";
import {
  generateLearnedCodeRepairs,
  generateLearnedCodeSurface,
  learnedCodeRepairOperation,
  codeModelsFromRecords
} from "../code-construction.js";
import { LEARNED_CODE_CONSTRUCTION_REPAIR_FAMILY, SUPPORTED_PROGRAM_REPAIR_FAMILIES } from "../program-repair-kernel.js";
import { kneserNeyProbability, predictKneserNey, trainKneserNey } from "../kneser-ney.js";
import { toJsonValue } from "../primitives.js";

const CORPUS = `interface Row { title: string; }
export function show(row: Row): string {
  return row.title;
}
export function name(value: Row): string {
  return value.title;
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
    const source = "return row.title;";
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
    expect(codeIdentifierTokens(codeSurfaceTokens("row.title = 3;"))).toEqual(["row", "title"]);
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
    const target = "interface Row { title: string; }\n\nexport function show(row: Row): string {\n  return row.titel;\n}\n";
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
        message: "Property 'titel' does not exist on type 'Row'.",
        raw: "",
        confidence: 0.95
      }],
      requiredSymbols: ["title", "row"]
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.content).toBe("  return row.title;");
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

  // Composing `add` for `export const total = add(1);` type-checks perfectly and destroys the module. The gate
  // could not see it, because "it compiles" bounds what is wrong with a program and never what it has to be.
  it("will not silence a diagnostic by deleting what the diagnostic never named", () => {
    const target = "function add(left: number, right: number): number {\n  return left + right;\n}\n\nexport const total = add(1);\n";
    const candidates = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: target,
      diagnostics: [{ id: "TS2554", class: "type", path: "src/main.ts", line: 5, column: 22, message: "Expected 2 arguments, but got 1.", raw: "", confidence: 0.95 }]
    });
    for (const candidate of candidates) {
      // Everything the line said outside the call must still be said.
      for (const token of ["export", "const", "total", "="]) {
        expect(candidate.content).toContain(token);
      }
    }
  });

  it("carries the learned family, not a compiler-owned one", () => {
    const candidate = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: "interface Row { title: string; }\n\nexport function show(row: Row): string {\n  return row.titel;\n}\n",
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

describe("filling an exact hole", () => {
  const target = "interface Row { title: string; }\n\nexport function show(row: Row): string {\n  return row.titel;\n}\n";
  const hole = { start: target.indexOf("titel"), length: 5, diagnosticId: "TS2551" };

  it("writes what the type system admits there, leaving every other byte alone", () => {
    const candidates = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: target,
      diagnostics: [],
      spans: [{ ...hole, admissible: ["title"], admissibleInside: ["title"] }]
    });
    expect(candidates[0]!.strategy).toBe("span");
    expect(candidates[0]!.content).toBe("  return row.title;");
  });

  // Every one of these type-checks. Each was produced by the search before the rule that forbids it.
  it("never fills a hole with less than the hole said", () => {
    const call = "function add(left: number, right: number): number {\n  return left + right;\n}\n\nexport const total = add(1);\n";
    const start = call.indexOf("add(1)");
    const candidates = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: call,
      diagnostics: [],
      spans: [{ start, length: 6, diagnosticId: "TS2554", admissible: ["add", "total"] }]
    });
    for (const candidate of candidates) {
      // `add(1)` filled with `(1)` drops the call; filled with `add` drops the arguments.
      expect(candidate.content).toContain("(");
      expect(candidate.content).toContain(")");
      expect(candidate.content).toContain("export const total =");
    }
  });

  it("opens a hole the way the hole opened", () => {
    const literal = "interface Point { x: number; y: number; }\n\nexport function origin(): Point {\n  return { x: 0 };\n}\n";
    const start = literal.indexOf("{ x: 0 }");
    const candidates = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: literal,
      diagnostics: [],
      spans: [{ start, length: 8, diagnosticId: "TS2741", admissible: ["origin"], admissibleInside: ["y"] }]
    });
    for (const candidate of candidates) {
      expect(candidate.content.trim().startsWith("return {")).toBe(true);
    }
  });

  it("prefers the smallest hole that admits a filling", () => {
    const candidates = generateLearnedCodeRepairs({
      models: [corpusModel()],
      languageId: "typescript",
      targetPath: "src/main.ts",
      targetText: target,
      diagnostics: [],
      spans: [
        { start: target.indexOf("row.titel"), length: 9, diagnosticId: "TS2551:expression", admissible: ["row"] },
        { ...hole, diagnosticId: "TS2551:token", admissible: ["title"], admissibleInside: ["title"] }
      ]
    });
    expect(candidates[0]!.holeLength).toBe(5);
  });
});

describe("shapes induced from what code recurs on", () => {
  const documents = [
    { id: "a.ts", text: "export const a = { id: 1, kind: 2 };\nexport const b = f(1, 2);\n" },
    { id: "b.ts", text: "export const c = { id: 3, kind: 4 };\nexport const d = g(5, 6);\n" },
    { id: "c.ts", text: "export const e = { id: 7, kind: 8 };\nexport const h = k(9, 10);\n" }
  ];
  const render = (construction: { parts: Array<{ kind: string; surface?: string; slot?: number }> }): string =>
    construction.parts.map(part => (part.kind === "literal" ? part.surface : `<${part.slot}>`)).join(" ");

  it("marks the positions that vary, not the ones a predicate sits beside", () => {
    const constructions = induceCodeConstructions({ documents, minimumDocuments: 2, minimumOccurrences: 2 });
    const shapes = constructions.map(render);
    // The keys are the same in all three documents and the values are not, so the keys are part of the shape and
    // the values are its slots. That is the whole difference from the prose-derived induction, whose slots were
    // whatever happened to sit either side of a token it had guessed was a predicate.
    expect(shapes).toContain("{ id : <0> , kind : <1> }");
    expect(shapes).toContain("<0> ( <1> , <2> )");
  });

  it("keeps a shape only when more than one document attests it", () => {
    const single = induceCodeConstructions({
      documents: [documents[0]!],
      minimumDocuments: 2,
      minimumOccurrences: 2
    });
    expect(single).toEqual([]);
  });

  it("offers the shapes a hole could become, nearest in size first", () => {
    const constructions = induceCodeConstructions({ documents, minimumDocuments: 2, minimumOccurrences: 2 });
    const applicable = applicableCodeConstructions(constructions, codeSurfaceTokens("f(1)"), 8).map(render);
    // A call with one argument may become a call with two; it may not become something that drops the call.
    expect(applicable.some(shape => shape === "<0> ( <1> , <2> )")).toBe(true);
    expect(applicable.every(shape => shape.includes("(") && shape.includes(")"))).toBe(true);
  });

  it("realizes a shape only when every slot has a filler", () => {
    const construction = induceCodeConstructions({ documents, minimumDocuments: 2, minimumOccurrences: 2 })
      .find(item => render(item) === "<0> ( <1> , <2> )")!;
    expect(realizeCodeConstruction(construction, new Map([[0, "add"], [1, "1"], [2, "2"]]))).toEqual(
      ["add", "(", "1", ",", "2", ")"]
    );
    expect(realizeCodeConstruction(construction, new Map([[0, "add"]]))).toBeUndefined();
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
