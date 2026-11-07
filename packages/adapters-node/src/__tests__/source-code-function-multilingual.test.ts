// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { codeRequestSignal, createHasher, realizeSourceCodeFunctions, toJsonValue, type NgramModelRecord } from "@scce/kernel";
import { compileSourceCodeFunctionsAsync } from "../source-code-function-learning.js";

describe("multilingual source callable ingestion", () => {
  it("lowers a Python function at exact UTF-16 spans, preserving its local binding and tuple semantics", async () => {
    const text = "# π🙂\ndef pair(value):\n    doubled = value * 2.0\n    return (value, doubled)\n";
    const sourceHash = createHasher().digestHex(text);
    const rows = await compileSourceCodeFunctionsAsync({ text, path: "π.py", languageId: "python", sourceHash });
    expect(rows).toHaveLength(1);
    expect(text.slice(rows[0]!.sourceStart, rows[0]!.sourceEnd)).toBe(rows[0]!.sourceText);
    expect(rows[0]!.sourceText).toBe("def pair(value):\n    doubled = value * 2.0\n    return (value, doubled)");
    expect(rows[0]!.bindings).toEqual([{ kind: "binary", operator: "multiply", left: { kind: "argument", index: 0 }, right: { kind: "literal", value: 2 } }]);
    expect(rows[0]!.expression).toEqual({ kind: "sequence", items: [{ kind: "argument", index: 0 }, { kind: "argument", index: 1 }] });
  });

  it("ingests and renames the actual Python stdlib colorsys callable, then checks a held-out result with Python", async () => {
    const python = pythonExecutable();
    if (!python) throw new Error("Python is required for the source callable execution regression; set SCCE_TEST_PYTHON to its executable");
    const stdlib = spawnSync(python, ["-c", "import sysconfig; print(sysconfig.get_path('stdlib'))"], { encoding: "utf8" });
    expect(stdlib.status).toBe(0);
    const source = await readFile(`${stdlib.stdout.trim()}/colorsys.py`, "utf8");
    const sourceHash = createHasher().digestHex(source);
    const constructions = await compileSourceCodeFunctionsAsync({ text: source, path: "colorsys.py", languageId: "python", sourceHash });
    const construction = constructions.find(row => row.callable.name === "rgb_to_yiq");
    expect(construction).toBeDefined();
    expect(source.slice(construction!.sourceStart, construction!.sourceEnd)).toBe(construction!.sourceText);

    const fitInputs = [[0.2, 0.4, 0.6], [0.8, 0.1, 0.3]];
    const fitResults = pythonRgbToYiq(python, fitInputs);
    const request = fitInputs.map((args, index) => `learnedColor(${args.join(",")})=${JSON.stringify(fitResults[index])}`).join("; ");
    const requirements = codeRequestSignal(request).behaviorRequirements;
    const record: NgramModelRecord = { id: "stdlib-colorsys", streamId: "oss_code:colorsys.py", languageHint: "python", maxOrder: 1, discount: 0.75, updatedAt: 1,
      modelJson: toJsonValue({ sourceSystem: "oss_code", sourceHash, formalLanguage: "python", codeFunctionConstructions: constructions }) };
    const realized = realizeSourceCodeFunctions({ records: [record], languageId: "python", requirements });
    expect(realized).toHaveLength(1);
    expect(realized[0]!.text).toContain("def learnedColor(");

    const unsafeInputs = [[9007199254740992, 0, 0], [0.8, 0.1, 0.3]];
    const unsafeResults = pythonRgbToYiq(python, unsafeInputs);
    const unsafeRequest = unsafeInputs.map((args, index) => `learnedColor(${args.join(",")})=${JSON.stringify(unsafeResults[index])}`).join("; ");
    const unsafeRequirements = codeRequestSignal(unsafeRequest).behaviorRequirements;
    expect(unsafeRequirements).toHaveLength(2);
    expect(realizeSourceCodeFunctions({ records: [record], languageId: "python", requirements: unsafeRequirements })).toEqual([]);

    const heldOut = [0.125, 0.25, 0.75];
    const expected = pythonRgbToYiq(python, [heldOut])[0];
    const executed = spawnSync(python, ["-c", `${realized[0]!.text}\nimport json; print(json.dumps(learnedColor(${heldOut.join(",")})))`], { encoding: "utf8" });
    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout.trim())).toEqual(expected);
  });

  it("lowers only floating-point callable bodies in Rust and Kotlin and preserves their native source", async () => {
    const cases = [
      { languageId: "rust", path: "scale.rs", source: "pub fn twice(value: f64) -> f64 { value * 2.0 }", expected: "pub fn learnedScale(value: f64) -> f64 { value * 2.0 }" },
      { languageId: "kotlin", path: "scale.kt", source: "fun twice(value: Double): Double { val result = value * 2.0; return result }", expected: "fun learnedScale(value: Double): Double { val result = value * 2.0; return result }" }
    ];
    for (const item of cases) {
      const sourceHash = createHasher().digestHex(item.source);
      const constructions = await compileSourceCodeFunctionsAsync({ text: item.source, path: item.path, languageId: item.languageId, sourceHash });
      expect(constructions).toHaveLength(1);
      expect(constructions[0]!.sourceText).toBe(item.source);
      const record: NgramModelRecord = { id: item.path, streamId: `oss_code:${item.path}`, languageHint: item.languageId, maxOrder: 1, discount: 0.75, updatedAt: 1,
        modelJson: toJsonValue({ sourceSystem: "oss_code", sourceHash, formalLanguage: item.languageId, codeFunctionConstructions: constructions }) };
      const requirements = codeRequestSignal("learnedScale(1.5)=3; learnedScale(2.25)=4.5").behaviorRequirements;
      const realized = realizeSourceCodeFunctions({ records: [record], languageId: item.languageId, requirements });
      expect(realized).toHaveLength(1);
      expect(realized[0]!.text).toBe(item.expected);
    }
    const rustInteger = "fn twice(value: i32) -> i32 { value * 2 }";
    expect(await compileSourceCodeFunctionsAsync({ text: rustInteger, path: "integer.rs", languageId: "rust", sourceHash: createHasher().digestHex(rustInteger) })).toEqual([]);
    const integerDivisionCases = [
      { languageId: "rust", path: "half.rs", source: "pub fn half() -> i32 { 1 / 2 }" },
      { languageId: "rust", path: "unused.rs", source: "pub fn half(unused: f64) -> f64 { 1 / 2 }" },
      { languageId: "rust", path: "local.rs", source: "pub fn half(unused: f64) -> i32 { let local: i32 = 1 / 2; local }" },
      { languageId: "rust", path: "local-float.rs", source: "pub fn half(value: f64) -> f64 { let local: i32 = 1 / 2; value * 2.0 }" },
      { languageId: "rust", path: "local-mismatch.rs", source: "pub fn half(value: f64) -> f64 { let local: i32 = value / 2.0; value * 2.0 }" },
      { languageId: "kotlin", path: "Half.kt", source: "fun half(unused: Double): Int { return 1 / 2 }" },
      { languageId: "kotlin", path: "unused.kt", source: "fun half(unused: Double): Double = 1 / 2" },
      { languageId: "kotlin", path: "Local.kt", source: "fun half(value: Double): Double { val local: Int = 1 / 2; return value * 2.0 }" },
      { languageId: "kotlin", path: "LocalMismatch.kt", source: "fun half(value: Double): Double { val local: Int = value / 2.0; return value * 2.0 }" }
    ];
    for (const item of integerDivisionCases) {
      expect(await compileSourceCodeFunctionsAsync({ text: item.source, path: item.path, languageId: item.languageId, sourceHash: createHasher().digestHex(item.source) })).toEqual([]);
    }
    const malformed = "def malformed(value):\n    return value +\n";
    expect(await compileSourceCodeFunctionsAsync({ text: malformed, path: "malformed.py", languageId: "python", sourceHash: createHasher().digestHex(malformed) })).toEqual([]);
    const validLiteralDivision = "pub fn half() -> f64 { 1.0 / 2.0 }";
    expect(await compileSourceCodeFunctionsAsync({ text: validLiteralDivision, path: "float.rs", languageId: "rust", sourceHash: createHasher().digestHex(validLiteralDivision) })).toHaveLength(1);
  });

  it("does not treat Python string addition as numeric addition in the shared behavior IR", async () => {
    const text = "def join(left, right):\n    return left + right\n";
    const sourceHash = createHasher().digestHex(text);
    const constructions = await compileSourceCodeFunctionsAsync({ text, path: "join.py", languageId: "python", sourceHash });
    const record: NgramModelRecord = { id: "python-join", streamId: "oss_code:join.py", languageHint: "python", maxOrder: 1, discount: 0.75, updatedAt: 1,
      modelJson: toJsonValue({ sourceSystem: "oss_code", sourceHash, formalLanguage: "python", codeFunctionConstructions: constructions }) };
    expect(realizeSourceCodeFunctions({ records: [record], languageId: "python", requirements: codeRequestSignal('join("a","b")="ab"; join("x","y")="xy"').behaviorRequirements })).toEqual([]);
  });

  it("applies Python numeric-domain checks only to operands used by source arithmetic", async () => {
    const text = "def scale(value, unused):\n    return value * 2\n";
    const sourceHash = createHasher().digestHex(text);
    const constructions = await compileSourceCodeFunctionsAsync({ text, path: "scale.py", languageId: "python", sourceHash });
    const record: NgramModelRecord = { id: "python-scale", streamId: "oss_code:scale.py", languageHint: "python", maxOrder: 1, discount: 0.75, updatedAt: 1,
      modelJson: toJsonValue({ sourceSystem: "oss_code", sourceHash, formalLanguage: "python", codeFunctionConstructions: constructions }) };
    const requirements = codeRequestSignal("scale(2,9007199254740992)=4; scale(3,9007199254740992)=6").behaviorRequirements;
    expect(requirements).toHaveLength(2);
    expect(realizeSourceCodeFunctions({ records: [record], languageId: "python", requirements })).toHaveLength(1);
  });
});

function pythonExecutable(): string | undefined {
  const configured = process.env.SCCE_TEST_PYTHON;
  for (const candidate of [configured, "C:/Python314/python.exe", "python", "python3"].filter((value): value is string => Boolean(value))) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) return candidate;
  }
  return undefined;
}

function pythonRgbToYiq(python: string, rows: readonly (readonly number[])[]): number[][] {
  const script = "import colorsys,json,sys; print(json.dumps([colorsys.rgb_to_yiq(*row) for row in json.load(sys.stdin)]))";
  const result = spawnSync(python, ["-c", script], { input: JSON.stringify(rows), encoding: "utf8" });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as number[][];
}
