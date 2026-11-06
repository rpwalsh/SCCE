// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/** Requires a typed no-speech abstention for an unanswerable factual question. */
export function validAbstention(input) {
  if (String(input.answer ?? "").trim().length !== 0 || Number(input.evidenceCount) !== 0 || input.force !== "unknown") return false;
  const availability = input.realizationAvailability;
  const typedInsufficientSupport = input.assistantForce === "insufficient_support"
    && availability?.status === "insufficient_support";
  const withheld = input.withheld;
  const typedWithheld = withheld?.schema === "scce.runtime.withheld_surface.v1"
    && Number(withheld.evidenceCount) === 0
    && String(withheld.epistemicForce) === "unknown"
    && Boolean(String(withheld.reasonId ?? ""));
  return typedInsufficientSupport || typedWithheld;
}
