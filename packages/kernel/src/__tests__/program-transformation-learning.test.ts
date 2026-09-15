// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { describe, expect, it } from "vitest";
import {
  createHasher,
  candidateStructuralSignature,
  learningEpisodesFromEvents,
  learningEpisodesFromVerifiedProgram,
  rankLearnedProgramTransformations,
  searchProgramTransformations,
  type BuildTestResult,
  type ProgramBehaviorRequirement,
  type ProgramGraph,
  type ProgramConstructIntent
} from "../index.js";

describe("durable program transformation learning", () => {
  const requirements: ProgramBehaviorRequirement[] = [
    requirement("fit.3", 3, 6),
    requirement("fit.7", 7, 14)
  ];

  it("records a selected construction only after its exact generated test passes and reorders an equivalent new callable", () => {
    const search = searchProgramTransformations(requirements);
    const defaultSelected = search.selected[0];
    const learnedCandidate = search.candidates.find(candidate =>
      candidate.fitMeanSquaredError === 0 && candidate.id !== defaultSelected?.id);
    expect(learnedCandidate).toBeTruthy();
    const intent: ProgramConstructIntent = {
      artifactKindIds: ["program.artifact.library"],
      capabilityIds: [],
      behaviorRequirements: requirements,
      behaviorImplementationPhase: "selected",
      behaviorTransformationCandidates: [...search.candidates],
      selectedBehaviorTransformationIds: [learnedCandidate!.id]
    };
    const program = programFixture(learnedCandidate!.id);
    const passed = buildTest(true);
    const episodes = learningEpisodesFromVerifiedProgram({
      episodeId: "episode.learn.1" as never,
      program,
      intent,
      buildTest: passed,
      now: 42,
      hasher: createHasher()
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.validation.command).toEqual(program.test);
    expect(episodes[0]!.validation.passed).toBe(true);
    expect(episodes[0]!.ownerRequirementIds).toEqual(["fit.3", "fit.7"]);

    const eventPayload = JSON.parse(JSON.stringify(episodes[0]));
    const restored = learningEpisodesFromEvents([{ typeId: "ProgramTransformationLearned", payload: eventPayload }]);
    expect(restored).toHaveLength(1);
    const equivalentSearch = searchProgramTransformations([
      requirement("fit.new.3", 3, 6, "scale"),
      requirement("fit.new.7", 7, 14, "scale")
    ]);
    expect(candidateStructuralSignature(equivalentSearch.selected[0]!, "expression"))
      .not.toBe(episodes[0]!.candidateSignature);
    const reordered = rankLearnedProgramTransformations(equivalentSearch.candidates, restored, "expression");
    expect(candidateStructuralSignature(reordered[0]!, "expression")).toBe(episodes[0]!.candidateSignature);
  });

  it("does not learn from a failed build, failed test, or an unselected candidate", () => {
    const search = searchProgramTransformations(requirements);
    const intent: ProgramConstructIntent = {
      artifactKindIds: ["program.artifact.library"],
      capabilityIds: [],
      behaviorRequirements: requirements,
      behaviorImplementationPhase: "probe",
      behaviorTransformationCandidates: [...search.candidates],
      selectedBehaviorTransformationIds: []
    };
    const input = {
      episodeId: "episode.learn.failed" as never,
      program: programFixture(search.selected[0]?.id),
      intent,
      now: 42,
      hasher: createHasher()
    };
    expect(learningEpisodesFromVerifiedProgram({ ...input, buildTest: buildTest(false) })).toEqual([]);
    expect(learningEpisodesFromVerifiedProgram({ ...input, buildTest: { ...buildTest(true), test: { ...buildTest(true).test, code: 1 }, passed: false } })).toEqual([]);
  });

  it("does not learn from a passing result without an exact executed test receipt", () => {
    const search = searchProgramTransformations(requirements);
    const selected = search.selected[0]!;
    const input = {
      episodeId: "episode.learn.receipt" as never,
      program: programFixture(selected.id),
      intent: {
        artifactKindIds: ["program.artifact.library"],
        capabilityIds: [],
        behaviorRequirements: requirements,
        behaviorImplementationPhase: "selected" as const,
        behaviorTransformationCandidates: [...search.candidates],
        selectedBehaviorTransformationIds: [selected.id]
      },
      now: 42,
      hasher: createHasher()
    };
    expect(learningEpisodesFromVerifiedProgram({ ...input, buildTest: { ...buildTest(true), testExecutionReceipt: undefined } })).toEqual([]);
    expect(learningEpisodesFromVerifiedProgram({
      ...input,
      buildTest: buildTest(true, { command: "other", args: ["test"], cwd: ".", status: "executed" })
    })).toEqual([]);
    expect(learningEpisodesFromVerifiedProgram({
      ...input,
      buildTest: buildTest(true, { command: "tool", args: ["test", "generated"], cwd: ".", status: "skipped" })
    })).toEqual([]);
  });

  it("does not learn an inadmissible candidate even when an untrusted caller reports a passing command", () => {
    const search = searchProgramTransformations(requirements);
    const inadmissible = search.candidates.find(candidate => candidate.fitMeanSquaredError > 1e-12);
    expect(inadmissible).toBeTruthy();
    const intent: ProgramConstructIntent = {
      artifactKindIds: ["program.artifact.library"],
      capabilityIds: [],
      behaviorRequirements: requirements,
      behaviorImplementationPhase: "selected",
      behaviorTransformationCandidates: [...search.candidates],
      selectedBehaviorTransformationIds: [inadmissible!.id]
    };
    expect(learningEpisodesFromVerifiedProgram({
      episodeId: "episode.learn.inadmissible" as never,
      program: programFixture(inadmissible!.id),
      intent,
      buildTest: buildTest(true),
      now: 42,
      hasher: createHasher()
    })).toEqual([]);
  });

  it("requires the selected candidate to agree with the emitted ProgramGraph marker", () => {
    const search = searchProgramTransformations(requirements);
    const selected = search.candidates.find(candidate => candidate.fitMeanSquaredError === 0)!;
    const other = search.candidates.find(candidate => candidate.fitMeanSquaredError === 0 && candidate.id !== selected.id)!;
    expect(other).toBeTruthy();
    const intent: ProgramConstructIntent = {
      artifactKindIds: ["program.artifact.library"],
      capabilityIds: [],
      behaviorRequirements: requirements,
      behaviorImplementationPhase: "selected",
      behaviorTransformationCandidates: [...search.candidates],
      selectedBehaviorTransformationIds: [selected.id]
    };
    expect(learningEpisodesFromVerifiedProgram({
      episodeId: "episode.learn.graph-mismatch" as never,
      program: programFixture(other!.id),
      intent,
      buildTest: buildTest(true),
      now: 42,
      hasher: createHasher()
    })).toEqual([]);
  });

  it("does not infer graph emission when the selected candidate marker is absent", () => {
    const search = searchProgramTransformations(requirements);
    const selected = search.selected[0]!;
    const intent: ProgramConstructIntent = {
      artifactKindIds: ["program.artifact.library"],
      capabilityIds: [],
      behaviorRequirements: requirements,
      behaviorImplementationPhase: "selected",
      behaviorTransformationCandidates: [...search.candidates],
      selectedBehaviorTransformationIds: [selected.id]
    };
    expect(learningEpisodesFromVerifiedProgram({
      episodeId: "episode.learn.graph-absent" as never,
      program: programFixture(),
      intent,
      buildTest: buildTest(true),
      now: 42,
      hasher: createHasher()
    })).toEqual([]);
  });

  it("deduplicates replayed successes even when a duplicate is assigned a fresh event id", () => {
    const search = searchProgramTransformations(requirements);
    const selected = search.candidates.find(candidate => candidate.fitMeanSquaredError === 0)!;
    const other = search.candidates.find(candidate => candidate.fitMeanSquaredError === 0 && candidate.id !== selected.id)!;
    expect(other).toBeTruthy();
    const makeEpisode = (candidate: typeof selected) => learningEpisodesFromVerifiedProgram({
      episodeId: `episode.learn.${candidate.id}` as never,
      program: programFixture(candidate.id),
      intent: {
        artifactKindIds: ["program.artifact.library"],
        capabilityIds: [],
        behaviorRequirements: requirements,
        behaviorImplementationPhase: "selected" as const,
        behaviorTransformationCandidates: [...search.candidates],
        selectedBehaviorTransformationIds: [candidate.id]
      },
      buildTest: buildTest(true),
      now: 42,
      hasher: createHasher()
    })[0]!;
    const first = makeEpisode(selected);
    const second = makeEpisode(other!);
    const baseline = rankLearnedProgramTransformations(
      search.candidates,
      learningEpisodesFromEvents([
        { typeId: "ProgramTransformationLearned", payload: JSON.parse(JSON.stringify(first)) },
        { typeId: "ProgramTransformationLearned", payload: JSON.parse(JSON.stringify(second)) }
      ]),
      "expression"
    ).map(candidate => candidate.id);
    const replayedEvents = learningEpisodesFromEvents([
      { typeId: "ProgramTransformationLearned", payload: JSON.parse(JSON.stringify(first)) },
      { typeId: "ProgramTransformationLearned", payload: { ...JSON.parse(JSON.stringify(first)), id: `${first.id}.replayed` } },
      { typeId: "ProgramTransformationLearned", payload: JSON.parse(JSON.stringify(second)) }
    ]);
    expect(replayedEvents).toHaveLength(2);
    const replayed = rankLearnedProgramTransformations(
      search.candidates,
      replayedEvents,
      "expression"
    ).map(candidate => candidate.id);
    expect(replayed).toEqual(baseline);
  });
});

function requirement(id: string, argument: number, output: number, callableId = "double"): ProgramBehaviorRequirement {
  return {
    id,
    requestHash: "request.learn",
    callableId,
    arguments: [argument],
    expectedResult: output,
    verificationRole: "fit",
    relationSurface: "=>",
    sourceSpan: { charStart: 0, charEnd: 1 }
  };
}

function buildTest(passed: boolean, receipt: BuildTestResult["testExecutionReceipt"] = { command: "tool", args: ["test", "generated"], cwd: ".", status: "executed" }): BuildTestResult {
  const command = { code: passed ? 0 : 1, stdout: "", stderr: passed ? "" : "failed", durationMs: 1 };
  return { build: command, test: command, testExecutionReceipt: receipt, repairAttempted: false, repairApplied: false, passed, artifacts: [] };
}

function programFixture(selectedCandidateId?: string): ProgramGraph {
  return {
    id: "program.learn.fixture" as never,
    language: "language.fixture",
    packageManager: "package.fixture",
    entrypoint: "src/index.ts",
    nodes: selectedCandidateId ? [{ id: selectedCandidateId, kind: "program_transformation_candidate", label: "double", metadata: { selected: true } }] : [],
    edges: [],
    files: [],
    build: { command: "tool", args: ["build"], cwd: "." },
    test: { command: "tool", args: ["test", "generated"], cwd: "." },
    hydration: {
      schema: "scce.program.hydration.v1",
      ownerRequirementIds: ["fit.3", "fit.7"],
      program: {
        programId: "program.learn.fixture",
        languageId: "language.fixture",
        packageManagerId: "package.fixture",
        entrypointPath: "src/index.ts",
        buildCommand: { command: "tool", args: ["build"], cwd: "." },
        testCommand: { command: "tool", args: ["test", "generated"], cwd: "." },
        nodeCount: 0,
        edgeCount: 0,
        fileCount: 0,
        provenanceEvidenceIds: []
      },
      files: [], symbols: [], dependencies: [], validations: [], emissions: [], diagnostics: [], valid: true
    }
  };
}
