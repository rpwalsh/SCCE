// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, type BuildTestResult, type TurnResult } from "@scce/kernel";
import { compactTurnResult } from "../routes.js";

describe("compact turn result", () => {
  it("retains complete build artifacts and capability outcome witnesses rather than previewing executable data", () => {
    const content = `export const value = 31;\n/*${"λ".repeat(1400)}*/\n`;
    const artifact = { artifactId: "artifact:owned", path: "src/module.mjs", mediaType: "text/javascript", content,
      contentHash: `sha256_${createHasher().digestHex(content)}`, role: "source" } as BuildTestResult["artifacts"][number];
    const witnessIds = Array.from({ length: 80 }, (_, index) => `evidence:owned:${index}`);
    const output = "native output:" + "証".repeat(900);
    const buildTest: BuildTestResult = { build: { code: 0, stdout: output, stderr: "", durationMs: 1 },
      test: { code: 0, stdout: output, stderr: output, durationMs: 2 }, repairAttempted: true, repairApplied: true, passed: true,
      artifacts: [artifact], attempts: [{ build: { code: 1, stdout: "", stderr: output, durationMs: 1 }, test: { code: null, stdout: "", stderr: output, durationMs: 0 }, artifacts: [artifact] }],
      testExecutionReceipt: { command: "node", args: ["--test", "test/module.test.mjs"], cwd: "owner/workspace", status: "executed" } };
    const events = ["CapabilitySucceeded", "CapabilityFailed"].map((typeId, index) => ({ id: `event:${index}`, episodeId: "episode:owner", typeId, t: index,
      parents: witnessIds, hash: `complete-event:${index}`, payload: { capabilityId: "process.build_test", planId: "approval:exact", ownerId: "owner:exact",
        sourceVersionId: "source:exact", inputHash: "sha256:approval-input", witnessIds, result: { artifacts: [artifact], error: output } } }));
    const result = { ...baseResult(), buildTest, events, workingMemory: { internalDiagnostics: "x".repeat(3 * 1024 * 1024) } } as unknown as TurnResult;
    const projected = compactTurnResult(result);
    expect(projected.buildTest).toEqual(buildTest);
    expect(projected.events).toEqual(events);
    expect(projected).not.toHaveProperty("workingMemory");
    expect(JSON.stringify(projected)).not.toContain("x".repeat(1000));
    expect((projected.buildTest as BuildTestResult).artifacts[0]?.contentHash).toBe(`sha256_${createHasher().digestHex(content)}`);
  });
  it("keeps the user surface and bounded proof while excluding internal working state", () => {
    const oversized = "x".repeat(250_000);
    const result = {
      episodeId: "episode.compact.fixture",
      answer: "A bounded answer.",
      epistemicForce: "invented",
      assistantForce: "creative_answer",
      requestedAuthority: "creative",
      evidence: [],
      entailment: {
        claim: {},
        verdict: "entailed",
        semanticVerdict: "entailed",
        force: "invented",
        support: 0,
        contradiction: 0,
        faithfulnessLcb: 1,
        confidence: {},
        scores: {},
        obligations: [],
        mappings: [],
        transforms: [],
        counterexamples: [],
        missing: [],
        proof: {
          id: "proof.compact.fixture",
          claimId: "claim.compact.fixture",
          verdict: "invented",
          confidence: {},
          proofGraph: { nodes: [], edges: [] },
          evidenceIds: [],
          transformIds: [],
          scores: {},
          validatorVersion: "fixture",
          createdAt: 1
        },
        evidenceIds: [],
        boundaries: []
      },
      learningNeeds: [],
      truthState: {},
      evidenceForce: "creative",
      guardFlags: {},
      calibrationStatus: "uncalibrated",
      proofCarryingAnswer: { supportedSentences: 1, totalSentences: 1, grounding: "invented" },
      runtimeMotion: { status: "held_for_review", heldSources: [{ id: "held.fixture", snippet: oversized }] },
      actionGraph: { summary: "kept", oversized },
      functionalCognition: { selectedGoal: { id: "goal.fixture", oversized } },
      selectedCandidate: { id: "candidate.fixture", oversized },
      judge: { selected: "candidate.fixture", oversized },
      answerRevision: { status: "accepted", oversized },
      runtimeCoherence: { emitAllowed: true, oversized },
      events: Array.from({ length: 100 }, (_, index) => ({
        id: `event.${index}`,
        episodeId: "episode.compact.fixture",
        typeId: index === 64 ? "TestExecuted" : "FixtureEvent",
        t: index,
        parents: [],
        payload: { oversized, passed: true, attempt: index, nested: { deep: { oversized } } }
      })),
      field: { oversized },
      cognitiveProposals: { oversized },
      workingMemory: { oversized },
      constructGraph: { oversized },
      validationGraph: { oversized },
      emissionGraph: { oversized },
      forecast: { oversized },
      scoreTraces: []
    } as unknown as TurnResult;

    const projected = compactTurnResult(result);
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject({
      episodeId: "episode.compact.fixture",
      answer: "A bounded answer.",
      assistantForce: "creative_answer",
      runtimeMotion: { status: "held_for_review" },
      diagnostics: { selectedCandidate: { id: "candidate.fixture" } }
    });
    expect(projected).toHaveProperty("evidence");
    expect(projected).toHaveProperty("entailment.proof");
    expect(projected).toHaveProperty("proofCarryingAnswer");
    expect(projected).not.toHaveProperty("field");
    expect(projected).not.toHaveProperty("cognitiveProposals");
    expect(projected).not.toHaveProperty("workingMemory");
    expect(projected).not.toHaveProperty("constructGraph");
    expect(JSON.stringify({ ...projected, events: [] }).length).toBeLessThan(50_000);
    expect(serialized).not.toContain(oversized);
  });

  it("keeps every event with its scalar payload fields and never truncates the answer", () => {
    const oversized = "x".repeat(250_000);
    const answer = "y".repeat(40_000);
    const result = {
      ...baseResult(),
      answer,
      events: Array.from({ length: 100 }, (_, index) => ({
        id: `event.${index}`,
        episodeId: "episode.compact.fixture",
        typeId: index === 64 ? "TestExecuted" : "FixtureEvent",
        t: index,
        parents: [],
        payload: { oversized, passed: index !== 3, attempt: index, nested: { deep: { oversized } } }
      }))
    } as unknown as TurnResult;

    const projected = compactTurnResult(result);
    const events = projected.events as Array<{ typeId: string; payload: Record<string, unknown> }>;

    expect(projected.answer).toBe(answer);
    expect(events).toHaveLength(100);
    expect(events[64]).toMatchObject({ typeId: "TestExecuted", payload: { passed: true, attempt: 64 } });
    expect(events[3]?.payload).toMatchObject({ passed: false, attempt: 3 });
    expect(events.filter(event => event.typeId === "TestExecuted" && event.payload.passed === true)).toHaveLength(1);
    for (const event of events) expect(JSON.stringify(event).length).toBeLessThan(2_000);
    expect(JSON.stringify(projected)).not.toContain(oversized);
  });
});

function baseResult(): Record<string, unknown> {
  return {
    episodeId: "episode.compact.fixture",
    answer: "",
    epistemicForce: "invented",
    evidence: [],
    entailment: {
      claim: {}, verdict: "entailed", semanticVerdict: "entailed", force: "invented", support: 0, contradiction: 0,
      faithfulnessLcb: 1, confidence: {}, scores: {}, obligations: [], mappings: [], transforms: [], counterexamples: [],
      missing: [], evidenceIds: [], boundaries: [],
      proof: { id: "p", claimId: "c", verdict: "invented", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 1 }
    },
    learningNeeds: [],
    truthState: {},
    evidenceForce: "creative",
    guardFlags: {},
    calibrationStatus: "uncalibrated",
    proofCarryingAnswer: {},
    events: [],
    scoreTraces: []
  };
}
