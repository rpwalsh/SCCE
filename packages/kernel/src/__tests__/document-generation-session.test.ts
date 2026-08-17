import { describe, expect, it } from "vitest";
import {
  completeDocumentSection,
  createDocumentGenerationSession,
  nextDocumentGenerationWork,
  reviseDocumentSession
} from "../document-generation-session.js";
import { addDocumentPlanNode, EMPTY_DOCUMENT_PLAN } from "../document-plan.js";
import { buildVoiceProfile } from "../voice-profile.js";

// Plan items 221-228: the real composed document/narrative generation
// capability class. Each check below exercises real cross-module
// behavior (the combined gate), not a restatement of the underlying
// modules' own already-passing unit tests.

function twoSectionPlan() {
  let plan = EMPTY_DOCUMENT_PLAN;
  plan = addDocumentPlanNode(plan, { id: "doc", kind: "document", order: 0, goal: "write a report" });
  plan = addDocumentPlanNode(plan, { id: "intro", kind: "section", parentId: "doc", order: 0, goal: "introduce the topic" });
  plan = addDocumentPlanNode(plan, { id: "body", kind: "section", parentId: "doc", order: 1, goal: "cover the topic", rhetoricalDependsOnIds: ["intro"] });
  return plan;
}

describe("createDocumentGenerationSession / nextDocumentGenerationWork", () => {
  it("surfaces only the leaf section whose rhetorical dependencies are already satisfied", () => {
    const session = createDocumentGenerationSession({ plan: twoSectionPlan() });
    const work = nextDocumentGenerationWork(session);
    expect(work.map(node => node.id)).toEqual(["intro"]);
  });
});

