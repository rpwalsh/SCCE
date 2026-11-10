// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createLanguageMemoryRuntime, languageGenerationSurfaceAdequate, planLanguageMemoryDiscourse } from "../language-memory-runtime.js";
import { composeConstructionSurface } from "../construction-surface.js";
import { induceLearnedConstructions, realizeLearnedSurface, type SurfaceMeaningPlan } from "../language-construction.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import { LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA } from "../language-construction-memory.js";

const hasher = createHasher();
function learned() {
  const source = "⟦a⟧42%＠9:00。";
  return induceLearnedConstructions({ hasher, examples: [{ id: "example", profileKey: "profile", surface: source,
    evidenceIds: ["source-proof"], roleSpans: [
      { roleId: "actor", start: 1, end: 2, surface: "a", evidenceIds: ["actor-proof"] },
      { roleId: "amount", start: 3, end: 6, surface: "42%", evidenceIds: ["quantity-proof"] }
    ] }] });
}
function plan(): SurfaceMeaningPlan {
  return { id: "new-binding", profileKey: "profile", roleSignature: ["actor", "amount"], slots: [
    { roleId: "actor", variants: [{ id: "new-actor", surface: "কি", profileKey: "profile", support: 1, evidenceIds: ["new-source.actor"] }] },
    { roleId: "amount", variants: [{ id: "new-amount", surface: "40%", profileKey: "profile", support: 1, evidenceIds: ["new-source.amount"] }] }
  ] };
}
describe("complete constructions as the runtime prose boundary", () => {
  it("retains the original multi-fact rhetorical role/priority plan independently of rendering", () => {
    const state = createLanguageMemoryRuntime().hydrate({ models: [] });
    const frames = [
      ["f.primary", "A", "r.quantity", "40%", "qr.ar.703a9d1f"],
      ["f.time", "A", "r.time", "9:00", "qr.ar.29d8e4a7"],
      ["f.secondary", "B", "r.context", "C", "qr.ar.c42f6b80"]
    ].map(([id, subject, predicate, object, roleId]) => ({ id: id!, role: "answer", realizationConstraints: {
      semanticAnswerFact: { subject: subject!, predicate: predicate!, object: object!, roleId: roleId!,
        sourceNodeId: subject!, relationId: predicate!, targetNodeId: object!, support: .8 }, semanticAnswer: { selectedSubject: "A" }
    } }));
    const planning = planLanguageMemoryDiscourse({ state, frames, contextSymbols: ["A"], generationExtent: 64 });
    // Independently executed 1051115e planning closure: complete materials + assignments + stages + prior.
    expect(hasher.digestHex(canonicalStringify(planning))).toBe("dce60ccbc2642101ca351dd417b41cc502e0288b19744bae9eec89d7f6d24d58");
    expect(planning.plan?.assignments.map(assignment => assignment.roleId)).toEqual(["qr.ar.29d8e4a7", "qr.ar.703a9d1f", "qr.ar.c42f6b80"]);
    expect(planning.materials.map(material => material.frameId).sort()).toEqual(frames.map(frame => frame.id).sort());
  });
  it("resolves an actual learned literal/slot program with novel evidence-bound fillers, not a replayed source", () => {
    const runtime = createLanguageMemoryRuntime({ hasher }), state = runtime.hydrate({ models: [] }), learning = learned();
    state.importedConstructionBundles = [{ schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, id: "bundle", bindingId: "binding",
      sourceProfileId: "profile", targetProfileId: "profile", sourceVersionIds: ["source"], evidenceIds: ["source-proof"],
      evidenceContentHashes: [], sourceExamples: [], constructions: [...learning.constructions], formClasses: [...learning.formClasses], contentDigest: "test-owned" }];
    const generated = runtime.generate({ state, constructionPlans: [plan()], requiredTerms: [{ text: "40%", weight: 1 }, { text: "9:00", weight: 1 }] });
    expect(generated.text).toBe("⟦কি⟧40%＠9:00。");
    expect(generated.realizationStatus).toBe("realized"); expect(generated.coverageComplete).toBe(true);
    expect(languageGenerationSurfaceAdequate(generated)).toBe(true);
    expect(generated.surface?.trace.filter(part => part.kind === "slot").map(part => part.evidenceIds)).toEqual([["new-source.actor"], ["new-source.amount"]]);
    expect(state).not.toHaveProperty("joinPrograms");
  });
  it("preserves an explicit multi-source parent program, layout and all child proofs exactly", () => {
    const learning = learned(), result = realizeLearnedSurface({ hasher, plan: plan(), ...learning });
    if (result.status !== "realized") throw new Error(result.rejection.code);
    const second = composeConstructionSurface([{ kind: "literal", surface: "明日→昨日。", evidenceIds: ["temporal-owner"], sourceExampleIds: ["temporal-source"] }])!;
    const parent = composeConstructionSurface([
      { kind: "slot", roleId: "claim.a", surface: result.realization },
      { kind: "literal", surface: "\n\n", evidenceIds: ["layout-owner"], sourceExampleIds: ["layout-source"] },
      { kind: "slot", roleId: "claim.b", surface: second }
    ])!;
    const runtime = createLanguageMemoryRuntime(), state = runtime.hydrate({ models: [] });
    const generated = runtime.generate({ state, constructionSurfaces: [parent] });
    expect(generated.text).toBe("⟦কি⟧40%＠9:00。\n\n明日→昨日。");
    expect(generated.surface).toEqual(parent); expect(generated.surface?.evidenceIds).toContain("temporal-owner");
    expect(generated.discourse.boundaries).toEqual([]); // Layout belongs to the parent, not a second predictor.
  });
  it("does not turn labels into prose or claim a shattered quantity satisfies its required surface", () => {
    const runtime = createLanguageMemoryRuntime(), state = runtime.hydrate({ models: [] });
    expect(runtime.generate({ state, requiredTerms: [{ text: "opaque-label", weight: 1 }] }))
      .toMatchObject({ text: "", realizationStatus: "unresolved", coverageComplete: false });
    const shattered = composeConstructionSurface([{ kind: "literal", surface: "40 % at 9: 00", evidenceIds: ["proof"], sourceExampleIds: ["source"] }])!;
    expect(runtime.generate({ state, constructionSurfaces: [shattered], requiredTerms: [{ text: "40%", weight: 1 }, { text: "9:00", weight: 1 }] }).coverageComplete).toBe(false);
  });
});
