// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  candidateCommitmentInventory,
  candidateCommitmentsLicensed,
  candidateMayAssertAsKnown
} from "./candidate-commitment-inventory.js";
import type { PlannedClaim } from "./cognitive-planner.js";
import type { ConversationTurnSurface } from "./language-construction.js";
import { factualRoundTripGate } from "./semantic-round-trip.js";
import { toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

/**
 * The stages every user-visible surface passes, whichever strategy realized it. A strategy is a way of
 * producing the surface; it is never another way of reaching the user.
 */
export const SURFACE_CONTRACT_STAGE_IDS = {
  meaning: "surface.contract.stage.meaning",
  commitments: "surface.contract.stage.commitments",
  authority: "surface.contract.stage.authority",
  discoursePlan: "surface.contract.stage.discourse_plan",
  realization: "surface.contract.stage.realization",
  roundTrip: "surface.contract.stage.round_trip",
  surface: "surface.contract.stage.surface"
} as const;

export type SurfaceContractStageId = typeof SURFACE_CONTRACT_STAGE_IDS[keyof typeof SURFACE_CONTRACT_STAGE_IDS];

/** Which realization strategy produced the surface. All of them sit under the contract; none is a terminal of its own. */
export const SURFACE_REALIZATION_STRATEGY_IDS = {
  learned: "surface.strategy.learned",
  deterministic: "surface.strategy.deterministic",
  recitedEvidence: "surface.strategy.recited_evidence",
  extendedGeneration: "surface.strategy.extended_generation"
} as const;

export type SurfaceRealizationStrategyId =
  typeof SURFACE_REALIZATION_STRATEGY_IDS[keyof typeof SURFACE_REALIZATION_STRATEGY_IDS];

/** Everything the turn holds that may license a unit of a surface. Nothing outside it may reach the user. */
export interface SurfaceContractMaterial {
  requestTurnId?: string;
  requestText: string;
  conversationTurns?: readonly ConversationTurnSurface[];
  evidenceTexts?: readonly { id: string; text: string }[];
  claimBases?: readonly PlannedClaim[];
  slotValues?: readonly { id: string; text: string }[];
  constructionFormLiterals?: readonly { id: string; text: string }[];
  /** The learned closed class of the language and corpus role this turn speaks in. */
  closedClass?: readonly string[];
  /** The meaning this turn selected, as text. Absent means the strategy constructed no intended semantics. */
  intendedText?: string;
}

export interface SurfaceContractResult {
  surface: string;
  withheld: boolean;
  audit: JsonValue;
}

/**
 * Runs the contract over one realized surface and reports, stage by stage, what it passed.
 *
 * `commitmentsDecide` is the one stage that withholds here: it is the gate the runtime-motion composer already
 * applied to its own surface, lifted to the boundary so every strategy carries it instead of only the one whose
 * producer happened to hold the licensing material.
 */
export function evaluateSurfaceContract(input: {
  surface: string;
  strategyId: SurfaceRealizationStrategyId;
  material: SurfaceContractMaterial;
  commitmentsDecide: boolean;
  discoursePlanId?: string | null;
}): SurfaceContractResult {
  const surface = input.surface;
  const material = input.material;
  const conversationTurns: ConversationTurnSurface[] = [
    ...(material.conversationTurns ?? []),
    {
      turnId: material.requestTurnId ?? "turn.request",
      turnIndex: (material.conversationTurns ?? []).length,
      surface: material.requestText
    }
  ].filter(turn => turn.surface.trim().length > 0);
  const inventory = candidateCommitmentInventory({
    text: surface,
    evidenceTexts: material.evidenceTexts ?? [],
    conversationTurns,
    claimBases: material.claimBases ?? [],
    ...(material.slotValues ? { slotValues: material.slotValues } : {}),
    ...(material.constructionFormLiterals ? { constructionFormLiterals: material.constructionFormLiterals } : {}),
    ...(material.closedClass ? { closedClass: material.closedClass } : {})
  });
  const licensed = candidateCommitmentsLicensed(inventory);
  const intendedText = (material.intendedText ?? "").trim();
  const roundTrip = intendedText && surface.trim()
    ? factualRoundTripGate({ intendedText, realizedText: surface })
    : undefined;
  const withheld = Boolean(surface.trim()) && input.commitmentsDecide && !licensed;
  const audit = toJsonValue({
    schema: "scce.mouth.surface_contract.v1",
    strategyId: input.strategyId,
    stages: [
      SURFACE_CONTRACT_STAGE_IDS.meaning,
      SURFACE_CONTRACT_STAGE_IDS.commitments,
      SURFACE_CONTRACT_STAGE_IDS.authority,
      SURFACE_CONTRACT_STAGE_IDS.discoursePlan,
      SURFACE_CONTRACT_STAGE_IDS.realization,
      SURFACE_CONTRACT_STAGE_IDS.roundTrip,
      SURFACE_CONTRACT_STAGE_IDS.surface
    ],
    meaning: { intendedSemanticsPresent: Boolean(intendedText) },
    commitments: {
      decides: input.commitmentsDecide,
      // False means the turn held no learned closed class, so `licensed` below is a verdict about a language it
      // could not tell form from content in.
      closedClassMeasured: inventory.closedClassMeasured,
      licensed,
      unlicensedUnits: inventory.unlicensedUnits.map(unit => unit.surface).slice(0, 24),
      authorityIds: [...inventory.authorityIds]
    },
    authority: {
      classId: inventory.authorityClassId,
      mayAssertAsKnown: candidateMayAssertAsKnown(inventory)
    },
    discoursePlan: { planId: input.discoursePlanId ?? null },
    realization: { strategyId: input.strategyId },
    // Honest, not decorative: a strategy that constructs no intended semantics reports that this stage did not
    // run rather than reporting a pass it never earned.
    roundTrip: roundTrip
      ? {
        applied: true,
        accepted: roundTrip.accepted,
        reason: roundTrip.reason ?? null,
        addedAtoms: roundTrip.cycleTrace.distance.added.length
      }
      : { applied: false, accepted: null, reason: "no-intended-semantics-for-this-strategy", addedAtoms: null },
    surface: { emitted: !withheld && Boolean(surface.trim()), withheld, chars: withheld ? 0 : surface.length }
  });
  return { surface: withheld ? "" : surface, withheld, audit };
}
