import { describe, expect, it } from "vitest";
import {
  COGNITIVE_OPERATOR_IDS,
  COGNITIVE_PROPOSAL_BOOTSTRAP,
  claimBasisIsAdmissible,
  createPatchTransactionPlan,
  createInventionConstruct,
  planCognitiveProposals,
  scoreReasoningProposal,
  type ActivatedOperator,
  type CognitiveActionPlan,
  type CognitiveProposal,
  type CognitivePlannerInput,
  type ConstructGraph,
  type EvidenceSpan,
  type FieldState,
  type GraphEdge,
  type GraphNode,
  type GraphSlice,
  type PlannedClaim,
  type ProgramGraph,
  type PatchTransactionPlan,
  type TurnRequirement,
  type TurnRequirementDimension,
  type TurnRequirementField
} from "../index.js";

describe("cognitive meaning planner", () => {
  it("builds a multi-source synthesis and a non-verbatim conclusion", () => {
    const first = evidence("evidence.one", "source.one", "Battery heat increases under sustained load.");
    const second = evidence("evidence.two", "source.two", "Thermal throttling begins after the enclosure warms.");
    const source = node("node.source", "sustained load", [first.id]);
    const middle = node("node.middle", "enclosure warming", [first.id, second.id]);
    const target = node("node.target", "load-sensitive thermal throttling", [first.id, second.id]);
    const graph = graphSlice(
      [source, middle, target],
      [edge("edge.one", source, middle, [first.id]), edge("edge.two", middle, target, [second.id])]
    );
    const planned = planCognitiveProposals(plannerInput({
      graph,
      evidence: [first, second],
      requirements: requirements({ sourceDependence: 0.92, inferentialDepth: 0.88 }, [requirement("req.source", "sourceDependence")]),
      operators: [operator("source", COGNITIVE_OPERATOR_IDS.sourceSynthesis, ["sourceDependence", "inferentialDepth"])]
    }));

    const synthesis = planned.find(proposal => proposal.claims.some(claim => claim.basis === "source_synthesis"));
    expect(synthesis).toBeDefined();
    const conclusion = synthesis!.claims.find(claim => claim.basis === "source_synthesis")!;
    expect(conclusion.evidenceIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(conclusion.graphNodeIds.length).toBeGreaterThan(0);
    expect([first.text, second.text]).not.toContain(conclusion.text);
    expect(synthesis!.satisfiedRequirementIds).toContain("req.source");
  });

  it("keeps graph inference distinct from observed premises", () => {
    const premise = evidence("evidence.premise", "source.premise", "The upstream gate is closed.");
    const source = node("node.upstream", "upstream gate closure", [premise.id]);
    const target = node("node.downstream", "downstream flow reduction", []);
    const graph = graphSlice([source, target], [edge("edge.flow", source, target, [premise.id])]);
    const proposals = planCognitiveProposals(plannerInput({
      graph,
      evidence: [premise],
      requirements: requirements({ inferentialDepth: 0.9 }, [requirement("req.infer", "inferentialDepth")]),
      operators: [operator("relation", COGNITIVE_OPERATOR_IDS.relationComposition, ["inferentialDepth"])]
    }));
    const proposal = proposals.find(item => item.claims.some(claim => claim.basis === "reasoned_inference"));

    expect(proposal).toBeDefined();
    expect(proposal!.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: premise.text, basis: "direct_evidence", evidenceIds: [premise.id] }),
      expect.objectContaining({ text: "downstream flow reduction", basis: "reasoned_inference", evidenceIds: [] })
    ]));
    expect(proposal!.claims.every(claim => claimBasisIsAdmissible(claim))).toBe(true);
  });

  it("marks counterfactual meaning as hypothetical rather than observed", () => {
    const premise = evidence("evidence.factual", "source.factual", "The valve is currently open.");
    const source = node("node.valve", "valve state", [premise.id]);
    const target = node("node.pressure", "pressure response", []);
    const graph = graphSlice([source, target], [edge("edge.pressure", source, target, [premise.id])]);
    const proposals = planCognitiveProposals(plannerInput({
      graph,
      evidence: [premise],
      requirements: requirements({ counterfactualDemand: 0.95, inferentialDepth: 0.8 }, [requirement("req.counterfactual", "counterfactualDemand")]),
      operators: [operator("counterfactual", COGNITIVE_OPERATOR_IDS.counterfactualConstruction, ["counterfactualDemand", "inferentialDepth"])]
    }));
    const claim = proposals.flatMap(proposal => proposal.claims).find(candidate => candidate.basis === "counterfactual");

    expect(claim).toMatchObject({ text: "pressure response", hypothetical: true, externallyFactual: false, evidenceIds: [] });
    expect(claimBasisIsAdmissible(claim!)).toBe(true);
  });

  it("detects unsupported reasoning leaps and applies the exact penalty", () => {
    const unsupported = plannedClaim({
      id: "claim.unsupported",
      text: "A conclusion with no derivation",
      basis: "reasoned_inference",
      externallyFactual: true
    });
    const supported = plannedClaim({
      id: "claim.supported",
      text: "A graph-derived conclusion",
      basis: "reasoned_inference",
      graphEdgeIds: ["edge.supported"],
      externallyFactual: true
    });
    const field = fieldState([]);
    const graph = graphSlice([], []);
    const base = { relations: [], steps: [], artifacts: [], satisfiedRequirementIds: [], missedRequirementIds: [] };
    const unsupportedQuality = scoreReasoningProposal({ proposal: { ...base, claims: [unsupported] }, requirements: requirements(), graph, field });
    const supportedQuality = scoreReasoningProposal({ proposal: { ...base, claims: [supported] }, requirements: requirements(), graph, field });

    expect(claimBasisIsAdmissible(unsupported)).toBe(false);
    expect(unsupportedQuality.unsupportedLeapRate).toBe(1);
    expect(supportedQuality.unsupportedLeapRate).toBe(0);
    expect(supportedQuality.score - unsupportedQuality.score).toBeCloseTo(0.45, 12);
  });

  it("selects diverse proposals with deterministic weighted-Jaccard MMR", () => {
    const inventions = [
      invention("proposal.alpha", "A ring-partitioned index with bounded neighborhood repair.", "artifact.index"),
      invention("proposal.beta", "A temporal ledger that reconstructs state from typed transitions.", "artifact.ledger"),
      invention("proposal.gamma", "A counterfactual cache that compares reversible branch outcomes.", "artifact.cache")
    ];
    const input = plannerInput({
      requirements: requirements({ noveltyDemand: 0.98, executableArtifactDemand: 0.8 }, [
        requirement("req.novel", "noveltyDemand"),
        requirement("req.artifact", "executableArtifactDemand")
      ]),
      operators: [operator("invention", COGNITIVE_OPERATOR_IDS.invention, ["noveltyDemand", "executableArtifactDemand"])],
      inventions
    });
    const first = planCognitiveProposals(input);
    const replay = planCognitiveProposals(input);

    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first).toEqual(replay);
    expect(new Set(first.map(proposal => proposal.id)).size).toBe(first.length);
    expect(new Set(first.flatMap(proposal => proposal.claims.map(claim => claim.text))).size).toBeGreaterThanOrEqual(3);
    for (const proposal of first) {
      expect(proposal.quality.mmr).toBeCloseTo(
        COGNITIVE_PROPOSAL_BOOTSTRAP.mmr.quality * proposal.quality.baseQuality
          + COGNITIVE_PROPOSAL_BOOTSTRAP.mmr.diversity * proposal.quality.diversity,
        12
      );
      const quality = proposal.quality.invention;
      expect(quality).toBeDefined();
      expect(quality!.novelty).toBeCloseTo(0.70 * quality!.noveltyMemory + 0.30 * quality!.noveltySibling, 12);
      expect(quality!.score).toBeCloseTo(
        0.24 * quality!.requirementSatisfaction
          + 0.18 * quality!.relationCoherence
          + 0.18 * quality!.novelty
          + 0.16 * quality!.fit
          + 0.12 * quality!.usefulness
          + 0.07 * quality!.languageRealizability
          + 0.05 * quality!.styleFit
          - 0.30 * quality!.risk
          - 0.22 * quality!.repetition
          - 0.70 * quality!.unsupportedExternallyFactualRate,
        12
      );
      expect(proposal.claims.every(claim => !claim.text.startsWith("{") && !claim.text.includes("\"scores\""))).toBe(true);
    }
  });

  it("maps parallel, shared-anchor, and relation-potential topology to analogy, comparison, and tradeoff meanings", () => {
    const a = node("node.a", "anchor alpha", []);
    const b = node("node.b", "outcome beta", []);
    const c = node("node.c", "anchor gamma", []);
    const d = node("node.d", "outcome delta", []);
    const e = node("node.e", "outcome epsilon", []);
    const graph = graphSlice([a, b, c, d, e], [
      edge("edge.ab", a, b, [], { alpha: 0.98, relationId: "relation.parallel" }),
      edge("edge.cd", c, d, [], { alpha: 0.91, relationId: "relation.parallel" }),
      edge("edge.ae", a, e, [], { alpha: 0.08, relationId: "relation.alternative", contradiction: 0.95 })
    ]);
    const proposals = planCognitiveProposals(plannerInput({
      graph,
      requirements: requirements({ noveltyDemand: 0.9, inferentialDepth: 0.9 }, [
        requirement("req.novel", "noveltyDemand"),
        requirement("req.infer", "inferentialDepth")
      ]),
      operators: [operator("analogy", COGNITIVE_OPERATOR_IDS.analogy, ["noveltyDemand", "inferentialDepth"])],
      maxProposals: 16
    }));

    expect(proposals.some(proposal => proposalFamily(proposal) === "analogy"
      && proposal.relations.some(relation => relation.relationId === "relation.cognitive.analogy.parallel_topology.v1"))).toBe(true);
    expect(proposals.some(proposal => proposalFamily(proposal) === "comparison"
      && proposal.relations.some(relation => relation.relationId === "relation.cognitive.comparison.shared_anchor.v1"))).toBe(true);
    expect(proposals.some(proposal => proposalFamily(proposal) === "tradeoff"
      && proposal.relations.some(relation => relation.relationId === "relation.cognitive.tradeoff.relation_potential.v1"))).toBe(true);
    expect(proposals.flatMap(proposal => proposal.claims).every(claim => !claim.text.startsWith("{") && !claim.text.includes("\"scores\""))).toBe(true);
  });

  it("composes procedures and mathematical derivations from ordered construct nodes", () => {
    const procedure = constructGraph({
      id: "construct.procedure",
      nodes: [
        { id: "step.1", kind: "construct.step.v1", label: "input state", metadata: { order: 1 } },
        { id: "step.2", kind: "construct.step.v1", label: "bounded transform", metadata: { order: 2 } },
        { id: "step.3", kind: "construct.step.v1", label: "validated output", metadata: { order: 3 } }
      ],
      edges: [
        { source: "step.1", target: "step.2", relation: "relation.sequence.v1", weight: 0.9 },
        { source: "step.2", target: "step.3", relation: "relation.sequence.v1", weight: 0.9 }
      ]
    });
    const mathematical = constructGraph({
      id: "construct.math",
      nodes: [
        { id: "math.1", kind: "construct.math.expression.v1", label: "x₀", metadata: { order: 1, value: 2 } },
        { id: "math.2", kind: "construct.math.operator.v1", label: "x₁", metadata: { order: 2, operands: [2, 3] } },
        { id: "math.3", kind: "construct.math.result.v1", label: "x₂", metadata: { order: 3, value: 5 } }
      ],
      edges: [
        { source: "math.1", target: "math.2", relation: "relation.derives.v1", weight: 1 },
        { source: "math.2", target: "math.3", relation: "relation.derives.v1", weight: 1 }
      ]
    });
    const base = {
      requirements: requirements({ inferentialDepth: 0.95 }, [requirement("req.infer", "inferentialDepth")]),
      operators: [operator("compose", COGNITIVE_OPERATOR_IDS.relationComposition, ["inferentialDepth"])],
      maxProposals: 16
    };
    const procedureProposals = planCognitiveProposals(plannerInput({ ...base, construct: procedure }));
    const mathematicalProposals = planCognitiveProposals(plannerInput({ ...base, construct: mathematical }));

    const procedureProposal = procedureProposals.find(proposal => proposalFamily(proposal) === "procedure_composition");
    const mathematicalProposal = mathematicalProposals.find(proposal => proposalFamily(proposal) === "mathematical_derivation");
    expect(procedureProposal?.steps.map(step => step.text)).toEqual(["input state", "bounded transform", "validated output"]);
    expect(procedureProposal?.claims[0]).toMatchObject({ text: "validated output", basis: "reasoned_inference", externallyFactual: false });
    expect(mathematicalProposal?.steps.map(step => step.text)).toEqual(["x₀", "x₁", "x₂"]);
    expect(mathematicalProposal?.claims[0]).toMatchObject({ text: "x₂", basis: "reasoned_inference", externallyFactual: false });
  });

  it("constructs algorithm and architecture designs only from program structure under high executable and novelty demand", () => {
    const program = programGraph();
    const proposals = planCognitiveProposals(plannerInput({
      requirements: requirements({ noveltyDemand: 0.95, executableArtifactDemand: 0.95 }, [
        requirement("req.novel", "noveltyDemand"),
        requirement("req.artifact", "executableArtifactDemand")
      ]),
      operators: [
        operator("program", COGNITIVE_OPERATOR_IDS.programPlanning, ["executableArtifactDemand"]),
        operator("invent", COGNITIVE_OPERATOR_IDS.invention, ["noveltyDemand"])
      ],
      programGraphs: [program],
      maxProposals: 16
    }));
    const algorithm = proposals.find(proposal => proposalFamily(proposal) === "algorithm_design");
    const architecture = proposals.find(proposal => proposalFamily(proposal) === "architecture_design");

    expect(algorithm?.claims.every(claim => claim.basis === "invented" && !claim.externallyFactual && claim.evidenceIds.length === 0)).toBe(true);
    expect(algorithm?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ title: "src/index.ts", validationRequired: true })]));
    expect(architecture?.claims.length).toBeGreaterThan(0);
    expect(architecture?.constructIds).toContain(program.id);

    const gatedOff = planCognitiveProposals(plannerInput({
      requirements: requirements({ noveltyDemand: 0.4, executableArtifactDemand: 0.95 }),
      operators: [
        operator("program", COGNITIVE_OPERATOR_IDS.programPlanning, ["executableArtifactDemand"]),
        operator("invent", COGNITIVE_OPERATOR_IDS.invention, ["noveltyDemand"])
      ],
      programGraphs: [program]
    }));
    expect(gatedOff.some(proposal => proposalFamily(proposal) === "algorithm_design" || proposalFamily(proposal) === "architecture_design")).toBe(false);
  });

  it("generates hypotheses as conjectured, non-observed meanings", () => {
    const source = node("node.observed", "observed anchor", []);
    const target = node("node.hypothesis", "candidate consequence", []);
    const graph = graphSlice([source, target], [edge("edge.uncertain", source, target, [], { alpha: 0.3, contradiction: 0.7 })]);
    const proposals = planCognitiveProposals(plannerInput({
      graph,
      requirements: requirements({ uncertaintyTolerance: 0.95, noveltyDemand: 0.8, inferentialDepth: 0.75 }, [
        requirement("req.uncertain", "uncertaintyTolerance")
      ]),
      operators: [operator("hypothesis", COGNITIVE_OPERATOR_IDS.invention, ["uncertaintyTolerance", "noveltyDemand", "inferentialDepth"])]
    }));
    const hypothesis = proposals.find(proposal => proposalFamily(proposal) === "hypothesis_generation");

    expect(hypothesis).toBeDefined();
    expect(hypothesis?.evidenceIds).toEqual([]);
    expect(hypothesis?.claims).toEqual([expect.objectContaining({
      text: "candidate consequence",
      basis: "conjectured",
      evidenceIds: [],
      externallyFactual: false,
      hypothetical: true
    })]);
  });

  it("keeps workspace and action meanings as previews unless a durable result receipt is referenced", () => {
    const workspacePlan = createPatchTransactionPlan({ operations: [{ kind: "create", path: "src/new.ts", content: "export const value = 1;\n" }] });
    const actionPlans: CognitiveActionPlan[] = [
      {
        id: "action.preview",
        capabilityId: "capability.fs.write",
        phase: "prepare",
        status: "succeeded",
        previewSurface: "prepared filesystem mutation",
        resultSurface: "unreceipted result must not surface"
      },
      {
        id: "action.receipted",
        capabilityId: "capability.process.run",
        phase: "commit",
        status: "succeeded",
        previewSurface: "prepared process execution",
        resultSurface: "validated process result",
        actionReceiptId: "receipt.action.1"
      }
    ];
    const proposals = planCognitiveProposals(plannerInput({
      requirements: requirements({ executableArtifactDemand: 0.9, actionCommitment: 0.9 }, [
        requirement("req.artifact", "executableArtifactDemand"),
        requirement("req.action", "actionCommitment")
      ]),
      operators: [
        operator("workspace", COGNITIVE_OPERATOR_IDS.workspaceRepair, ["executableArtifactDemand"]),
        operator("action", COGNITIVE_OPERATOR_IDS.actionPlanning, ["actionCommitment"])
      ],
      workspacePlans: [workspacePlan],
      actionPlans,
      maxProposals: 16
    }));

    expect(proposals.some(proposal => proposalFamily(proposal) === "workspace_artifact_preview"
      && proposal.artifacts.some(artifact => artifact.kindId === "artifact.workspace.patch_transaction.v1"))).toBe(true);
    expect(proposals.flatMap(proposal => proposal.claims).some(claim => claim.text === "unreceipted result must not surface")).toBe(false);
    expect(proposals.flatMap(proposal => proposal.claims).find(claim => claim.text === "prepared filesystem mutation")).toMatchObject({
      basis: "learned_prior",
      actionReceiptId: undefined
    });
    expect(proposals.flatMap(proposal => proposal.claims).find(claim => claim.text === "validated process result")).toMatchObject({
      basis: "action_result",
      actionReceiptId: "receipt.action.1"
    });
  });
});

