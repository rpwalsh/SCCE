import type { CapabilityPlanPreview, CapabilityScore } from "./tool-cognition.js";
import type { CounterfactualTrace } from "./functional-cognition.js";
import { clamp01 } from "./primitives.js";

const SAFETY_MARGIN_FLOOR = 0; // scoreCmps compares against thetaSafe itself; this only bounds the value to [0,1].

/**
 * Converts a real, already-scored, non-executing capability-plan preview
 * (see tool-cognition.ts's `previewPlans`) into CMPS-scoreable
 * `CounterfactualTrace`s for `functionalCognitionEngine.project()`.
 *
 * One trace per objective the planner is weighing. `planSteps` is the
 * top-utility candidate for that objective; `substitutedSteps` is the
 * next-best real alternative the scorer actually considered for the same
 * objective (empty when no alternative exists — scoreCmps already falls
 * back to `planSteps` in that case). `evidenceSurvival` and
 * `predictedSkillConfidence` are the scorer's real `evi`/`fit` values, not
 * invented numbers. `safetyMargins` is `1 - risk` for the top candidate,
 * the same risk quantity capability admission and approval routing use
 * elsewhere — this is a real safety-relevant number, not a fabricated one.
 *
 * An empty or action-free preview (a purely factual/no-action turn) yields
 * an empty trace list, which correctly keeps `cmpsAvailable`/`fc` false —
 * this function must never invent a trace to make FC reachable.
 */
export function counterfactualTracesFromCapabilityPreview(preview: CapabilityPlanPreview): CounterfactualTrace[] {
  const byObjective = new Map<string, CapabilityScore[]>();
  for (const score of preview.scored) {
    const list = byObjective.get(score.objectiveId);
    if (list) list.push(score);
    else byObjective.set(score.objectiveId, [score]);
  }

  const traces: CounterfactualTrace[] = [];
  for (const [objectiveId, scores] of byObjective) {
    if (scores.length === 0) continue;
    const ranked = [...scores].sort((a, b) => b.utility - a.utility || a.capabilityId.localeCompare(b.capabilityId));
    const primary = ranked[0];
    if (!primary) continue;
    const alternate = ranked[1];
    traces.push({
      id: `cmps_trace_${objectiveId}`,
      sourceTraceId: objectiveId,
      planSteps: [planStep(primary)],
      substitutedSteps: alternate ? [planStep(alternate)] : [],
      evidenceSurvival: [clamp01(primary.evi)],
      predictedSkillConfidence: [clamp01(primary.fit)],
      safetyMargins: [clamp01(Math.max(SAFETY_MARGIN_FLOOR, 1 - primary.risk))]
    });
  }
  return traces.sort((a, b) => a.id.localeCompare(b.id));
}

function planStep(score: CapabilityScore): string {
  return `${score.capabilityId}:${score.phase}`;
}
