import { describe, expect, it } from "vitest";
import { DIALOGUE_ACT_IDS, realizeDialogueResponse, updateDialogueState, type DialogueAnswerGraphLike, type UserStyleProfile } from "../dialogue-pragmatics.js";
import { createInMemoryDialogueMemoryStore, persistDialogueOutcomeAndLearn, persistDialogueTurn, styleProfileFromTargetProfilePatterns } from "../dialogue-learning.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";

describe("communicative act evidence in the requirement field", () => {
  it("raises dialogue dependence on turn one in proportion to the learned act weight", async () => {
    const profile = await learnedChallengeProfile();
    expect(profile.communicativeActWeights?.[DIALOGUE_ACT_IDS.challenge]).toBeGreaterThan(profile.communicativeActWeights?.[DIALOGUE_ACT_IDS.neutral] ?? 1);
    const requestText = "request under a learned act";
    const field = (actId: string, userStyleProfile?: UserStyleProfile) => deriveTurnRequirementField({
      requestText,
      dialogueState: updateDialogueState({
        requestText,
        conversationId: "conversation.turn-one",
        statePatch: { communicativeActId: actId, ...(userStyleProfile ? { userStyleProfile } : {}) }
      })
    });

    const learned = field(DIALOGUE_ACT_IDS.challenge, profile);
    const unlearned = field(DIALOGUE_ACT_IDS.challenge);
    expect(learned.activatedDialogueMoveIds).toContain(DIALOGUE_ACT_IDS.challenge);
    expect(learned.dialogueDependence).toBeGreaterThan(unlearned.dialogueDependence);

    const neutralLearned = field(DIALOGUE_ACT_IDS.neutral, profile);
    const neutralUnlearned = field(DIALOGUE_ACT_IDS.neutral);
    expect(neutralLearned.dialogueDependence).toBeCloseTo(neutralUnlearned.dialogueDependence, 12);
    expect(neutralLearned.dialogueDependence).toBeCloseTo(unlearned.dialogueDependence, 12);
  });
});

async function learnedChallengeProfile(): Promise<UserStyleProfile> {
  const cold = realizeDialogueResponse({
    conversationId: "conversation.act-requirement",
    turnId: "turn.first",
    requestText: "first request",
    answerGraph: supportedGraph(),
    statePatch: { communicativeActId: DIALOGUE_ACT_IDS.challenge }
  });
  const store = createInMemoryDialogueMemoryStore();
  await persistDialogueTurn({ store, result: cold, now: 10 });
  await persistDialogueOutcomeAndLearn({ store, result: cold, promptText: "first request", corrected: true, correctionText: "recheck the challenged premise", now: 11 });
  const patterns = await store.listTargetProfilePatterns!({ targetProfileId: cold.policyDecision.targetProfileId, limit: 100 });
  return styleProfileFromTargetProfilePatterns({ patterns });
}

function supportedGraph(): DialogueAnswerGraphLike {
  return {
    id: "answer_graph.act-requirement",
    statusId: "workspace.kernel.answer.ready",
    claims: [{ id: "claim.act-requirement", roleId: "answer_graph.role.certified_claim", surface: "The result is stable.", certified: true }],
    supportLinks: [{ claimId: "claim.act-requirement", evidenceId: "evidence.act-requirement", sourceRef: { path: "act-requirement-source" }, forceClass: "independent" }],
    caveats: [],
    actions: [],
    uncertainty: { unsupported: false, missingEvidenceCount: 0, contradictionCount: 0, gapCount: 0 }
  };
}
