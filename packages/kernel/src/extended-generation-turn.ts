import { addDocumentPlanNode, EMPTY_DOCUMENT_PLAN, type DocumentPlan, type DocumentPlanNode } from "./document-plan.js";
import {
  completeDocumentSection,
  createDocumentGenerationSession,
  nextDocumentGenerationWork,
  type DocumentGenerationSession
} from "./document-generation-session.js";
import type { NarrativeEvent } from "./narrative-state.js";
import type { VoiceSample } from "./voice-profile.js";
import { requestContentPriorUnits, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { surfaceEchoesPrompt } from "./creative-section-realization.js";
import { toJsonValue } from "./primitives.js";
import type { JsonValue, RequestedAuthority } from "./types.js";
import type { TurnRequirementField } from "./turn-requirements.js";

/**
 * Plan items 221-228, live routing (the gap `document-generation-session.ts`'s
 * own scope note named): the multi-section, narrative-checked,
 * anti-copy-guarded document machinery existed, was tested, and was
 * storage-wired -- but only a caller who already knew to pass
 * `metadata.documentGeneration` could reach it. An ordinary request for a
 * long piece of writing fell through to the single-shot realization path
 * and produced one or two invented sentences.
 *
 * This module closes that gap *through the existing requirement
 * abstraction* rather than by adding a request-shape branch: the same
 * learned `TurnRequirementField` that already routes authority decides
 * whether a turn needs extended generation, and if so the turn produces a
 * real plan, real persistent state, real per-section realization, real
 * validation, and a real assembly -- instead of one realization call.
 */

/** How many sections a request's own detail demand justifies. Bounded on both ends: never fewer than a real multi-part document, never an unbounded generation loop. */
const MIN_SECTIONS = 3;
const MAX_SECTIONS = 12;

export interface ExtendedGenerationDecision {
  required: boolean;
  sectionTarget: number;
  detailDemand: number;
  noveltyDemand: number;
  audit: JsonValue;
}

/**
 * The turn-classification decision, made from learned requirement
 * dimensions only -- no request-text pattern matching, no language-specific
 * keyword list, nothing a non-English request would fail. `brevityDetailBalance`
 * is the dimension that already means "how much detail does this request
 * demand" (0 = maximally brief, 1 = maximally detailed); `noveltyDemand`
 * already means "how much of this must be invented rather than retrieved".
 * A request that scores high on both is, by the system's own learned
 * routing vocabulary, a request for an extended invented document.
 */
export function extendedGenerationDecision(input: {
  requirementField: TurnRequirementField;
  requestedAuthority: RequestedAuthority;
  detailThreshold?: number;
  noveltyThreshold?: number;
}): ExtendedGenerationDecision {
  const detailDemand = clamp01Number(input.requirementField.brevityDetailBalance);
  const noveltyDemand = clamp01Number(input.requirementField.noveltyDemand);
  const detailThreshold = input.detailThreshold ?? 0.6;
  const noveltyThreshold = input.noveltyThreshold ?? 0.5;
  // Creative authority is the routing decision the system already made for
  // "this must be invented". Extended generation is a *scale* decision on
  // top of it, never a replacement for it.
  const authorityEligible = input.requestedAuthority === "creative";
  // The requirement model must actually carry signal. On an untrained
  // deployment `deriveTurnRequirementField` returns the same constants for
  // every request (including "hi") with confidence 0 -- a threshold on a
  // constant is not a routing decision, it is a coin permanently landing
  // one way. Requiring real confidence keeps this honest: extended
  // generation fires from explicit requirements or a genuinely fitted
  // model, never from an uncalibrated placeholder.
  const fieldConfidence = clamp01Number(input.requirementField.confidence);
  const required = authorityEligible
    && fieldConfidence > 0
    && detailDemand >= detailThreshold
    && noveltyDemand >= noveltyThreshold;
  // Section count scales with the request's own detail demand rather than a
  // fixed constant, so a modest request does not get a twelve-part document.
  const sectionTarget = required
    ? Math.max(MIN_SECTIONS, Math.min(MAX_SECTIONS, Math.round(MIN_SECTIONS + (detailDemand - detailThreshold) / Math.max(1e-6, 1 - detailThreshold) * (MAX_SECTIONS - MIN_SECTIONS))))
    : 0;
  return {
    required,
    sectionTarget,
    detailDemand,
    noveltyDemand,
    audit: toJsonValue({
      decision: "scce.extended_generation.requirement_projection.v1",
      required,
      sectionTarget,
      detailDemand,
      noveltyDemand,
      detailThreshold,
      noveltyThreshold,
      authorityEligible,
      fieldConfidence,
      basis: ["requirementField.brevityDetailBalance", "requirementField.noveltyDemand", "requirementField.confidence", "requestedAuthority"]
    })
  };
}

/**
 * A real generation plan derived from the request's own content, not a
 * fixed template: each section is a genuine `DocumentPlanNode` with a real
 * rhetorical dependency on its predecessor (so `pendingDocumentPlanNodes`
 * yields them in a real order and a later section can never be written
 * before an earlier one) and a real coverage obligation naming the request
 * unit it is responsible for. Coverage ids are the request's own content
 * units, so `document-plan.ts`'s existing completion invariant genuinely
 * checks that the finished document covered what was asked for.
 */
export function buildExtendedGenerationPlan(input: {
  requestText: string;
  sectionTarget: number;
  documentId?: string;
}): DocumentPlan {
  const documentId = input.documentId ?? "document.root";
  const units = uniqueKernelStrings(requestContentPriorUnits(input.requestText)).slice(0, input.sectionTarget);
  const coverageIds = units.map(unit => `coverage.${unit}`);
  let plan = addDocumentPlanNode(EMPTY_DOCUMENT_PLAN, {
    id: documentId,
    kind: "document",
    order: 0,
    goal: input.requestText,
    requiredCoverageIds: coverageIds
  });
  let previousId: string | undefined;
  for (let index = 0; index < input.sectionTarget; index++) {
    const id = `${documentId}.section.${index + 1}`;
    plan = addDocumentPlanNode(plan, {
      id,
      kind: "section",
      parentId: documentId,
      order: index + 1,
      goal: sectionGoal(input.requestText, index, input.sectionTarget),
      requiredCoverageIds: coverageIds[index] ? [coverageIds[index]!] : [],
      ...(previousId ? { rhetoricalDependsOnIds: [previousId] } : {})
    });
    previousId = id;
  }
  return plan;
}

function sectionGoal(requestText: string, index: number, total: number): string {
  // Position-relative goal only. Deliberately not a genre template or an
  // English narrative-beat vocabulary -- the realizer, not this planner,
  // decides what the section says.
  return `${requestText} [part ${index + 1} of ${total}]`;
}

export interface ExtendedGenerationSectionRealization {
  text: string;
  narrativeEvent?: NarrativeEvent;
}

export interface ExtendedGenerationRunResult {
  session: DocumentGenerationSession;
  sections: Array<{ nodeId: string; goal: string; text: string; accepted: boolean; reason?: string }>;
  answer: string;
  audit: JsonValue;
}

/**
 * Drive the plan to completion one real section at a time.
 *
 * `realizeSection` is injected rather than imported so this module never
 * becomes a second realization path: production passes the turn's own
 * Mouth, and every section is realized by exactly the same machinery a
 * single-shot answer would have used. Each realized section then passes
 * through `completeDocumentSection`'s real combined gate (anti-copy guard,
 * then narrative consistency, then the plan's own coverage/order
 * invariants) before it is allowed into the document. A rejected section
 * is recorded with its real reason and never silently included.
 */
export async function runExtendedGeneration(input: {
  session: DocumentGenerationSession;
  realizeSection: (section: DocumentPlanNode, index: number, priorSectionTexts: readonly string[]) => Promise<ExtendedGenerationSectionRealization>;
  maxSections?: number;
}): Promise<ExtendedGenerationRunResult> {
  let session = input.session;
  const sections: ExtendedGenerationRunResult["sections"] = [];
  const maxSections = input.maxSections ?? MAX_SECTIONS;
  for (let index = 0; index < maxSections; index++) {
    const pending = nextDocumentGenerationWork(session);
    const section = pending[0];
    if (!section) break;
    const realized = await input.realizeSection(section, index, sections.filter(row => row.accepted).map(row => row.text));
    const text = realized.text.trim();
    if (!text) {
      // An empty realization is a real failure, not an empty section: stop
      // rather than emit a document with a hole in it.
      sections.push({ nodeId: section.id, goal: section.goal, text: "", accepted: false, reason: "empty realization" });
      break;
    }
    if (surfaceEchoesPrompt(text, section.goal)) {
      // A prompt is never content.
      sections.push({ nodeId: section.id, goal: section.goal, text: "", accepted: false, reason: "prompt echo" });
      break;
    }
    const completion = completeDocumentSection(session, {
      nodeId: section.id,
      content: text,
      satisfiedCoverageIds: section.requiredCoverageIds,
      ...(realized.narrativeEvent ? { narrativeEvent: realized.narrativeEvent } : {})
    });
    if (completion.accepted) {
      session = completion.session;
      sections.push({ nodeId: section.id, goal: section.goal, text, accepted: true });
      continue;
    }
    sections.push({ nodeId: section.id, goal: section.goal, text, accepted: false, reason: completion.reason });
    break;
  }
  const accepted = sections.filter(row => row.accepted);
  return {
    session,
    sections,
    answer: accepted.map(row => row.text).join("\n\n"),
    audit: toJsonValue({
      source: "scce.extended_generation.run.v1",
      sectionsAttempted: sections.length,
      sectionsAccepted: accepted.length,
      rejections: sections.filter(row => !row.accepted).map(row => ({ nodeId: row.nodeId, reason: row.reason ?? null })),
      narrativeEvents: session.narrative.events.length,
      antiCopyGuarded: Boolean(session.voiceProfile),
      protectedPassages: session.protectedPassages.length
    })
  };
}

/** Build the turn's session: a real plan plus whatever real protected passages this turn actually has, so the anti-copy guard has something to guard against rather than being decorative. */
export function extendedGenerationSessionForTurn(input: {
  requestText: string;
  sectionTarget: number;
  protectedPassages?: readonly VoiceSample[];
}): DocumentGenerationSession {
  return createDocumentGenerationSession({
    plan: buildExtendedGenerationPlan({ requestText: input.requestText, sectionTarget: input.sectionTarget }),
    protectedPassages: input.protectedPassages ?? []
  });
}

function clamp01Number(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, numeric));
}
