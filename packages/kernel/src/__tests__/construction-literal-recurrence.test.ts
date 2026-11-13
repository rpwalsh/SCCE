// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { induceLearnedConstructions, realizeLearnedSurface, LANGUAGE_CONSTRUCTION_REJECTION_IDS, type SurfaceMeaningPlan } from "../language-construction.js";
const hasher = createHasher();
function learned(heading: string) {
  const surface = `始。${heading}：a。${heading}：b。`, first = surface.indexOf("a"), second = surface.indexOf("b");
  return induceLearnedConstructions({ hasher, examples: [{ id: "example.literal.recurrence", profileKey: "profile.owned", surface,
    evidenceIds: ["evidence.owned"], roleSpans: [{ roleId: "role.a", start: first, end: first + 1, surface: "a", evidenceIds: ["evidence.owned"] },
      { roleId: "role.b", start: second, end: second + 1, surface: "b", evidenceIds: ["evidence.owned"] }] }] });
}
function plan(left = "κ", right = "月"): SurfaceMeaningPlan {
  return { id: "plan.owned", profileKey: "profile.owned", roleSignature: ["role.a", "role.b"], slots: [left, right].map((surface, index) => ({
    roleId: index ? "role.b" : "role.a", variants: [{ id: `variant.${index}`, profileKey: "profile.owned", surface, evidenceIds: ["evidence.current"] }] })) };
}
it.each(["🧭", "민수", "ليلى", "Ж"])("licenses literal recurrence only from its distinct observed source coordinates: %s", heading => {
  const memory = learned(heading), result = realizeLearnedSurface({ hasher, ...memory, plan: plan() });
  expect(result.status).toBe("realized");
  if (result.status === "realized") expect(result.realization.text).toBe(`始。${heading}：κ。${heading}：月。`);
});
it.each(["same-origin", "reordered-origin", "different-examples"])("rejects fabricated fixed recurrence geometry: %s", damage => {
  const memory = learned("甲"), construction = memory.constructions[0]!;
  const first = construction.sequence[0]!, second = construction.sequence[2]!;
  if (first.kind !== "literal" || second.kind !== "literal") throw Error("fixture must expose the two literal origins");
  const firstHeadingOffset = first.surface.indexOf("甲"), secondHeadingOffset = second.surface.indexOf("甲");
  for (const origin of second.origins) {
    if (damage === "different-examples") origin.sourceExampleId = "unrelated.example";
    else {
      const sourceStart = damage === "same-origin" ? first.origins[0]!.start + firstHeadingOffset - secondHeadingOffset : 0;
      origin.start = sourceStart; origin.end = sourceStart + second.surface.length;
    }
  }
  expect(realizeLearnedSurface({ hasher, ...memory, plan: plan() })).toMatchObject({ status: "rejected",
    rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateFragment } });
});
it.each(["unknown-example", "unknown-evidence", "unlicensed-literal-evidence"])("rejects all-origins forged membership: %s", damage => {
  const memory = learned("甲");
  for (const part of memory.constructions[0]!.sequence) {
    if (part.kind !== "literal") continue;
    if (damage === "unlicensed-literal-evidence") part.evidenceIds = ["evidence.foreign.literal"];
    for (const origin of part.origins) {
      if (damage === "unknown-example") origin.sourceExampleId = "unknown.example";
      if (damage === "unknown-evidence") origin.evidenceIds = ["unknown.evidence"];
    }
  }
  expect(realizeLearnedSurface({ hasher, ...memory, plan: plan() })).toMatchObject({ status: "rejected",
    rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateFragment } });
});
it("does not license a new slot collision from literal source recurrence", () => {
  const memory = learned("甲");
  expect(realizeLearnedSurface({ hasher, ...memory, plan: plan("Q", " q ") })).toMatchObject({ status: "rejected",
    rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateFragment } });
});
it("does not license a copied literal fragment when a caller slot creates the new matching occurrence", () => {
  const surface = "甲：a。乙：b。", first = surface.indexOf("乙"), memory = induceLearnedConstructions({ hasher, examples: [{
    id: "example.mixed", profileKey: "profile.owned", surface, evidenceIds: ["evidence.owned"], roleSpans: [
      { roleId: "role.a", start: first, end: first + 1, surface: "乙", evidenceIds: ["evidence.owned"] }] }] });
  const meaning: SurfaceMeaningPlan = { id: "plan.mixed", profileKey: "profile.owned", roleSignature: ["role.a"], slots: [{
    roleId: "role.a", variants: [{ id: "variant.collision", profileKey: "profile.owned", surface: "甲", evidenceIds: ["evidence.current"] }] }] };
  expect(realizeLearnedSurface({ hasher, ...memory, plan: meaning })).toMatchObject({ status: "rejected",
    rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateFragment } });
});