function plannerInput(options: {
  graph?: GraphSlice;
  evidence?: EvidenceSpan[];
  requirements?: TurnRequirementField;
  operators?: ActivatedOperator[];
  inventions?: ReturnType<typeof createInventionConstruct>[];
  construct?: ConstructGraph;
  programGraphs?: ProgramGraph[];
  workspacePlans?: PatchTransactionPlan[];
  actionPlans?: CognitiveActionPlan[];
  maxProposals?: number;
} = {}): CognitivePlannerInput {
  const graph = options.graph ?? graphSlice([], []);
  return {
    requestText: "fixture request surface",
    requirements: options.requirements ?? requirements(),
    operatorActivations: options.operators ?? [],
    evidence: options.evidence ?? [],
    graph,
    field: fieldState(graph.nodes),
    construct: options.construct ?? constructGraph(),
    inventions: options.inventions ?? [],
    programGraphs: options.programGraphs ?? [],
    workspacePlans: options.workspacePlans ?? [],
    actionPlans: options.actionPlans ?? [],
    maxProposals: options.maxProposals ?? 8
  };
}

function requirements(
  patch: Partial<Record<TurnRequirementDimension, number>> = {},
  requiredFeatures: TurnRequirement[] = []
): TurnRequirementField {
  return {
    externalTruthAuthority: patch.externalTruthAuthority ?? 0.2,
    sourceDependence: patch.sourceDependence ?? 0.2,
    noveltyDemand: patch.noveltyDemand ?? 0.2,
    inferentialDepth: patch.inferentialDepth ?? 0.2,
    semanticPreservation: patch.semanticPreservation ?? 0.2,
    surfaceTransformation: patch.surfaceTransformation ?? 0.2,
    executableArtifactDemand: patch.executableArtifactDemand ?? 0.2,
    actionCommitment: patch.actionCommitment ?? 0.2,
    dialogueDependence: patch.dialogueDependence ?? 0.2,
    uncertaintyTolerance: patch.uncertaintyTolerance ?? 0.5,
    formatConstraintStrength: patch.formatConstraintStrength ?? 0.2,
    audienceAdaptation: patch.audienceAdaptation ?? 0.2,
    brevityDetailBalance: patch.brevityDetailBalance ?? 0.5,
    temporalReasoningDemand: patch.temporalReasoningDemand ?? 0.2,
    causalReasoningDemand: patch.causalReasoningDemand ?? 0.2,
    counterfactualDemand: patch.counterfactualDemand ?? 0.2,
    requiredFeatures,
    prohibitedFeatures: [],
    activatedFrameIds: ["frame.fixture"],
    activatedPatternIds: ["pattern.fixture"],
    activatedPhraseUnitIds: [],
    activatedDialogueMoveIds: [],
    activatedConstructIds: [],
    confidence: 0.9,
    trace: {}
  };
}

