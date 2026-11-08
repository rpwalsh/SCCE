// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { codeIntentFromDocumentation } from "../code-intent.js";
import type { EvidenceSpan } from "../types.js";

it("does not read ordinary factual evidence as a formal source body", () => {
  const note = { provenance: {}, get text() { throw new Error("unowned field-note body reached formal parser"); } } as unknown as EvidenceSpan;
  const intent = codeIntentFromDocumentation({ requestText: "Ω κ λ", documentation: [note] });
  expect(intent.references).toEqual([]);
  expect(intent.symbols).toEqual(intent.requestSymbols);
  expect(intent.languageId).toBeUndefined();
});

it("retains source-owned documentation references and identifiers", () => {
  const doc = { provenance: { relativePath: "src/opaque.ts", sourceHash: "source.current", repository: { ownerUri: "fixture://repo" } },
    text: "export function αβ(γδ: number) { return γδ; }", alpha: 1 } as unknown as EvidenceSpan;
  const intent = codeIntentFromDocumentation({ requestText: "αβ", documentation: [doc] });
  expect(intent.references).toEqual([{ relativePath: "src/opaque.ts", languageId: "typescript", sourceFamily: "fixture://repo", sourceHash: "source.current", score: 1 }]);
  expect(intent.symbols).toContain("αβ");
  expect(intent.symbols).toContain("γδ");
  expect(intent.languageId).toBe("typescript");
});
