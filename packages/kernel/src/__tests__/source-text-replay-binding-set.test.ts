// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import {
  captureSourceTextReplayBindings,
  sourceTextReplayJson as exact,
  type SourceTextReplayContext
} from "../source-text-replay.js";
import {
  SOURCE_TEXT_REPLAY_BINDING_SET_REFERENCE_SCHEMA,
  createSourceTextReplayBindingSet,
  resolveSourceTextReplayBindingSet,
  sourceTextReplayBindingSetId,
  sourceTextReplayBindingSetReference,
  validateSourceTextReplayBindingSet,
  validateSourceTextReplayBindingSetReference
} from "../source-text-replay-binding-set.js";
import type { LanguageInductionDocument } from "../language-induction.js";
import type { SourceVersionId } from "../types.js";

const hasher = createHasher();
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture() {
  const owners: SourceTextReplayContext["owners"] = new Map([
    ["owner.a", { text: "prefix | Mira sees Pelora. | suffix", sourceVersionId: "source-version-a" as SourceVersionId }],
    ["doc.b", { text: "Neralis is on Pelora island.", sourceVersionId: "source-version-b" as SourceVersionId }]
  ]);
  const firstText = "Mira sees Pelora.", start = owners.get("owner.a")!.text.indexOf(firstText);
  const documents: LanguageInductionDocument[] = [
    { id: "doc.a", text: firstText, sourceVersionId: owners.get("owner.a")!.sourceVersionId!, sourceFamilyId: "field-notes",
      evidenceIds: ["evidence-a" as never], trust: 0.9,
      sourceWindow: { ownerDocumentId: "owner.a", startUtf16: start, endUtf16: start + firstText.length } },
    { id: "doc.b", text: owners.get("doc.b")!.text, sourceVersionId: owners.get("doc.b")!.sourceVersionId!, sourceFamilyId: "encyclopedia",
      evidenceIds: ["evidence-b" as never], trust: 0.7 }
  ];
  const context = { owners, hasher }, bindings = captureSourceTextReplayBindings(documents, context);
  const bindingSet = createSourceTextReplayBindingSet({ modelId: "model.1", profileId: "profile.1",
    manifestPatternId: "pattern.manifest.1", manifestDigest: "a".repeat(64), bindings }, hasher);
  const reference = sourceTextReplayBindingSetReference(bindingSet, hasher);
  return { bindings, bindingSet, reference };
}

describe("content-addressed source replay binding sets", () => {
  it("stores only order/trust/windowed once and gives every replay envelope one compact reference", () => {
    const f = fixture(), serialized = exact(f.bindingSet);
    expect(f.bindingSet.documents).toEqual([
      { documentId: "doc.a", trust: 0.9, windowed: true },
      { documentId: "doc.b", trust: 0.7, windowed: false }
    ]);
    expect(serialized).not.toContain("evidence-a");
    expect(serialized).not.toContain("field-notes");
    expect(serialized).not.toContain("owner.a");
    expect(serialized).not.toContain("Mira sees Pelora");
    expect(f.reference).toEqual({ schema: SOURCE_TEXT_REPLAY_BINDING_SET_REFERENCE_SCHEMA,
      id: sourceTextReplayBindingSetId(f.bindingSet, hasher) });
    expect(exact(resolveSourceTextReplayBindingSet({ ...f, hasher }))).toBe(exact(f.bindings));
  });

  it("is deterministic across cold serialization", () => {
    const f = fixture(), stored = cold(f.bindingSet), reference = cold(f.reference);
    expect(validateSourceTextReplayBindingSet(stored)).toEqual(f.bindingSet);
    expect(validateSourceTextReplayBindingSetReference(reference)).toEqual(f.reference);
    expect(sourceTextReplayBindingSetId(stored, hasher)).toBe(f.reference.id);
    expect(resolveSourceTextReplayBindingSet({ bindingSet: stored, reference, bindings: cold(f.bindings), hasher })).toEqual(f.bindings);
  });

  it.each(["row", "reference", "order", "witness", "trust", "extra"])("fails closed on %s mismatch", mutation => {
    const f = fixture(), bindingSet: any = cold(f.bindingSet), reference: any = cold(f.reference), bindings: any[] = cold(f.bindings);
    if (mutation === "row") bindingSet.manifestDigest = "b".repeat(64);
    if (mutation === "reference") reference.id = `${reference.id.slice(0, -1)}0`;
    if (mutation === "order") bindings.reverse();
    if (mutation === "witness") bindings[0].evidenceIds = ["foreign"];
    if (mutation === "trust") bindings[0].trust = 0.1;
    if (mutation === "extra") bindingSet.extra = true;
    expect(() => resolveSourceTextReplayBindingSet({ bindingSet, reference, bindings, hasher })).toThrow();
  });
});
