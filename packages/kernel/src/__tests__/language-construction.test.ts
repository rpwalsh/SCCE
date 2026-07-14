import { describe, expect, it } from "vitest";
import {
  LANGUAGE_CONSTRUCTION_REJECTION_IDS,
  induceLearnedConstructions,
  realizeLearnedSurface,
  type AlignedSurfaceExample,
  type SurfaceMeaningPlan,
  type SurfaceMeaningSlotVariant
} from "../language-construction.js";
import { createHasher } from "../primitives.js";

const ROLE_A = "role.17";
const ROLE_B = "role.29";
const PROFILE_1 = "profile.05";
const PROFILE_2 = "profile.08";
const PROFILE_3 = "profile.13";
const HASHER = createHasher();

describe("corpus-learned surface constructions", () => {
  it("substitutes evidence-bound slots while preserving learned spacing and attachments", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({
        id: "example.01",
        profileKey: PROFILE_1,
        surface: "Aster → pump.",
        roles: [[ROLE_A, "Aster"], [ROLE_B, "pump"]]
      })]
    });
    const construction = learned.constructions[0];
    expect(construction?.sequence.map(part => part.kind === "literal" ? part.surface : part.roleId)).toEqual([
      ROLE_A,
      " → ",
      ROLE_B,
      "."
    ]);

    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: plan(PROFILE_1, [variant(ROLE_A, "Nova", PROFILE_1), variant(ROLE_B, "valve", PROFILE_1)]),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });

    expect(result.status).toBe("realized");
    if (result.status !== "realized") throw new Error(result.rejection.code);
    expect(result.realization.text).toBe("Nova → valve.");
    expect(result.realization.trace.map(part => [part.kind, part.outputStart, part.outputEnd])).toEqual([
      ["slot", 0, 4],
      ["literal", 4, 7],
      ["slot", 7, 12],
      ["literal", 12, 13]
    ]);
    expect(result.realization.trace.every(part => part.evidenceIds.length > 0)).toBe(true);
  });

  it("preserves whitespace-free NFC combining-mark surfaces without inserting separators", () => {
    const sourceLeft = "x\u0305";
    const targetLeft = "z\u0305";
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({
        id: "example.02",
        profileKey: PROFILE_2,
        surface: `⟦${sourceLeft}⟧42◇`,
        roles: [[ROLE_A, sourceLeft], [ROLE_B, "42"]]
      })]
    });

    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: plan(PROFILE_2, [variant(ROLE_A, targetLeft, PROFILE_2), variant(ROLE_B, "81", PROFILE_2)]),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });

    expect(result.status).toBe("realized");
    if (result.status !== "realized") throw new Error(result.rejection.code);
    expect(result.realization.text).toBe(`⟦${targetLeft}⟧81◇`);
    expect(result.realization.text).toBe(result.realization.text.normalize("NFC"));
    expect(result.realization.text).not.toContain(" ");
  });

  it("learns role order and punctuation attachment from an opaque RTL-like profile", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({
        id: "example.03",
        profileKey: PROFILE_3,
        surface: "42←אבג؛",
        roles: [[ROLE_B, "42"], [ROLE_A, "אבג"]]
      })]
    });
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: plan(PROFILE_3, [variant(ROLE_A, "דהו", PROFILE_3), variant(ROLE_B, "73", PROFILE_3)]),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });

    expect(result.status).toBe("realized");
    if (result.status !== "realized") throw new Error(result.rejection.code);
    expect(result.realization.text).toBe("73←דהו؛");
    expect(result.realization.trace.filter(part => part.kind === "slot").map(part => part.roleId)).toEqual([ROLE_B, ROLE_A]);
  });

  it("keeps constructions and every slot variant inside one opaque profile", () => {
    const left = alignedExample({
      id: "example.04",
      profileKey: PROFILE_1,
      surface: "a:b!",
      roles: [[ROLE_A, "a"], [ROLE_B, "b"]]
    });
    const right = alignedExample({
      id: "example.05",
      profileKey: PROFILE_2,
      surface: "b〈a〉。",
      roles: [[ROLE_B, "b"], [ROLE_A, "a"]]
    });
    const learned = induceLearnedConstructions({ examples: [right, left], hasher: HASHER });

    const local = realizeLearnedSurface({
      hasher: HASHER,
      plan: plan(PROFILE_1, [variant(ROLE_A, "c", PROFILE_1), variant(ROLE_B, "d", PROFILE_1)]),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });
    expect(local.status).toBe("realized");
    if (local.status !== "realized") throw new Error(local.rejection.code);
    expect(local.realization.text).toBe("c:d!");

    const mixed = realizeLearnedSurface({
      hasher: HASHER,
      plan: plan(PROFILE_1, [variant(ROLE_A, "c", PROFILE_1), variant(ROLE_B, "d", PROFILE_2)]),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });
    expect(mixed).toMatchObject({
      status: "rejected",
      rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.profile }
    });
  });

  it("returns a structured rejection instead of emitting normalized duplicate fragments", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({
        id: "example.06",
        profileKey: PROFILE_1,
        surface: "a!b!c!",
        roles: [[ROLE_A, "a"], [ROLE_B, "c"]]
      })]
    });
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: plan(PROFILE_1, [variant(ROLE_A, "Q", PROFILE_1), variant(ROLE_B, " q ", PROFILE_1)]),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error(result.realization.text);
    expect(result.rejection.code).toBe(LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateFragment);
    expect(result.rejection).not.toHaveProperty("text");
    expect(result.rejection.issues[0]?.fingerprints).toHaveLength(1);
  });

  it("selects constructions and tied slot variants deterministically", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [
        alignedExample({ id: "example.08", profileKey: PROFILE_1, surface: "u·v!", roles: [[ROLE_A, "u"], [ROLE_B, "v"]] }),
        alignedExample({ id: "example.07", profileKey: PROFILE_1, surface: "u·v!", roles: [[ROLE_A, "u"], [ROLE_B, "v"]] })
      ]
    });
    const meaning = plan(PROFILE_1, [
      {
        roleId: ROLE_A,
        variants: [variantValue("variant.z", "m", PROFILE_1), variantValue("variant.a", "n", PROFILE_1)]
      },
      variant(ROLE_B, "o", PROFILE_1)
    ]);
    const forward = realizeLearnedSurface({ plan: meaning, constructions: learned.constructions, formClasses: learned.formClasses, hasher: HASHER });
    const reversed = realizeLearnedSurface({
      plan: { ...meaning, slots: [...meaning.slots].reverse().map(slot => ({ ...slot, variants: [...slot.variants].reverse() })) },
      constructions: [...learned.constructions].reverse(),
      formClasses: [...learned.formClasses].reverse(),
      hasher: HASHER
    });

    expect(forward).toEqual(reversed);
    expect(forward.status).toBe("realized");
    if (forward.status !== "realized") throw new Error(forward.rejection.code);
    expect(forward.realization.text).toBe("n·o!");
    expect(learned.constructions[0]?.support).toBeCloseTo(2 / 3);
  });

  it("keeps construction-pattern provenance separate from emitted slot evidence", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [
        alignedExample({ id: "example.09", profileKey: PROFILE_1, surface: "a!", roles: [[ROLE_A, "a"]] }),
        alignedExample({ id: "example.10", profileKey: PROFILE_1, surface: "b!", roles: [[ROLE_A, "b"]] })
      ]
    });
    const construction = learned.constructions[0];
    expect(construction?.patternEvidenceIds).toContain("evidence.example.10.role.17");
    expect(construction?.provenance.verification).toBe("unverified");

    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: {
        id: "plan.provenance",
        profileKey: PROFILE_1,
        roleSignature: [ROLE_A],
        slots: [variant(ROLE_A, "a", PROFILE_1)]
      },
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });

    expect(result.status).toBe("realized");
    if (result.status !== "realized") throw new Error(result.rejection.code);
    const slotTrace = result.realization.trace.find(part => part.kind === "slot");
    expect(slotTrace?.sourceExampleIds).toEqual(["example.09"]);
    expect(result.realization.evidenceIds).toContain("evidence.variant.role.17");
    expect(result.realization.evidenceIds).not.toContain("evidence.example.10.role.17");
    expect(result.realization.provenance.verification).toBe("unverified");
  });

  it("rejects duplicate example identity and out-of-range caller support", () => {
    const duplicate = alignedExample({
      id: "example.duplicate",
      profileKey: PROFILE_1,
      surface: "a:b!",
      roles: [[ROLE_A, "a"], [ROLE_B, "b"]]
    });
    const duplicateResult = induceLearnedConstructions({
      examples: [duplicate, { ...duplicate }],
      hasher: HASHER
    });
    expect(duplicateResult.constructions).toHaveLength(0);
    expect(duplicateResult.rejected).toEqual([
      expect.objectContaining({
        code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateIdentity,
        sourceExampleId: "example.duplicate"
      })
    ]);

    const learned = induceLearnedConstructions({
      examples: [alignedExample({
        id: "example.support",
        profileKey: PROFILE_1,
        surface: "a:b!",
        roles: [[ROLE_A, "a"], [ROLE_B, "b"]]
      })],
      hasher: HASHER
    });
    const unbounded = variant(ROLE_A, "c", PROFILE_1);
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: plan(PROFILE_1, [
        { ...unbounded, variants: [{ ...unbounded.variants[0]!, support: 10_000 }] },
        variant(ROLE_B, "d", PROFILE_1)
      ]),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });
    expect(result).toMatchObject({
      status: "rejected",
      rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.slotVariant }
    });
  });

  it("rejects output traces whose part boundary bisects one grapheme", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({
        id: "example.grapheme",
        profileKey: PROFILE_1,
        surface: "👩x",
        roles: [[ROLE_A, "x"]]
      })]
    });
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: {
        id: "plan.grapheme",
        profileKey: PROFILE_1,
        roleSignature: [ROLE_A],
        slots: [variant(ROLE_A, "\u200d👩", PROFILE_1)]
      },
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });
    expect(result).toMatchObject({
      status: "rejected",
      rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.trace }
    });
  });

  it("rejects punctuation-free accidental repetition across explicit role occurrences", () => {
    const missingOccurrences = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({
        id: "example.repeat.invalid",
        profileKey: PROFILE_1,
        surface: "ha ha",
        roles: [[ROLE_A, "ha"], [ROLE_A, "ha"]]
      })]
    });
    expect(missingOccurrences.rejected[0]?.code).toBe(LANGUAGE_CONSTRUCTION_REJECTION_IDS.roleSignature);

    const learned = repeatedRoleLearning();
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: repeatedRolePlan(),
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });
    expect(result).toMatchObject({
      status: "rejected",
      rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.duplicateFragment }
    });
  });

  it("allows declared intentional repetition without inserting spacing", () => {
    const learned = repeatedRoleLearning();
    const meaning = repeatedRolePlan();
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: {
        ...meaning,
        intentionalRepetitions: [{ id: "repetition.opaque.01", occurrenceIds: ["occurrence.01", "occurrence.02"] }]
      },
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });
    expect(result.status).toBe("realized");
    if (result.status !== "realized") throw new Error(result.rejection.code);
    expect(result.realization.text).toBe("yo yo");
    expect(result.realization.trace.filter(part => part.kind === "slot").map(part => part.occurrenceId)).toEqual([
      "occurrence.01",
      "occurrence.02"
    ]);
  });

  it("represents an evidence-bound null role without emitting it", () => {
    const source = alignedExample({
      id: "example.null",
      profileKey: PROFILE_1,
      surface: "a!",
      roles: [[ROLE_A, "a"]]
    });
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [{
        ...source,
        nullRoleOccurrences: [{
          roleId: ROLE_B,
          occurrenceId: "occurrence.null.01",
          evidenceIds: ["evidence.null.01"]
        }]
      }]
    });
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: {
        id: "plan.null",
        profileKey: PROFILE_1,
        roleSignature: [ROLE_A, ROLE_B],
        slots: [
          variant(ROLE_A, "c", PROFILE_1),
          {
            roleId: ROLE_B,
            occurrenceId: "occurrence.null.01",
            realization: "null",
            variants: [],
            evidenceIds: ["evidence.plan.null.01"]
          }
        ]
      },
      constructions: learned.constructions,
      formClasses: learned.formClasses
    });
    expect(result.status).toBe("realized");
    if (result.status !== "realized") throw new Error(result.rejection.code);
    expect(result.realization.text).toBe("c!");
    expect(result.realization.evidenceIds).not.toContain("evidence.plan.null.01");
    expect(result.realization.trace.every(part => part.occurrenceId !== "occurrence.null.01")).toBe(true);
    expect(result.realization.roleOccurrences).toContainEqual({
      roleId: ROLE_B,
      occurrenceId: "occurrence.null.01",
      realization: "null"
    });
  });

  it("does not trust a sealed-provenance claim without an injected verifier", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({
        id: "example.seal",
        profileKey: PROFILE_1,
        surface: "a!",
        roles: [[ROLE_A, "a"]]
      })]
    });
    const construction = learned.constructions[0]!;
    const result = realizeLearnedSurface({
      hasher: HASHER,
      plan: {
        id: "plan.seal",
        profileKey: PROFILE_1,
        roleSignature: [ROLE_A],
        slots: [variant(ROLE_A, "c", PROFILE_1)]
      },
      constructions: [{
        ...construction,
        provenance: {
          verification: "sealed",
          methodId: "provenance.method.opaque.01",
          sealId: "seal.opaque.01",
          digest: "digest.opaque.01",
          sourceExampleIds: construction.sourceExampleIds,
          evidenceIds: construction.patternEvidenceIds
        }
      }],
      formClasses: learned.formClasses
    });
    expect(result).toMatchObject({
      status: "rejected",
      rejection: { code: LANGUAGE_CONSTRUCTION_REJECTION_IDS.provenance }
    });
  });
});