function requirement(id: string, dimension: TurnRequirementDimension): TurnRequirement {
  return {
    id,
    dimension,
    value: 0.9,
    confidence: 0.9,
    status: "explicit",
    origin: {
      requestSpan: { text: "fixture", charStart: 0, charEnd: 7, byteStart: 0, byteEnd: 7 },
      semanticRoleId: "role.fixture",
      learnedFrameOrPatternId: "frame.fixture"
    },
    sourceActivationId: "activation.fixture",
    trace: {}
  };
}

function operator(id: string, operatorId: ActivatedOperator["operatorId"], dimensions: TurnRequirementDimension[]): ActivatedOperator {
  return {
    id: `operator.activation.${id}`,
    operatorId,
    activation: 0.95,
    active: true,
    contributingRequirementDimensions: dimensions,
    support: { requirement: 0.9, graph: 0.7, dialogue: 0, construct: 0.4, outcome: 0 },
    trace: {}
  };
}

function evidence(id: string, sourceId: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: sourceId as EvidenceSpan["sourceId"],
    sourceVersionId: `${sourceId}.version` as EvidenceSpan["sourceVersionId"],
    chunkId: `${id}.chunk` as EvidenceSpan["chunkId"],
    contentHash: `${id}.hash` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: Buffer.byteLength(text),
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text,
    languageHints: [],
    scriptHints: [],
    trustVector: {},
    provenance: {},
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: 10
  };
}

