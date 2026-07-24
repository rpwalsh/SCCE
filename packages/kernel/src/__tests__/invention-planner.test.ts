import { describe, expect, it, vi } from "vitest";
import {
  classifyRequestedAuthority,
  CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
  CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
  CREATIVE_REQUEST_FRAME_SCHEMA,
  createClock,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createNgramMemoryCompiler,
  ENGLISH_CREATIVE_EVENT_COMPILER_ID,
  featureSet,
  planInventions,
  updateDialogueState,
  type ConstructGraph,
  type CreativeEventCompatibilityModel,
  type CreativeRequestFrame,
  type DurableLanguageConstructionBundle,
  type EvidenceSpan,
  type FieldState,
  type GraphEdge,
  type GraphNode,
  type GraphSlice,
  type InventionConstruct,
  type JsonValue,
  type PlanInventionsInput
} from "../index.js";
import type { LanguageProfile } from "../types.js";

describe("requested authority classification", () => {
  it("classifies a structured creative activation with inspectable softmax state", () => {
    const decision = classifyRequestedAuthority({
      requestText: "Ω-17",
      semanticFrameIds: ["authority.feature.request.creative"]
    });

    expect(decision.requestedAuthority).toBe("creative");
    expect(decision.explicitOverride).toBe(false);
    expect(decision.features["authority.feature.request.creative"]).toBeGreaterThan(0);
    expect(Object.values(decision.probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(decision.probabilities.creative).toBeGreaterThan(decision.probabilities.factual);
    expect(decision.probabilities.creative / decision.probabilities.factual).toBeCloseTo(
      Math.exp((decision.logits.creative - decision.logits.factual) / decision.temperature),
      12
    );
    expect(JSON.stringify(decision.audit)).toContain("evidenceAvailabilityUsed");
  });

  it("keeps an unsupported factual question factual", () => {
    const decision = classifyRequestedAuthority({ requestText: "Ω-18?" });

    expect(decision.requestedAuthority).toBe("factual");
    expect(decision.features["authority.feature.request.creative"]).toBe(0);
  });

  it("honors an explicit authority override before inference", () => {
    const decision = classifyRequestedAuthority({
      requestText: "Ω-19",
      explicitAuthority: "program"
    });

    expect(decision.requestedAuthority).toBe("program");
    expect(decision.explicitOverride).toBe(true);
    expect(decision.probabilities.program).toBe(1);
    expect(decision.probabilities.creative).toBe(0);
  });
});

describe("invention planner", () => {
  it("creates deterministic citation-free structural constructs from exact production memory", () => {
    const fixture = plannerFixtureWithStructuralCreativeBundle("Invent a new indexing algorithm for this graph");
    const first = planInventions({ ...fixture, requestedAuthority: "creative", samplingDisabled: true });
    const second = planInventions({ ...fixture, requestedAuthority: "creative", samplingDisabled: true });

    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.map(item => item.id)).toEqual(second.map(item => item.id));
    expect(first.map(item => item.trace)).toEqual(second.map(item => item.trace));
    expect(new Set(first.map(semanticPlanId)).size).toBe(first.length);
    for (const construct of first) {
      const trace = traceRecord(construct);
      expect(construct.proofStatusId).toBe("proof.status.generated_not_evidence");
      expect(construct.basisEvidenceIds).toEqual([]);
      expect(trace.constraintCoverage).toEqual(expect.any(Number));
      expect(trace.graphCoherence).toEqual(expect.any(Number));
      expect(trace.novelty).toEqual(expect.any(Number));
      expect(trace.languageRealizability).toEqual(expect.any(Number));
      expect(trace.usefulness).toEqual(expect.any(Number));
      expect(trace.risk).toEqual(expect.any(Number));
      expect(trace.repetition).toEqual(expect.any(Number));
      expect(trace.unsupportedFactualAssertion).toBe(0);
      expect(trace.bootstrapScore).toEqual(expect.any(Number));
      expect(trace.selectionProbability).toEqual(expect.any(Number));
      expect(trace.rank).toEqual(expect.any(Number));
      expect(trace.copiesCompleteEvidenceSentence).toBe(false);
      const claims = trace.claimBasis as Array<{ kind: string; force: string; evidenceIds: string[] }>;
      expect(claims.some(claim => claim.kind === "invention" && claim.force === "invented" && claim.evidenceIds.length === 0)).toBe(true);
    }
    const top = traceRecord(first[0]!);
    const expectedBootstrap =
      0.28 * Number(top.constraintCoverage) +
      0.22 * Number(top.graphCoherence) +
      0.2 * Number(top.novelty) +
      0.15 * Number(top.languageRealizability) +
      0.15 * Number(top.usefulness) -
      0.3 * Number(top.risk) -
      0.2 * Number(top.repetition) -
      0.5 * Number(top.unsupportedFactualAssertion);
    expect(Number(top.bootstrapScore)).toBeCloseTo(expectedBootstrap, 12);
    expect(first.reduce((sum, item) => sum + Number(traceRecord(item).selectionProbability), 0)).toBeCloseTo(1, 12);
  });

  it("binds activated request spans in the non-creative learned structure lane", () => {
    const requestText = "Write a fictional two-sentence story about a purple pump that learns to sing.";
    const corpus = "At dusk, the old pump hummed beside the quiet harbor. It dreamed of carrying starlight across the sleeping town. Before dawn, its steady rhythm became a silver melody and woke the patient bells.";
    const fixture = plannerFixtureWithLanguageCorpus(requestText, corpus);
    const pumpUnitIds = fixture.languageMemoryState.importedUnits
      .filter(unit => unit.unitKind === "symbol" && unit.text.normalize("NFKC").toLocaleLowerCase() === "pump")
      .map(unit => unit.id);
    const fullRequestControl = creativeRequestConstraintField(requestText, requestText);
    fixture.construct.nodes.push({ id: "invention", kind: "construct:invention", label: "construct", metadata: {} });

    const planned = planInventions({
      ...fixture,
      requestedAuthority: "factual",
      requirementField: {
        ...fullRequestControl,
        activatedPhraseUnitIds: pumpUnitIds,
      },
      samplingDisabled: true
    });
    const surface = planned[0]!.proposalSurface;
    const realization = traceRecord(planned[0]!).proposalRealization as Record<string, JsonValue>;

    expect(surface).toBe("At dusk, the purple pump hummed beside the quiet harbor. Pump that learns to sing dreamed of carrying starlight across the sleeping town.");
    expect(surface.match(/[.!?]+(?:\s|$)/gu)).toHaveLength(2);
    expect(corpus.split(/(?<=[.!?])\s+/u)).not.toContain(surface.split(/(?<=[.!?])\s+/u)[0]);
    expect(corpus.split(/(?<=[.!?])\s+/u)).not.toContain(surface.split(/(?<=[.!?])\s+/u)[1]);
    expect(realization).toMatchObject({
      path: "learned_structural_composition",
      structuralSentenceCount: 2,
      requestConstraintCoverage: 1,
      stoppedBy: "source_exhausted"
    });
    expect(realization.sourcePieceIds).toEqual(expect.arrayContaining([pumpUnitIds[0]]));
    expect(realization.requestSlotSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "purple pump" }),
      expect.objectContaining({ text: "pump that learns to sing" })
    ]));
    expect(planned[0]!.basisEvidenceIds).toEqual([]);
  });

  it("gives the exact current purity-proven compiler cluster exclusive structural authority", () => {
    const fixture = plannerFixtureWithStructuralCreativeBundle(
      "Write a fictional story about a cartographer crossing a storm."
    );

    const planned = planInventions({
      ...fixture,
      requestedAuthority: "creative",
      samplingDisabled: true
    });

    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      const trace = traceRecord(candidate);
      const realization = trace.proposalRealization as Record<string, JsonValue>;
      expect(realization.path).toBe("mouth_realization_deferred");
      expect(realization.semanticPlanId).toEqual(expect.any(String));
      expect(realization.structuralBundleIds).toEqual(["bundle.structural-authority"]);
      expect((realization.structuralEventPlan as JsonValue[]).length).toBeGreaterThanOrEqual(4);
      expect(trace.structuralSemanticPlan).toMatchObject({
        schema: "scce.structural_semantic_plan.v2",
        selectionAuthority: "candidate_engine_and_judge",
        surfaceRealizationCompetitive: false
      });
      expect(trace.proposalSelectionGuard).toMatchObject({
        id: "guard.invention.production_structural_authority.v1",
        productionStructuralAuthority: true,
        coldStartFallbackActive: false,
        learnedCandidateCount: 0,
        fallbackCandidateCount: 0
      });
    }
    expect(planned.some(candidate => {
      const path = (traceRecord(candidate).proposalRealization as Record<string, JsonValue>).path;
      return path === "learned_continuation"
        || path === "learned_structural_composition"
        || path === "mouth_non_event_realization_deferred";
    })).toBe(false);
  });

  it("fails only the structural event route when calibrated compatibility is unavailable", () => {
    const fixture = plannerFixtureWithStructuralCreativeBundle("Ï†-request without learned compatibility");
    const planned = planInventions({
      ...fixture,
      requestedAuthority: "creative",
      languageMemoryState: {
        ...fixture.languageMemoryState,
        creativeEventCompatibilityModels: []
      },
      samplingDisabled: true
    });

    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      const realization = traceRecord(candidate).proposalRealization as Record<string, JsonValue>;
      expect(realization.path).not.toBe("mouth_realization_deferred");
      expect(realization.structuralEventPlan ?? []).toEqual([]);
    }
  });

  it("hands no-model creative realization to Mouth without phrase salad or repeated generation", () => {
    const requestText = "Invent a new indexing algorithm for this graph.";
    const fixture = plannerFixtureWithLanguageCorpus(
      requestText,
      "At dusk, the old pump hummed beside the quiet harbor. It dreamed of carrying starlight across the sleeping town. Before dawn, its steady rhythm became a silver melody and woke the patient bells."
    );
    const generate = vi.spyOn(fixture.languageMemory, "generate");
    const creativeRequestFrame: CreativeRequestFrame = {
      schema: CREATIVE_REQUEST_FRAME_SCHEMA,
      id: "request.frame.no-model-handoff",
      compilerId: "compiler.request.fixture",
      focus: {
        id: "request.focus.algorithm",
        roleId: "request.role.focus",
        span: exactSpan(requestText, "algorithm")
      },
      arguments: [{
        id: "request.argument.graph",
        roleId: "request.role.argument",
        span: exactSpan(requestText, "this graph")
      }],
      sourceActivationIds: ["activation.request.no-model-handoff"]
    };

    const planned = planInventions({
      ...fixture,
      requestedAuthority: "creative",
      creativeRequestFrame,
      maxCandidates: 4,
      samplingDisabled: true
    });

    expect(generate.mock.calls.length).toBeLessThanOrEqual(1);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.proposalSurface).toBe("Invent a new indexing algorithm for this graph");
    expect(planned[0]!.proposalSurface).not.toContain(";");
    const realization = traceRecord(planned[0]!).proposalRealization as Record<string, JsonValue>;
    expect(realization.path)
      .toBe("mouth_non_event_realization_deferred");
    expect(realization.requestRoleBindings).toEqual([
      expect.objectContaining({
        id: "request.focus.algorithm",
        roleId: "request.role.focus",
        text: "algorithm",
        source: "creative_request_frame"
      }),
      expect.objectContaining({
        id: "request.argument.graph",
        roleId: "request.role.argument",
        text: "this graph",
        source: "creative_request_frame"
      })
    ]);
    expect(realization.contextSymbols).toEqual(expect.arrayContaining(["algorithm", "this graph"]));
    expect(fixture.languageMemoryState.creativeEventCompatibilityModels).toEqual([]);
  });

  it("does not admit low-posterior source-adjacent events", () => {
    const fixture = plannerFixtureWithStructuralCreativeBundle("Ï†-adjacency invariant");
    const bundle = fixture.languageMemoryState.importedConstructionBundles[0]!;
    const admittedEventIds = new Set([
      bundle.creativeEvents![0]!.id,
      bundle.creativeEvents![2]!.id,
      bundle.creativeEvents![4]!.id,
      bundle.creativeEvents![5]!.id
    ]);
    const model = fixture.languageMemoryState.creativeEventCompatibilityModels[0]!;
    const planned = planInventions({
      ...fixture,
      requestedAuthority: "creative",
      languageMemoryState: {
        ...fixture.languageMemoryState,
        creativeEventCompatibilityModels: [{
          ...model,
          eventCompatibilities: model.eventCompatibilities.map(row => {
            const event = bundle.creativeEvents!.find(candidate => candidate.relationId === row.eventRelationId)!;
            return {
              ...row,
              posterior: admittedEventIds.has(event.id) ? 0.94 : 0.18
            };
          })
        }]
      },
      samplingDisabled: true
    });

    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      const selected = structuralEventRows(candidate).map(row => String(row.eventId));
      expect(new Set(selected)).toEqual(admittedEventIds);
    }
  });

  it("selects by opaque IDs independently of request and event surfaces", () => {
    const left = plannerFixtureWithStructuralCreativeBundle("ab12 cd34");
    const right = plannerFixtureWithStructuralCreativeBundle("í•œê¸€ í‘œë©´");
    const rightBundle = right.languageMemoryState.importedConstructionBundles[0]!;
    rightBundle.creativeEvents = rightBundle.creativeEvents?.map((event, index) => ({
      ...event,
      sourceLabel: `í‘œë©´-${index}`,
      forms: {
        infinitive: `í‘œë©´${index}`,
        past: `í‘œë©´${index}`,
        present: `í‘œë©´${index}`,
        gerund: `í‘œë©´${index}`,
        participle: `í‘œë©´${index}`
      }
    }));

    const leftPlans = planInventions({
      ...left,
      requestedAuthority: "creative",
      samplingDisabled: true
    }).map(candidate => structuralEventRows(candidate).map(row => row.eventId).join("|")).sort();
    const rightPlans = planInventions({
      ...right,
      requestedAuthority: "creative",
      samplingDisabled: true
    }).map(candidate => structuralEventRows(candidate).map(row => row.eventId).join("|")).sort();

    expect(rightPlans).toEqual(leftPlans);
  });

  it("requires an injective request binding for every event argument", () => {
    const requestText = "Ï† focus omega";
    const fixture = plannerFixtureWithStructuralCreativeBundle(requestText);
    const frame = creativeRequestFrameFor(requestText, "ignored", "omega");
    const bundle = fixture.languageMemoryState.importedConstructionBundles[0]!;
    bundle.creativeEvents = bundle.creativeEvents?.map((event, index) => ({
      ...event,
      valencyId: "scce.valency.agent_patient",
      roleIds: index === 1
        ? ["scce.role.agent", "scce.role.patient", "scce.role.complement"]
        : ["scce.role.agent", "scce.role.patient"],
      argumentFrame: {
        ...event.argumentFrame,
        roleIds: index === 1
          ? ["scce.role.agent", "scce.role.patient", "scce.role.complement"]
          : ["scce.role.agent", "scce.role.patient"],
        bindings: [
          {
            roleId: "scce.role.patient",
            surface: `source-only-${index}`,
            surfaceDigest: `digest.source-only.${index}`,
            startCodePoint: index * 10,
            endCodePoint: index * 10 + 1
          },
          ...(index === 1
            ? [{
              roleId: "scce.role.complement" as const,
              surface: "second-source-only",
              surfaceDigest: "digest.second-source-only",
              startCodePoint: 20,
              endCodePoint: 21,
              connector: {
                surface: "to",
                surfaceDigest: "digest.connector.to",
                startCodePoint: 19,
                endCodePoint: 20
              }
            }]
            : [])
        ]
      }
    }));
    const model = fixture.languageMemoryState.creativeEventCompatibilityModels[0]!;
    const roleCompatibilities: CreativeEventCompatibilityModel["roleCompatibilities"] = [
      {
        requestFrameId: frame.id,
        requestRoleId: frame.arguments[0]!.roleId,
        eventRoleId: "scce.role.patient",
        posterior: 0.95,
        support: 12,
        sourceActivationIds: ["activation.role.patient"]
      },
      {
        requestFrameId: frame.id,
        requestRoleId: frame.arguments[0]!.roleId,
        eventRoleId: "scce.role.complement",
        posterior: 0.95,
        support: 12,
        sourceActivationIds: ["activation.role.complement"]
      }
    ];
    const planned = planInventions({
      ...fixture,
      creativeRequestFrame: frame,
      requestedAuthority: "creative",
      languageMemoryState: {
        ...fixture.languageMemoryState,
        creativeEventCompatibilityModels: [{ ...model, roleCompatibilities }]
      },
      samplingDisabled: true
    });

    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      const rows = structuralEventRows(candidate);
      expect(rows.some(row => row.eventId === bundle.creativeEvents![1]!.id)).toBe(false);
      expect(rows.length).toBe(5);
      for (const row of rows) {
        const bindings = row.requestRoleBindings as Array<Record<string, JsonValue>>;
        expect(bindings).toHaveLength(1);
        expect(bindings[0]).toMatchObject({
          requestArgumentId: frame.arguments[0]!.id,
          requestRoleId: frame.arguments[0]!.roleId,
          requestSpan: { text: "omega" },
          admissible: true
        });
        expect(JSON.stringify(bindings)).not.toContain("source-only");
      }
    }
  });

  it("fails only the structural event route when the construction cluster is impure", () => {
    const fixture = plannerFixtureWithStructuralCreativeBundle(
      "Write a fictional story about a cartographer crossing a storm."
    );
    const planned = planInventions({
      ...fixture,
      requestedAuthority: "creative",
      languageMemoryState: {
        ...fixture.languageMemoryState,
        scope: {
          ...fixture.languageMemoryState.scope,
          purityProven: false,
          degraded: true
        }
      },
      samplingDisabled: true
    });

    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      const realization = traceRecord(candidate).proposalRealization as Record<string, JsonValue>;
      expect(realization.path).not.toBe("mouth_realization_deferred");
      expect(realization.structuralEventPlan ?? []).toEqual([]);
    }
  });

  it("keeps the non-event creative route available without verified current structural bundles", () => {
    const fixture = plannerFixture("Write a fictional story about a cartographer crossing a storm.");

    const planned = planInventions({
      ...fixture,
      requestedAuthority: "creative",
      samplingDisabled: true
    });

    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      const realization = traceRecord(candidate).proposalRealization as Record<string, JsonValue>;
      expect(realization.path).not.toBe("mouth_realization_deferred");
      expect(realization.structuralEventPlan ?? []).toEqual([]);
    }
  });

  it("rejects exact source reconstruction in the non-creative invention lane", () => {
    const requestText = "compose a violet pump";
    const sourceSentence = "violet pump hummed beside the empty canal.";
    const fixture = plannerFixtureWithLanguageCorpus(requestText, sourceSentence);
    fixture.construct.nodes.push({ id: "invention", kind: "construct:invention", label: "construct", metadata: {} });

    const planned = planInventions({
      ...fixture,
      requestedAuthority: "factual",
      requirementField: creativeRequestConstraintField(requestText, "violet pump"),
      samplingDisabled: true
    });

    expect(planned.every(candidate => (traceRecord(candidate).proposalRealization as Record<string, JsonValue>).path === "mouth_non_event_realization_deferred")).toBe(true);
    expect(planned.every(candidate => candidate.proposalSurface !== sourceSentence)).toBe(true);
    expect(planned.every(candidate => !candidate.proposalSurface.includes(";"))).toBe(true);
    expect(traceRecord(planned[0]!).proposalSelectionGuard).toMatchObject({
      coldStartFallbackActive: false,
      mouthRealizationHandoffActive: true,
      learnedCandidateCount: 0,
      fallbackCandidateCount: 0
    });
  });

  it("does not run for factual authority without an explicit invention construct", () => {
    const fixture = plannerFixture("What is the graph fanout?");
    fixture.construct.forceVector = { force: "invented" };
    expect(planInventions({ ...fixture, requestedAuthority: "factual" })).toEqual([]);
  });

  it("does not treat English creative tokens as production routing signals", () => {
    const fixture = plannerFixture("invent imagine devise brainstorm");

    expect(planInventions({ ...fixture, requestedAuthority: "factual" })).toEqual([]);
  });

  it("plans structural constructs for opaque and non-English surfaces without lexical routing", () => {
    const opaque = planInventions({
      ...plannerFixtureWithStructuralCreativeBundle("zxq_91f7 qv_22"),
      requestedAuthority: "creative",
      samplingDisabled: true
    });
    const nonEnglish = planInventions({
      ...plannerFixtureWithStructuralCreativeBundle("그래프 제약을 결합한 새로운 구조"),
      requestedAuthority: "creative",
      samplingDisabled: true
    });

    expect(opaque.length).toBeGreaterThanOrEqual(3);
    expect(nonEnglish.length).toBeGreaterThanOrEqual(3);
    expect(new Set(opaque.map(semanticPlanId)).size).toBe(opaque.length);
    expect(new Set(nonEnglish.map(semanticPlanId)).size).toBe(nonEnglish.length);
    for (const construct of [...opaque, ...nonEnglish]) {
      const trace = traceRecord(construct);
      expect(trace.lexicalRoutingUsed).toBe(false);
      expect(trace.surfaceTokensAffectAdmission).toBe(false);
    }
    expect(JSON.stringify(nonEnglish.map(item => item.proposalSurface))).toContain("그래프");
  });

  it("keeps multilingual non-event composition available without structural memory", () => {
    const requestText = "નવી રચના જાંબલી પંપ";
    const premise = evidenceSpan("જાંબલી પંપ શાંત લયમાં ગૂંજ્યો.");
    const source = graphNode("node.source.multilingual", "જાંબલી પંપ", [premise.id]);
    source.representation = { surface: "bi:જાંબલી|પંપ", label: "language_memory" };
    source.metadata = { surface: `relation_${"a".repeat(48)}`, control: "language_memory" };
    const target = graphNode("node.target.multilingual", "શાંત લય", [premise.id]);
    const edge = {
      ...graphEdge(source, target, [premise.id]),
      relationId: `relation_${"b".repeat(48)}` as GraphEdge["relationId"]
    };
    const fixture = plannerFixture(requestText, {
      evidence: [premise],
      graph: graphSlice([source, target], [edge]),
      activeNodeIds: [String(source.id), String(target.id)]
    });

    const planned = planInventions({ ...fixture, requestedAuthority: "creative", samplingDisabled: true });

    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      const realization = traceRecord(candidate).proposalRealization as Record<string, JsonValue>;
      expect(realization.path).not.toBe("mouth_realization_deferred");
      expect(realization.structuralEventPlan ?? []).toEqual([]);
    }
  });

  it("admits opaque invention through numeric learned requirements", () => {
    const fixture = plannerFixture("ξ7 ψ_19");

    const planned = planInventions({
      ...fixture,
      requestedAuthority: "factual",
      requirementField: {
        noveltyDemand: 0.91,
        activatedFrameIds: ["frame.learned.opaque.7"],
        activatedPatternIds: ["pattern.learned.opaque.3"],
        activatedPhraseUnitIds: [],
        activatedConstructIds: []
      }
    });

    expect(planned).toHaveLength(1);
    const activation = traceRecord(planned[0]!).planningActivation as Record<string, JsonValue>;
    expect(activation.authority).toBe(0);
    expect(activation.noveltyRequirement).toBe(0.91);
    expect(activation.activation).toBe(0.91);
    expect(activation.activeLearnedIds).toEqual(["frame.learned.opaque.7", "pattern.learned.opaque.3"]);
  });

  it("admits invention through the numeric learned operator ID without reading the surface", () => {
    const fixture = plannerFixture("بنية_7 نمط_19");

    const planned = planInventions({
      ...fixture,
      requestedAuthority: "factual",
      operatorActivations: [{
        id: "activation.learned.invention.1",
        operatorId: "operator.cognition.invention.v1",
        activation: 0.84,
        active: true,
        contributingRequirementDimensions: ["noveltyDemand"],
        support: { requirement: 0.84, graph: 0, dialogue: 0, construct: 0, outcome: 0 },
        trace: {}
      }]
    });

    expect(planned).toHaveLength(1);
    const activation = traceRecord(planned[0]!).planningActivation as Record<string, JsonValue>;
    expect(activation.inventionOperator).toBe(0.84);
    expect(activation.activeLearnedIds).toEqual([
      "activation.learned.invention.1",
      "operator.cognition.invention.v1"
    ]);
  });

  it("runs when the existing construct graph explicitly requests invention", () => {
    const fixture = plannerFixture("Compose the requested construct");
    fixture.construct.nodes.push({ id: "invention", kind: "construct:invention", label: "construct", metadata: {} });

    const planned = planInventions({ ...fixture, requestedAuthority: "factual" });

    expect(planned).toHaveLength(1);
    expect(planned.every(item => item.proofStatusId === "proof.status.generated_not_evidence")).toBe(true);
  });

  it("keeps factual premise evidence separate from deduction and invention basis", () => {
    const premise = evidenceSpan("Observed fanout is sixty-four.");
    const unavailable = "evidence.unavailable" as EvidenceSpan["id"];
    const sourceNode = graphNode("node.source", "partition fanout", [premise.id, unavailable]);
    const targetNode = graphNode("node.target", "adaptive bucket", []);
    const edge = graphEdge(sourceNode, targetNode, [premise.id, unavailable]);
    const fixture = plannerFixture("Invent an adaptive indexing algorithm for graph fanout", {
      evidence: [premise],
      graph: graphSlice([sourceNode, targetNode], [edge]),
      activeNodeIds: [String(sourceNode.id), String(targetNode.id)]
    });
    fixture.construct.nodes.push({ id: "invention", kind: "construct:invention", label: "construct", metadata: {} });

    const planned = planInventions({ ...fixture, requestedAuthority: "factual" });

    expect(planned).toHaveLength(1);
    for (const construct of planned) {
      const trace = traceRecord(construct);
      const claims = trace.claimBasis as Array<{ kind: string; force: string; evidenceIds: string[] }>;
      const premiseClaims = claims.filter(claim => claim.kind === "factual_premise");
      expect(premiseClaims.some(claim => claim.force === "observed" && claim.evidenceIds.includes(String(premise.id)))).toBe(true);
      expect(claims.some(claim => claim.kind === "deduction" && claim.force === "inferred")).toBe(true);
      expect(claims.some(claim => claim.kind === "invention" && claim.force === "invented" && claim.evidenceIds.length === 0)).toBe(true);
      expect(construct.basisEvidenceIds).toEqual([String(premise.id)]);
      expect(JSON.stringify(trace.claimBasis)).not.toContain(String(unavailable));
      expect(construct.proposalSurface).not.toContain(premise.text);
    }
  });

  it("marks untested performance predictions conjectural without fake evidence", () => {
    const fixture = plannerFixtureWithStructuralCreativeBundle("Invent an indexing algorithm with 2x faster lookup performance");
    const lexicalOnly = planInventions({ ...fixture, requestedAuthority: "creative" });
    const lexicalClaims = traceRecord(lexicalOnly[0]!).claimBasis as Array<{ kind: string }>;
    expect(lexicalClaims.some(claim => claim.kind === "performance_prediction")).toBe(false);

    fixture.construct.nodes.push({
      id: "performance-prediction",
      kind: "construct:performance_prediction",
      label: "semantic.role.performance_prediction",
      metadata: { semanticRoleId: "semantic.role.performance_prediction" }
    });

    const planned = planInventions({ ...fixture, requestedAuthority: "creative" });
    const trace = traceRecord(planned[0]!);
    const claims = trace.claimBasis as Array<{ kind: string; force: string; evidenceIds: string[] }>;

    expect(trace.untestedPerformanceClaim).toBe(true);
    expect(claims.some(claim => claim.kind === "performance_prediction" && claim.force === "conjectured" && claim.evidenceIds.length === 0)).toBe(true);
    expect(planned[0]!.basisEvidenceIds).toEqual([]);
  });
});