function alignedExample(input: {
  id: string;
  profileKey: string;
  surface: string;
  roles: ReadonlyArray<readonly [string, string, string?]>;
}): AlignedSurfaceExample {
  const used = new Map<string, number>();
  return {
    id: input.id,
    profileKey: input.profileKey,
    surface: input.surface,
    evidenceIds: [`evidence.${input.id}`],
    roleSpans: input.roles.map(([roleId, surface, occurrenceId]) => {
      const from = used.get(surface) ?? 0;
      const start = input.surface.indexOf(surface, from);
      if (start < 0) throw new Error(roleId);
      used.set(surface, start + surface.length);
      return {
        roleId,
        ...(occurrenceId === undefined ? {} : { occurrenceId }),
        start,
        end: start + surface.length,
        surface,
        evidenceIds: [`evidence.${input.id}.${roleId}`]
      };
    })
  };
}

function plan(profileKey: string, slots: SurfaceMeaningPlan["slots"]): SurfaceMeaningPlan {
  return {
    id: "plan.01",
    profileKey,
    roleSignature: [ROLE_A, ROLE_B],
    slots
  };
}

function variant(
  roleId: string,
  surface: string,
  profileKey: string,
  occurrenceId?: string
): SurfaceMeaningPlan["slots"][number] {
  return {
    roleId,
    ...(occurrenceId === undefined ? {} : { occurrenceId }),
    variants: [variantValue(`variant.${occurrenceId ?? roleId}`, surface, profileKey)]
  };
}

function repeatedRoleLearning() {
  return induceLearnedConstructions({
    hasher: HASHER,
    examples: [alignedExample({
      id: "example.repeat.valid",
      profileKey: PROFILE_1,
      surface: "ha ha",
      roles: [
        [ROLE_A, "ha", "occurrence.01"],
        [ROLE_A, "ha", "occurrence.02"]
      ]
    })]
  });
}

function repeatedRolePlan(): SurfaceMeaningPlan {
  return {
    id: "plan.repeat",
    profileKey: PROFILE_1,
    roleSignature: [ROLE_A],
    slots: [
      variant(ROLE_A, "yo", PROFILE_1, "occurrence.01"),
      variant(ROLE_A, "yo", PROFILE_1, "occurrence.02")
    ]
  };
}

function variantValue(id: string, surface: string, profileKey: string): SurfaceMeaningSlotVariant {
  return {
    id,
    profileKey,
    surface,
    evidenceIds: [`evidence.${id}`],
    support: 1
  };
}
