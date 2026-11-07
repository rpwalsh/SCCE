// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { sourceOwnedBehaviorRequirementsFromDocumentation, type CodeIntent } from "../code-intent.js";
import { toJsonValue } from "../primitives.js";

const intent: CodeIntent = { languageId: "typescript", symbols: [], references: [{ relativePath: "src/filtre.ts", languageId: "typescript", sourceFamily: "repo:fixture", sourceHash: `sha256:${"b".repeat(64)}`, score: 1 }], audit: null };
function pattern(path = "src/filtre.ts", targetName = "filtre_éléments", targetSymbolId = "symbol:resolved") {
  const span = { start: 20, end: 36, textHash: `sha256:${"a".repeat(64)}` };
  return { patternJson: toJsonValue({
    schema: "scce.source_owned_test_contract.v1", sourcePath: path, sourceHash: `sha256:${"b".repeat(64)}`, sourceVersionId: "source-v1",
    formalLanguage: "typescript", repositoryFamily: "repo:fixture", targetSymbolId, targetName,
    cases: [1, 2].map((n, index) => ({ targetSymbolId, targetName, arguments: [[1, n]], expectedResult: [1, n],
      testPath: "spec/filtre.test.ts", testHash: `sha256:${"c".repeat(64)}`, testSourceVersionId: `test-v${n}`,
      inputSpan: span, expectedSpan: span, assertionSpan: { ...span, start: 10 + index * 20, end: 26 + index * 20 } }))
  }) };
}

describe("documentation-bound source-owned code contracts", () => {
  it("selects cases only for the documented target path and preserves held-out source identity", () => {
    const requirements = sourceOwnedBehaviorRequirementsFromDocumentation({ requestText: "Keep unique items.", intent, patterns: [pattern()] });
    expect(requirements).toHaveLength(2);
    expect(requirements.map(row => row.verificationRole)).toEqual(["fit", "held_out"]);
    expect(requirements[0]!.sourceSpan).toEqual({ charStart: 0, charEnd: [..."Keep unique items."].length });
    expect(requirements[0]!.sourceContract?.assertionSpan).toMatchObject({ start: 10, textHash: `sha256:${"a".repeat(64)}` });
    expect(requirements[0]!.sourceContract).toMatchObject({ sourcePath: "src/filtre.ts", sourceVersionId: "source-v1", targetSymbolId: "symbol:resolved", testSourceVersionId: "test-v1" });
  });

  it("does not infer a source contract from an unmatched path, language, or ambiguous source family", () => {
    expect(sourceOwnedBehaviorRequirementsFromDocumentation({ requestText: "Keep unique items.", intent, patterns: [pattern("src/other.ts")] })).toEqual([]);
    expect(sourceOwnedBehaviorRequirementsFromDocumentation({ requestText: "Keep unique items.", intent: { ...intent, languageId: "javascript" }, patterns: [pattern()] })).toEqual([]);
    expect(sourceOwnedBehaviorRequirementsFromDocumentation({ requestText: "Keep unique items.", intent: { ...intent, references: [{ relativePath: "src/filtre.ts", languageId: "typescript", sourceFamily: "repo:other", score: 1 }] }, patterns: [pattern()] })).toEqual([]);
    expect(sourceOwnedBehaviorRequirementsFromDocumentation({ requestText: "Keep unique items.", intent, patterns: [pattern(), pattern()] })).toEqual([]);
  });

  it("keeps a caller declared function name while preserving the source target symbol", () => {
    const requirements = sourceOwnedBehaviorRequirementsFromDocumentation({ requestText: "Create propre_liste(items: number[]): number[]",
      intent: { ...intent, requestSymbols: ["propre_liste"] }, patterns: [pattern()], ownerCallableIds: ["propre_liste"] });
    expect(requirements[0]).toMatchObject({ callableId: "propre_liste", sourceContract: { targetSymbolId: "symbol:resolved", sourcePath: "src/filtre.ts" } });
  });

  it("uses an exact requested source symbol to choose among multiple contracts in one file", () => {
    const requests = sourceOwnedBehaviorRequirementsFromDocumentation({ requestText: "Use add_one.", intent: { ...intent, requestSymbols: ["add_one"] },
      patterns: [pattern("src/filtre.ts", "filtre_éléments", "symbol:dedupe"), pattern("src/filtre.ts", "add_one", "symbol:add-one")] });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.sourceContract?.targetSymbolId).toBe("symbol:add-one");
  });
});
