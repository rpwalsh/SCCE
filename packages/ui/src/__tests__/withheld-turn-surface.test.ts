// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { renderWorkbench } from "../index.js";
import { UI_MESSAGES_EN_US } from "../locales.js";
import { WITHHELD_SURFACE_SCHEMA, withheldSurfaceView } from "../workbench-model.js";

const NO_EVIDENCE = {
  schema: WITHHELD_SURFACE_SCHEMA,
  reasonId: "withheld.no_admitted_evidence",
  basisReasonIds: [],
  evidenceCount: 0,
  entailmentVerdict: "unsupported",
  epistemicForce: "insufficient_support",
  unresolvedRequirementIds: [],
  learningNeeds: [],
  components: []
};

describe("the workbench renders a withheld turn from its reason id", () => {
  it("carries a message for every reason id the kernel can emit", () => {
    for (const reasonId of ["withheld.no_admitted_evidence", "withheld.surface_refused"]) {
      expect(UI_MESSAGES_EN_US, reasonId).toHaveProperty(reasonId);
    }
  });

  it("maps a withheld record to a distinct, non-empty surface per reason", () => {
    const missing = withheldSurfaceView(NO_EVIDENCE, UI_MESSAGES_EN_US);
    const refused = withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "withheld.surface_refused", evidenceCount: 3 }, UI_MESSAGES_EN_US);
    expect(missing?.reasonId).toBe("withheld.no_admitted_evidence");
    expect(/[\p{L}\p{N}]/u.test(missing?.text ?? "")).toBe(true);
    expect(/[\p{L}\p{N}]/u.test(refused?.text ?? "")).toBe(true);
    expect(missing?.text).not.toBe(refused?.text);
    expect(missing?.detail).toMatchObject({ schema: WITHHELD_SURFACE_SCHEMA, reasonId: "withheld.no_admitted_evidence" });
  });

  it("renders nothing for a payload that is not a withheld record", () => {
    expect(withheldSurfaceView(undefined, UI_MESSAGES_EN_US)).toBeUndefined();
    expect(withheldSurfaceView({ schema: "scce.turn_stream.v1", reasonId: "withheld.surface_refused" }, UI_MESSAGES_EN_US)).toBeUndefined();
    expect(withheldSurfaceView({ ...NO_EVIDENCE, reasonId: "" }, UI_MESSAGES_EN_US)).toBeUndefined();
  });

  it("decides the withheld bubble from the typed record, not from the error message text", () => {
    const html = renderWorkbench("http://127.0.0.1:3873");
    expect(html).toContain("withheldSurfaceView");
    expect(html).not.toContain("runtime declined");
  });
});
