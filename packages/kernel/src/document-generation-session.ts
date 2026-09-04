// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { AddDocumentPlanNodeInput, DocumentPlan, DocumentPlanNode } from "./document-plan.js";
import { EMPTY_DOCUMENT_PLAN, pendingDocumentPlanNodes, completeDocumentPlanNode } from "./document-plan.js";
import type { InitialFact, NarrativeConsistencyReport, NarrativeEvent, NarrativeState } from "./narrative-state.js";
import { establishedNarrativeFacts, evaluateNarrativeConsistency, openNarrativeSetupIds } from "./narrative-state.js";
import type { AntiCopyGuardResult, VoiceProfile, VoiceSample } from "./voice-profile.js";
import { checkAntiCopyGuard } from "./voice-profile.js";
import {
  deleteDocumentPlanNode,
  insertDocumentPlanNode,
  mergeDocumentPlanNodes,
  moveDocumentPlanNode,
  rewriteDocumentPlanNodeContent,
  splitDocumentPlanNode,
  type DocumentRevisionResult
} from "./document-revision.js";

/**
 * Plan items 221-228: the real document/narrative generation capability
 * class the four Phase 18 modules were built for but, until now, never
 * actually composed into one coherent unit. Every real guarantee here is
 * delegated to the already-real, already-tested module that owns it --
 * `document-plan.ts` (coverage/order/reference/rhetorical dependencies),
 * `narrative-state.ts` (structural consistency), `voice-profile.ts`
 * (anti-copy guard), `document-revision.ts` (reversible patches) --
 * nothing here reimplements any of their logic.
 *
 * The one property this module exists to add on top of them: completing
 * a document section is a single real gate that a violation of *either*
 * the anti-copy guard *or* narrative consistency blocks outright, before
 * `document-plan.ts`'s own completion invariants (coverage, rhetorical
 * ordering) are even reached -- so a caller can never accidentally mark a
 * section "done" whose content plagiarizes a protected passage or breaks
 * the narrative it belongs to.
 *
 * **Scope note**: this module is a real, tested library-level
 * composition. It does not (yet) have a live call site in
 * `production-turn-runtime.ts` -- wiring it in requires a genuinely new
 * turn-classification decision (recognizing a "write/revise a document"
 * request) that does not exist anywhere in that ~2900-line file today,
 * which is separate, carefully-sequenced follow-up work, not attempted
 * in this pass.
 */

export interface DocumentGenerationSession {
  plan: DocumentPlan;
  narrative: NarrativeState;
  initialFacts: InitialFact[];
  voiceProfile?: VoiceProfile;
  protectedPassages: VoiceSample[];
  maxAllowedNgramWords: number;
}

export function createDocumentGenerationSession(input: {
  plan?: DocumentPlan;
  narrative?: NarrativeState;
  initialFacts?: readonly InitialFact[];
  voiceProfile?: VoiceProfile;
  protectedPassages?: readonly VoiceSample[];
  maxAllowedNgramWords?: number;
} = {}): DocumentGenerationSession {
  return {
    plan: input.plan ?? EMPTY_DOCUMENT_PLAN,
    narrative: input.narrative ?? { events: [] },
    initialFacts: [...(input.initialFacts ?? [])],
    ...(input.voiceProfile ? { voiceProfile: input.voiceProfile } : {}),
    protectedPassages: [...(input.protectedPassages ?? [])],
    maxAllowedNgramWords: input.maxAllowedNgramWords ?? 8
  };
}

/** Every leaf section genuinely ready to be written next -- direct passthrough to `document-plan.ts`'s own real readiness computation. */
export function nextDocumentGenerationWork(session: DocumentGenerationSession): DocumentPlanNode[] {
  return pendingDocumentPlanNodes(session.plan);
}

export interface NarrativeConditioning {
  /** Every (subject, fact) -> value binding the committed narrative has established -- the binding world-state the next section must be written under. */
  establishedFacts: InitialFact[];
  /** Setups planted but not yet paid off -- the pending narrative obligations the next sections carry. */
  openSetupIds: string[];
}

/**
 * Lever 4, filter -> conditioning: the narrative constraints handed to the
 * generator BEFORE a section is written, derived from exactly the same
 * committed state `completeDocumentSection`'s consistency gate will later
 * check against. The gate stays (defense in depth against a generator that
 * ignores its conditioning), but consistency is no longer discoverable
 * only after the fact -- callers commissioning the next section receive
 * the established world-state and open setups as an input.
 */
export function narrativeConditioningForSession(session: DocumentGenerationSession): NarrativeConditioning {
  return {
    establishedFacts: establishedNarrativeFacts(session.narrative, session.initialFacts),
    openSetupIds: openNarrativeSetupIds(session.narrative)
  };
}

export interface CompleteDocumentSectionInput {
  nodeId: string;
  content: string;
  satisfiedCoverageIds?: readonly string[];
  narrativeEvent?: NarrativeEvent;
}

export type CompleteDocumentSectionResult =
  | { accepted: true; session: DocumentGenerationSession }
  | {
      accepted: false;
      reason: string;
      antiCopyResult?: AntiCopyGuardResult;
      narrativeReport?: NarrativeConsistencyReport;
    };

