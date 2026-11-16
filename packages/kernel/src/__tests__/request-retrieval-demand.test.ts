// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { requestRetrievalDemand } from "../production-turn-runtime.js";
import type { RequestedAuthority } from "../types.js";

function input(text: string, namedSubjects: readonly string[] = []) {
  return { requestText: text, sourceSignals: { text, namedSubjects, sentenceSequences: [] as readonly (readonly string[])[] },
    authority: "creative" as RequestedAuthority, projection: { authorityDistinguishable: true },
    requirements: Object.freeze({ sourceDependence: 0, noveltyDemand: 1 }), sourceIndependentDialogue: false,
    discourseEvidenceBound: false, metadataEvidenceCount: 0, explicitContextEvidenceCount: 0, declaredEvidenceScope: false };
}

it.each([
  { text: "Give the exact cron expression configured in the admitted walkdir CI workflow.", references: ["ci"] },
  { text: "記録された作業手順の設定値を示してください。", references: ["作業手順"] },
  { text: "أعطني القيمة المسجلة في وثيقة المسار.", references: ["وثيقة المسار"] }
])("uses the current measured source reference for every retrieval gate without changing creative authority: $text", ({ text, references }) => {
  const current = input(text, references), before = JSON.stringify(current);
  const demand = requestRetrievalDemand(current);
  expect(demand).toMatchObject({ sourceDemand: true, namedSubjects: 1, authoredRequestNeedsNoRetrieval: false,
    sourceAnchoringRequired: true, durableEscalationAllowed: true });
  expect(current.authority).toBe("creative"); expect(JSON.stringify(current)).toBe(before);
});

it("preserves source-free creative work's existing no-retrieval decision", () => {
  const current = input("a request whose current corpus measurement names no source");
  expect(requestRetrievalDemand(current)).toEqual({ sourceDemand: false, namedSubjects: 0, quotationSequences: 0,
    authoredRequestNeedsNoRetrieval: true, sourceAnchoringRequired: false, durableEscalationAllowed: false });
});

it("lets the same source-demand decision license program retrieval without projecting factual authority", () => {
  const current = { ...input("opaque request", ["source.opaque"]), authority: "program" as const };
  expect(requestRetrievalDemand(current)).toMatchObject({ sourceDemand: true, sourceAnchoringRequired: true, durableEscalationAllowed: true });
  expect(current.authority).toBe("program");
  expect(requestRetrievalDemand({ ...current, sourceSignals: { ...current.sourceSignals, namedSubjects: [] } }).durableEscalationAllowed).toBe(false);
});

it("uses quotation and admitted context through the same decision without a subject-name cue", () => {
  const current = input("opaque request");
  for (const context of [
    { sourceSignals: { ...current.sourceSignals, sentenceSequences: [["opaque", "quotation"]] } },
    { discourseEvidenceBound: true }, { metadataEvidenceCount: 1 }, { explicitContextEvidenceCount: 1 }, { declaredEvidenceScope: true }
  ]) expect(requestRetrievalDemand({ ...current, ...context })).toMatchObject({ sourceDemand: true,
    authoredRequestNeedsNoRetrieval: false, sourceAnchoringRequired: true, durableEscalationAllowed: true });
});

it("rejects a previous request's source signals rather than allowing them to license lookup", () => {
  const previous = input("previous request", ["previous.source"]);
  expect(() => requestRetrievalDemand({ ...previous, requestText: "different current request" })).toThrow(/current request/u);
  const current = input("different current request");
  expect(requestRetrievalDemand(current).sourceDemand).toBe(false);
});