function plannerFixtureWithStructuralCreativeBundle(requestText: string) {
  const fixture = plannerFixture(requestText);
  const profileId = "profile.structural-authority";
  const sourceVersionId = "source-version.structural-authority";
  const evidenceId = "evidence.structural-authority";
  const bundle: DurableLanguageConstructionBundle = {
    id: "bundle.structural-authority",
    schema: "scce.language_construction_pattern.v1",
    bindingId: "binding.structural-authority",
    sourceProfileId: profileId,
    targetProfileId: profileId,
    sourceVersionIds: [sourceVersionId],
    evidenceIds: [evidenceId],
    evidenceContentHashes: ["hash.structural-authority"],
    sourceExamples: [],
    constructions: [],
    formClasses: [],
    creativeEvents: Array.from({ length: 6 }, (_, index) => ({
      id: `event.structural-authority.${index}`,
      compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
      constructionId: `construction.structural-authority.${index}`,
      profileId,
      sourceVersionId,
      evidenceId,
      evidenceContentHash: "hash.structural-authority",
      evidenceCharStart: 0,
      evidenceCharEnd: 64,
      labelStartCodePoint: index,
      labelEndCodePoint: index + 1,
      sourceOrdinal: index,
      relationId: `relation.structural-authority.${index}`,
      sourceLabel: "crossed",
      sourceLabelDigest: `digest.structural-authority.${index}`,
      tenseId: "scce.tense.past",
      valencyId: "scce.valency.agent",
      roleIds: ["scce.role.agent"],
      argumentFrame: {
        id: `argument-frame.structural-authority.${index}`,
        schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
        compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
        sourceSentenceStartCodePoint: 0,
        sourceSentenceEndCodePoint: 64,
        roleIds: ["scce.role.agent"],
        bindings: []
      },
      forms: {
        infinitive: "cross",
        past: "crossed",
        present: "crosses",
        gerund: "crossing",
        participle: "crossed"
      }
    })),
    contentDigest: "digest.bundle.structural-authority"
  };
  const creativeRequestFrame = creativeRequestFrameFor(requestText, profileId);
  const compatibilityModel: CreativeEventCompatibilityModel = {
    schema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
    id: "model.structural-authority",
    version: "fixture.v1",
    requestCompilerId: "compiler.request.fixture",
    eventCompilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    calibrationId: "calibration.structural-authority",
    reliability: "calibrated",
    minimumAdmissiblePosterior: 0.72,
    minimumRolePosterior: 0.72,
    eventCompatibilities: (bundle.creativeEvents ?? []).map(event => ({
      requestFrameId: creativeRequestFrame.id,
      eventRelationId: event.relationId,
      posterior: 0.94,
      support: 8,
      sourceActivationIds: ["activation.structural-authority"]
    })),
    roleCompatibilities: []
  };
  return {
    ...fixture,
    creativeRequestFrame,
    languageMemoryState: {
      ...fixture.languageMemoryState,
      importedConstructionBundles: [bundle],
      creativeEventCompatibilityModels: [compatibilityModel],
      scope: {
        mode: "cluster" as const,
        clusterId: "cluster.structural-authority",
        profileIds: [profileId],
        sourceVersionIds: [sourceVersionId],
        purityProven: true,
        degraded: false
      }
    }
  };
}

