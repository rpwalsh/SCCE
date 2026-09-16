// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CONVERSATIONAL_BINDING_REFUSAL_IDS,
  CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID,
  SURFACE_AUTHORITY_CLASS_IDS,
  admitConversationalActBinding,
  authorityClassMayAssertAsKnown,
  conversationBoundMoveMayAssertAsKnown,
  conversationalActBindingId,
  conversationalActBindingRecordId,
  conversationalSurfaceMeaningPlan,
  literalResidueIsCorpusInvariant,
  surfaceAuthorityClass,
  type ConversationTurnSurface,
  type ConversationalActBinding
} from "../conversational-act-binding.js";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";
import {
  LANGUAGE_CONSTRUCTION_REJECTION_IDS,
  induceLearnedConstructions,
  realizeLearnedSurface,
  type AlignedSurfaceExample
} from "../language-construction.js";
import { createHasher } from "../primitives.js";
import type { RequestCommunicativeActClassification } from "../request-communicative-act.js";

const HASHER = createHasher();
const PROFILE = "profile.conversational.01";
// An induced act id, not a member of any hand-authored inventory.
const INDUCED_ACT = "actshape.6b1d0f24";
const CONVERSATION = "conversation.01";

// A plausible measured spread of independent source families; its Otsu split is the floor.
const FAMILY_DISTRIBUTION = [1, 1, 2, 2, 3, 7, 8, 9];

const TURNS: ConversationTurnSurface[] = [
  { turnId: "turn.01", turnIndex: 0, surface: "the pump feed reads high" },
  { turnId: "turn.02", turnIndex: 1, surface: "no thats wrong" }
];

function classification(
  overrides: Partial<RequestCommunicativeActClassification> = {}
): RequestCommunicativeActClassification {
  return {
    schema: "scce.request_communicative_act_classification.v1",
    status: "active",
    actId: INDUCED_ACT,
    matchedPatternIds: ["feature.01"],
    logOddsOverNeutral: 1.4,
    classIds: [INDUCED_ACT, DIALOGUE_ACT_IDS.neutral],
    ...overrides
  };
}

function binding(overrides: Partial<ConversationalActBinding> = {}): ConversationalActBinding {
  const actId = overrides.actId ?? INDUCED_ACT;
  const profileKey = overrides.profileKey ?? PROFILE;
  const base: Omit<ConversationalActBinding, "id" | "schema"> = {
    actId,
    bindingId: conversationalActBindingId(HASHER, profileKey, actId),
    profileKey,
    conversationId: CONVERSATION,
    turnId: "turn.02",
    turnIndex: 1,
    // "the pump feed" -- code points 0..13 of turn.01.
    fillers: [{ slotIndex: 0, surface: "the pump feed", sourceTurnId: "turn.01", startCodePoint: 0, endCodePoint: 13 }],
    ...stripIdentity(overrides)
  };
  return { schema: "scce.conversational_act_binding.v1", id: conversationalActBindingRecordId(HASHER, base), ...base };
}

function stripIdentity(overrides: Partial<ConversationalActBinding>): Partial<Omit<ConversationalActBinding, "id" | "schema">> {
  const { id: _id, schema: _schema, ...rest } = overrides;
  return rest;
}

function admit(input: { binding?: ConversationalActBinding; classification?: RequestCommunicativeActClassification; distribution?: readonly number[]; families?: number }) {
  return admitConversationalActBinding({
    binding: input.binding ?? binding(),
    classification: input.classification ?? classification(),
    conversationTurns: TURNS,
    literalInvariance: {
      independentSourceFamilies: input.families ?? 9,
      observedDistribution: input.distribution ?? FAMILY_DISTRIBUTION
    },
    hasher: HASHER
  });
}

describe("surface authority classes are derived from claim discriminators", () => {
  it("separates the four classes and lets only the grounded factual one assert as known", () => {
    const conversationBound = surfaceAuthorityClass({ externallyFactual: false, hypothetical: false, evidenceIds: [] });
    const hypothetical = surfaceAuthorityClass({ externallyFactual: false, hypothetical: true, evidenceIds: [] });
    const grounded = surfaceAuthorityClass({ externallyFactual: true, hypothetical: false, evidenceIds: ["evidence.01"] });
    const unsupported = surfaceAuthorityClass({ externallyFactual: true, hypothetical: false, evidenceIds: [] });
    expect([conversationBound, hypothetical, grounded, unsupported]).toEqual([
      SURFACE_AUTHORITY_CLASS_IDS.conversationBound,
      SURFACE_AUTHORITY_CLASS_IDS.hypotheticalProposed,
      SURFACE_AUTHORITY_CLASS_IDS.groundedFactual,
      SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual
    ]);
    expect([conversationBound, hypothetical, grounded, unsupported].map(authorityClassMayAssertAsKnown))
      .toEqual([false, false, true, false]);
  });

  it("holds an externally factual claim with no evidence to unsupported however it is dressed up", () => {
    // "What is the boiling point of tungsten?" with nothing admitted: externally factual, no evidence.
    const tungsten = { externallyFactual: true, hypothetical: false, evidenceIds: [] as string[] };
    expect(surfaceAuthorityClass(tungsten)).toBe(SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual);
    expect(authorityClassMayAssertAsKnown(surfaceAuthorityClass(tungsten))).toBe(false);
  });
});

