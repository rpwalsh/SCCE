/**
 * Plan items 229-230. Discourse-pragmatics state (tone, phrasing
 * preference, presentation order) is real, uncertain, attributed state --
 * `dialogue-pragmatics.ts` already tracks it from real corrections. What
 * was missing is an explicit boundary proving it can only ever affect
 * *presentation*, never suppress a required factual disclosure or bypass
 * an authorization decision. This module makes that boundary a structural
 * property rather than a rule some caller has to remember: the pragmatics
 * input type has no field capable of marking a disclosure "skippable" or a
 * capability "authorized" -- there is no code path here through which
 * pragmatics preference could reach either outcome, even in principle.
 */

export interface PragmaticsPresentationPreference {
  /** Stylistic suggestions only -- phrasing/tone choices, never disclosure or authorization decisions. */
  suppressPhraseIds?: readonly string[];
  reorderPriority?: readonly string[];
  toneAdjustment?: string;
}

export interface RequiredDisclosure {
  id: string;
  content: string;
}

export interface AuthorizationDecision {
  capabilityId: string;
  authorized: boolean;
  reason: string;
}

export interface PresentationPlan {
  requiredDisclosures: readonly RequiredDisclosure[];
  authorizationDecisions: readonly AuthorizationDecision[];
  pragmatics: PragmaticsPresentationPreference;
}

export interface GuardedPresentationResult {
  /** Every required disclosure's id, unconditionally -- pragmatics.suppressPhraseIds is never consulted here. */
  includedDisclosureIds: string[];
  /** Only capabilities with authorized:true -- pragmatics has no field that could mark one executable. */
  executableCapabilityIds: string[];
  /** The one thing pragmatics genuinely may influence: the presentation order of the disclosures that are already, unconditionally, going to be included. */
  presentationOrder: string[];
}

export function applyPragmaticsGuard(plan: PresentationPlan): GuardedPresentationResult {
  const includedDisclosureIds = plan.requiredDisclosures.map(disclosure => disclosure.id);
  const executableCapabilityIds = plan.authorizationDecisions
    .filter(decision => decision.authorized)
    .map(decision => decision.capabilityId);
  const presentationOrder = orderByPreference(includedDisclosureIds, plan.pragmatics.reorderPriority ?? []);
  return { includedDisclosureIds, executableCapabilityIds, presentationOrder };
}

function orderByPreference(ids: readonly string[], priority: readonly string[]): string[] {
  const prioritized = priority.filter(id => ids.includes(id));
  const rest = ids.filter(id => !prioritized.includes(id)).sort();
  return [...prioritized, ...rest];
}