describe("completeDocumentSection (plan items 221-228: the real combined gate)", () => {
  it("completes a section with no voice profile or narrative event attached, using document-plan.ts's own real invariants", () => {
    const session = createDocumentGenerationSession({ plan: twoSectionPlan() });
    const result = completeDocumentSection(session, { nodeId: "intro", content: "This report covers X." });
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(nextDocumentGenerationWork(result.session).map(node => node.id)).toEqual(["body"]);
    }
  });

  it("rejects content that reproduces a protected passage verbatim -- the real anti-copy guard blocks completion outright", () => {
    const protectedPassage = { sourceId: "book.1", text: "it was the best of times it was the worst of times it was the age of wisdom" };
    const voiceProfile = buildVoiceProfile([protectedPassage]);
    const session = createDocumentGenerationSession({
      plan: twoSectionPlan(),
      voiceProfile,
      protectedPassages: [protectedPassage],
      maxAllowedNgramWords: 5
    });
    const result = completeDocumentSection(session, {
      nodeId: "intro",
      content: "As the classic line goes, it was the best of times it was the worst of times it was the age of wisdom, and so on."
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toMatch(/protected passage/);
      expect(result.antiCopyResult?.violatesProtectedSpan).toBe(true);
    }
    // Rejection has zero effect on session state -- the node stays pending.
    expect(nextDocumentGenerationWork(session).map(node => node.id)).toEqual(["intro"]);
  });

  it("accepts content that draws on the same vocabulary as a protected passage without copying a long contiguous run", () => {
    const protectedPassage = { sourceId: "book.1", text: "it was the best of times it was the worst of times it was the age of wisdom" };
    const voiceProfile = buildVoiceProfile([protectedPassage]);
    const session = createDocumentGenerationSession({
      plan: twoSectionPlan(),
      voiceProfile,
      protectedPassages: [protectedPassage],
      maxAllowedNgramWords: 5
    });
    const result = completeDocumentSection(session, { nodeId: "intro", content: "This report opens with a brief, original summary of the era." });
    expect(result.accepted).toBe(true);
  });

  it("rejects a section whose declared narrative event introduces a real inconsistency, and never commits the rejected event", () => {
    const session = createDocumentGenerationSession({
      plan: twoSectionPlan(),
      initialFacts: [{ subjectId: "door", factId: "state", value: "locked" }]
    });
    const result = completeDocumentSection(session, {
      nodeId: "intro",
      content: "The hero opens the already-open door.",
      narrativeEvent: {
        id: "event.1", order: 1, description: "hero opens the door",
        causedByEventIds: [], setupIds: [], payoffForSetupIds: [],
        stateChanges: [{ subjectId: "door", factId: "state", fromValue: "unlocked", toValue: "open" }]
      }
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toMatch(/narrative inconsistency/);
      expect(result.narrativeReport?.consistent).toBe(false);
    }
    // The rejected event was never committed -- the session's narrative is unchanged.
    expect(session.narrative.events).toEqual([]);
  });

  it("accepts and commits a section whose narrative event is genuinely consistent with prior state", () => {
    const session = createDocumentGenerationSession({
      plan: twoSectionPlan(),
      initialFacts: [{ subjectId: "door", factId: "state", value: "locked" }]
    });
    const result = completeDocumentSection(session, {
      nodeId: "intro",
      content: "The hero unlocks the door.",
      narrativeEvent: {
        id: "event.1", order: 1, description: "hero unlocks the door",
        causedByEventIds: [], setupIds: [], payoffForSetupIds: [],
        stateChanges: [{ subjectId: "door", factId: "state", fromValue: "locked", toValue: "unlocked" }]
      }
    });
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.session.narrative.events).toHaveLength(1);
    }
  });

  it("carries a mid-document open setup as an obligation, and only blocks it at the document's final section (lever 4)", () => {
    const session = createDocumentGenerationSession({
      plan: twoSectionPlan(),
      initialFacts: [{ subjectId: "door", factId: "state", value: "locked" }]
    });

    // Section 1 plants a setup with no payoff yet: a legitimate carried
    // obligation, not an inconsistency -- must be accepted.
    const first = completeDocumentSection(session, {
      nodeId: "intro",
      content: "A gun hangs on the wall as the hero unlocks the door.",
      narrativeEvent: {
        id: "event.1", order: 1, description: "gun planted; door unlocked",
        causedByEventIds: [], setupIds: ["setup.gun"], payoffForSetupIds: [],
        stateChanges: [{ subjectId: "door", factId: "state", fromValue: "locked", toValue: "unlocked" }]
      }
    });
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;

    // The FINAL section leaving the setup undischarged is a real defect --
    // no pending work remains to pay it off -- and must block.
    const finalWithoutPayoff = completeDocumentSection(first.session, {
      nodeId: "body",
      content: "The story ends without the gun ever firing.",
      narrativeEvent: {
        id: "event.2", order: 2, description: "ending",
        causedByEventIds: ["event.1"], setupIds: [], payoffForSetupIds: [],
        stateChanges: []
      }
    });
    expect(finalWithoutPayoff.accepted).toBe(false);
    if (!finalWithoutPayoff.accepted) {
      expect(finalWithoutPayoff.narrativeReport?.undischargedSetupIds).toEqual(["setup.gun"]);
    }

    // The same final section paying the setup off completes cleanly.
    const finalWithPayoff = completeDocumentSection(first.session, {
      nodeId: "body",
      content: "The gun fires at last, shattering the lock forever.",
      narrativeEvent: {
        id: "event.2", order: 2, description: "gun pays off",
        causedByEventIds: ["event.1"], setupIds: [], payoffForSetupIds: ["setup.gun"],
        stateChanges: []
      }
    });
    expect(finalWithPayoff.accepted).toBe(true);
  });
});

describe("reviseDocumentSession (session-level passthrough to document-revision.ts)", () => {
  it("inserting a node updates the session's plan and returns the real diff patch, leaving narrative/voice untouched", () => {
    const session = createDocumentGenerationSession({ plan: twoSectionPlan(), initialFacts: [{ subjectId: "x", factId: "y", value: 1 }] });
    const { session: revised, patch } = reviseDocumentSession.insert(session, {
      id: "conclusion", kind: "section", parentId: "doc", order: 2, goal: "wrap up"
    });
    expect(revised.plan.nodes["conclusion"]).toBeDefined();
    expect(patch.added.map(node => node.id)).toEqual(["conclusion"]);
    expect(revised.initialFacts).toEqual(session.initialFacts);
  });

  it("deleting a still-referenced node is refused, matching document-revision.ts's own real guarantee", () => {
    let plan = twoSectionPlan();
    plan = addDocumentPlanNode(plan, { id: "citation", kind: "paragraph", parentId: "body", order: 0, goal: "cite intro", referenceIds: ["intro"] });
    const session = createDocumentGenerationSession({ plan });
    expect(() => reviseDocumentSession.delete(session, "intro")).toThrow(/still referenced/);
  });
});