describe("conversational act binding admission", () => {
  it("admits a supported conversational move and emits a move that can never assert as known", () => {
    const admission = admit({});
    expect(admission.status).toBe("admissible");
    if (admission.status !== "admissible") return;
    expect(admission.move).toMatchObject({
      externallyFactual: false,
      hypothetical: false,
      evidenceIds: [],
      relationIds: [],
      authorityClassId: SURFACE_AUTHORITY_CLASS_IDS.conversationBound
    });
    expect(conversationBoundMoveMayAssertAsKnown(admission.move)).toBe(false);
  });

  it("refuses when the act classifier never earned its model", () => {
    for (const status of ["inert_unconfigured", "bypassed_not_applicable", "failed", "disabled_explicitly"] as const) {
      const admission = admit({ classification: classification({ status, actId: INDUCED_ACT }) });
      expect(admission.status).toBe("refused");
      if (admission.status !== "refused") continue;
      expect(admission.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.actNotEarned);
    }
  });

  it("refuses the neutral source-lookup act, which is the factual lane", () => {
    const admission = admit({
      binding: binding({ actId: DIALOGUE_ACT_IDS.neutral }),
      classification: classification({ actId: DIALOGUE_ACT_IDS.neutral })
    });
    expect(admission.status).toBe("refused");
    if (admission.status !== "refused") return;
    expect(admission.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.actIsSourceLookup);
  });

  it("refuses a relation-keyed bundle key relabelled as conversational", () => {
    const admission = admit({ binding: binding({ bindingId: "surface.construction.binding.relation.f00d" }) });
    expect(admission.status).toBe("refused");
    if (admission.status !== "refused") return;
    expect(admission.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.bindingKeyMismatch);
  });

  it("refuses a filler that is not an exact span of a turn of this conversation", () => {
    const corpus = admit({
      binding: binding({
        fillers: [{ slotIndex: 0, surface: "The boiling point of tungsten is 3422 degrees Celsius", sourceTurnId: "turn.01", startCodePoint: 0, endCodePoint: 13 }]
      })
    });
    expect(corpus.status).toBe("refused");
    if (corpus.status !== "refused") return;
    expect(corpus.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.fillerNotConversationInternal);

    const unknownTurn = admit({
      binding: binding({
        fillers: [{ slotIndex: 0, surface: "the pump feed", sourceTurnId: "turn.99", startCodePoint: 0, endCodePoint: 13 }]
      })
    });
    expect(unknownTurn.status).toBe("refused");
    if (unknownTurn.status !== "refused") return;
    expect(unknownTurn.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.fillerFromUnknownTurn);
  });

  it("refuses a filler cut from a turn that has not happened yet", () => {
    const admission = admit({
      binding: binding({
        turnIndex: 0,
        turnId: "turn.01",
        fillers: [{ slotIndex: 0, surface: "no thats wrong", sourceTurnId: "turn.02", startCodePoint: 0, endCodePoint: 14 }]
      })
    });
    expect(admission.status).toBe("refused");
    if (admission.status !== "refused") return;
    expect(admission.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.fillerFromFutureTurn);
  });

  it("refuses when the literal residue's invariance is unmeasured or below the measured split", () => {
    const unmeasured = admit({ distribution: [3, 3] });
    expect(unmeasured.status).toBe("refused");
    if (unmeasured.status !== "refused") return;
    expect(unmeasured.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.literalInvarianceUnmeasured);

    const measured = literalResidueIsCorpusInvariant({ independentSourceFamilies: 1, observedDistribution: FAMILY_DISTRIBUTION });
    expect(measured).toMatchObject({ measured: true, invariant: false });
    const belowFloor = admit({ families: 1 });
    expect(belowFloor.status).toBe("refused");
    if (belowFloor.status !== "refused") return;
    expect(belowFloor.reasonIds).toContain(CONVERSATIONAL_BINDING_REFUSAL_IDS.literalResidueNotInvariant);
  });
});