function node(id: string, label: string, evidenceIds: EvidenceSpan["id"][]): GraphNode {
  return {
    id: id as GraphNode["id"],
    typeId: "type.fixture" as GraphNode["typeId"],
    representation: { label },
    alpha: 0.9,
    evidenceIds,
    features: [],
    createdAt: 1,
    updatedAt: 10,
    metadata: {}
  };
}

function edge(
  id: string,
  source: GraphNode,
  target: GraphNode,
  evidenceIds: EvidenceSpan["id"][],
  patch: { alpha?: number; weight?: number; relationId?: string; contradiction?: number } = {}
): GraphEdge {
  return {
    id: id as GraphEdge["id"],
    source: source.id,
    target: target.id,
    relationId: (patch.relationId ?? "relation.fixture") as GraphEdge["relationId"],
    alpha: patch.alpha ?? 0.9,
    weight: patch.weight ?? 0.9,
    temporalScope: { validFrom: 1 },
    evidenceIds,
    createdAt: 1,
    updatedAt: 10,
    metadata: { relationPotential: { modalityAgreement: 1, contradiction: patch.contradiction ?? 0 } }
  };
}

function graphSlice(nodes: GraphNode[], edges: GraphEdge[]): GraphSlice {
  return { nodes, edges, hyperedges: [], bounded: true, query: {} };
}