function creativeRequestFrameFor(
  requestText: string,
  _profileId: string,
  argumentText?: string
): CreativeRequestFrame {
  const focusSpan = exactSpan(requestText, requestText);
  const argumentSpan = argumentText ? exactSpan(requestText, argumentText) : undefined;
  return {
    schema: CREATIVE_REQUEST_FRAME_SCHEMA,
    id: "request.frame.structural-authority",
    compilerId: "compiler.request.fixture",
    focus: {
      id: "request.focus.structural-authority",
      roleId: "request.role.structural-authority.focus",
      span: focusSpan
    },
    arguments: argumentSpan
      ? [{
        id: "request.argument.structural-authority",
        roleId: "request.role.structural-authority.argument",
        span: argumentSpan
      }]
      : [],
    sourceActivationIds: ["activation.structural-authority"]
  };
}

function exactSpan(requestText: string, surface: string) {
  const utf16Start = requestText.indexOf(surface);
  if (utf16Start < 0) throw new Error(`fixture surface not found: ${surface}`);
  const prefix = requestText.slice(0, utf16Start);
  return {
    text: surface,
    charStart: [...prefix].length,
    charEnd: [...prefix + surface].length,
    byteStart: Buffer.byteLength(prefix),
    byteEnd: Buffer.byteLength(prefix + surface)
  };
}