describe("the realization gate this lane deliberately leaves closed", () => {
  it("pins that a conversational plan is still refused by realizeLearnedSurface for want of an evidence id", () => {
    const admission = admit({});
    expect(admission.status).toBe("admissible");
    if (admission.status !== "admissible") return;
    const learned = induceLearnedConstructions({ hasher: HASHER, examples: [aligned()] });
    expect(learned.constructions.length).toBe(1);
    const { plan, licences } = conversationalSurfaceMeaningPlan({
      binding: admission.binding,
      roleIdForSlot: () => ROLE,
      occurrenceIdForSlot: () => OCCURRENCE,
      hasher: HASHER
    });
    expect(plan.slots.every(slot => slot.variants.every(variant => variant.evidenceIds.length === 0))).toBe(true);
    expect(licences).toHaveLength(1);
    expect(licences[0]).toMatchObject({ sourceTurnId: "turn.01", startCodePoint: 0, endCodePoint: 13 });
    const realized = realizeLearnedSurface({
      plan,
      constructions: learned.constructions,
      formClasses: learned.formClasses,
      hasher: HASHER
    });
    // The gate: the realizer requires a per-slot evidence id. No fake one is supplied, so it refuses.
    expect(realized.status).toBe("rejected");
    if (realized.status !== "rejected") return;
    expect(realized.rejection.code).toBe(LANGUAGE_CONSTRUCTION_REJECTION_IDS.trace);
  });

  it("still refuses that same plan when the caller supplies no conversation to cut the licence from", () => {
    const admission = admit({});
    expect(admission.status).toBe("admissible");
    if (admission.status !== "admissible") return;
    const learned = induceLearnedConstructions({ hasher: HASHER, examples: [aligned()] });
    const { plan } = conversationalSurfaceMeaningPlan({
      binding: admission.binding,
      roleIdForSlot: () => ROLE,
      occurrenceIdForSlot: () => OCCURRENCE,
      hasher: HASHER
    });
    // The licence rides on the variant, but it licenses nothing until a turn proves the span.
    expect(plan.slots[0]!.variants[0]!.conversationInternalLicence).toBeDefined();
    const realized = realizeLearnedSurface({ plan, constructions: learned.constructions, formClasses: learned.formClasses, hasher: HASHER });
    expect(realized.status).toBe("rejected");
    if (realized.status !== "rejected") return;
    expect(realized.rejection.code).toBe(LANGUAGE_CONSTRUCTION_REJECTION_IDS.trace);
  });
});

