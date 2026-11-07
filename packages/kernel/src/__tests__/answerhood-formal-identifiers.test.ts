// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerCoversRequest, evidenceDiscriminatesAskedRelation } from "../local-evidence-runtime.js";
import { primeLearnedAnswerUnitForms } from "../learned-answer-unit-forms.js";
import { sourceOwnedAnswerUnitForms } from "./fixtures/source-owned-answer-unit-forms.js";
import type { EvidenceSpan } from "../types.js";

function source(text: string, title: string): EvidenceSpan {
  return { id: "evidence.atomic-relation", sourceVersionId: "source.atomic-relation", text, textPreview: text, status: "promoted", alpha: 1,
    charStart: 0, charEnd: [...text].length, provenance: { title } } as unknown as EvidenceSpan;
}

describe("formal identifiers do not carry natural-language predicate obligations", () => {
  const teaching = sourceOwnedAnswerUnitForms("control r0. controls r0. controlled r0. inspect r0. inspects r0. inspected r0. monitor r0. monitors r0. monitored r0.");
  beforeEach(() => teaching.prime());
  afterEach(() => primeLearnedAnswerUnitForms({ deltas: [], profileIds: new Set() }));

  it.each(["/api/pumps/alpha/control", "https://example.test/control", "urn:service:control", "service.controls", "service_controls", "`controls`", "\\service\\control"])(
    "requires the asked predicate outside the same formal identifier %s", identifier => {
      const request = "route controls pump alpha?";
      const units = ["route", "controls", "pump", "alpha"];
      const positive = `pump alpha is controlled by route ${identifier}.`;
      const mention = `pump alpha log lists route ${identifier}.`;
      expect(answerCoversRequest([positive], source(positive, "pump alpha"), units, request, { relationRequired: true })).toBe(true);
      expect(answerCoversRequest([mention], source(mention, "pump alpha"), units, request, { relationRequired: true })).toBe(false);
      expect(evidenceDiscriminatesAskedRelation(positive, source(positive, "pump alpha"), request)).toBe(true);
      expect(evidenceDiscriminatesAskedRelation(mention, source(mention, "pump alpha"), request)).toBe(false);
    });

  it("keeps uncased natural predicates distinct from the same units inside a path", () => {
    const request = "נמלית שליטה מסלול?";
    const units = ["נמלית", "שליטה", "מסלול"];
    const positive = "נמלית שליטה מסלול /מערכת/שליטה.";
    const mention = "נמלית תיעוד מסלול /מערכת/שליטה.";
    expect(answerCoversRequest([positive], source(positive, "נמלית"), units, request, { relationRequired: true })).toBe(true);
    expect(answerCoversRequest([mention], source(mention, "נמלית"), units, request, { relationRequired: true })).toBe(false);
  });
});