function plannerFixture(requestText: string, options: { evidence?: EvidenceSpan[]; graph?: GraphSlice; activeNodeIds?: string[] } = {}) {
  const languageMemory = createLanguageMemoryRuntime();
  const languageMemoryState = languageMemory.hydrate({ models: [], observations: [], units: [], patterns: [], semanticFrames: [] });
  const graph = options.graph ?? graphSlice([], []);
  return {
    requestText,
    field: fieldState(requestText, graph.nodes, options.activeNodeIds ?? []),
    graph,
    languageMemory,
    languageMemoryState,
    dialogueState: updateDialogueState({ requestText }),
    evidence: options.evidence ?? [],
    construct: constructGraph()
  };
}

function plannerFixtureWithLanguageCorpus(requestText: string, text: string) {
  const hasher = createHasher();
  const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true });
  const sourceVersionId = ids.sourceVersionId("creative-language-fixture");
  const profile: LanguageProfile = {
    id: "profile.creative-language-fixture",
    sourceVersionId,
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "ltr",
    entropy: 0.5,
    createdAt: 1
  };
  const evidence: EvidenceSpan = {
    id: "evidence.creative-language-fixture" as EvidenceSpan["id"],
    sourceId: "source.creative-language-fixture" as EvidenceSpan["sourceId"],
    sourceVersionId,
    chunkId: "chunk.creative-language-fixture" as EvidenceSpan["chunkId"],
    contentHash: "hash.creative-language-fixture" as EvidenceSpan["contentHash"],
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
    features: featureSet(text, 128),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
  const compiled = createNgramMemoryCompiler({ hasher, idFactory: ids }).compile({
    streamId: "stream.creative-language-fixture",
    profile,
    sourceVersionId,
    text,
    evidence: [evidence],
    createdAt: 1
  });
  const languageMemory = createLanguageMemoryRuntime({ hasher, idFactory: ids });
  const languageMemoryState = languageMemory.hydrate({
    models: compiled.models,
    observations: compiled.observations,
    units: compiled.units,
    patterns: compiled.patterns,
    semanticFrames: compiled.semanticFrames
  });
  return {
    ...plannerFixture(requestText),
    languageMemory,
    languageMemoryState
  };
}