// The paired regression T23 requires, both halves in one run. Enabling either half alone proves nothing.
// .agent/tasks/T23-conversational-realization-gate.md
describe("the paired regression: conversation speaks, an unsupported world fact still does not", () => {
  it("realizes a supported conversational move once a conversation-internal licence is accepted in place of an evidence id", () => {
    const admission = admit({});
    expect(admission.status).toBe("admissible");
    if (admission.status !== "admissible") return;
    const learned = induceLearnedConstructions({ hasher: HASHER, examples: [aligned()] });
    const { plan, licences } = conversationalSurfaceMeaningPlan({
      binding: admission.binding,
      roleIdForSlot: () => ROLE,
      occurrenceIdForSlot: () => OCCURRENCE,
      hasher: HASHER
    });
    expect(plan.slots.every(slot => slot.variants.every(variant => variant.evidenceIds.length === 0))).toBe(true);
    expect(licences).toHaveLength(1);
    const realized = realizeLearnedSurface({
      plan,
      constructions: learned.constructions,
      formClasses: learned.formClasses,
      hasher: HASHER,
      conversationTurns: TURNS
    });
    if (realized.status !== "realized") console.log("REJECT", JSON.stringify(realized.rejection, null, 1));
    expect(realized.status).toBe("realized");
    if (realized.status !== "realized") return;
    // T23: realized, carrying no document reference, and classed as a move that can never assert as known.
    expect(realized.realization.evidenceIds).toEqual([]);
    expect(realized.realization.text).toBe("the pump feed");
    expect(surfaceAuthorityClass(admission.move)).toBe(SURFACE_AUTHORITY_CLASS_IDS.conversationBound);
    expect(authorityClassMayAssertAsKnown(surfaceAuthorityClass(admission.move))).toBe(false);
    const provenance = realized.realization.provenance.records.find(item => item.recordKind === "meaning_variant");
    expect(provenance?.provenance.methodId).toBe(CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID);
    expect(provenance?.provenance.evidenceIds).toEqual([]);
  });

  it("speaks a learned conversational frame around the user's own words, with the frame's corpus provenance intact", () => {
    const admission = admit({});
    expect(admission.status).toBe("admissible");
    if (admission.status !== "admissible") return;
    const learned = induceLearnedConstructions({ hasher: HASHER, examples: [dialogueFrameExample()] });
    expect(learned.constructions.length).toBe(1);
    const { plan } = conversationalSurfaceMeaningPlan({
      binding: admission.binding,
      roleIdForSlot: () => FRAME_ROLE,
      occurrenceIdForSlot: () => FRAME_OCCURRENCE,
      hasher: HASHER
    });
    const realized = realizeLearnedSurface({
      plan,
      constructions: learned.constructions,
      formClasses: learned.formClasses,
      hasher: HASHER,
      conversationTurns: TURNS
    });
    if (realized.status !== "realized") console.log("REJECT", JSON.stringify(realized.rejection, null, 1));
    expect(realized.status).toBe("realized");
    if (realized.status !== "realized") return;
    // Corpus form, conversation filler. The filler is verbatim from turn.01; nothing here is invented.
    expect(realized.realization.text).toBe("Where is the pump feed, by the way?");
    const slotPart = realized.realization.trace.find(part => part.kind === "slot");
    expect(slotPart?.surface).toBe("the pump feed");
    expect(slotPart?.evidenceIds).toEqual([]);
    // The literal frame keeps the corpus evidence it was induced from: form provenance, not claim support.
    const literal = realized.realization.trace.filter(part => part.kind === "literal");
    expect(literal.length).toBeGreaterThan(0);
    expect(literal.every(part => part.evidenceIds.length > 0)).toBe(true);
  });

  it("refuses every forgery of the conversation-internal licence", () => {
    const admission = admit({});
    expect(admission.status).toBe("admissible");
    if (admission.status !== "admissible") return;
    const learned = induceLearnedConstructions({ hasher: HASHER, examples: [aligned()] });
    const base = conversationalSurfaceMeaningPlan({
      binding: admission.binding,
      roleIdForSlot: () => ROLE,
      occurrenceIdForSlot: () => OCCURRENCE,
      hasher: HASHER
    }).plan;
    const variant = base.slots[0]!.variants[0]!;
    const licence = variant.conversationInternalLicence!;
    const attempt = (patch: Partial<typeof variant>, turns = TURNS) => realizeLearnedSurface({
      plan: { ...base, slots: [{ ...base.slots[0]!, variants: [{ ...variant, ...patch }] }] },
      constructions: learned.constructions,
      formClasses: learned.formClasses,
      hasher: HASHER,
      conversationTurns: turns
    });
    // A surface that is not the span the licence names -- the fabrication this whole line exists to prevent.
    const invented = attempt({ surface: "3422 degrees Celsius" });
    expect(invented.status).toBe("rejected");
    // A licence pointing at a turn this conversation does not contain.
    const unknownTurn = attempt({ conversationInternalLicence: { ...licence, sourceTurnId: "turn.99" } });
    expect(unknownTurn.status).toBe("rejected");
    // A licence whose span is widened past the words it was cut from.
    const widened = attempt({ conversationInternalLicence: { ...licence, endCodePoint: 23 } });
    expect(widened.status).toBe("rejected");
    // A licence belonging to a different variant.
    const borrowed = attempt({ conversationInternalLicence: { ...licence, variantId: "surface.conversational_variant.other" } });
    expect(borrowed.status).toBe("rejected");
    // A variant that declares conversation-internal provenance without a verified span.
    const declared = attempt({
      conversationInternalLicence: undefined,
      provenance: { verification: "unverified", methodId: CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID, sourceExampleIds: [], evidenceIds: [] }
    });
    expect(declared.status).toBe("rejected");
    // And the same plan with no conversation supplied at all.
    expect(attempt({}, []).status).toBe("rejected");
  });
});

const ROLE = "role.conversational.01";
const OCCURRENCE = "occurrence.conversational.01";
const FRAME_ROLE = "role.conversational.frame";
const FRAME_OCCURRENCE = "occurrence.conversational.frame";

// One real line of the trained dialogue population (corpus/dialogue/pg844.txt), aligned on its own noun phrase.
const DIALOGUE_LINE = "Where is that place in the country, by the way?";

function dialogueFrameExample(): AlignedSurfaceExample {
  const start = DIALOGUE_LINE.indexOf("that place in the country");
  return {
    id: "example.dialogue.frame.01",
    profileKey: PROFILE,
    surface: DIALOGUE_LINE,
    evidenceIds: ["evidence.corpus.dialogue.pg844"],
    roleSpans: [{
      roleId: FRAME_ROLE,
      occurrenceId: FRAME_OCCURRENCE,
      start,
      end: start + "that place in the country".length,
      surface: "that place in the country",
      evidenceIds: ["evidence.corpus.dialogue.pg844.role"]
    }]
  };
}

function aligned(): AlignedSurfaceExample {
  return {
    id: "example.conversational.01",
    profileKey: PROFILE,
    surface: "ok",
    evidenceIds: ["evidence.example.conversational.01"],
    roleSpans: [{
      roleId: ROLE,
      occurrenceId: OCCURRENCE,
      start: 0,
      end: 2,
      surface: "ok",
      evidenceIds: ["evidence.example.conversational.01.role"]
    }]
  };
}