function fieldState(nodes: GraphNode[]): FieldState {
  return {
    requestFeatures: [],
    seeds: [],
    active: nodes.map(item => ({ nodeId: item.id, activation: 0.9 })),
    ppf: nodes.map(item => ({ nodeId: item.id, mass: 0.8 })),
    alphaTrace: {
      alpha: 1 / 137,
      thresholds: { virtual: 0.1, visible: 0.2, bonded: 0.4, structural: 0.7 },
      relations: [],
      adjacency: { nodes: nodes.map(item => String(item.id)), values: [] },
      laplacian: { nodes: nodes.map(item => String(item.id)), values: [] },
      normalizedLaplacian: { nodes: nodes.map(item => String(item.id)), values: [] },
      surfaces: { pressure: 0.1, drift: 0.1, contradiction: 0, bond: 0.6, risk: 0.1, actionability: 0.8 },
      contradictionMass: 0,
      bondedLeakage: 0
    },
    causalMass: []
  };
}

function constructGraph(options: {
  id?: string;
  nodes?: ConstructGraph["nodes"];
  edges?: ConstructGraph["edges"];
  artifacts?: ConstructGraph["artifacts"];
  program?: ProgramGraph;
} = {}): ConstructGraph {
  return {
    id: (options.id ?? "construct.fixture") as ConstructGraph["id"],
    episodeId: "episode.fixture" as ConstructGraph["episodeId"],
    forceVector: {},
    nodes: options.nodes ?? [],
    edges: options.edges ?? [],
    program: options.program,
    artifacts: options.artifacts ?? []
  };
}

