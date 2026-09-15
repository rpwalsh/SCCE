// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_STYLE_PROFILE,
  INTERACTION_FEATURE_IDS,
  realizeDialogueResponse,
  type DialogueAnswerGraphLike
} from "../dialogue-pragmatics.js";

describe("multi-claim dialogue realization", () => {
  it("realizes every certified claim with its linked evidence for an expanded response", () => {
    const result = realizeDialogueResponse({
      requestText: "Please provide a detailed explanation of the verified material in this graph now",
      answerGraph: graph(),
      statePatch: {
        userStyleProfile: {
          ...DEFAULT_USER_STYLE_PROFILE,
          weights: {
            ...DEFAULT_USER_STYLE_PROFILE.weights,
            [INTERACTION_FEATURE_IDS.compactness]: 0.1,
            [INTERACTION_FEATURE_IDS.responseLead]: 0.1
          }
        }
      }
    });

    expect(result.selected.candidateId).toBe("cand.a8c6207d");
    expect(result.finalText).toContain("The parser preserves the source span.");
    expect(result.finalText).toContain("The validator rejects an unproven rewrite.");
    expect(result.finalText).toContain("[docs/parser.md:4]");
    expect(result.finalText).toContain("[docs/validator.md:9]");
    expect(result.finalText).not.toContain("docs/note.md:2");
  });

  it("keeps compact realization on the primary certified claim", () => {
    const result = realizeDialogueResponse({
      requestText: "answer",
      answerGraph: graph(),
      statePatch: {
        userStyleProfile: {
          ...DEFAULT_USER_STYLE_PROFILE,
          weights: {
            ...DEFAULT_USER_STYLE_PROFILE.weights,
            [INTERACTION_FEATURE_IDS.compactness]: 0.95,
            [INTERACTION_FEATURE_IDS.responseLead]: 0.95
          }
        }
      }
    });

    expect(result.selected.candidateId).toBe("cand.5fc0e1b2");
    expect(result.finalText).toContain("The parser preserves the source span.");
    expect(result.finalText).not.toContain("The validator rejects an unproven rewrite.");
  });

  it("carries the same certified claim set into typed formal and plan surfaces", () => {
    const formal = realizeDialogueResponse({
      requestText: "opaque::formal::δ",
      statePatch: {
        interactionSignals: [{
          id: "signal.formal.typed",
          featureId: INTERACTION_FEATURE_IDS.calculusNeed,
          intentId: "intent.formal.typed",
          value: 1,
          confidence: 1,
          sourceIds: ["typed.interpreter"],
          trace: { source: "typed.interpreter" }
        }]
      },
      answerGraph: graph()
    });
    const formalCandidate = formal.candidates.find(candidate => candidate.id === "cand.95d18c3f");
    expect(formalCandidate?.text).toContain("The parser preserves the source span.");
    expect(formalCandidate?.text).toContain("The validator rejects an unproven rewrite.");
    expect(formalCandidate?.text).toContain("[docs/parser.md:4]");
    expect(formalCandidate?.text).toContain("[docs/validator.md:9]");

    const planned = realizeDialogueResponse({
      requestText: "Please provide a detailed explanation of the verified material in this graph now",
      answerGraph: graph({ affectedFile: "src/parser.ts" }),
      statePatch: { activeTask: "task.continuation" }
    });
    const planCandidate = planned.candidates.find(candidate => candidate.id === "cand.2d8f5a09");
    expect(planCandidate?.text).toContain("The parser preserves the source span.");
    expect(planCandidate?.text).toContain("The validator rejects an unproven rewrite.");
    expect(planCandidate?.text).toContain("[docs/parser.md:4]");
    expect(planCandidate?.text).toContain("[docs/validator.md:9]");
  });
});

function graph(input: { affectedFile?: string } = {}): DialogueAnswerGraphLike {
  return {
    id: "answer_graph.multi_claim",
    claims: [
      { id: "claim.parser", surface: "The parser preserves the source span.", certified: true },
      { id: "claim.validator", surface: "The validator rejects an unproven rewrite.", certified: true },
      { id: "claim.untrusted", surface: "The untrusted note is excluded.", certified: false }
    ],
    supportLinks: [
      { claimId: "claim.parser", evidenceId: "evidence.parser", sourceRef: { path: "docs/parser.md", lineStart: 4 } },
      { claimId: "claim.validator", evidenceId: "evidence.validator", sourceRef: { path: "docs/validator.md", lineStart: 9 } },
      { claimId: "claim.untrusted", evidenceId: "evidence.untrusted", sourceRef: { path: "docs/note.md", lineStart: 2 } }
    ],
    caveats: [],
    actions: input.affectedFile ? [{ id: "action.parser", affectedFiles: [input.affectedFile], evidenceSpanIds: ["evidence.parser"] }] : [],
    uncertainty: { unsupported: false, missingEvidenceCount: 0, contradictionCount: 0, gapCount: 0 }
  };
}
