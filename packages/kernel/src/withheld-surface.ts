// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord, kernelString, kernelStringArray, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import type { RuntimeWithheldSurface, TurnResult } from "./types.js";

export const RUNTIME_WITHHELD_SURFACE_SCHEMA = "scce.runtime.withheld_surface.v1" as const;

/** Structural conditions a withheld turn can be in. Typed state ids, never text a surface may speak. */
export const RUNTIME_WITHHELD_REASON_IDS = {
  /** Nothing was admitted, so there was nothing to say anything from. */
  noAdmittedEvidence: "withheld.no_admitted_evidence",
  /** Evidence was admitted and every surface built from it was refused. */
  surfaceRefused: "withheld.surface_refused"
} as const;

/** A component that would have had to speak here, and whether it was in a state to. */
export interface RuntimeWithheldComponent {
  id: string;
  status: string;
}

function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

/**
 * The turn's own record of why it said nothing. Every field is read back off the result -- nothing is
 * re-derived from the request text and nothing is authored -- so a surface can render its own message
 * from the reason id without the kernel ever holding a reply string.
 */
export function withheldSurfaceForTurn(result: TurnResult): RuntimeWithheldSurface | undefined {
  if (hasSpeech(result.answer)) return undefined;
  const selected = jsonRecord(result.selectedCandidate);
  const requestAct = jsonRecord(result.requestCommunicativeAct);
  const components: RuntimeWithheldComponent[] = [];
  const requestActStatus = kernelString(requestAct.status);
  if (requestActStatus) components.push({ id: "request_communicative_act", status: requestActStatus });
  return {
    schema: RUNTIME_WITHHELD_SURFACE_SCHEMA,
    reasonId: result.evidence.length
      ? RUNTIME_WITHHELD_REASON_IDS.surfaceRefused
      : RUNTIME_WITHHELD_REASON_IDS.noAdmittedEvidence,
    basisReasonIds: uniqueKernelStrings(result.answerBasis?.reasonIds ?? []),
    ...(result.answerBasis?.truthState ? { truthStateId: String(result.answerBasis.truthState) } : {}),
    evidenceCount: result.evidence.length,
    entailmentVerdict: String(result.entailment.verdict),
    epistemicForce: String(result.epistemicForce),
    ...(result.requestedAuthority ? { requestedAuthority: String(result.requestedAuthority) } : {}),
    // What the turn looked for and did not resolve: the judge-selected candidate's own missed requirements.
    unresolvedRequirementIds: uniqueKernelStrings(kernelStringArray(selected.missedRequirementIds)).slice(0, 12),
    learningNeeds: result.learningNeeds.slice(0, 12),
    components
  };
}
