// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerCoversRequest, evidenceDiscriminatesAskedRelation, evidenceTitledForRequestSubject } from "../local-evidence-runtime.js";
import { primeLearnedAnswerUnitForms } from "../learned-answer-unit-forms.js";
import { sourceOwnedAnswerhoodLanguage } from "./fixtures/source-owned-answerhood-language.js";
import type { EvidenceSpan } from "../types.js";

function source(text: string, title: string): EvidenceSpan {
  return { id: "evidence.atomic-relation", sourceVersionId: "source.atomic-relation", text, textPreview: text, status: "promoted", alpha: 1,
    charStart: 0, charEnd: [...text].length, provenance: { title } } as unknown as EvidenceSpan;
}

describe("formal identifiers do not carry natural-language predicate obligations", () => {
  const teaching = sourceOwnedAnswerhoodLanguage("control r0. controls r0. controlled r0. settle r0. settled r0. handle r0. handled r0. inspect r0. inspects r0. inspected r0. monitor r0. monitors r0. monitored r0.").forms;
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

  it.each(["li", "港", "נמלית"])("binds the observed source label %s without granting unknown subjects title authority", title => {
    const span = source(`${title} r0.`, title);
    expect(evidenceTitledForRequestSubject(`q0 ${title}?`, [span])).toBe(true);
    expect(evidenceTitledForRequestSubject("q0 z9?", [span])).toBe(false);
    expect(evidenceTitledForRequestSubject(`q0 x${title}x?`, [span])).toBe(false);
    expect(evidenceTitledForRequestSubject("q0 z9?", [source("z9 r0.", "")])).toBe(false);
  });

  it("does not satisfy subject ownership through an empty request-role group", () => {
    const span = source("k2 r0.", "k2");
    expect(answerCoversRequest([span.text], span, [], "q0 z9?", { relationRequired: true })).toBe(false);
  });

  it("does not substitute another source's self-identity for the asked subject", () => {
    const span = { ...source("r0 v9.", "k2"), provenance: { title: "k2", identity: "k2 r0" } } as EvidenceSpan;
    expect(answerCoversRequest([span.text], span, ["q0", "z9"], "q0 z9?", {
      relationRequired: true, boundValues: ["v9"]
    })).toBe(false);
  });
});
