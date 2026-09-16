// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CONVERSATIONAL_BINDING_REFUSAL_IDS,
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

  // The paired regression whoever opens that gate must satisfy, both halves, in one run. See
  // .agent/tasks/T23-conversational-realization-gate.md. Enabling either half alone proves nothing.
  it.todo("realizes a supported conversational move once a conversation-internal licence is accepted in place of an evidence id");
  it.todo("still withholds for \"What is the boiling point of tungsten?\" with no admitted evidence");
});

const ROLE = "role.conversational.01";
const OCCURRENCE = "occurrence.conversational.01";

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
