// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { codeRequestSignal, createHasher, realizeSourceCodeFunctions, toJsonValue, type NgramModelRecord } from "@scce/kernel";
import { compileSourceCodeFunctionsAsync } from "../source-code-function-learning.js";

const cases = [
  { languageId: "go", text: "package sample\nfunc sum(left, right float64) float64 { return left + right }" },
  { languageId: "c", text: "double sum(double left, double right) { return left + right; }" },
  { languageId: "cpp", text: "namespace sample { double sum(double left, double right) { return left + right; } }" },
  { languageId: "java", text: "public class Sample { public static double sum(double left, double right) { return left + right; } }" },
  { languageId: "csharp", text: "namespace Sample { public static class Numbers { public static double sum(double left, double right) { return left + right; } } }" }
];

describe("shared native source callable admission", () => {
  it.each(cases)("preserves $languageId source through serialized ownership and shared IR realization", async ({ languageId, text }) => {
    const constructions = await compile(text, languageId);
    expect(constructions).toHaveLength(1);
    expect(constructions[0]!.parameters.map(row => row.name)).toEqual(["left", "right"]);
    expect(text.slice(constructions[0]!.sourceStart, constructions[0]!.sourceEnd)).toBe(constructions[0]!.sourceText);
    const realized = realize(text, languageId, constructions, "learned(1.25,2.5)=3.75; learned(-0.5,4.25)=3.75");
    expect(realized).toHaveLength(1);
    expect(realized[0]!.text).toBe(constructions[0]!.sourceText.replace("sum(", "learned("));
  });

  it("rejects integer arithmetic, receiver-dependent methods, side effects, and unknown grammars", async () => {
    for (const [languageId, text] of [
      ["go", "package sample\nfunc half(value int) int { return value / 2 }"],
      ["c", "int half(int value) { return value / 2; }"],
      ["cpp", "namespace sample { int half(int value) { return value / 2; } }"],
      ["java", "class Sample { public double identity(double value) { return value; } }"],
      ["csharp", "class Sample { public double identity(double value) { return value; } }"],
      ["java", "class Sample { static double identity(double value) { observe(value); return value; } }"],
      ["go", "package sample\nfunc identity(value float32) float32 { return value }"],
      ["klingon", "double identity(double value) { return value; }"]
    ]) expect(await compile(text!, languageId!)).toEqual([]);
  });
});

const goRoot = process.env.SCCE_TEST_GO_ROOT ?? "C:/Users/react/toolchains/go";
const jdkRoot = process.env.SCCE_TEST_JDK_ROOT ?? "C:/Program Files/Java/jdk-25";
const goSource = join(goRoot, "src/cmd/compile/internal/ssa/testdata/fma.go");
const javaSourceZip = join(jdkRoot, "lib/src.zip");

describe("installed human source integration probes", () => {
  it.skipIf(!existsSync(goSource))("learns the Go Authors' actual identity source and runs held-out renamed source with Go", async () => {
    const source = await readFile(goSource, "utf8");
    expect(source).toContain("Copyright 2022 The Go Authors");
    expect(await readFile(join(goRoot, "LICENSE"), "utf8")).toContain("Redistribution and use");
    const constructions = (await compile(source, "go")).filter(row => row.callable.name === "f");
    expect(constructions).toHaveLength(1);
    const realized = realize(source, "go", constructions, "learned(1.25)=1.25; learned(-2.5)=-2.5");
    expect(realized).toHaveLength(1);
    const directory = await mkdtemp(join(tmpdir(), "scce-human-go-"));
    try {
      const path = join(directory, "main.go");
      await writeFile(path, `package main\nimport "fmt"\n${realized[0]!.text}\nfunc main() { fmt.Println(learned(0.375)) }\n`);
      const result = spawnSync(join(goRoot, "bin/go.exe"), ["run", path], { encoding: "utf8", timeout: 60000 });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(Number(result.stdout.trim())).toBe(0.375);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!existsSync(javaSourceZip))("learns installed JDK Double.sum from its real class and executes held-out source in a Java harness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scce-human-java-"));
    try {
      const extracted = spawnSync(join(jdkRoot, "bin/jar.exe"), ["xf", javaSourceZip, "java.base/java/lang/Double.java"], { cwd: directory, encoding: "utf8", timeout: 30000 });
      expect(extracted.status).toBe(0);
      const path = join(directory, "java.base/java/lang/Double.java");
      const source = await readFile(path, "utf8");
      expect(source.slice(0, 1000)).toContain("Copyright");
      const constructions = (await compile(source, "java")).filter(row => row.callable.name === "sum");
      expect(constructions).toHaveLength(1);
      const realized = realize(source, "java", constructions, "learned(1.25,2.5)=3.75; learned(-0.5,4.25)=3.75");
      expect(realized).toHaveLength(1);
      // This harness provides the declaring class; it is not evidence of standalone application emission.
      const harness = join(directory, "Probe.java");
      await writeFile(harness, `class Probe { ${realized[0]!.text}\npublic static void main(String[] args) { System.out.println(learned(0.125,0.25)); } }`);
      const compiled = spawnSync(join(jdkRoot, "bin/javac.exe"), [harness], { encoding: "utf8", timeout: 30000 });
      expect(compiled.stderr).toBe("");
      expect(compiled.status).toBe(0);
      const result = spawnSync(join(jdkRoot, "bin/java.exe"), ["-cp", dirname(harness), "Probe"], { encoding: "utf8", timeout: 30000 });
      expect(result.status).toBe(0);
      expect(Number(result.stdout.trim())).toBe(0.375);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

async function compile(text: string, languageId: string) {
  return compileSourceCodeFunctionsAsync({ text, languageId, path: `source.${languageId}`, sourceHash: createHasher().digestHex(text) });
}

function realize(source: string, languageId: string, constructions: Awaited<ReturnType<typeof compile>>, request: string) {
  const record: NgramModelRecord = { id: `human-source-${languageId}`, streamId: `oss_code:source.${languageId}`, languageHint: languageId,
    maxOrder: 1, discount: 0.75, updatedAt: 1, modelJson: toJsonValue({ sourceSystem: "oss_code", sourceHash: createHasher().digestHex(source), formalLanguage: languageId, codeFunctionConstructions: constructions }) };
  return realizeSourceCodeFunctions({ records: [JSON.parse(JSON.stringify(record)) as NgramModelRecord], languageId, requirements: codeRequestSignal(request).behaviorRequirements });
}
