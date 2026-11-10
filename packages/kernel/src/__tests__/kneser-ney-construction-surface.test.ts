// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { continueBoundedProse, proposeKneserNeyContinuation, trainKneserNey } from "../kneser-ney.js";
import { composeConstructionSurface } from "../construction-surface.js";

describe("Kneser-Ney operational proposals and owned prose", () => {
  it("preserves bounded symbol proposals and scoring without claiming their token encoding is prose", () => {
    const model = trainKneserNey(["猫", "が", "走る", "猫", "が", "眠る", "猫", "が", "走る"]);
    const options = { generationExtent: 8, deterministicChoiceSeed: "owned-surface", minSymbolsBeforeEos: 3 };
    const proposal = proposeKneserNeyContinuation(model, ["猫"], options);
    expect(proposal.schema).toBe("scce.kneser_ney_symbol_proposal.v1");
    expect(proposal.symbols.length).toBeGreaterThan(0); expect(proposal.symbols.length).toBeLessThanOrEqual(8);
    expect(proposal).not.toHaveProperty("text");
    const unresolved = continueBoundedProse(model, ["猫"], options);
    expect(unresolved).toMatchObject({ ...proposal, text: "", realizationStatus: "unresolved", requiredAction: "try_alternate_construction" });
    const surface = composeConstructionSurface([{ kind: "literal", surface: "猫が走る。\tকি!", evidenceIds: ["proof"], sourceExampleIds: ["source"] }])!;
    const realized = continueBoundedProse(model, ["猫"], { ...options, realize: observed => {
      expect(observed).toEqual(proposal); observed.symbols.length = 0; return surface;
    } });
    expect(realized.symbols).toEqual(proposal.symbols);
    expect(realized.text).toBe(surface.text); expect(realized.surface).toEqual(surface);
    expect(realized.realizationStatus).toBe("realized");
    expect(realized.logProbability).toBe(proposal.logProbability);
  });
  it("rejects incomplete construction trace coverage instead of inserting boundary text", () => {
    const model = trainKneserNey("alpha beta alpha beta alpha gamma");
    expect(continueBoundedProse(model, ["alpha"], { realize: () => ({ text: "alpha beta", trace: [], evidenceIds: [] }) }))
      .toMatchObject({ text: "", realizationStatus: "unresolved" });
  });
});
