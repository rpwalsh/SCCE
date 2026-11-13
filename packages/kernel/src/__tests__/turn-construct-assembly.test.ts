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
import type { ConstructGraph, EvidenceSpan, GraphSnapshot, TurnResult } from "../types.js";
import { attachLearnedGraphPriorConstruct } from "../learned-graph-prior-runtime.js";
import { semanticAnswerConstructFacts, compileRealizationContract } from "../semantic-answer-construct.js";
import { requestValueBindingConstructFact, currentSourceBoundRoleValueFact } from "../source-bound-semantic-fact.js";

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

function sourceBoundPriorFixture() {
  const source = { id: "evidence.neralis", sourceVersionId: "source.neralis", status: "promoted",
    text: "Neralis observatory is located on Pelora island near the old harbor." } as EvidenceSpan;
  const graph = {
    nodes: ["Neralis observatory", "Pelora island near the old harbor"].map((label, index) => ({
      id: `node.${index}`, typeId: "entity", representation: { label }, features: [], alpha: 1,
      evidenceIds: [source.id], metadata: {}, createdAt: 1, updatedAt: 1
    })),
    edges: [{ id: "edge.topic", source: "node.0", target: "node.1", relationId: "relation.identity",
      alpha: 1, weight: 1, evidenceIds: [source.id], metadata: {
        relation: { subject: "Neralis observatory", predicate: "is located on", object: "Pelora island near the old harbor", confidence: 1 }
      }, createdAt: 1, updatedAt: 1 }], hyperedges: []
  } as unknown as GraphSnapshot;
  const field = { active: graph.nodes.map(node => ({ nodeId: node.id, activation: 1 })), ppf: [], seeds: [], causalMass: [], alphaTrace: { surfaces: { contradiction: 0 } } } as unknown as TurnResult["field"];
  const fact = requestValueBindingConstructFact({ subject: "Neralis observatory", value: "Pelora island",
    relationId: "relation.location", requestedRoleId: "role.place", resolverId: "resolver.acquired_source_construction",
    evidenceIds: [String(source.id)] }, [source])!;
  return { source, graph, field, fact };
}

describe("turn construct assembly", () => {
  it("preserves a current typed role answer without a quote plan through a competing topical prior", () => {
    const { source, graph, field, fact } = sourceBoundPriorFixture();
    const input = baseInput({ requestText: "Where is Neralis observatory located?", boundFact: fact,
      boundFactEvidence: [source], learnedPrior: { graph, field, selectedEvidence: [source] } });
    const competing = attachLearnedGraphPriorConstruct({ construct: input.baseConstruct, requestText: input.requestText,
      graph, field, selectedEvidence: [source], brainMarker: {}, hasher: input.hasher });
    expect(semanticAnswerConstructFacts(competing)?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "Neralis observatory", predicate: "is located on", object: "Pelora island near the old harbor" })
    ]));
    const result = assembleTurnConstruct(input).construct;
    expect(result.nodes.find(node => node.kind === "construct:semantic_answer")?.metadata).not.toHaveProperty("localEvidenceAnswer");
    const facts = semanticAnswerConstructFacts(result)!.facts;
    expect(facts).toHaveLength(1);
    expect(facts).toMatchObject([{ subject: fact.subject, predicate: "", object: fact.object, relationId: fact.relationId,
      relationRoleId: fact.relationRoleId, requestedSlotId: fact.requestedSlotId, evidenceIds: fact.evidenceIds, sourceVersionId: fact.sourceVersionId }]);
    expect(currentSourceBoundRoleValueFact({ text: fact.object, contract: compileRealizationContract(input.requestText, fact),
      facts, evidence: [source] })).toEqual(fact);
  });

  it.each(["missing", "quarantined", "foreign_version"] as const)("does not authorize a typed answer with %s current owners", invalid => {
    const { source, graph, field, fact } = sourceBoundPriorFixture();
    const owners = invalid === "missing" ? [] : [{ ...source, ...(invalid === "quarantined" ? { status: "quarantined" as const }
      : { sourceVersionId: "source.foreign" as EvidenceSpan["sourceVersionId"] }) }];
    const input = baseInput({ requestText: "Where is Neralis observatory located?", boundFact: fact, boundFactEvidence: [source],
      learnedPrior: { graph, field, selectedEvidence: owners } });
    const facts = semanticAnswerConstructFacts(assembleTurnConstruct(input).construct)?.facts ?? [];
    expect(currentSourceBoundRoleValueFact({ text: fact.object, contract: compileRealizationContract(input.requestText, fact),
      facts, evidence: owners })).toBeUndefined();
    if (owners.length) expect(facts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relationId: fact.relationId, relationRoleId: fact.relationRoleId, object: fact.object, predicate: "" })
    ]));
  });

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
