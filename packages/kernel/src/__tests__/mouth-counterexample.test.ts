// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createLanguageMemoryRuntime } from "../index.js";
import { realizeCounterexampleSurfaces } from "../mouth-counterexample.js";
import type { SemanticEntailmentResult } from "../types.js";
import { contrastSourceSpan, counterexampleSourceTeaching } from "./fixtures/counterexample-source-teaching.js";

function fixture(options: Parameters<typeof counterexampleSourceTeaching>[0]["render"] = undefined, reversedRoles = false) {
  const clock = createClock({ fixedTime: 1000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const teaching = counterexampleSourceTeaching({ ids, hasher, render: options, reversedRoles });
  const state = createLanguageMemoryRuntime({ idFactory: ids, hasher }).hydrateFromImportedBrain({
    importRunId: "contrast-test", models: [], observations: [], units: [], patterns: [teaching.pattern], semanticFrames: [],
    constructionEvidence: [teaching.evidence]
  });
  const owner = contrastSourceSpan("The instrument reading is 40%.", ids);
  const entailment = { semanticVerdict: "contradicted", claim: { text: "The instrument reading is 100%." },
    counterexamples: [{ id: "counterexample:quantity", kind: "quantity", claimText: "100%", evidenceIds: [owner.id],
      sourceVersionIds: [owner.sourceVersionId], contradiction: 1, reason: "diagnostic-is-not-language",
      audit: { metadata: { matched: { kind: "quantity", value: "40%" } } } }] } as unknown as SemanticEntailmentResult;
  return { entailment, owner, teaching, hasher, ids, bundles: state.importedConstructionBundles };
}

describe("source-owned counterexample construction", () => {
  it.each([
    [(supported: string, denied: string) => `The supported reading is ${supported}, rather than ${denied}.`, "The supported reading is 40%, rather than 100%."],
    [(supported: string, denied: string) => `支持値は${supported}、否定値は${denied}。`, "支持値は40%、否定値は100%。"]
  ])("binds new supported and denied values using the observed language", (render, expected) => {
    const f = fixture(render);
    const rows = realizeCounterexampleSurfaces({ entailment: f.entailment, evidence: [f.owner], bundles: f.bundles, hasher: f.hasher });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe(expected);
    expect(rows[0]?.evidenceIds).toEqual([f.owner.id]);
    expect(rows[0]?.supportedValue).toBe("40%");
    expect(rows[0]?.deniedValue).toBe("100%");
    expect(rows[0]?.text).not.toContain("diagnostic-is-not-language");
    expect(rows[0]?.evidenceIds).not.toContain(f.teaching.evidence.id);
  });

  it("does not manufacture wording when the observed construction is absent", () => {
    const f = fixture();
    expect(realizeCounterexampleSurfaces({ entailment: f.entailment, evidence: [f.owner], bundles: [], hasher: f.hasher })).toEqual([]);
  });

  it("rejects a form whose source annotations reverse supported and denied roles", () => {
    const f = fixture(undefined, true);
    expect(realizeCounterexampleSurfaces({ entailment: f.entailment, evidence: [f.owner], bundles: f.bundles, hasher: f.hasher })).toEqual([]);
  });

  it("does not bind a value from an unrelated source or a learned prior", () => {
    const f = fixture();
    const unrelated = contrastSourceSpan("Another instrument reading is 40%.", f.ids);
    for (const evidence of [[unrelated], [{ ...f.owner, provenance: { ...(f.owner.provenance as object), provenanceClass: "learned_language_prior" }, trustVector: { forceClass: "learned_language_prior" } }]]) {
      expect(realizeCounterexampleSurfaces({ entailment: f.entailment, evidence, bundles: f.bundles, hasher: f.hasher })).toEqual([]);
    }
  });

  it("does not bind a denied value absent from the actual request", () => {
    const f = fixture();
    f.entailment.counterexamples[0]!.claimText = "99%";
    expect(realizeCounterexampleSurfaces({ entailment: f.entailment, evidence: [f.owner], bundles: f.bundles, hasher: f.hasher })).toEqual([]);
  });
});
