// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { grammarSourceOwnedTestCases } from "../grammar-source-owned-test-contracts.js";
import { sourceOwnedTestContractProjections } from "../source-owned-test-contracts.js";
import { statefulSourceContractFixtures } from "./fixtures/polyglot-source-contracts.js";
import { sourceOwnedProgramBehaviorFromDocumentation } from "@scce/kernel";

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("owned native program ABI provenance", () => {
  it.each([statefulSourceContractFixtures[1], statefulSourceContractFixtures[2]])("retains exact declared $languageId signatures through source contracts and stateful IR", async item => {
    const files = Object.entries(item.files).filter(([name]) => /\.(?:go|rs)$/u.test(name)).map(([name, text]) => ({
      path: name, text, languageId: item.languageId, sourceHash: hash(text), sourceVersionId: `source_version_${hash(text).slice(7)}` }));
    const cases = await grammarSourceOwnedTestCases(files);
    expect(cases).toHaveLength(2);
    expect(cases[0]!.nativeAbi).toMatchObject({ schema: "scce.program.native_callable_abi.v1", languageId: item.languageId,
      callableName: "f1", parameters: [{ name: "key", type: { text: item.languageId === "go" ? "string" : "&str" } }],
      returnType: { text: item.languageId === "go" ? "int" : "i64" } });
    const patterns = [...sourceOwnedTestContractProjections(cases, "fixture://native-abi").values()].flat().map(patternJson => ({ patternJson }));
    const source = files.find(file => file.path === item.sourcePath)!;
    const behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText: "Create the documented public module.",
      intent: { languageId: item.languageId, symbols: [], references: [{ sourceFamily: "fixture://native-abi", relativePath: source.path, sourceHash: source.sourceHash, score: 1 }], audit: null }, patterns });
    const invocations = behavior.statefulBehaviorRequirements[1]!.sourceContract!.invocations;
    expect(invocations.map(row => row.nativeAbi?.callableName)).toEqual(["f0", "f1", "f0", "f1"]);
    for (const row of invocations) {
      const abi = row.nativeAbi!;
      expect(abi.owner).toMatchObject({ targetSymbolId: row.targetSymbolId, sourcePath: row.sourcePath, sourceHash: row.sourceHash, sourceVersionId: row.sourceVersionId });
      expect(hash(source.text.slice(abi.signatureSpan.start, abi.signatureSpan.end))).toBe(abi.signatureSpan.textHash);
      for (const type of [...abi.parameters.map(parameter => parameter.type), ...(abi.returnType ? [abi.returnType] : [])]) {
        expect(source.text.slice(type.span.start, type.span.end)).toBe(type.text);
        expect(hash(type.text)).toBe(type.span.textHash);
      }
    }
    for (const corruption of ["foreign-owner", "changed-type"]) {
      const badCases = cases.map(row => ({ ...row, nativeAbi: corruption === "foreign-owner"
        ? { ...row.nativeAbi!, owner: { ...row.nativeAbi!.owner, sourceVersionId: "foreign" } }
        : { ...row.nativeAbi!, returnType: { ...row.nativeAbi!.returnType!, text: "different_type" } } }));
      const badPatterns = [...sourceOwnedTestContractProjections(badCases, "fixture://native-abi").values()].flat().map(patternJson => ({ patternJson }));
      expect(sourceOwnedProgramBehaviorFromDocumentation({ requestText: "Create the documented public module.",
        intent: { languageId: item.languageId, symbols: [], references: [{ sourceFamily: "fixture://native-abi", relativePath: source.path, sourceHash: source.sourceHash, score: 1 }], audit: null },
        patterns: badPatterns })).toEqual({ behaviorRequirements: [], statefulBehaviorRequirements: [] });
    }
  });
});