function programGraph(): ProgramGraph {
  const file = {
    artifactId: "artifact.source" as ProgramGraph["files"][number]["artifactId"],
    path: "src/index.ts",
    mediaType: "text/typescript",
    content: "export const run = () => 1;\n",
    contentHash: "hash.program.source" as ProgramGraph["files"][number]["contentHash"],
    role: "source" as const
  };
  return {
    id: "program.fixture",
    language: "language.typescript",
    packageManager: "package-manager.pnpm",
    entrypoint: "src/index.ts",
    nodes: [
      { id: "program.input", kind: "program.input.v1", label: "typed input", metadata: { order: 1 } },
      { id: "program.transform", kind: "program.transform.v1", label: "bounded transform", metadata: { order: 2 } },
      { id: "program.output", kind: "program.output.v1", label: "validated output", metadata: { order: 3 } }
    ],
    edges: [
      { source: "program.input", target: "program.transform", relation: "relation.sequence.v1", weight: 0.9 },
      { source: "program.transform", target: "program.output", relation: "relation.sequence.v1", weight: 0.9 }
    ],
    files: [file],
    build: { command: "pnpm", args: ["build"], cwd: "." },
    test: { command: "pnpm", args: ["test"], cwd: "." }
  };
}

function proposalFamily(proposal: CognitiveProposal): string {
  const trace = proposal.trace && typeof proposal.trace === "object" && !Array.isArray(proposal.trace)
    ? proposal.trace as Record<string, unknown>
    : {};
  return typeof trace.family === "string" ? trace.family : "";
}

function invention(id: string, proposalSurface: string, kindId: string) {
  return createInventionConstruct({
    id,
    title: proposalSurface.split(" ").slice(0, 3).join(" "),
    proposalSurface,
    artifactKindIds: [kindId],
    noveltyScore: 0.9,
    supportScore: 0.8,
    riskScore: 0.1,
    trace: {
      constraintCoverage: 1,
      graphCoherence: 0.8,
      novelty: 0.9,
      languageRealizability: 0.8,
      usefulness: 0.85,
      risk: 0.1,
      repetition: 0,
      claimBasis: [{ id: `${id}.claim`, surface: proposalSurface, force: "invented", evidenceIds: [], kind: "invention" }]
    }
  });
}

function plannedClaim(input: {
  id: string;
  text: string;
  basis: PlannedClaim["basis"];
  graphEdgeIds?: string[];
  externallyFactual?: boolean;
}): PlannedClaim {
  return {
    id: input.id,
    text: input.text,
    basis: input.basis,
    evidenceIds: [],
    priorIds: [],
    graphNodeIds: [],
    graphEdgeIds: input.graphEdgeIds ?? [],
    externallyFactual: input.externallyFactual ?? false,
    hypothetical: false,
    trace: {}
  };
}