function creativeRequestConstraintField(requestText: string, surface: string): NonNullable<PlanInventionsInput["requirementField"]> {
  const utf16Start = requestText.indexOf(surface);
  if (utf16Start < 0) throw new Error("fixture constraint is not in request");
  const prefix = requestText.slice(0, utf16Start);
  const charStart = [...prefix].length;
  const charEnd = charStart + [...surface].length;
  return {
    noveltyDemand: 1,
    requiredFeatures: [{
      id: "requirement.creative-fixture",
      dimension: "noveltyDemand",
      value: 1,
      confidence: 1,
      status: "explicit",
      origin: {
        requestSpan: {
          text: surface,
          charStart,
          charEnd,
          byteStart: Buffer.byteLength(prefix),
          byteEnd: Buffer.byteLength(prefix + surface)
        },
        semanticRoleId: "role.creative-fixture",
        learnedFrameOrPatternId: "frame.creative-fixture"
      },
      sourceActivationId: "activation.creative-fixture",
      trace: {}
    }],
    activatedFrameIds: [],
    activatedPatternIds: [],
    activatedPhraseUnitIds: [],
    activatedConstructIds: []
  };
}

function constructGraph(): ConstructGraph {
  return {
    id: "construct.test" as ConstructGraph["id"],
    episodeId: "episode.test" as ConstructGraph["episodeId"],
    forceVector: {},
    nodes: [],
    edges: [],
    artifacts: []
  };
}

