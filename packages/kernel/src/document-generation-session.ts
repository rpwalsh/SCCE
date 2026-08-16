import type { AddDocumentPlanNodeInput, DocumentPlan, DocumentPlanNode } from "./document-plan.js";
import { EMPTY_DOCUMENT_PLAN, pendingDocumentPlanNodes, completeDocumentPlanNode } from "./document-plan.js";
import type { InitialFact, NarrativeConsistencyReport, NarrativeEvent, NarrativeState } from "./narrative-state.js";
import { evaluateNarrativeConsistency } from "./narrative-state.js";
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
    if (!narrativeReport.consistent) {
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
