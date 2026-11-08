// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { requestClosedClassWords, requestScaffoldingConstructions } from "../closed-class-words.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { answerCoversRequest, evidenceDiscriminatesAskedRelation, requestContentEvidenceUnits } from "../local-evidence-runtime.js";
import type { EvidenceSpan } from "../types.js";
import type { LanguagePatternRecord } from "../storage.js";

const request = "Where is Neralis observatory located?";
const location = "Neralis observatory is located on Pelora island.";
const director = "Mira Venn directs Neralis observatory.";
const span = { id: "field.notes", sourceVersionId: "field.notes.source", status: "promoted", text: `${director} ${location}`,
  textPreview: `${director} ${location}`, provenance: { title: "Neralis observatory" } } as EvidenceSpan;
const pattern = (surface: string, copies: Record<string, number>, anchor = "any"): LanguagePatternRecord => ({
  id: `${surface}:${anchor}`, profileId: "request.corpus", patternKind: "semantic_role", support: 1, entropy: 0,
  evidenceIds: ["request.corpus.evidence" as never], updatedAt: 1, patternJson: {
    schema: "scce.request_requirement_pattern.v1", selectedAuthority: "factual", requestSpanRole: "control", surface, anchor,
    requestUnitResponseCopyRecipe: "scce.request_unit_response_copy.v1", requestUnitResponseCopyAuthority: "factual",
    requestUnitResponseCopy: Object.entries(copies).map(([unit, copiedPairs]) => ({ unit, copiedPairs, supportedPairs: 6 }))
  }
});
const patterns = [pattern("where is", { where: 0, is: 6 }, "start"), pattern("located", { located: 6 }),
  pattern("observatory located", { observatory: 6, located: 0 })];

afterEach(() => clearCorpusIdentitySignals());

it("discounts source-witnessed request form while keeping a copied predicate required across overlapping frames", () => {
  primeCorpusIdentitySignals({ closedClass: new Set(["is", "on"]), identities: new Set(["neralis observatory"]), spread: new Map(), concentration: 0 });
  const closed = requestClosedClassWords({ requestText: request, patterns, authority: "factual", identityClosedClassWords: new Set(["is", "on"]) });
  expect(closed.has("where")).toBe(true);
  expect(closed.has("located")).toBe(false);
  expect(closed.has("neralis")).toBe(false);
  const units = requestContentEvidenceUnits(request).filter(unit => !closed.has(unit));
  expect(answerCoversRequest([location], span, units, request, { relationRequired: true, languageClosedClassWords: closed })).toBe(true);
  expect(evidenceDiscriminatesAskedRelation(location, span, request, closed)).toBe(true);
  expect(answerCoversRequest([director], span, units, request, { relationRequired: true, languageClosedClassWords: closed })).toBe(false);
  expect(evidenceDiscriminatesAskedRelation(director, span, request, closed)).toBe(false);
  for (const question of ["Where is Neralis observatory blood type?", "Where is Neralis observatory date?", "Where is Neralis observatory year?"]) {
    const scoped = requestClosedClassWords({ requestText: question, patterns, authority: "factual", identityClosedClassWords: new Set(["is", "on"]) });
    expect(evidenceDiscriminatesAskedRelation(location, span, question, scoped)).toBe(false);
    expect(evidenceDiscriminatesAskedRelation(director, span, question, scoped)).toBe(false);
  }
});

it("does not grant new erasure authority to legacy, foreign-class, unknown-recipe or malformed copy records", () => {
  const valid = pattern("where is", { where: 0, is: 6 }, "start");
  const metadata = valid.patternJson as Record<string, any>;
  for (const patch of [
    { requestUnitResponseCopyRecipe: undefined }, { requestUnitResponseCopyRecipe: "unknown" },
    { requestUnitResponseCopyAuthority: "creative" },
    { requestUnitResponseCopy: [{ unit: "where", supportedPairs: 0, copiedPairs: 0 }] },
    { requestUnitResponseCopy: [{ unit: "where", supportedPairs: 6, copiedPairs: -1 }] },
    { requestUnitResponseCopy: [{ unit: "where", supportedPairs: 6, copiedPairs: 7 }] },
    { requestUnitResponseCopy: [{ unit: "located", supportedPairs: 6, copiedPairs: 0 }] }
  ]) {
    const row = { ...valid, patternJson: { ...metadata, ...patch } } as LanguagePatternRecord;
    expect(requestScaffoldingConstructions([row], "factual", request)).toEqual([]);
  }
  expect(requestScaffoldingConstructions([valid], "creative", request)).toEqual([]);
});

it("uses only source-observed matching request frames and preserves opaque normalized units", () => {
  const unrelated = pattern("where does", { where: 6, does: 6 }, "start");
  expect(requestScaffoldingConstructions([...patterns, unrelated], "factual", request)).toEqual([{ parts: [{ kind: "literal", surface: "where" }] }]);
  expect(requestScaffoldingConstructions([pattern("\u03c8 \u03bc", { "\u03c8": 0, "\u03bc": 6 })], "factual", "\u03c8 \u03bc \u03bb?")).toEqual([{ parts: [{ kind: "literal", surface: "\u03c8" }] }]);
});