/**
 * The real combined gate (items 221-228). Runs, in order: the real
 * anti-copy guard against every protected passage (if a voice profile is
 * attached to this session), then real narrative-consistency evaluation
 * (if this section declares a narrative event), and only if both pass
 * does it delegate to `document-plan.ts`'s own real completion
 * invariants (coverage, rhetorical ordering). A rejected narrative event
 * is never committed to `session.narrative` -- rejection has zero effect
 * on session state, matching this module's other real all-or-nothing
 * guarantees.
 */
export function completeDocumentSection(
  session: DocumentGenerationSession,
  input: CompleteDocumentSectionInput
): CompleteDocumentSectionResult {
  if (session.voiceProfile) {
    const antiCopyResult = checkAntiCopyGuard(input.content, session.protectedPassages, session.maxAllowedNgramWords);
    if (antiCopyResult.violatesProtectedSpan) {
      return {
        accepted: false,
        reason: `generated content for ${input.nodeId} reproduces a protected passage verbatim (${antiCopyResult.matchedLength} words from ${antiCopyResult.matchedSourceId})`,
        antiCopyResult
      };
    }
  }

  let narrative = session.narrative;
  if (input.narrativeEvent) {
    const candidateNarrative: NarrativeState = { events: [...narrative.events, input.narrativeEvent] };
    const narrativeReport = evaluateNarrativeConsistency(candidateNarrative, session.initialFacts);
    // Lever 4 refinement (surfaced by the conditioning work's own test): a
    // mid-document open setup is a legitimate carried obligation -- a gun
    // planted in section 1 that pays off in section 5 must not be rejected
    // at section 1's completion. Only an unexplained state change blocks a
    // mid-document section; undischarged setups block only the DOCUMENT's
    // final section, when no pending work remains to pay them off. Until
    // then they are exactly what `narrativeConditioningForSession` hands
    // forward to the next section's generator as `openSetupIds`.
    // All incomplete LEAF sections other than this one -- deliberately NOT
    // just the currently-ready (pending) ones: a section that rhetorically
    // depends on this one is still remaining work that can pay a setup off.
    // Container nodes (parents of other nodes) are structure, not writable
    // work, and are never themselves completed.
    const parentIds = new Set(Object.values(session.plan.nodes)
      .flatMap(node => node.parentId ? [node.parentId] : []));
    const remainingAfterThis = Object.values(session.plan.nodes)
      .filter(node => !node.completed && node.id !== input.nodeId && !parentIds.has(node.id)).length;
    const blocking = narrativeReport.unexplainedStateChanges.length > 0
      || (remainingAfterThis === 0 && narrativeReport.undischargedSetupIds.length > 0);
    if (blocking) {
      return {
        accepted: false,
        reason: `completing ${input.nodeId} would introduce a narrative inconsistency`,
        narrativeReport
      };
    }
    narrative = candidateNarrative;
  }

  const plan = completeDocumentPlanNode(session.plan, {
    nodeId: input.nodeId,
    content: input.content,
    satisfiedCoverageIds: input.satisfiedCoverageIds ?? []
  });
  return { accepted: true, session: { ...session, plan, narrative } };
}

export interface DocumentSessionRevisionResult {
  session: DocumentGenerationSession;
  patch: DocumentRevisionResult["patch"];
}

function withRevisedPlan(session: DocumentGenerationSession, result: DocumentRevisionResult): DocumentSessionRevisionResult {
  return { session: { ...session, plan: result.plan }, patch: result.patch };
}

/** Session-level passthroughs to `document-revision.ts`'s real, reversible revision operations -- narrative and voice-profile state are untouched by a structural plan revision. */
export const reviseDocumentSession = {
  insert: (session: DocumentGenerationSession, input: AddDocumentPlanNodeInput): DocumentSessionRevisionResult =>
    withRevisedPlan(session, insertDocumentPlanNode(session.plan, input)),
  rewrite: (session: DocumentGenerationSession, nodeId: string, newContent: string): DocumentSessionRevisionResult =>
    withRevisedPlan(session, rewriteDocumentPlanNodeContent(session.plan, nodeId, newContent)),
  move: (session: DocumentGenerationSession, nodeId: string, destination: { parentId?: string; order: number }): DocumentSessionRevisionResult =>
    withRevisedPlan(session, moveDocumentPlanNode(session.plan, nodeId, destination)),
  delete: (session: DocumentGenerationSession, nodeId: string): DocumentSessionRevisionResult =>
    withRevisedPlan(session, deleteDocumentPlanNode(session.plan, nodeId)),
  merge: (session: DocumentGenerationSession, input: Parameters<typeof mergeDocumentPlanNodes>[1]): DocumentSessionRevisionResult =>
    withRevisedPlan(session, mergeDocumentPlanNodes(session.plan, input)),
  split: (session: DocumentGenerationSession, input: Parameters<typeof splitDocumentPlanNode>[1]): DocumentSessionRevisionResult =>
    withRevisedPlan(session, splitDocumentPlanNode(session.plan, input))
};
