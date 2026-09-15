import { describe, expect, it } from "vitest";
import {
  DIALOGUE_ACT_IDS,
  DIALOGUE_ACTION_IDS,
  realizeDialogueResponse,
  type DialogueAnswerGraphLike
} from "../dialogue-pragmatics.js";
import {
  createInMemoryDialogueMemoryStore,
  persistDialogueOutcomeAndLearn,
  persistDialogueTurn,
  styleProfileFromTargetProfilePatterns
} from "../dialogue-learning.js";

describe("durable communicative-act learning", () => {
  it("changes a later typed challenge route after a cold restart", async () => {
    const graph = supportedGraph();
    const cold = realizeDialogueResponse({
      conversationId: "conversation.act-learning",
      turnId: "turn.first",
      requestText: "first request",
      answerGraph: graph,
      statePatch: { communicativeActId: DIALOGUE_ACT_IDS.challenge }
    });
    expect(cold.policyDecision.selectedActionIds).not.toContain(DIALOGUE_ACTION_IDS.premiseCheck);

    const store = createInMemoryDialogueMemoryStore();
    await persistDialogueTurn({ store, result: cold, now: 10 });
    await persistDialogueOutcomeAndLearn({
      store,
      result: cold,
      promptText: "first request",
      corrected: true,
      correctionText: "recheck the challenged premise",
      now: 11
    });

    const restarted = createInMemoryDialogueMemoryStore({
      targetProfilePatterns: await store.listTargetProfilePatterns!({
        targetProfileId: cold.policyDecision.targetProfileId,
        limit: 100
      })
    });
    const patterns = await restarted.listTargetProfilePatterns!({
      targetProfileId: cold.policyDecision.targetProfileId,
      limit: 100
    });
    const profile = styleProfileFromTargetProfilePatterns({ patterns });
    const warm = realizeDialogueResponse({
      conversationId: cold.state.conversationId,
      turnId: "turn.after-restart",
      requestText: "later request",
      answerGraph: graph,
      statePatch: { userStyleProfile: profile, communicativeActId: DIALOGUE_ACT_IDS.challenge }
    });

    expect(profile.communicativeActWeights?.[DIALOGUE_ACT_IDS.challenge]).toBeGreaterThan(0.66);
    expect(warm.policyDecision.selectedActionIds).toContain(DIALOGUE_ACTION_IDS.premiseCheck);
    expect(warm.finalText).toContain("independent result");
  });

  it("keeps owner correction in act policy and leaves independent claim content unchanged", async () => {
    const graph = supportedGraph();
    const result = realizeDialogueResponse({
      conversationId: "conversation.truth-boundary",
      turnId: "turn.truth",
      requestText: "request",
      answerGraph: graph
    });
    const store = createInMemoryDialogueMemoryStore();
    await persistDialogueTurn({ store, result, now: 20 });
    await persistDialogueOutcomeAndLearn({
      store,
      result,
      promptText: "request",
      corrected: true,
      correctionText: "The independent result is unstable.",
      now: 21
    });
    const patterns = await store.listTargetProfilePatterns!({ targetProfileId: result.policyDecision.targetProfileId, limit: 100 });
    const profile = styleProfileFromTargetProfilePatterns({ patterns });
    const next = realizeDialogueResponse({
      conversationId: result.state.conversationId,
      turnId: "turn.truth.next",
      requestText: "next",
      answerGraph: graph,
      statePatch: { userStyleProfile: profile, communicativeActId: DIALOGUE_ACT_IDS.repair }
    });
    expect(next.finalText).toContain("independent result");
    expect(next.finalText).not.toContain("unstable");
    expect(profile.communicativeActWeights?.[DIALOGUE_ACT_IDS.repair]).toBeGreaterThan(0.66);
    expect(next.policyDecision.selectedActionIds).toContain(DIALOGUE_ACTION_IDS.boundary);
  });
});

function supportedGraph(): DialogueAnswerGraphLike {
  return {
    id: "answer_graph.independent",
    statusId: "workspace.kernel.answer.ready",
    claims: [{ id: "claim.independent", roleId: "answer_graph.role.certified_claim", surface: "The independent result is stable.", certified: true }],
    supportLinks: [{ claimId: "claim.independent", evidenceId: "evidence.independent", sourceRef: { path: "owner-independent-source" }, forceClass: "independent" }],
    caveats: [],
    actions: [],
    uncertainty: { unsupported: false, missingEvidenceCount: 0, contradictionCount: 0, gapCount: 0 }
  };
}
