// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createSourceAdmissionController } from "../admission.js";
import type { EvidenceSpan, SourceAdmissionContext, SourceTrust, SourceVersion } from "../types.js";

// Admission decides promote / quarantine / reject, which is the highest authority in the ingest path. It used
// to reach that decision partly through `risk < 0.55`, where risk was 0.45*sensitive + 0.35*binaryRatio +
// 0.2*(no evidence). That blend could not fire: binaryRatio over policy already forces reject, so by that line
// it contributes at most 0.042, leaving 0.45*sensitive + 0.042 < 0.55 -- true for every sensitivity. It bound
// only on sources carrying no evidence. These tests hold the conditions that replaced it.

const TRUST: SourceTrust = {
  identity: 1, integrity: 1, parserReliability: 1, directness: 1,
  authority: 1, freshness: 1, independenceGroup: "fixture:admission",
  accessScope: "owner_private", licenseStatus: "owner_authorized"
};

const CONTEXT: SourceAdmissionContext = {
  sourceClass: "owner_local",
  intendedUse: "direct_evidence",
  promotionAuthority: "owner"
};

function source(metadata: Record<string, unknown> = {}): SourceVersion {
  return {
    sourceId: "source_fixture" as SourceVersion["sourceId"],
    sourceVersionId: "source_version_fixture" as SourceVersion["sourceVersionId"],
    namespace: "fixture",
    canonicalUri: "file://fixture",
    contentHash: "sha256_fixture" as SourceVersion["contentHash"],
    mediaType: "text/plain",
    observedAt: 1_000,
    byteLength: 512,
    sourceTrust: TRUST,
    metadata: metadata as SourceVersion["metadata"]
  };
}

function span(id: string, alpha: number, features: string[] = []): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: "source_fixture" as EvidenceSpan["sourceId"],
    sourceVersionId: "source_version_fixture" as EvidenceSpan["sourceVersionId"],
    chunkId: `${id}_chunk` as EvidenceSpan["chunkId"],
    contentHash: "sha256_chunk" as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0, byteEnd: 16, charStart: 0, charEnd: 16,
    text: "sixteen bytes ok",
    textPreview: "sixteen bytes ok",
    languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {},
    features,
    status: "quarantined",
    alpha,
    observedAt: 1_000
  } as EvidenceSpan;
}

describe("admission decides on conditions, not on a blended score", () => {
  it("promotes an authorized source that carries evidence", () => {
    const decision = createSourceAdmissionController().decide({
      source: source(), evidence: [span("e1", 0.8)], context: CONTEXT
    });
    expect(decision.disposition).toBe("promote");
  });

  it("never promotes a source carrying no evidence, whatever its trust", () => {
    // The retired blend promoted this: no evidence scored 0.2, comfortably under 0.55. Promotion grants
    // influence over the graph and language memory, and there is nothing here to grant it over.
    const decision = createSourceAdmissionController({ requireText: false }).decide({
      source: source(), evidence: [], context: CONTEXT
    });
    expect(decision.disposition).not.toBe("promote");
    expect(decision.reasons).toContain("source carries no evidence to promote");
  });

  it("raises the sensitivity rail on any structured sensitivity, not only above a cut", () => {
    // The rail fired at > 0.15 while the per-span test in the same function used > 0.
    const decision = createSourceAdmissionController({ sensitiveFeatureIds: ["safety:pii"] }).decide({
      source: source(), evidence: [span("e1", 0.9, ["safety:pii"])], context: CONTEXT
    });
    expect(decision.safetyRails).toContain("safety.rail.structured_sensitive_source");
    expect(decision.risk).toBeGreaterThan(0);
  });

  it("discounts unpromoted sensitive evidence by how sensitive it measured", () => {
    // A flat ceiling of 0.42 treated a barely-sensitive span and a wholly sensitive one alike, and RAISED the
    // alpha of anything already under it. The discount is monotone and never raises.
    const decision = createSourceAdmissionController({ sensitiveFeatureIds: ["safety:pii"] }).decide({
      source: source(),
      evidence: [span("e1", 0.9, ["safety:pii"]), span("e2", 0.2, ["safety:pii"]), span("e3", 0.9, [])],
      // quarantine_only forces the unpromoted path, which is where the discount applies.
      context: { ...CONTEXT, intendedUse: "quarantine_only" }
    });
    expect(decision.disposition).not.toBe("promote");
    const byId = new Map(decision.evidenceActions.map(action => [action.evidenceId, action]));

    const sensitiveHigh = byId.get("e1")!;
    expect(sensitiveHigh.action).toBe("lower-alpha");
    expect(sensitiveHigh.alpha).toBeLessThan(0.9);

    // Never raised: the low-alpha sensitive span keeps at most what it had.
    const sensitiveLow = byId.get("e2")!;
    expect(sensitiveLow.alpha).toBeLessThanOrEqual(0.2);

    // Untouched where nothing measured sensitive.
    expect(byId.get("e3")!.alpha).toBe(0.9);
  });

  it("reads extraction reliability as a defect rate, and gets stricter as defects accumulate", () => {
    const controller = createSourceAdmissionController();
    const clean = controller.decide({
      source: source({ parserCount: 1 }), evidence: [span("e1", 0.7)], context: CONTEXT
    });
    const defective = controller.decide({
      source: source({ parserCount: 1, warnings: ["a", "b", "c"], missingPreconditions: [] }),
      evidence: [span("e1", 0.7)],
      context: CONTEXT
    });
    expect(clean.parserDiagnosticReliability).toBeGreaterThan(defective.parserDiagnosticReliability);
    // Three warnings against one parser now fails the gate it feeds, where the old expression still passed.
    expect(defective.parserDiagnosticReliability).toBeLessThan(0.4);
    expect(defective.disposition).not.toBe("promote");
    // And text length no longer enters it: the same defects score the same however much text there was.
    const longer = controller.decide({
      source: source({ parserCount: 1, warnings: ["a", "b", "c"], charLength: 5_000_000 }),
      evidence: [span("e1", 0.7)],
      context: CONTEXT
    });
    expect(longer.parserDiagnosticReliability).toBe(defective.parserDiagnosticReliability);
  });
});
