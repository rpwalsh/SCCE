// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { evaluateHeldOutConstructionCoverage, prepareConstructionInduction } from "../graph-surface-alignment.js";
import { createHasher } from "../primitives.js";
import * as segmentation from "../unicode-segmentation-v2.js";
import * as induction from "../language-induction.js";

describe("held-out construction work", () => {
  it("reuses a prepared induction and rejects changed training documents", () => {
    const hasher = createHasher();
    const documents = [{ id: "train", text: "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.", evidenceIds: ["evidence.train" as never] }];
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    try {
      const preparedInduction = prepareConstructionInduction({ documents, hasher });
      const input = { trainDocuments: documents, heldOutDocuments: [{ id: "heldout", text: "dog chased ball." }], profileId: "profile.fixture", hasher };
      const first = evaluateHeldOutConstructionCoverage({ ...input, preparedInduction });
      expect(first).toEqual(evaluateHeldOutConstructionCoverage({ ...input, preparedInduction }));
      expect(first.some(row => row.predicate === "chased")).toBe(true);
      expect(engine).toHaveBeenCalledTimes(1);
      documents[0]!.text += " More training material.";
      expect(() => evaluateHeldOutConstructionCoverage({ ...input, preparedInduction })).toThrow("inputs changed");
    } finally {
      engine.mockRestore();
    }
  });

  it("segments each held-out document once across all learned predicates", () => {
    const train = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
      "cat pushed cart.", "dog pushed cart.", "cat pushed box.", "dog pushed box."
    ].join(" ");
    const heldOut = "cat chased ball. dog pushed cart.";
    const segment = vi.spyOn(segmentation, "segmentUnicodeSurfaceV2");
    try {
      const coverage = evaluateHeldOutConstructionCoverage({
        trainDocuments: [{ id: "train", text: train, evidenceIds: ["evidence.train" as never] }],
        heldOutDocuments: [{ id: "heldout", text: heldOut, evidenceIds: ["evidence.heldout" as never] }],
        profileId: "profile.fixture",
        hasher: createHasher()
      });
      expect(coverage).toEqual(expect.arrayContaining([
        expect.objectContaining({ predicate: "chased", heldOutOccurrences: 1, heldOutPrePredicateCovered: 1, heldOutPostPredicateCovered: 1 }),
        expect.objectContaining({ predicate: "pushed", heldOutOccurrences: 1, heldOutPrePredicateCovered: 1, heldOutPostPredicateCovered: 1 })
      ]));
      expect(segment.mock.calls.filter(([text]) => text === heldOut)).toHaveLength(1);
    } finally {
      segment.mockRestore();
    }
  });
});
