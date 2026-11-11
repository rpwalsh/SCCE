// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { CognitiveProposal } from "../cognitive-planner.js";
import type { InventionConstruct } from "../prediction.js";
import { createHasher } from "../primitives.js";
import type { RuntimeReplanMotion } from "../runtime-motion.js";
import {
  assembleTurnConstruct,
  type TurnConstructAssemblyInput
} from "../turn-construct-assembly.js";
import type { ConstructGraph, TurnResult } from "../types.js";

function baseConstruct(): ConstructGraph {
  return {
    id: "construct.fixture" as ConstructGraph["id"],
    episodeId: "episode.fixture" as ConstructGraph["episodeId"],
    forceVector: {},
    nodes: [{ id: "request", kind: "request", label: "request", metadata: {} }],
    edges: [],
    artifacts: []
  };
}

function baseInput(overrides: Partial<TurnConstructAssemblyInput> = {}): TurnConstructAssemblyInput {
  return {
    baseConstruct: baseConstruct(),
    requestText: "Explain the result",
    brainMarker: {},
    hasher: createHasher(),
    closedClassWords: new Set(),
    boundFactEvidence: [],
    learnedPrior: {
      graph: { nodes: [], edges: [], hyperedges: [] },
      field: {} as TurnResult["field"],
      selectedEvidence: []
    },
    runtimeDiagnostic: { enabled: false, locale: "en" },
    ...overrides
  };
}

function proposal(): CognitiveProposal {
  return {
    id: "proposal.fixture",
    operatorActivations: [],
    claims: [],
    constructIds: [],
    quality: { mmr: 0.8 },
    trace: {}
  } as unknown as CognitiveProposal;
}

function invention(): InventionConstruct {
  return {
    schema: "scce.invention_construct.v1",
    id: "invention.fixture",
    title: "Fixture invention",
    proposalSurface: "A proposed surface",
    artifactKindIds: [],
    basisEvidenceIds: [],
    basisPriorIds: [],
    noveltyScore: 0.8,
    supportScore: 0.7,
    riskScore: 0.1,
    proofStatusId: "proof.status.generated_not_evidence",
    validationPlan: [],
    trace: {}
  };
}

function motion(): RuntimeReplanMotion {
  return {
    schema: "scce.runtime_motion.learn_hydrate_replan.v1",
    motionId: "motion.learn_hydrate_replan",
    guardId: "guard.fixture",
    attempt: 1,
    trigger: "coherence_support_failure",
    requestedAuthority: "reasoned",
    parentEpisodeId: "episode.fixture",
    queryHash: "query.fixture",
    connectorConfigured: false,
    status: "empty",
    searchResultCount: 0,
    fetchedSourceCount: 0,
    ingestedSourceCount: 0,
    ingestedEvidenceCount: 0,
    sourceUris: [],
    sourceSurfaces: [],
    failures: [],
    priorRejectedHypotheses: []
  };
}

describe("turn construct assembly", () => {
  it("returns the original construct when no activated optional attachment applies", () => {
    const input = baseInput();
    expect(assembleTurnConstruct(input).construct).toBe(input.baseConstruct);
  });

  it("attaches proposal, invention, then the requested runtime diagnostic", () => {
    const result = assembleTurnConstruct(baseInput({
      proposal: proposal(),
      invention: invention(),
      runtimeDiagnostic: { enabled: true, locale: "en" }
    })).construct;

    expect(result.nodes.map(node => node.kind)).toEqual([
      "request",
      "construct:cognitive-proposal",
      "construct:invention",
      "construct:runtime_diagnostic"
    ]);
  });

  it("applies runtime motion last, replacing the preceding diagnostic construct", () => {
    const result = assembleTurnConstruct(baseInput({
      proposal: proposal(),
      invention: invention(),
      runtimeDiagnostic: { enabled: true, locale: "en" },
      runtimeMotion: { motion: motion(), answerSurface: "Clarify the requested result" }
    })).construct;
    const diagnosticNodes = result.nodes.filter(node => node.kind === "construct:runtime_diagnostic");

    expect(result.nodes.map(node => node.kind)).toEqual([
      "request",
      "construct:cognitive-proposal",
      "construct:invention",
      "construct:runtime_diagnostic"
    ]);
    expect(diagnosticNodes).toHaveLength(1);
    expect(diagnosticNodes[0]?.metadata).toMatchObject({
      schema: "scce.runtime_motion_construct.v1",
      answerSurface: "Clarify the requested result"
    });
  });
});