function graphSlice(nodes: GraphNode[], edges: GraphEdge[]): GraphSlice {
  return { nodes, edges, hyperedges: [], bounded: true, query: { features: ["question.graph"] } };
}

function graphNode(id: string, label: string, evidenceIds: EvidenceSpan["id"][]): GraphNode {
  return {
    id: id as GraphNode["id"],
    typeId: "type.graph" as GraphNode["typeId"],
    representation: { label },
    alpha: 0.92,
    evidenceIds,
    features: featureSet(label, 64),
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function graphEdge(source: GraphNode, target: GraphNode, evidenceIds: EvidenceSpan["id"][]): GraphEdge {
  return {
    id: "edge.test" as GraphEdge["id"],
    source: source.id,
    target: target.id,
    relationId: "rel.adaptive" as GraphEdge["relationId"],
    alpha: 0.86,
    weight: 0.9,
    temporalScope: { validFrom: 0 },
    evidenceIds,
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function fieldState(requestText: string, nodes: GraphNode[], activeNodeIds: string[]): FieldState {
  const activeSet = new Set(activeNodeIds);
  return {
    requestFeatures: featureSet(requestText, 128),
    seeds: [],
    active: nodes.filter(node => activeSet.has(String(node.id))).map(node => ({ nodeId: node.id, activation: 0.98 })),
    ppf: nodes.filter(node => activeSet.has(String(node.id))).map(node => ({ nodeId: node.id, mass: 0.94 })),
    alphaTrace: {
      alpha: 1 / 137,
      thresholds: { virtual: 0.1, visible: 0.2, bonded: 0.4, structural: 0.7 },
      relations: [],
      adjacency: { nodes: nodes.map(node => String(node.id)), values: [] },
      laplacian: { nodes: nodes.map(node => String(node.id)), values: [] },
      normalizedLaplacian: { nodes: nodes.map(node => String(node.id)), values: [] },
      surfaces: { pressure: 0.18, drift: 0.3, contradiction: 0.04, bond: 0.4, risk: 0.08, actionability: 0.82 },
      contradictionMass: 0.04,
      bondedLeakage: 0
    },
    causalMass: []
  };
}

function evidenceSpan(text: string): EvidenceSpan {
  return {
    id: "evidence.premise" as EvidenceSpan["id"],
    sourceId: "source.premise" as EvidenceSpan["sourceId"],
    sourceVersionId: "source-version.premise" as EvidenceSpan["sourceVersionId"],
    chunkId: "chunk.premise" as EvidenceSpan["chunkId"],
    contentHash: "hash.premise" as EvidenceSpan["contentHash"],
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
    features: featureSet(text, 128),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}

function traceRecord(construct: InventionConstruct): Record<string, JsonValue> {
  expect(construct.trace).toBeTruthy();
  expect(Array.isArray(construct.trace)).toBe(false);
  expect(typeof construct.trace).toBe("object");
  return construct.trace as Record<string, JsonValue>;
}

function structuralEventRows(construct: InventionConstruct): Array<Record<string, JsonValue>> {
  const realization = traceRecord(construct).proposalRealization as Record<string, JsonValue>;
  return (realization.structuralEventPlan as JsonValue[]).map(row => row as Record<string, JsonValue>);
}

function semanticPlanId(construct: InventionConstruct): string {
  const realization = traceRecord(construct).proposalRealization as Record<string, JsonValue>;
  return String(realization.semanticPlanId);
}
