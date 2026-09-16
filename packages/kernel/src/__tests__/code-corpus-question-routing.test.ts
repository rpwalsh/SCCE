// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { codeRequestObservedRequirements, codeRequestSignal } from "../code-request.js";

// Head-to-head "code" rows: questions ABOUT source already promoted in the corpus, not demands to synthesize one.
const IDENTIFIER_QUESTIONS = [
  "Which file defines bestEvidenceSentences?",
  "Which file defines codeRequestSignal?",
  "Which file defines deriveClosedClassWords?",
  "Which file defines syncTaskResumptionSnapshotForTurn?",
  "Which file defines createProgramPlanner?",
  "What does deriveClosedClassWords derive its word set from?"
];

// The same kind of question, but naming a source path; still routed by the separate path condition.
const PATH_QUESTIONS = [
  "Which module does task-replanning.ts build its replanning on?",
  "Which module does program-planner.ts import createCodeLearningEngine from?",
  "Which module does task-resumption-turn-request.ts import captureTaskResumptionSnapshot from?"
];

const artifactDemandOf = (text: string) => {
  const signal = codeRequestSignal(text, {});
  const requirement = codeRequestObservedRequirements(text, signal)
    .find(candidate => candidate.dimension === "executableArtifactDemand");
  return requirement?.value ?? 0;
};

describe("a question about code is not a demand for an artifact", () => {
  it("an identifier named in a question does not on its own project executable artifact demand", () => {
    for (const question of IDENTIFIER_QUESTIONS) {
      expect(`${question} -> ${artifactDemandOf(question)}`).toBe(`${question} -> 0`);
    }
  });

  it("a fenced artifact still projects executable artifact demand", () => {
    const fenced = "Fix this:\n```ts\nexport function add(a: number, b: number) { return a - b; }\n```";
    expect(artifactDemandOf(fenced)).toBeGreaterThanOrEqual(0.5);
  });

  // Recorded, not asserted as correct: naming a path still routes a corpus question into the artifact lane.
  // Unlike an identifier, a path enters through `hasPath`, which this change deliberately does not touch.
  it("records that a path named in a question still projects artifact demand", () => {
    for (const question of PATH_QUESTIONS) {
      expect(artifactDemandOf(question)).toBeGreaterThanOrEqual(0.5);
    }
  });
});
