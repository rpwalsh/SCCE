// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { treeSitterBehaviorRepairSites, treeSitterRepairSpans, treeSitterSyntaxInsertionSites } from "../tree-sitter-repair-spans.js";
import { languageIdForFilePath, parseRepositorySyntax } from "../tree-sitter-syntax.js";

describe("parser-owned structural behavioral repair sites", () => {
  it("bounds the frozen map-write loss by its call and argument grammar productions", async () => {
    const original = await readFile(new URL("../../../../tools/repair-acceptance/cases/map-write-loss/src/paired-evaluation-statistics.ts", import.meta.url), "utf8");
    const originalCall = "byFamily.set(record.taskFamilyId, bucket)";
    expect(original).toContain(originalCall);
    const damagedCall = "byFamily.get(record.taskFamilyId)";
    const text = original.replace(originalCall, damagedCall);
    const parsed = await parseRepositorySyntax({ fileId: "statistics.ts", languageId: "typescript", text });
    expect(parsed.errors).toEqual([]);
    const sites = await treeSitterBehaviorRepairSites({ targetPath: "statistics.ts", text });
    const start = text.indexOf(damagedCall);
    expect(sites).toContainEqual({ start, length: damagedCall.length, grammarNodeType: "call_expression" });
    expect(sites).toContainEqual({ start: start + "byFamily.get".length, length: "(record.taskFamilyId)".length, grammarNodeType: "arguments" });
    expect(sites).toContainEqual({ start: start + "byFamily.".length, length: "get".length, grammarNodeType: "property_identifier" });
    expect(sites.some(site => site.length === text.length)).toBe(false);
    expect(new Set(sites.map(site => `${site.start}:${site.length}`)).size).toBe(sites.length);
    expect(await treeSitterRepairSpans({ targetPath: "statistics.ts", text, diagnostics: [] })).toEqual([]);
  });

  it.each([
    ["sample.ts", "const label = '\u{1f600}';\nconsume(record.key);", "consume(record.key)", "(record.key)"],
    ["sample.js", "const label = '\u{1f600}';\nconsume(record.key);", "consume(record.key)", "(record.key)"],
    ["sample.tsx", "const label = <span>\u{1f600}</span>;\nconsume(record.key);", "consume(record.key)", "(record.key)"],
    ["sample.py", "label = '\u{1f600}'\nconsume(record.key)\n", "consume(record.key)", "(record.key)"],
    ["sample.rs", "fn run() { let label = \"\u{1f600}\"; consume(record.key); }", "consume(record.key)", "(record.key)"],
    ["sample.go", "package sample\nfunc run() { label := \"\u{1f600}\"; consume(record.key) }", "consume(record.key)", "(record.key)"],
    ["sample.c", "void run() { char *label = \"\u{1f600}\"; consume(record.key); }", "consume(record.key)", "(record.key)"],
    ["sample.cpp", "void run() { auto label = \"\u{1f600}\"; consume(record.key); }", "consume(record.key)", "(record.key)"],
    ["sample.java", "class Sample { void run() { String label = \"\u{1f600}\"; consume(record.key); } }", "consume(record.key)", "(record.key)"],
  ])("uses grammar fields and UTF-16 offsets in %s", async (targetPath, text, call, argumentsText) => {
    const parsed = await parseRepositorySyntax({ fileId: targetPath, languageId: languageIdForFilePath(targetPath)!, text });
    expect(parsed.errors).toEqual([]);
    const sites = await treeSitterBehaviorRepairSites({ targetPath, text });
    for (const region of [call, argumentsText]) {
      const start = text.indexOf(region);
      const site = sites.find(site => site.start === start && site.length === region.length);
      expect(site).toBeDefined();
      expect(site!.grammarNodeType.length).toBeGreaterThan(0);
      expect(text.slice(site!.start, site!.start + site!.length)).toBe(region);
    }
    expect(sites.some(site => site.start === 0 && site.length === text.length)).toBe(false);
  });

  it("admits compound arguments and nested invocations without climbing their statement ancestors", async () => {
    const text = "function run() { consume(record.key + offset, nested(value)); }";
    const sites = await treeSitterBehaviorRepairSites({ targetPath: "nested.ts", text });
    const surfaces = sites.map(site => text.slice(site.start, site.start + site.length));
    expect(surfaces).toContain("record.key + offset");
    expect(surfaces).toContain("nested(value)");
    expect(surfaces).toContain("consume(record.key + offset, nested(value))");
    expect(surfaces).not.toContain("consume(record.key + offset, nested(value));");
    expect(surfaces).not.toContain("{ consume(record.key + offset, nested(value)); }");
    expect(surfaces).not.toContain(text);
    expect(new Set(sites.map(site => `${site.start}:${site.length}`)).size).toBe(sites.length);
  });

  it.each([
    ["callback.ts", "consume((value) => { inspect(value); }, context);", "(value) => { inspect(value); }"],
    ["callback.ts", "consume((value) => inspect(value), context);", "(value) => inspect(value)"],
    ["callback.py", "consume(lambda value: inspect(value), context)\n", "lambda value: inspect(value)"],
    ["callback.go", "package sample\nfunc run() { consume(func(value int) { inspect(value) }, context) }", "func(value int) { inspect(value) }"],
    ["callback.rs", "fn run() { consume(|value| { inspect(value); }, context); }", "|value| { inspect(value); }"],
  ])("keeps callback binding scopes out of structural regions in %s", async (targetPath, text, callback) => {
    const parsed = await parseRepositorySyntax({ fileId: targetPath, languageId: languageIdForFilePath(targetPath)!, text });
    expect(parsed.errors).toEqual([]);
    const sites = await treeSitterBehaviorRepairSites({ targetPath, text });
    const callbackStart = text.indexOf(callback);
    expect(sites.some(site => site.start <= callbackStart && site.start + site.length >= callbackStart + callback.length)).toBe(false);
    for (const region of ["inspect(value)", "(value)", "context"]) {
      const start = region === "(value)" ? text.lastIndexOf(region) : text.indexOf(region);
      expect(sites.some(site => site.start === start && site.length === region.length)).toBe(true);
    }
  });

  it("keeps syntax recovery and unsupported-language sites separate", async () => {
    const text = "consume(value";
    expect(await treeSitterBehaviorRepairSites({ targetPath: "broken.ts", text })).toEqual([]);
    expect((await treeSitterSyntaxInsertionSites({ targetPath: "broken.ts", text })).length).toBeGreaterThan(0);
    expect(await treeSitterBehaviorRepairSites({ targetPath: "unknown.xyz", text: "consume(value)" })).toEqual([]);
  });
});
