// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ContentHash, EpisodeId, EvidenceSpan, FileArtifact, Hasher, JsonValue, ProgramBehaviorRequirement, ProgramConstructIntent, ProgramGraph, ProgramStatefulBehaviorRequirement, SemanticEntailmentResult } from "./types.js";
import type { IdFactory } from "./ids.js";
import { canonicalStringify, clamp01, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import { createCodeLearningEngine, emittedProgramRuntimeForLanguage, EMITTED_PROGRAM_RUNTIME, type CodeImplementationBlueprint, type CodeKnowledgeGraph, type EmittedProgramRuntime } from "./code-learning.js";
import { createEngineeringCorpusRuntime, packageManagerCommandName, plannerScriptKind } from "./engineering-corpus-runtime.js";
import { createProgramHydrationContract, hydrationSummary } from "./program-runtime.js";
import { searchProgramTransformations, type ProgramExpression, type ProgramTransformationCandidate } from "./program-transformation-search.js";
import { searchStateTransitions, type StateTransitionCandidate } from "./state-transition-search.js";

export interface ProgramTargetProfile {
  id: string;
  label: string;
  capabilities: string[];
  runtimeTarget: string;
  packageManager: string;
  language: string;
  entrypoint: string;
  persistence: string;
  requiredInputs: Array<{ id: string; mediaType: string; source: string; required: boolean }>;
  requiredOutputs: Array<{ id: string; mediaType: string; target: string; required: boolean }>;
  sideEffects: Array<{ id: string; kind: string; risk: number }>;
  packageHints: Array<{ name: string; role: string; evidence: string[] }>;
  evidence: JsonValue;
}

export interface ProgramShape {
  target: ProgramTargetProfile;
  confidence: number;
  requiredInputs: Array<{ id: string; mediaType: string; source: string; required: boolean }>;
  requiredOutputs: Array<{ id: string; mediaType: string; target: string; required: boolean }>;
  sideEffects: Array<{ id: string; kind: string; risk: number }>;
  persistence: string;
  runtimeTarget: string;
  operatorConstraints: string[];
  requestedStructures: string[];
  evidenceFeatures: string[];
  energy: ProgramEnergy;
  reasons: string[];
}

interface CommandHint {
  kind: string;
  name: string;
  command?: string;
  packageName?: string;
  confidence: number;
}

export interface ProgramEnergy {
  missingRequirementCost: number;
  idiomMismatch: number;
  dependencyUncertainty: number;
  buildRisk: number;
  testGap: number;
  complexity: number;
  securityRisk: number;
  exampleSupport: number;
  ownerUtility: number;
  validationPotential: number;
  total: number;
}

export interface ProgramIntent {
  kind: string;
  confidence: number;
  reasons: string[];
  requestedOutputs: string[];
  constraints: string[];
  evidenceFeatures: string[];
  shape: ProgramShape;
}

export interface ProgramFilePlan {
  path: string;
  role: FileArtifact["role"];
  mediaType: string;
  purpose: string;
  dependsOn: string[];
  invariants: string[];
}

export interface SourceEmissionPlan {
  id: string;
  artifactKinds: string[];
  expectedFiles: string[];
  entrypoint: string;
  validation: Array<{ id: string; command: string; args: string[]; cwd: string; expects: string[]; commandSource: string }>;
  staticChecks: string[];
  risks: Array<{ id: string; severity: "info" | "warning" | "error"; reason: string }>;
  missingDependencies: string[];
  provenanceEvidenceIds: string[];
}

export interface ProgramPlan {
  id: string;
  intent: ProgramIntent;
  codeGraph: CodeKnowledgeGraph;
  blueprint: CodeImplementationBlueprint;
  files: ProgramFilePlan[];
  sourceEmission: SourceEmissionPlan;
  ownerBehaviorRequirements: ProgramBehaviorRequirement[];
  ownerStatefulBehaviorRequirements: ProgramStatefulBehaviorRequirement[];
  ownerBehaviorImplementationPhase: "probe" | "selected";
  ownerBehaviorTransformationCandidates: ProgramTransformationCandidate[];
  selectedOwnerBehaviorTransformationIds: string[];
  ownerStatefulBehaviorTransformationCandidates: StateTransitionCandidate[];
  selectedOwnerStatefulBehaviorTransformationIds: string[];
  graph: {
    nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>;
    edges: Array<{ source: string; target: string; relation: string; weight: number }>;
  };
  build: { command: string; args: string[]; cwd: string };
  test: { command: string; args: string[]; cwd: string };
  repairHints: Array<{ check: string; hint: string; severity: "info" | "warning" | "error" }>;
}

export interface ProgramPlannerInput {
  episodeId: EpisodeId;
  requestText: string;
  entailment: SemanticEntailmentResult;
  evidence: EvidenceSpan[];
  programIntent?: ProgramConstructIntent;
}

export function createProgramPlanner(options: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    plan(input: ProgramPlannerInput): ProgramPlan {
      const code = createCodeLearningEngine({ hasher: options.hasher });
      const codeGraph = code.learn(input);
      const shape = inferProgramShape(input.requestText, input.entailment, input.evidence, options.hasher, codeGraph, input.programIntent);
      const emittedRuntime = emittedRuntimeForShape(shape);
      const intent = intentFromShape(shape);
      const blueprint = code.blueprint({ target: shape.target.id, requestText: input.requestText, graph: codeGraph, entailment: input.entailment });
      const files = planFiles(shape);
      const build = buildCommand(shape, files);
      const test = testCommand(shape, files);
      const ownerBehaviorRequirements = validatedOwnerBehaviorRequirements(input.programIntent?.behaviorRequirements ?? []);
      const ownerStatefulBehaviorRequirements = validatedOwnerStatefulBehaviorRequirements(input.programIntent?.statefulBehaviorRequirements ?? []);
      if (ownerBehaviorRequirements.length && ownerStatefulBehaviorRequirements.length) {
        throw new Error("a program intent cannot mix scalar and stateful owner behavior representations");
      }
      const ownerBehaviorImplementationPhase = ownerBehaviorRequirements.length || ownerStatefulBehaviorRequirements.length
        ? input.programIntent?.behaviorImplementationPhase ?? "probe"
        : "selected";
      const ownerBehaviorTransformations = validatedOwnerBehaviorTransformations(
        ownerBehaviorRequirements,
        ownerBehaviorImplementationPhase,
        input.programIntent?.behaviorTransformationCandidates ?? [],
        input.programIntent?.selectedBehaviorTransformationIds ?? []
      );
      const ownerStatefulBehaviorTransformations = validatedOwnerStatefulBehaviorTransformations(
        ownerStatefulBehaviorRequirements,
        ownerBehaviorImplementationPhase,
        input.programIntent?.statefulBehaviorTransformationCandidates ?? [],
        input.programIntent?.selectedStatefulBehaviorTransformationIds ?? []
      );
      const planId = options.idFactory.semanticId("program_plan", { episodeId: input.episodeId, shape, files });
      const sourceEmission = sourceEmissionPlan({
        planId,
        shape,
        codeGraph,
        blueprint,
        files,
        build,
        test,
        evidenceIds: input.evidence.map(span => String(span.id)),
        hasher: options.hasher
      });
      const nodes = [
        { id: "program-shape", kind: "program_shape", label: shape.target.label, metadata: toJsonValue(shape) },
        { id: "program-energy", kind: "program_energy", label: "E_program", metadata: toJsonValue(shape.energy) },
        { id: codeGraph.id, kind: "learned_code_graph", label: "code knowledge graph", metadata: codeGraph.audit },
        { id: blueprint.id, kind: "implementation_blueprint", label: blueprint.target, metadata: blueprint.audit },
        { id: sourceEmission.id, kind: "source_emission_plan", label: entrypointFor(shape), metadata: toJsonValue(sourceEmission) },
        ...ownerBehaviorRequirements.map(requirement => ({
          id: requirement.id,
          kind: "owner_behavior_requirement",
          label: requirement.callableId,
          metadata: toJsonValue(requirement)
        })),
        ...ownerStatefulBehaviorRequirements.map(requirement => ({
          id: requirement.id,
          kind: "owner_stateful_behavior_requirement",
          label: requirement.invocations.at(-1)?.callableId ?? "stateful",
          metadata: toJsonValue(requirement)
        })),
        ...ownerBehaviorTransformations.candidates.map(candidate => ({
          id: candidate.id,
          kind: "program_transformation_candidate",
          label: candidate.callableId,
          metadata: toJsonValue({ ...candidate, selected: ownerBehaviorTransformations.selectedIds.includes(candidate.id) })
        })),
        ...ownerStatefulBehaviorTransformations.candidates.map(candidate => ({
          id: candidate.id,
          kind: "program_state_transition_candidate",
          label: candidate.transitionIr.map(instruction => instruction.operationId).join(","),
          metadata: toJsonValue({ ...candidate, selected: ownerStatefulBehaviorTransformations.selectedIds.includes(candidate.id) })
        })),
        ...shape.requiredInputs.map(item => ({ id: `input:${item.id}`, kind: "program_input", label: item.id, metadata: toJsonValue(item) })),
        ...shape.requiredOutputs.map(item => ({ id: `output:${item.id}`, kind: "program_output", label: item.id, metadata: toJsonValue(item) })),
        ...files.map(file => ({ id: file.path, kind: `file:${file.role}`, label: file.path, metadata: toJsonValue({ purpose: file.purpose, invariants: file.invariants }) }))
      ];
      const edges = [
        { source: "program-shape", target: codeGraph.id, relation: "learns_from_evidence", weight: codeGraph.confidence },
        { source: codeGraph.id, target: blueprint.id, relation: "constrains_blueprint", weight: 1 - blueprint.unbackedSynthesisRisk },
        { source: "program-energy", target: "program-shape", relation: "selects_family", weight: 1 - shape.energy.total },
        { source: blueprint.id, target: sourceEmission.id, relation: "emission_plan", weight: 1 - blueprint.unbackedSynthesisRisk },
        { source: sourceEmission.id, target: entrypointFor(shape), relation: "entrypoint", weight: 0.95 },
        ...ownerBehaviorRequirements.flatMap(requirement => files
          .filter(file => file.path === emittedRuntime.sourcePath || file.path === emittedRuntime.testPath)
          .map(file => ({ source: requirement.id, target: file.path, relation: file.role === "test" ? "verified_by" : "implemented_by", weight: 1 }))),
        ...ownerStatefulBehaviorRequirements.flatMap(requirement => files
          .filter(file => file.path === emittedRuntime.sourcePath || file.path === emittedRuntime.testPath)
          .map(file => ({ source: requirement.id, target: file.path, relation: file.role === "test" ? "verified_by" : "implemented_by", weight: 1 }))),
        ...ownerBehaviorTransformations.candidates.flatMap(candidate => [
          ...candidate.predictedFitObligationIds.map(requirementId => ({ source: requirementId, target: candidate.id, relation: "predicted_satisfied_by", weight: 1 })),
          ...candidate.heldOutObligationIds.map(requirementId => ({ source: requirementId, target: candidate.id, relation: "reserved_for_validation", weight: 0 })),
          ...(ownerBehaviorTransformations.selectedIds.includes(candidate.id)
            ? [{ source: candidate.id, target: emittedRuntime.sourcePath, relation: "selected_for_emission", weight: 1 }]
            : [])
        ]),
        ...ownerStatefulBehaviorTransformations.candidates.flatMap(candidate => [
          ...candidate.predictedFitIds.map(requirementId => ({ source: requirementId, target: candidate.id, relation: "predicted_satisfied_by", weight: 1 })),
          ...candidate.heldoutIds.map(requirementId => ({ source: requirementId, target: candidate.id, relation: "reserved_for_validation", weight: 0 })),
          ...(ownerStatefulBehaviorTransformations.selectedIds.includes(candidate.id)
            ? [{ source: candidate.id, target: emittedRuntime.sourcePath, relation: "selected_for_emission", weight: 1 }]
            : [])
        ]),
        ...shape.requiredInputs.flatMap(inputNode => files.map(file => ({ source: `input:${inputNode.id}`, target: file.path, relation: "constrains_file", weight: inputNode.required ? 0.82 : 0.42 }))),
        ...shape.requiredOutputs.flatMap(outputNode => files.map(file => ({ source: file.path, target: `output:${outputNode.id}`, relation: "emits_output", weight: outputNode.required ? 0.82 : 0.42 }))),
        ...files.flatMap(file => file.dependsOn.map(dep => ({ source: dep, target: file.path, relation: "required_by", weight: 0.85 }))),
        ...files.map(file => ({ source: blueprint.id, target: file.path, relation: "planned_file", weight: file.role === "source" ? 1 : 0.75 }))
      ];
      return {
        id: planId,
        intent,
        codeGraph,
        blueprint,
        files,
        sourceEmission,
        ownerBehaviorRequirements,
        ownerStatefulBehaviorRequirements,
        ownerBehaviorImplementationPhase,
        ownerBehaviorTransformationCandidates: ownerBehaviorTransformations.candidates,
        selectedOwnerBehaviorTransformationIds: ownerBehaviorTransformations.selectedIds,
        ownerStatefulBehaviorTransformationCandidates: ownerStatefulBehaviorTransformations.candidates,
        selectedOwnerStatefulBehaviorTransformationIds: ownerStatefulBehaviorTransformations.selectedIds,
        graph: { nodes, edges },
        build,
        test,
        repairHints: [
          ...blueprint.repairPolicy.map(policy => ({ check: policy.diagnostic, hint: policy.operation, severity: policy.diagnostic === "semantic" ? "warning" as const : "error" as const })),
          { check: "program-energy", hint: "Recompute shape energy when requested inputs, outputs, or validation path change.", severity: "warning" },
          { check: "evidence", hint: "Do not promote generated behavior above source-backed proof obligations without new evidence.", severity: "warning" }
        ]
      };
    },

    emit(input: ProgramPlannerInput): ProgramGraph {
      const plan = this.plan(input);
      const files = emitFiles(plan, input, options.idFactory, options.hasher);
      const emittedRuntime = emittedRuntimeForShape(plan.intent.shape);
      const usesFallbackRuntime = !nodeRuntimeForShape(plan.intent.shape);
      const graphWithoutHydration = {
        id: options.idFactory.semanticId("program_graph", { episodeId: input.episodeId, planId: plan.id, files: files.map(file => file.contentHash) }),
        language: usesFallbackRuntime ? emittedRuntime.languageId : plan.intent.shape.target.language,
        packageManager: usesFallbackRuntime ? emittedRuntime.commandName : plan.intent.shape.target.packageManager,
        entrypoint: entrypointFor(plan.intent.shape),
        nodes: [
          ...plan.graph.nodes,
          ...files.map(file => ({ id: `artifact:${file.path}`, kind: `artifact:${file.role}`, label: file.path, metadata: toJsonValue({ contentHash: file.contentHash, mediaType: file.mediaType }) }))
        ],
        edges: [
          ...plan.graph.edges,
          ...files.map(file => ({ source: file.path, target: `artifact:${file.path}`, relation: "emits", weight: 1 }))
        ],
        files,
        build: plan.build,
        test: plan.test,
        taskDecomposition: toJsonValue(plan.blueprint.taskDecomposition)
      };
      const hydration = createProgramHydrationContract({
        program: graphWithoutHydration,
        sourcePlanId: plan.sourceEmission.id,
        evidenceIds: input.evidence.map(span => String(span.id)),
        ownerRequirementIds: [...plan.ownerBehaviorRequirements, ...plan.ownerStatefulBehaviorRequirements].map(requirement => requirement.id),
        risks: plan.sourceEmission.risks.map(risk => risk.id)
      });
      return {
        ...graphWithoutHydration,
        hydration,
        nodes: [
          ...graphWithoutHydration.nodes,
          { id: "program-hydration", kind: "program_hydration_contract", label: hydration.schema, metadata: hydrationSummary(hydration) }
        ],
        edges: [
          ...graphWithoutHydration.edges,
          { source: plan.sourceEmission.id, target: "program-hydration", relation: "hydrates_as", weight: hydration.valid ? 1 : 0.35 }
        ]
      };
    }
  };
}

function inferProgramShape(text: string, entailment: SemanticEntailmentResult, evidence: EvidenceSpan[], hasher: Hasher, codeGraph: CodeKnowledgeGraph, programIntent?: ProgramConstructIntent): ProgramShape {
  const requestFeatures = featureSet(text, 512);
  const evidenceFeatures = [...new Set(evidence.flatMap(span => span.features.slice(0, 80)))].slice(0, 240);
  const evidenceShape = evidenceSignals(evidence);
  const structural = structuralSignals(text, requestFeatures, evidenceShape, codeGraph, programIntent);
  const support = clamp01(0.6 * entailment.support + 0.25 * entailment.faithfulnessLcb + 0.15 * (1 - entailment.contradiction));
  const obligationFeatures = entailment.obligations
    .filter(item => item.status === "satisfied" || item.status === "underdetermined")
    .flatMap(item => [`obligation:${item.kind}`, `status:${item.status}`, ...featureSet(item.claimText, 64).slice(0, 12)]);
  const coupling = evidenceFeatures.length ? weightedJaccard([...requestFeatures, ...obligationFeatures], evidenceFeatures) : 0;
  const profiles = targetProfiles({ text, structural, support, coupling, evidenceCount: evidence.length, codeGraph, hasher, programIntent });
  const scored = profiles.map(target => {
    const energy = programEnergy({ target, structural, support, coupling, evidenceCount: evidence.length, entailment });
    return { target, energy, score: clamp01(1 - energy.total + targetSpecificity(target) * 0.06) };
  }).sort((a, b) => b.score - a.score);
  const selected = selectTargetProfile(scored, structural, programIntent);
  const requestedStructures = [
    ...structural.fileExtensions.map(ext => `extension:${ext}`),
    ...structural.delimiters.map(delimiter => `delimiter:${delimiter}`),
    ...structural.symbols.slice(0, 20).map(symbol => `symbol:${symbol}`),
    ...structural.fields.slice(0, 32).map(field => `field:${field}`)
  ];
  return {
    target: selected.target,
    confidence: clamp01(0.25 + 0.35 * selected.score + 0.2 * support + 0.2 * coupling),
    requiredInputs: selected.target.requiredInputs,
    requiredOutputs: selected.target.requiredOutputs,
    sideEffects: selected.target.sideEffects,
    persistence: selected.target.persistence,
    runtimeTarget: selected.target.runtimeTarget,
    operatorConstraints: [
      "relative paths only",
      "language/runtime must be source-backed or carried as an unresolved target profile",
      "explicit parse/validation failure objects",
      "no network access",
      "no external mutation during generation"
    ],
    requestedStructures,
    evidenceFeatures: evidenceFeatures.slice(0, 64),
    energy: selected.energy,
    reasons: [
      `selectedTarget=${selected.target.id}`,
      `selectedLabel=${selected.target.label}`,
      `requestHash=${hasher.digestHex(text).slice(0, 16)}`,
      `support=${support.toFixed(3)}`,
      `evidenceCoupling=${coupling.toFixed(3)}`,
      `energy=${selected.energy.total.toFixed(3)}`,
      ...scored.slice(1).map(item => `${item.target.id}:energy=${item.energy.total.toFixed(3)}`)
    ]
  };
}

function targetProfiles(input: {
  text: string;
  structural: ReturnType<typeof structuralSignals>;
  support: number;
  coupling: number;
  evidenceCount: number;
  codeGraph: CodeKnowledgeGraph;
  hasher: Hasher;
  programIntent?: ProgramConstructIntent;
}): ProgramTargetProfile[] {
  const sourceLanguages = input.codeGraph.languages.length
    ? input.codeGraph.languages
    : [{ language: "source.unresolved", weight: 0.12, evidenceIds: [] }];
  const primaryLanguage = sourceLanguages[0]?.language ?? "source.unresolved";
  const packageManagers = packageManagersFromGraph(input.codeGraph);
  const commandHints = commandHintsFromGraph(input.codeGraph);
  const dataLanguage = preferredLanguageForCapabilities(sourceLanguages, ["capability:validated-transform", "capability:structured-input"], input.codeGraph) ?? primaryLanguage;
  const browserLanguage = preferredLanguageForCapabilities(sourceLanguages, ["capability:browser-render", "capability:interactive-surface"], input.codeGraph) ?? primaryLanguage;
  const sourceProfiles = sourceLanguages.slice(0, 8).map(language => {
    const capabilities = capabilitiesForLanguageProfile(language.language, input.structural, input.codeGraph);
    const packageManager = packageManagers[0] ?? packageManagerForProfile(language.language, input.codeGraph);
    return profile({
      seed: { language, capabilities, text: input.text, support: input.support, coupling: input.coupling },
      language: language.language,
      label: labelForProfile(language.language, capabilities, input.codeGraph),
      capabilities,
      runtimeTarget: runtimeTargetFor(language.language, capabilities, packageManager),
      packageManager,
      entrypoint: entrypointForProfile(language.language, capabilities, input.codeGraph),
      persistence: capabilities.includes("capability:pure-call") ? "none" : "local_file",
      requiredInputs: profileInputs(capabilities, input.structural),
      requiredOutputs: profileOutputs(capabilities, input.structural),
      sideEffects: profileSideEffects(capabilities),
      packageHints: packageHintsFor(input.codeGraph, language.language, capabilities),
      evidence: toJsonValue({ language, repositoryShape: input.codeGraph.repositoryShape, commandHints, confidence: input.codeGraph.confidence }),
      hasher: input.hasher
    });
  });
  const constructProfile = input.programIntent ? [profileFromProgramIntent(input.programIntent, {
    sourceLanguages,
    primaryLanguage,
    packageManagers,
    commandHints,
    structural: input.structural,
    codeGraph: input.codeGraph,
    hasher: input.hasher
  })] : [];
  const requestProfiles = [
    profile({
      seed: { request: input.text, kind: "data-flow", fields: input.structural.fields, delimiters: input.structural.delimiters },
      language: dataLanguage,
      label: "source-derived data flow",
      capabilities: ["capability:structured-input", "capability:validated-transform", "capability:diagnostic-output"],
      runtimeTarget: runtimeTargetFor(dataLanguage, ["capability:validated-transform"], packageManagers[0] ?? packageManagerForProfile(dataLanguage, input.codeGraph)),
      packageManager: packageManagers[0] ?? packageManagerForProfile(dataLanguage, input.codeGraph),
      entrypoint: entrypointForProfile(dataLanguage, ["capability:validated-transform"], input.codeGraph),
      persistence: "local_file",
      requiredInputs: profileInputs(["capability:structured-input"], input.structural),
      requiredOutputs: profileOutputs(["capability:diagnostic-output"], input.structural),
      sideEffects: profileSideEffects(["capability:validated-transform"]),
      packageHints: packageHintsFor(input.codeGraph, dataLanguage, ["capability:validated-transform"]),
      evidence: toJsonValue({ requestStructures: input.structural.fields, delimiters: input.structural.delimiters, commandHints }),
      hasher: input.hasher
    }),
    profile({
      seed: { request: input.text, kind: "interactive-surface", webLike: input.structural.webLike },
      language: browserLanguage,
      label: "source-derived interactive surface",
      capabilities: ["capability:interactive-surface", "capability:browser-render", "capability:stateful-ui"],
      runtimeTarget: runtimeTargetFor(browserLanguage, ["capability:browser-render"], packageManagers[0] ?? packageManagerForProfile(browserLanguage, input.codeGraph)),
      packageManager: packageManagers[0] ?? packageManagerForProfile(browserLanguage, input.codeGraph),
      entrypoint: entrypointForProfile(browserLanguage, ["capability:browser-render"], input.codeGraph),
      persistence: "local_file",
      requiredInputs: profileInputs(["capability:interactive-surface", "capability:browser-render"], input.structural),
      requiredOutputs: profileOutputs(["capability:browser-render"], input.structural),
      sideEffects: profileSideEffects(["capability:browser-render"]),
      packageHints: packageHintsFor(input.codeGraph, browserLanguage, ["capability:browser-render"]),
      evidence: toJsonValue({ repositoryShape: input.codeGraph.repositoryShape, dependencies: input.codeGraph.dependencies.slice(0, 12), commandHints }),
      hasher: input.hasher
    })
  ];
  const profiles = dedupeProfiles([...constructProfile, ...sourceProfiles, ...requestProfiles]);
  return profiles.length ? profiles : [unresolvedProfile(input.hasher, input.text)];
}

function profileFromProgramIntent(intent: ProgramConstructIntent, input: {
  sourceLanguages: ReadonlyArray<{ language: string; weight: number }>;
  primaryLanguage: string;
  packageManagers: readonly string[];
  commandHints: readonly CommandHint[];
  structural: ReturnType<typeof structuralSignals>;
  codeGraph: CodeKnowledgeGraph;
  hasher: Hasher;
}): ProgramTargetProfile {
  const capabilities = [...new Set([
    "capability:source-learning",
    ...intent.capabilityIds,
    ...capabilitiesFromArtifactKinds(intent.artifactKindIds)
  ])].filter(Boolean);
  const language = intent.languageId
    ?? preferredLanguageForCapabilities(input.sourceLanguages, capabilities, input.codeGraph)
    ?? input.primaryLanguage;
  const packageManager = intent.packageManagerId
    ?? input.packageManagers[0]
    ?? packageManagerForProfile(language, input.codeGraph);
  const runtimeTarget = intent.runtimeTargetId ?? runtimeTargetFor(language, capabilities, packageManager);
  const entrypoint = intent.entrypointPath ?? entrypointForProfile(language, capabilities, input.codeGraph);
  return profile({
    seed: { programIntent: intent, language, capabilities, runtimeTarget, packageManager, entrypoint },
    language,
    label: "construct-derived program target",
    capabilities,
    runtimeTarget,
    packageManager,
    entrypoint,
    persistence: capabilities.includes("capability:pure-call") ? "none" : "local_file",
    requiredInputs: intent.inputMediaTypes?.length
      ? intent.inputMediaTypes.map((mediaType, index) => ({ id: `construct-input-${index + 1}`, mediaType, source: "construct", required: true }))
      : profileInputs(capabilities, input.structural),
    requiredOutputs: intent.outputMediaTypes?.length
      ? intent.outputMediaTypes.map((mediaType, index) => ({ id: `construct-output-${index + 1}`, mediaType, target: "construct", required: true }))
      : profileOutputs(capabilities, input.structural),
    sideEffects: profileSideEffects(capabilities),
    packageHints: packageHintsFor(input.codeGraph, language, capabilities),
    evidence: toJsonValue({
      constructIntent: true,
      artifactKindIds: intent.artifactKindIds,
      capabilityIds: intent.capabilityIds,
      provenanceEvidenceIds: intent.provenanceEvidenceIds ?? [],
      constructMetadata: intent.metadata ?? {},
      commandHints: input.commandHints
    }),
    hasher: input.hasher
  });
}

function capabilitiesFromArtifactKinds(artifactKindIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const kind of artifactKindIds) {
    if (kind.endsWith(".cli")) out.add("capability:command-runtime");
    if (kind.endsWith(".library")) out.add("capability:pure-call");
    if (kind.endsWith(".tabular_transformer")) {
      out.add("capability:structured-input");
      out.add("capability:validated-transform");
      out.add("capability:diagnostic-output");
    }
    if (kind.endsWith(".log_parser")) {
      out.add("capability:log-parse");
      out.add("capability:diagnostic-output");
    }
    if (kind.endsWith(".api_handler")) out.add("capability:interface-runtime");
    if (kind.endsWith(".interactive_surface")) {
      out.add("capability:interactive-surface");
      out.add("capability:browser-render");
      out.add("capability:stateful-ui");
    }
  }
  return [...out];
}

function profile(input: Omit<ProgramTargetProfile, "id"> & { seed: unknown; hasher: Hasher }): ProgramTargetProfile {
  const capabilities = [...new Set(input.capabilities.filter(Boolean))].sort();
  const id = `target_${input.hasher.digestHex(canonicalStringify({ seed: input.seed, language: input.language, capabilities, runtimeTarget: input.runtimeTarget, entrypoint: input.entrypoint })).slice(0, 40)}`;
  return {
    id,
    label: input.label,
    capabilities,
    runtimeTarget: input.runtimeTarget,
    packageManager: input.packageManager,
    language: input.language,
    entrypoint: input.entrypoint,
    persistence: input.persistence,
    requiredInputs: input.requiredInputs,
    requiredOutputs: input.requiredOutputs,
    sideEffects: input.sideEffects,
    packageHints: input.packageHints,
    evidence: input.evidence
  };
}

function unresolvedProfile(hasher: Hasher, text: string): ProgramTargetProfile {
  return profile({
    seed: { text, sourceDerived: true },
    language: "source.unresolved",
    label: "source-derived unresolved program target",
    capabilities: ["capability:source-learning", "capability:diagnostic-output"],
    runtimeTarget: "runtime.unresolved",
    packageManager: "source.unresolved",
    entrypoint: "src/source-program.txt",
    persistence: "local_file",
    requiredInputs: [{ id: "source-request", mediaType: "text/plain", source: "argument", required: true }],
    requiredOutputs: [{ id: "source-plan", mediaType: "application/json", target: "file", required: true }],
    sideEffects: [{ id: "emit-source-plan", kind: "write_file", risk: 0.08 }],
    packageHints: [],
    evidence: toJsonValue({ unresolved: true }),
    hasher
  });
}

function dedupeProfiles(profiles: readonly ProgramTargetProfile[]): ProgramTargetProfile[] {
  const byId = new Map<string, ProgramTargetProfile>();
  for (const target of profiles) if (!byId.has(target.id)) byId.set(target.id, target);
  return [...byId.values()];
}

function selectTargetProfile(
  scored: Array<{ target: ProgramTargetProfile; energy: ProgramEnergy; score: number }>,
  structural: ReturnType<typeof structuralSignals>,
  programIntent?: ProgramConstructIntent
): { target: ProgramTargetProfile; energy: ProgramEnergy; score: number } {
  if (programIntent) {
    const construct = scored.find(item => Boolean(jsonRecord(item.target.evidence).constructIntent));
    if (construct) return construct;
  }
  if (structural.webLike) {
    const web = scored.find(item => hasCapability(item.target, "capability:browser-render") || hasCapability(item.target, "capability:interactive-surface"));
    if (web) return web;
  }
  if (structural.logLike) {
    const parser = bestArtifactProfile(scored, item => hasCapability(item.target, "capability:log-parse"));
    if (parser) return parser;
  }
  if (structural.tableLike || structural.jsonLike) {
    const data = bestArtifactProfile(scored, item => hasCapability(item.target, "capability:validated-transform") || hasCapability(item.target, "capability:structured-input"));
    if (data) return data;
  }
  if (structural.commandLike) {
    const command = bestArtifactProfile(scored, item => hasCapability(item.target, "capability:command-runtime"));
    if (command) return command;
  }
  const first = scored[0];
  if (!first) throw new Error("program planner could not derive any target profile");
  return first;
}

function bestArtifactProfile(
  scored: Array<{ target: ProgramTargetProfile; energy: ProgramEnergy; score: number }>,
  predicate: (item: { target: ProgramTargetProfile; energy: ProgramEnergy; score: number }) => boolean
): { target: ProgramTargetProfile; energy: ProgramEnergy; score: number } | undefined {
  return scored
    .filter(predicate)
    .sort((a, b) => targetEmissionReadiness(b.target) - targetEmissionReadiness(a.target) || b.score - a.score || a.target.id.localeCompare(b.target.id))[0];
}

function targetEmissionReadiness(target: ProgramTargetProfile): number {
  const manager = packageManagerCommandName(target.packageManager);
  if (target.runtimeTarget === "runtime.browser") return 1;
  if (manager === "pnpm" || manager === "npm" || manager === "yarn" || manager === "bun") return 0.95;
  if (target.runtimeTarget === "runtime.node") return 0.9;
  if (target.packageManager && target.packageManager !== "source-derived" && target.packageManager !== "source.unresolved" && target.packageManager !== "source-script") return 0.55;
  if (target.runtimeTarget.startsWith("runtime.extension:")) return 0.35;
  return 0;
}

function targetSpecificity(target: ProgramTargetProfile): number {
  let score = 0;
  if (target.language && target.language !== "source.repository" && target.language !== "source.unresolved") score += 0.45;
  if (target.entrypoint && target.entrypoint !== "src/source-program.txt") score += 0.18;
  if (target.packageManager && target.packageManager !== "source-derived" && target.packageManager !== "source.unresolved") score += 0.12;
  score += Math.min(0.2, target.packageHints.length * 0.04);
  return clamp01(score);
}

function capabilitiesForLanguageProfile(language: string, structural: ReturnType<typeof structuralSignals>, codeGraph: CodeKnowledgeGraph): string[] {
  const caps = new Set<string>(["capability:source-learning", `capability:language:${language}`]);
  const files = filesForLanguage(codeGraph, language);
  const signals = signalsForLanguage(codeGraph, language);
  const hasCommandEvidence = structural.commandLike || signals.some(signal => signal.kind === "script.runtime" || signal.kind === "script.build" || signal.kind === "script.validation");
  const hasModuleEvidence = structural.moduleLike || files.some(file => file.role.includes("module") || file.role.includes("interface")) || signals.some(signal => signal.kind === "symbol" || signal.kind === "export");
  const hasPresentationEvidence = structural.webLike || codeGraph.repositoryShape.hasUiSurface || files.some(file => file.role.includes("presentation")) || signals.some(signal => signal.kind === "file-role" && signal.text.includes("presentation"));
  if (hasCommandEvidence) caps.add("capability:command-runtime");
  if (hasModuleEvidence) caps.add("capability:pure-call");
  if (structural.logLike) {
    caps.add("capability:log-parse");
    caps.add("capability:diagnostic-output");
  }
  if (structural.tableLike || structural.jsonLike) {
    caps.add("capability:structured-input");
    caps.add("capability:validated-transform");
    caps.add("capability:diagnostic-output");
  }
  if (structural.proseLike) caps.add("capability:prose-report");
  if (hasPresentationEvidence) {
    caps.add("capability:interactive-surface");
    caps.add("capability:browser-render");
    caps.add("capability:stateful-ui");
  }
  if (codeGraph.repositoryShape.hasApiSurface) caps.add("capability:interface-runtime");
  if (codeGraph.repositoryShape.hasTests) caps.add("capability:validation-runner");
  return [...caps];
}

function preferredLanguageForCapabilities(languages: ReadonlyArray<{ language: string; weight: number }>, capabilities: readonly string[], codeGraph: CodeKnowledgeGraph): string | undefined {
  const scored = languages.map(item => ({ ...item, score: item.weight + sourceCapabilityFit(item.language, capabilities, codeGraph) }));
  return scored.sort((a, b) => b.score - a.score)[0]?.language;
}

function sourceCapabilityFit(language: string, capabilities: readonly string[], codeGraph: CodeKnowledgeGraph): number {
  let score = 0;
  const files = filesForLanguage(codeGraph, language);
  const signals = signalsForLanguage(codeGraph, language);
  const runtimeLanguage = createEngineeringCorpusRuntime(codeGraph.engineeringCorpora)
    .rankLanguages({ capabilities, limit: 16 })
    .find(item => item.language === language);
  if (runtimeLanguage) score += runtimeLanguage.score;
  if (capabilities.includes("capability:browser-render") && (files.some(file => file.role.includes("presentation")) || signals.some(signal => signal.kind === "file-role" && signal.text.includes("presentation")))) score += 0.75;
  if (capabilities.includes("capability:validated-transform") && (signals.some(signal => signal.kind === "schema" || signal.kind === "code-symbol-shape" || signal.kind === "language-evidence") || files.some(file => file.role.includes("configuration")))) score += 0.42;
  if (capabilities.includes("capability:structured-input") && signals.some(signal => signal.kind === "code-symbol-shape" || signal.kind === "file-role")) score += 0.36;
  if (capabilities.includes("capability:command-runtime") && signals.some(signal => signal.kind === "script.runtime" || signal.kind === "script.build" || signal.kind === "script.validation")) score += 0.38;
  return score;
}

function labelForProfile(language: string, capabilities: readonly string[], codeGraph: CodeKnowledgeGraph): string {
  const strongest = codeGraph.idioms[0]?.label ?? codeGraph.signals[0]?.kind ?? "source";
  const languageLabel = language.startsWith("path-extension:") ? language.slice("path-extension:".length) : language;
  const capabilityLabel = capabilities
    .filter(item => !item.startsWith("capability:language:"))
    .slice(0, 3)
    .map(item => item.slice("capability:".length))
    .join("+");
  return `${languageLabel}:${capabilityLabel || strongest}`;
}

function runtimeTargetFor(language: string, capabilities: readonly string[], packageManager: string): string {
  if (capabilities.includes("capability:browser-render")) return "runtime.browser";
  if (packageManager && packageManager !== "source-derived" && packageManager !== "source.unresolved") return `runtime.package:${safeIdentifier(packageManager)}`;
  const ext = extensionFromLanguageEvidence(language);
  if (ext) return `runtime.extension:${safeIdentifier(ext.slice(1) || ext)}`;
  return capabilities.includes("capability:command-runtime") ? "runtime.source-command" : "runtime.source-derived";
}

function packageManagerForProfile(language: string, codeGraph: CodeKnowledgeGraph): string {
  const commandSignal = signalsForLanguage(codeGraph, language).find(signal => signal.kind === "script.build" || signal.kind === "script.validation" || signal.kind === "script.runtime");
  if (commandSignal) return "source-script";
  return "source-derived";
}

function entrypointForProfile(language: string, capabilities: readonly string[], codeGraph: CodeKnowledgeGraph): string {
  const corpusEntrypoint = corpusEntrypointForLanguage(codeGraph, language, capabilities);
  if (corpusEntrypoint) return corpusEntrypoint;
  const existing = codeGraph.repositoryShape.files
    .map(file => ({ file, score: entrypointScore(file.pathHint, file.role, capabilities) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.file.confidence - a.file.confidence)[0]?.file;
  if (existing) return existing.pathHint;
  const ext = extensionFromLanguageEvidence(language) || ".source";
  return `src/main${ext}`;
}

function entrypointScore(pathHint: string, role: string, capabilities: readonly string[]): number {
  const lower = pathHint.toLocaleLowerCase();
  if (capabilities.includes("capability:browser-render")) {
    if (lower.includes("main.")) return 1;
    if (lower.includes("index.")) return 0.92;
    if (lower.includes("app.")) return 0.72;
    if (lower.includes("page.")) return 0.62;
  }
  if (capabilities.includes("capability:command-runtime")) {
    if (lower.includes("main.")) return 1;
    if (lower.includes("cli.")) return 0.92;
    if (lower.includes("program.")) return 0.82;
  }
  if (role.includes("module")) return 0.42;
  if (role.includes("interface")) return 0.38;
  return 0;
}

function extensionFromLanguageEvidence(language: string): string | undefined {
  const normalized = language.toLocaleLowerCase();
  const extensionIndex = normalized.lastIndexOf("path-extension:");
  if (extensionIndex >= 0) {
    const value = language.slice(extensionIndex + "path-extension:".length).trim();
    if (value.startsWith(".")) return value;
  }
  const extensionPrefix = "extension:";
  if (normalized.startsWith(extensionPrefix)) {
    const value = language.slice(extensionPrefix.length).trim();
    if (value.startsWith(".")) return value;
  }
  return undefined;
}

function corpusEntrypointForLanguage(codeGraph: CodeKnowledgeGraph, language: string, capabilities: readonly string[]): string | undefined {
  return createEngineeringCorpusRuntime(codeGraph.engineeringCorpora)
    .rankEntrypoints({ language, capabilities, limit: 1 })[0]?.path;
}

function profileInputs(capabilities: readonly string[], structural: ReturnType<typeof structuralSignals>): ProgramShape["requiredInputs"] {
  if (capabilities.includes("capability:browser-render")) return [{ id: "browser-interaction", mediaType: "application/json", source: "argument", required: false }];
  if (capabilities.includes("capability:structured-input")) return [{ id: structural.tableLike ? "tabular-file" : "structured-file", mediaType: structural.tableLike ? "text/csv" : "application/json", source: "file", required: true }];
  if (capabilities.includes("capability:pure-call")) return [{ id: "library-call", mediaType: "application/json", source: "library_call", required: true }];
  return [{ id: "argument-or-stdin", mediaType: "text/plain", source: "argument", required: false }];
}

function profileOutputs(capabilities: readonly string[], structural: ReturnType<typeof structuralSignals>): ProgramShape["requiredOutputs"] {
  if (capabilities.includes("capability:browser-render")) return [{ id: "interactive-surface", mediaType: "text/html", target: "file", required: true }];
  if (capabilities.includes("capability:validated-transform")) return [{ id: structural.tableLike ? "tabular-summary" : "transformed-structure", mediaType: "application/json", target: "stdout", required: true }];
  if (capabilities.includes("capability:prose-report")) return [{ id: "report", mediaType: "text/markdown", target: "stdout", required: true }];
  if (capabilities.includes("capability:pure-call")) return [{ id: "return-value", mediaType: "application/json", target: "return_value", required: true }];
  return [{ id: "command-result", mediaType: "application/json", target: "stdout", required: true }];
}

function profileSideEffects(capabilities: readonly string[]): ProgramShape["sideEffects"] {
  if (capabilities.includes("capability:browser-render")) return [{ id: "render-browser-ui", kind: "write_file", risk: 0.12 }];
  if (capabilities.includes("capability:validated-transform")) return [{ id: "read-input", kind: "read_file", risk: 0.08 }, { id: "emit-output", kind: "stdout", risk: 0.03 }];
  if (capabilities.includes("capability:prose-report")) return [{ id: "read-input", kind: "read_file", risk: 0.08 }, { id: "emit-report", kind: "stdout", risk: 0.03 }];
  if (capabilities.includes("capability:pure-call")) return [{ id: "pure-module", kind: "none", risk: 0 }];
  return [{ id: "emit-output", kind: "stdout", risk: 0.03 }];
}

function packageHintsFor(codeGraph: CodeKnowledgeGraph, language: string, capabilities: readonly string[]): ProgramTargetProfile["packageHints"] {
  const normalizedLanguage = language.toLocaleLowerCase();
  const selected = codeGraph.dependencies
    .filter(dep => dep.language === language || dep.language.toLocaleLowerCase() === normalizedLanguage || capabilityNeedsDependency(capabilities, dep.packageName))
    .slice(0, 24);
  return selected.map(dep => ({
    name: dep.packageName,
    role: dep.purpose,
    evidence: dep.importedBy.map(String)
  }));
}

function filesForLanguage(codeGraph: CodeKnowledgeGraph, language: string): CodeKnowledgeGraph["repositoryShape"]["files"] {
  return codeGraph.repositoryShape.files.filter(file => file.language === language);
}

function signalsForLanguage(codeGraph: CodeKnowledgeGraph, language: string): CodeKnowledgeGraph["signals"] {
  return codeGraph.signals.filter(signal => signal.language === language);
}

function commandHintsFromGraph(codeGraph: CodeKnowledgeGraph): CommandHint[] {
  const hints: CommandHint[] = [];
  for (const signal of codeGraph.signals) {
    if (!signal.kind.startsWith("script")) continue;
    const meta = jsonRecord(signal.metadata);
    const script = jsonRecord(meta.script);
    const command = typeof script.command === "string" ? script.command : undefined;
    const packageName = typeof meta.package === "string" ? meta.package : undefined;
    hints.push({
      kind: signal.kind,
      name: signal.text,
      command,
      packageName,
      confidence: signal.confidence
    });
  }
  for (const corpus of codeGraph.engineeringCorpora) {
    for (const command of [
      ...corpus.plannerHints.buildCommands,
      ...corpus.plannerHints.validationCommands,
      ...corpus.plannerHints.runtimeCommands,
      ...corpus.plannerHints.lintCommands
    ]) {
      hints.push({
        kind: plannerScriptKind(command.kind),
        name: command.scriptName,
        command: command.command,
        packageName: command.packageName,
        confidence: command.confidence
      });
    }
  }
  return hints.sort((a, b) => commandKindRank(a.kind) - commandKindRank(b.kind) || b.confidence - a.confidence || a.name.localeCompare(b.name)).slice(0, 24);
}

function commandHintsFromTarget(target: ProgramTargetProfile): CommandHint[] {
  const record = jsonRecord(target.evidence);
  const raw = record.commandHints;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const hint = jsonRecord(item);
    const kind = typeof hint.kind === "string" ? hint.kind : "";
    const name = typeof hint.name === "string" ? hint.name : "";
    if (!kind || !name) return [];
    return [{
      kind,
      name,
      command: typeof hint.command === "string" ? hint.command : undefined,
      packageName: typeof hint.packageName === "string" ? hint.packageName : undefined,
      confidence: typeof hint.confidence === "number" ? clamp01(hint.confidence) : 0.5
    }];
  });
}

function commandKindRank(kind: string): number {
  if (kind === "script.build") return 1;
  if (kind === "script.validation") return 2;
  if (kind === "script.runtime") return 3;
  if (kind === "script.lint") return 4;
  return 10;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function capabilityNeedsDependency(capabilities: readonly string[], packageName: string): boolean {
  void capabilities;
  return packageName.trim().length > 0;
}

function packageManagersFromGraph(codeGraph: CodeKnowledgeGraph): string[] {
  const runtimeManagers = createEngineeringCorpusRuntime(codeGraph.engineeringCorpora).packageManagers();
  const fromSignals = codeGraph.signals
    .filter(signal => signal.kind === "package-manager")
    .map(signal => packageManagerCommandName(signal.text))
    .filter(Boolean);
  return [...new Set([...runtimeManagers, ...fromSignals])];
}

function profileFitScore(target: ProgramTargetProfile, structural: ReturnType<typeof structuralSignals>): number {
  const fits = [
    hasCapability(target, "capability:browser-render") ? scoreBool(structural.webLike) : undefined,
    hasCapability(target, "capability:structured-input") ? scoreBool(structural.tableLike || structural.jsonLike) : undefined,
    hasCapability(target, "capability:validated-transform") ? scoreBool(structural.tableLike || structural.jsonLike) : undefined,
    hasCapability(target, "capability:log-parse") ? scoreBool(structural.logLike) : undefined,
    hasCapability(target, "capability:pure-call") ? scoreBool(structural.moduleLike && !structural.commandLike) : undefined,
    hasCapability(target, "capability:command-runtime") ? scoreBool(structural.commandLike || structural.fileExtensions.length > 0) : undefined,
    hasCapability(target, "capability:prose-report") ? scoreBool(structural.proseLike) : undefined
  ].filter((value): value is number => typeof value === "number");
  return fits.length ? mean(fits) : 0.35;
}

function structuralSignals(text: string, features: readonly string[], evidence: EvidenceShapeSignals, codeGraph: CodeKnowledgeGraph, programIntent?: ProgramConstructIntent) {
  const fileExtensions = [...new Set(extractFileExtensions(text).map(item => item.toLowerCase()))];
  const firstLine = splitLinesNoRegex(text).find(line => line.trim().length > 0) ?? "";
  const requestDelimiter = delimiterFor(firstLine);
  const delimiters = [...new Set([...(requestDelimiter ? [requestDelimiter] : []), ...evidence.delimiters])].slice(0, 8);
  const symbols = [...new Set([...extractSymbols(text, 120), ...evidence.symbols])];
  const fields = [...new Set([...evidence.fields, ...symbols.map(symbolRoot).filter(Boolean)])].slice(0, 64);
  const jsonLike = looksJsonLike(text) || evidence.jsonLike;
  const featureSetView = new Set(features);
  const intentCapabilities = new Set([...(programIntent?.capabilityIds ?? []), ...capabilitiesFromArtifactKinds(programIntent?.artifactKindIds ?? [])]);
  const tableLike = evidence.tableLike || intentCapabilities.has("capability:validated-transform") || Boolean(requestDelimiter) || fileExtensions.includes(".csv") || fileExtensions.includes(".tsv") || featureSetView.has("sym:csv") || featureSetView.has("sym:tsv");
  const moduleLike = evidence.moduleLike || symbols.length > 0 || fileExtensions.some(ext => ext.length > 1);
  const commandLike = intentCapabilities.has("capability:command-runtime") || looksCommandLike(text);
  const logLike = evidence.logLike || intentCapabilities.has("capability:log-parse") || fileExtensions.includes(".log") || looksLogLike(text);
  const proseLike = evidence.proseLike || features.filter(feature => feature.startsWith("sym:")).length > 18 && !tableLike && !jsonLike;
  const webLike = codeGraph.repositoryShape.hasUiSurface;
  return { fileExtensions, delimiters, symbols, fields, jsonLike, tableLike, moduleLike, commandLike, logLike, proseLike, webLike };
}

interface EvidenceShapeSignals {
  fields: string[];
  symbols: string[];
  delimiters: string[];
  tableLike: boolean;
  jsonLike: boolean;
  moduleLike: boolean;
  logLike: boolean;
  proseLike: boolean;
}

function evidenceSignals(evidence: readonly EvidenceSpan[]): EvidenceShapeSignals {
  const fields: string[] = [];
  const symbols: string[] = [];
  const delimiters: string[] = [];
  let tableLike = false;
  let jsonLike = false;
  let moduleLike = false;
  let logLike = false;
  let proseLike = false;
  for (const span of evidence.slice(0, 24)) {
    const text = span.text || span.textPreview;
    const firstLine = splitLinesNoRegex(text).find(line => line.trim().length > 0) ?? "";
    const delimiter = delimiterFor(firstLine);
    if (delimiter) {
      delimiters.push(delimiter);
      tableLike = true;
      fields.push(...firstLine.split(delimiter).map(normalizeField).filter(Boolean));
    }
    const jsonFields = looksJsonLike(text) ? extractJsonLikeFields(text) : [];
    if (jsonFields.length) jsonLike = true;
    fields.push(...jsonFields);
    const foundSymbols = extractSymbols(text, 120);
    symbols.push(...foundSymbols);
    moduleLike ||= extractFileExtensions(text).some(ext => ext.length > 1) || foundSymbols.length > 0;
    logLike ||= span.mediaType.includes("log") || looksLogLike(text);
    proseLike ||= featureSet(text, 96).filter(feature => feature.startsWith("sym:")).length > 24 && !tableLike && !jsonLike;
  }
  return {
    fields: [...new Set(fields)].slice(0, 80),
    symbols: [...new Set(symbols)].slice(0, 80),
    delimiters: [...new Set(delimiters)].slice(0, 8),
    tableLike,
    jsonLike,
    moduleLike,
    logLike,
    proseLike
  };
}

function delimiterFor(line: string): string | undefined {
  const candidates = [",", "\t", "|", ";"];
  const scored = candidates.map(delimiter => ({ delimiter, count: line.split(delimiter).length - 1 })).sort((a, b) => b.count - a.count);
  return scored[0] && scored[0].count >= 2 ? scored[0].delimiter : undefined;
}

function splitLinesNoRegex(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const end = i > start && text[i - 1] === "\r" ? i - 1 : i;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

function extractDelimiters(text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) if (ch === "," || ch === ";" || ch === "\t" || ch === "|") out.add(ch);
  return [...out];
}

function extractFileExtensions(text: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ".") continue;
    let j = i + 1;
    let value = ".";
    while (j < text.length && value.length <= 9 && isIdentifierLike(text[j] ?? "")) {
      value += text[j];
      j++;
    }
    if (value.length > 1 && value.length <= 9) out.add(value);
  }
  return [...out];
}

function extractSymbols(text: string, limit: number): string[] {
  const out = new Set<string>();
  let i = 0;
  while (i < text.length && out.size < limit) {
    const head = readIdentifier(text, i);
    if (!head) {
      i++;
      continue;
    }
    let cursor = head.end;
    let symbol = head.value;
    let dotted = false;
    while (text[cursor] === ".") {
      const next = readIdentifier(text, cursor + 1);
      if (!next) break;
      symbol += `.${next.value}`;
      cursor = next.end;
      dotted = true;
    }
    const after = skipSpaces(text, cursor);
    if (dotted || text[after] === "(") out.add(text[after] === "(" && !dotted ? `${symbol}()` : symbol);
    i = Math.max(cursor, head.end);
  }
  return [...out];
}

function extractJsonLikeFields(text: string): string[] {
  const fields = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\"" || ch === "'") {
      const read = readQuoted(text, i);
      if (read && text[skipSpaces(text, read.end)] === ":" && read.value) fields.add(read.value);
      if (read) i = read.end;
      continue;
    }
    const symbol = readIdentifier(text, i);
    if (symbol && text[skipSpaces(text, symbol.end)] === ":") {
      fields.add(symbol.value);
      i = symbol.end;
    }
  }
  return [...fields].slice(0, 80);
}

function looksJsonLike(text: string): boolean {
  return extractJsonLikeFields(text).length > 0 && (text.includes("{") || text.includes("["));
}

function looksCommandLike(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("#!")) return true;
  const lower = text.toLocaleLowerCase();
  if (wordAppears(lower, "stdin") || wordAppears(lower, "stdout")) return true;
  for (let i = 0; i < text.length - 2; i++) {
    if (text[i] === "-" && text[i + 1] === "-" && isIdentifierLike(text[i + 2] ?? "")) return true;
  }
  return false;
}

function looksLogLike(text: string): boolean {
  const lines = splitLinesNoRegex(text).filter(line => line.trim().length > 0).slice(0, 48);
  if (lines.length < 2) return false;
  let scored = 0;
  for (const line of lines) {
    const lower = line.toLocaleLowerCase();
    if (line.includes("T") && line.includes(":") && (line.includes("Z") || line.includes("+"))) scored += 0.25;
    if (line.includes("[") && line.includes("]")) scored += 0.18;
    if (wordAppears(lower, "error") || wordAppears(lower, "warn") || wordAppears(lower, "info") || wordAppears(lower, "debug")) scored += 0.28;
    if (line.includes("=") && (wordAppears(lower, "level") || wordAppears(lower, "status") || wordAppears(lower, "component"))) scored += 0.22;
  }
  return scored / Math.max(1, lines.length) > 0.24;
}

function readIdentifier(text: string, start: number): { value: string; end: number } | undefined {
  const first = text[start] ?? "";
  if (!isIdentifierStart(first)) return undefined;
  let end = start + 1;
  while (end < text.length && isIdentifierLike(text[end] ?? "")) end++;
  return { value: text.slice(start, end), end };
}

function readQuoted(text: string, start: number): { value: string; end: number } | undefined {
  const quote = text[start];
  if (quote !== "\"" && quote !== "'") return undefined;
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch === "\\" && i + 1 < text.length) {
      value += text[i + 1];
      i++;
    } else {
      value += ch;
    }
  }
  return undefined;
}

function skipSpaces(text: string, start: number): number {
  let i = start;
  while (i < text.length && (text[i] ?? "").trim() === "") i++;
  return i;
}

function symbolRoot(symbol: string): string {
  const dot = symbol.indexOf(".");
  const paren = symbol.indexOf("(");
  const candidates = [dot, paren].filter(index => index >= 0);
  const end = candidates.length ? Math.min(...candidates) : symbol.length;
  return symbol.slice(0, end);
}

function wordAppears(text: string, word: string): boolean {
  let index = text.indexOf(word);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1] ?? "";
    const after = text[index + word.length] ?? "";
    if (!isIdentifierLike(before) && !isIdentifierLike(after)) return true;
    index = text.indexOf(word, index + 1);
  }
  return false;
}

function programEnergy(input: {
  target: ProgramTargetProfile;
  structural: ReturnType<typeof structuralSignals>;
  support: number;
  coupling: number;
  evidenceCount: number;
  entailment: SemanticEntailmentResult;
}): ProgramEnergy {
  const profileFit = profileFitScore(input.target, input.structural);
  const missingRequirementCost = clamp01(0.72 - profileFit * 0.48 - input.coupling * 0.12 - input.support * 0.12);
  const idiomMismatch = clamp01((1 - profileFit) * 0.58 + input.entailment.contradiction * 0.24);
  const dependencyUncertainty = clamp01(0.18 + (input.evidenceCount ? 0 : 0.28) + (1 - input.coupling) * 0.22);
  const buildRisk = clamp01(0.16 + input.entailment.contradiction * 0.22 + (hasCapability(input.target, "capability:pure-call") ? 0.04 : 0.08));
  const testGap = clamp01(0.35 - input.support * 0.16 + (input.evidenceCount < 2 ? 0.18 : 0));
  const complexity = clamp01(0.22 + input.structural.symbols.length / 80 + input.structural.fileExtensions.length / 24);
  const securityRisk = hasAnyCapability(input.target, ["capability:command-runtime", "capability:validated-transform", "capability:structured-input"]) ? 0.18 : 0.08;
  const exampleSupport = clamp01(0.3 * input.support + 0.45 * input.coupling + 0.25 * Math.min(1, input.evidenceCount / 8));
  const ownerUtility = profileFit;
  const validationPotential = hasCapability(input.target, "capability:pure-call") ? 0.72 : hasCapability(input.target, "capability:validated-transform") ? 0.82 : 0.68;
  const total = clamp01(
    0.16 * missingRequirementCost +
    0.13 * idiomMismatch +
    0.1 * dependencyUncertainty +
    0.11 * buildRisk +
    0.08 * testGap +
    0.08 * complexity +
    0.08 * securityRisk -
    0.1 * exampleSupport -
    0.08 * ownerUtility -
    0.08 * validationPotential +
    0.42
  );
  return { missingRequirementCost, idiomMismatch, dependencyUncertainty, buildRisk, testGap, complexity, securityRisk, exampleSupport, ownerUtility, validationPotential, total };
}

function intentFromShape(shape: ProgramShape): ProgramIntent {
  return {
    kind: shape.target.id,
    confidence: shape.confidence,
    reasons: shape.reasons,
    requestedOutputs: shape.requiredOutputs.map(item => item.id),
    constraints: shape.operatorConstraints,
    evidenceFeatures: shape.evidenceFeatures,
    shape
  };
}

function sourceEmissionPlan(input: {
  planId: string;
  shape: ProgramShape;
  codeGraph: CodeKnowledgeGraph;
  blueprint: CodeImplementationBlueprint;
  files: ProgramFilePlan[];
  build: { command: string; args: string[]; cwd: string };
  test: { command: string; args: string[]; cwd: string };
  evidenceIds: string[];
  hasher: Hasher;
}): SourceEmissionPlan {
  const artifactKinds = artifactKindsForShape(input.shape);
  const staticChecks = [
    "check.relative_paths",
    "check.entrypoint_declared",
    "check.emitted_files_listed",
    "check.imports_have_dependency_records",
    "check.validation_plan_explicit"
  ];
  const risks: SourceEmissionPlan["risks"] = [];
  if (input.shape.energy.dependencyUncertainty > 0.5) risks.push({ id: "risk.dependency_uncertainty", severity: "warning", reason: "dependency support is weak in the engineering corpus" });
  if (input.shape.energy.testGap > 0.48) risks.push({ id: "risk.validation_gap", severity: "warning", reason: "test command or validation evidence is incomplete" });
  if (input.blueprint.unbackedSynthesisRisk > 0.64) risks.push({ id: "risk.unbacked_synthesis", severity: "error", reason: "blueprint source coupling is below emission threshold" });
  if (input.build.command === "source-derived") risks.push({ id: "risk.build_command_unobserved", severity: "info", reason: "build command is a source-level placeholder because no package script was observed" });
  if (input.test.command === "source-derived") risks.push({ id: "risk.test_command_unobserved", severity: "info", reason: "test command is a source-level placeholder because no validation script was observed" });
  const missingDependencies = missingDependenciesForPlan(input.shape, input.files, input.codeGraph);
  const id = `source_emit_${input.hasher.digestHex(canonicalStringify({
    planId: input.planId,
    artifactKinds,
    files: input.files.map(file => file.path),
    build: input.build,
    test: input.test,
    evidenceIds: input.evidenceIds.slice(0, 24)
  })).slice(0, 40)}`;
  return {
    id,
    artifactKinds,
    expectedFiles: input.files.map(file => file.path),
    entrypoint: entrypointFor(input.shape),
    validation: [
      { id: "validation.build", command: input.build.command, args: input.build.args, cwd: input.build.cwd, expects: ["program.graph.json", entrypointFor(input.shape)], commandSource: commandSourceId(input.build) },
      { id: "validation.test", command: input.test.command, args: input.test.args, cwd: input.test.cwd, expects: input.files.filter(file => file.role === "test").map(file => file.path), commandSource: commandSourceId(input.test) }
    ],
    staticChecks,
    risks,
    missingDependencies,
    provenanceEvidenceIds: input.evidenceIds.slice(0, 64)
  };
}

function commandSourceId(command: { command: string }): string {
  return command.command === "source-derived" ? "program.validation.command.source_derived" : "program.validation.command.observed";
}

function artifactKindsForShape(shape: ProgramShape): string[] {
  const out = new Set<string>();
  if (hasCapability(shape.target, "capability:command-runtime")) out.add("artifact.cli");
  if (hasCapability(shape.target, "capability:pure-call")) out.add("artifact.library");
  if (hasCapability(shape.target, "capability:validated-transform")) out.add("artifact.tabular_transformer");
  if (hasCapability(shape.target, "capability:log-parse")) out.add("artifact.log_parser");
  if (hasCapability(shape.target, "capability:interface-runtime")) out.add("artifact.api_handler");
  if (hasCapability(shape.target, "capability:browser-render")) out.add("artifact.interactive_surface");
  out.add("artifact.validation_source");
  return [...out];
}

function missingDependenciesForPlan(shape: ProgramShape, files: readonly ProgramFilePlan[], codeGraph: CodeKnowledgeGraph): string[] {
  const observed = new Set(codeGraph.dependencies.map(dep => dep.packageName));
  for (const hint of shape.target.packageHints) observed.add(hint.name);
  const required = new Set<string>();
  if (files.some(file => file.path.endsWith(".tsx"))) {
    required.add("react");
    required.add("react-dom");
  }
  if (files.some(file => file.path === "vite.config.ts")) {
    required.add("vite");
    required.add("@vitejs/plugin-react");
  }
  return [...required].filter(dep => !observed.has(dep)).sort();
}

function planFiles(shape: ProgramShape): ProgramFilePlan[] {
  const common: ProgramFilePlan[] = [
    { path: "program.graph.json", role: "config", mediaType: "application/json", purpose: "program graph manifest", dependsOn: [], invariants: ["json parseable", "program shape present", "evidence refs explicit"] },
    { path: "implementation.plan.json", role: "config", mediaType: "application/json", purpose: "implementation plan with energy terms", dependsOn: ["program.graph.json"], invariants: ["operator constraints explicit", "validation path explicit", "relative paths only"] },
    { path: "source.memory.json", role: "config", mediaType: "application/json", purpose: "learned source memory contract", dependsOn: ["program.graph.json"], invariants: ["source versions explicit", "obligations explicit", "code signals explicit", "operations evidence-backed"] },
    { path: "README.md", role: "doc", mediaType: "text/markdown", purpose: "operator notes", dependsOn: ["program.graph.json"], invariants: ["states limits", "states validation command"] }
  ];
  const nodeRuntime = nodeRuntimeForShape(shape);
  const apiFiles: ProgramFilePlan[] = nodeRuntime && hasCapability(shape.target, "capability:interface-runtime") ? [
    { path: "src/api-handler.ts", role: "source", mediaType: "text/typescript", purpose: "source-backed HTTP/API handler", dependsOn: ["source.memory.json"], invariants: ["pure request handler", "no implicit server start", "returns explicit diagnostics"] }
  ] : [];
  const validationFramework = observedValidationFramework(shape.target);
  const behaviorRegression = hasCapability(shape.target, "capability:pure-call") && validationFramework !== undefined;
  const testFiles: ProgramFilePlan[] = nodeRuntime ? [
    behaviorRegression
      ? {
        path: "test/generated-artifact.test.ts",
        role: "test",
        mediaType: "text/typescript",
        purpose: "source-backed library behavior regression",
        dependsOn: ["src/domain.ts"],
        invariants: ["uses observed validation framework", "imports emitted implementation", "asserts structured result behavior"]
      }
      : { path: "test/generated-artifact.test.ts", role: "test", mediaType: "text/typescript", purpose: "source-level artifact self-check", dependsOn: ["program.graph.json"], invariants: ["standard source only", "no external test runner import", "checks emitted metadata"] }
  ] : [];
  const nodeCommon: ProgramFilePlan[] = nodeRuntime ? [
    { path: "package.json", role: "config", mediaType: "application/json", purpose: "source-derived package metadata", dependsOn: ["program.graph.json"], invariants: ["script commands match graph", "dependencies source-hinted"] },
    { path: "tsconfig.json", role: "config", mediaType: "application/json", purpose: "typescript validation configuration when applicable", dependsOn: ["package.json"], invariants: ["strict checking", "no emit"] }
  ] : [];
  if (hasCapability(shape.target, "capability:browser-render")) return [
    ...common,
    ...nodeCommon,
    { path: "index.html", role: "source", mediaType: "text/html", purpose: "Vite HTML entry", dependsOn: ["src/main.tsx"], invariants: ["single root element", "module script", "no remote scripts"] },
    { path: "vite.config.ts", role: "config", mediaType: "text/typescript", purpose: "Vite React configuration", dependsOn: ["package.json"], invariants: ["react plugin declared", "no network proxy by default"] },
    { path: "src/main.tsx", role: "source", mediaType: "text/typescript-jsx", purpose: "React root bootstrap", dependsOn: ["src/App.tsx"], invariants: ["StrictMode", "createRoot", "CSS imported"] },
    { path: "src/App.tsx", role: "source", mediaType: "text/typescript-jsx", purpose: "interactive application shell", dependsOn: ["source.memory.json"], invariants: ["stateful controls", "request-derived model", "no canned domain claims"] },
    { path: "src/styles.css", role: "source", mediaType: "text/css", purpose: "responsive workbench styling", dependsOn: ["src/App.tsx"], invariants: ["mobile layout", "accessible contrast", "no external assets"] },
    ...apiFiles,
    ...testFiles
  ];
  if (hasCapability(shape.target, "capability:log-parse") && nodeRuntime) return [
    ...common,
    ...nodeCommon,
    { path: "src/log-parser.ts", role: "source", mediaType: "text/typescript", purpose: "diagnostic log parser", dependsOn: ["source.memory.json"], invariants: ["line streaming", "diagnostics explicit", "no global process mutation"] },
    ...apiFiles,
    ...testFiles
  ];
  if (hasCapability(shape.target, "capability:validated-transform") && nodeRuntime) return [
    ...common,
    ...nodeCommon,
    { path: "src/transform.ts", role: "source", mediaType: "text/typescript", purpose: "data transformer", dependsOn: ["program.graph.json"], invariants: ["parse errors explicit", "streamable input path", "deterministic output"] },
    { path: "schema.mapping.json", role: "config", mediaType: "application/json", purpose: "input-output mapping", dependsOn: ["program.graph.json"], invariants: ["fields declared", "missing value policy explicit"] },
    ...apiFiles,
    ...testFiles
  ];
  if (hasCapability(shape.target, "capability:command-runtime") && nodeRuntime) return [
    ...common,
    ...nodeCommon,
    { path: "src/cli.ts", role: "source", mediaType: "text/typescript", purpose: "command entrypoint", dependsOn: ["program.graph.json"], invariants: ["stdin supported", "exit code explicit", "json output"] },
    { path: "src/command.ts", role: "source", mediaType: "text/typescript", purpose: "command operation", dependsOn: ["src/cli.ts"], invariants: ["pure operation core", "argument validation", "bounded diagnostics"] },
    ...apiFiles,
    ...testFiles
  ];
  if (hasCapability(shape.target, "capability:pure-call") && nodeRuntime) return [
    ...common,
    ...nodeCommon,
    { path: "src/index.ts", role: "source", mediaType: "text/typescript", purpose: "library entrypoint", dependsOn: ["program.graph.json"], invariants: ["pure functions", "exports typed result", "no process exit"] },
    { path: "src/domain.ts", role: "source", mediaType: "text/typescript", purpose: "domain model and operations", dependsOn: ["src/index.ts"], invariants: ["no network", "input validation", "stable errors"] },
    ...apiFiles,
    ...testFiles
  ];
  if (hasCapability(shape.target, "capability:prose-report") && nodeRuntime) return [
    ...common,
    ...nodeCommon,
    { path: "src/report.ts", role: "source", mediaType: "text/typescript", purpose: "markdown report renderer", dependsOn: ["program.graph.json"], invariants: ["escapes pipe cells", "handles missing fields", "deterministic ordering"] },
    { path: "report.template.md", role: "doc", mediaType: "text/markdown", purpose: "report section template", dependsOn: ["program.graph.json"], invariants: ["no canned domain claims", "data fields drive output"] },
    ...apiFiles,
    ...testFiles
  ];
  if (!nodeRuntime) return [
    ...common,
    { path: "source.program.json", role: "config", mediaType: "application/json", purpose: "source-derived language target and idiom memory", dependsOn: ["source.memory.json"], invariants: ["language open", "runtime explicit", "source evidence retained"] },
    { path: emittedRuntimeForShape(shape).sourcePath, role: "source", mediaType: emittedRuntimeForShape(shape).mediaType, purpose: "request-declared call contracts over the planned operation", dependsOn: ["source.program.json"], invariants: ["standard library only", "declared contracts checked", "no network access"] },
    { path: emittedRuntimeForShape(shape).testPath, role: "test", mediaType: emittedRuntimeForShape(shape).mediaType, purpose: "executable check of the emitted program", dependsOn: [emittedRuntimeForShape(shape).sourcePath], invariants: ["imports the emitted program", "asserts declared contracts", "exits nonzero on failure"] },
    { path: "BUILDING.md", role: "doc", mediaType: "text/markdown", purpose: "runtime-specific build notes", dependsOn: ["source.program.json"], invariants: ["does not claim unrun build", "lists learned commands"] }
  ];
  return [
    ...common,
    ...nodeCommon,
    { path: "src/cli.ts", role: "source", mediaType: "text/typescript", purpose: "command entrypoint", dependsOn: ["program.graph.json"], invariants: ["stdin supported", "exit code explicit", "json output"] },
    { path: "src/command.ts", role: "source", mediaType: "text/typescript", purpose: "command operation", dependsOn: ["src/cli.ts"], invariants: ["pure operation core", "argument validation", "bounded diagnostics"] },
    ...apiFiles,
    ...testFiles
  ];
}

function emitFiles(plan: ProgramPlan, input: ProgramPlannerInput, idFactory: IdFactory, hasher: Hasher): FileArtifact[] {
  const manifest = programGraphManifest(plan, input);
  const sourceMemory = sourceMemoryFor(input, plan);
  const emittedRuntime = emittedRuntimeForShape(plan.intent.shape);
  const byPath = new Map<string, string>();
  byPath.set("program.graph.json", `${JSON.stringify(manifest, null, 2)}\n`);
  byPath.set("implementation.plan.json", `${JSON.stringify(implementationPlan(plan, input), null, 2)}\n`);
  byPath.set("source.memory.json", `${JSON.stringify(sourceMemory, null, 2)}\n`);
  byPath.set("package.json", packageJson(plan));
  byPath.set("tsconfig.json", tsconfigJson(plan));
  byPath.set("README.md", readme(plan, input));
  byPath.set("index.html", webIndexHtml(plan));
  byPath.set("vite.config.ts", viteConfig(plan));
  byPath.set("src/main.tsx", webMainTsx());
  byPath.set("src/App.tsx", webAppTsx(plan, input, sourceMemory));
  byPath.set("src/styles.css", webStylesCss());
  byPath.set("src/index.ts", libraryIndex(sourceMemory));
  byPath.set("src/domain.ts", libraryDomain(plan, sourceMemory));
  byPath.set("src/transform.ts", transformerModule(plan, sourceMemory));
  byPath.set("src/log-parser.ts", logParserModule(plan, sourceMemory));
  byPath.set("src/api-handler.ts", apiHandlerModule(plan, sourceMemory));
  byPath.set("test/generated-artifact.test.ts", generatedArtifactTest(plan));
  byPath.set("schema.mapping.json", `${JSON.stringify(schemaMapping(plan), null, 2)}\n`);
  byPath.set("src/report.ts", reportModule(plan, sourceMemory));
  byPath.set("report.template.md", reportTemplate(plan));
  byPath.set("src/cli.ts", cliModule(plan, sourceMemory));
  byPath.set("src/command.ts", commandModule(plan, sourceMemory));
  if (plan.files.some(file => file.path === "source.program.json")) {
    // Owner behavior has already passed the requirement boundary by this point.  Its
    // executable contract must therefore come from that graph-native authority, not
    // from a second parse of the request surface.  Older callers without behavior
    // requirements retain the punctuation-bound declaration fallback below.
    const contracts = plan.ownerBehaviorRequirements.length
      ? declaredCallContractsFromRequirements(plan.ownerBehaviorRequirements)
      : declaredCallContracts(input.requestText);
    const statefulContracts = declaredStatefulCallContractsFromRequirements(plan.ownerStatefulBehaviorRequirements);
    byPath.set("source.program.json", `${JSON.stringify(sourceProgramContract(plan, input), null, 2)}\n`);
    if (emittedRuntime.languageId === "python") {
      byPath.set(emittedRuntime.sourcePath, executablePythonProgramModule(plan, contracts, statefulContracts));
      byPath.set(emittedRuntime.testPath, executablePythonProgramTest(plan));
    } else {
      byPath.set(emittedRuntime.sourcePath, executableProgramModule(plan, contracts, statefulContracts));
      byPath.set(emittedRuntime.testPath, executableProgramTest(plan, contracts));
    }
    byPath.set("BUILDING.md", buildNotes(plan));
  }
  return plan.files.map(filePlan => artifact(filePlan.path, filePlan.mediaType, byPath.get(filePlan.path) ?? "", filePlan.role, idFactory, hasher));
}

function programGraphManifest(plan: ProgramPlan, input: ProgramPlannerInput): JsonValue {
  return toJsonValue({
    kind: "program_graph",
    version: 4,
    episodeId: input.episodeId,
    planId: plan.id,
    shape: plan.intent.shape,
    graph: plan.graph,
    sourceEmission: plan.sourceEmission,
    codeGraph: plan.codeGraph.audit,
    blueprint: plan.blueprint.audit,
    proof: {
      id: input.entailment.proof.id,
      force: input.entailment.force,
      semanticVerdict: input.entailment.semanticVerdict,
      obligations: input.entailment.obligations.map(item => ({ id: item.id, kind: item.kind, status: item.status, evidenceIds: item.evidenceIds, sourceVersionIds: item.sourceVersionIds }))
    },
    validation: { build: plan.build, test: plan.test, repairHints: plan.repairHints }
  });
}

function implementationPlan(plan: ProgramPlan, input: ProgramPlannerInput): JsonValue {
  return toJsonValue({
    target: plan.intent.shape.target,
    energy: plan.intent.shape.energy,
    models: domainModels(plan.intent.shape),
    operations: operationsFor(plan.intent.shape),
    operationContracts: operationContracts(plan, input),
    interfaces: interfacesFor(plan.intent.shape),
    dependencies: dependenciesFor(plan.intent.shape, plan.codeGraph),
    sourceEmission: plan.sourceEmission,
    validation: { build: plan.build, test: plan.test },
    evidenceRefs: input.evidence.slice(0, 24).map(span => ({ evidenceId: span.id, sourceVersionId: span.sourceVersionId, status: span.status }))
  });
}

function operationContracts(plan: ProgramPlan, input: ProgramPlannerInput): JsonValue {
  return toJsonValue(plan.blueprint.operations.map(operation => ({
    id: operation.id,
    kind: operation.kind,
    path: operation.path,
    language: operation.language,
    intent: operation.intent,
    preconditions: operation.preconditions,
    postconditions: operation.postconditions,
    evidenceIds: operation.evidenceIds.map(String),
    sourceVersionIds: input.evidence.filter(span => operation.evidenceIds.includes(span.id)).map(span => String(span.sourceVersionId)),
    confidence: operation.confidence,
    risk: operation.risk,
    validation: plan.blueprint.validation.filter(item => item.evidenceIds.some(id => operation.evidenceIds.includes(id))).map(item => item.id),
    admission: {
      proofId: input.entailment.proof.id,
      semanticVerdict: input.entailment.semanticVerdict,
      force: input.entailment.force,
      allowedToEmit: input.entailment.semanticVerdict !== "contradicted" && operation.risk < 0.82
    }
  })));
}

function sourceMemoryFor(input: ProgramPlannerInput, plan: ProgramPlan): JsonValue {
  return toJsonValue({
    requestHash: hashText(input.requestText),
    proofId: input.entailment.proof.id,
    semanticVerdict: input.entailment.semanticVerdict,
    force: input.entailment.force,
    confidence: input.entailment.confidence,
    evidence: input.evidence.slice(0, 12).map(span => ({
      evidenceId: span.id,
      sourceVersionId: span.sourceVersionId,
      alpha: Number(span.alpha.toFixed(4)),
      status: span.status,
      preview: span.textPreview.slice(0, 300)
    })),
    obligations: input.entailment.obligations.slice(0, 32).map(item => ({
      kind: item.kind,
      status: item.status,
      evidenceIds: item.evidenceIds.map(String),
      sourceVersionIds: item.sourceVersionIds.map(String),
      reason: item.reason
    })),
    codeGraph: {
      id: plan.codeGraph.id,
      confidence: plan.codeGraph.confidence,
      languages: plan.codeGraph.languages,
      signals: plan.codeGraph.signals.slice(0, 80).map(signal => ({
        id: signal.id,
        kind: signal.kind,
        language: signal.language,
        text: signal.text,
        evidenceId: signal.evidenceId,
        sourceVersionId: signal.sourceVersionId,
        confidence: signal.confidence
      })),
      idioms: plan.codeGraph.idioms.slice(0, 32),
      dependencies: plan.codeGraph.dependencies.slice(0, 32),
      repositoryShape: plan.codeGraph.repositoryShape
    },
    blueprint: {
      id: plan.blueprint.id,
      target: plan.blueprint.target,
      sourceCoupling: plan.blueprint.sourceCoupling,
      unbackedSynthesisRisk: plan.blueprint.unbackedSynthesisRisk,
      files: plan.blueprint.files,
      operations: plan.blueprint.operations,
      validation: plan.blueprint.validation,
      repairPolicy: plan.blueprint.repairPolicy
    },
    operationContracts: operationContracts(plan, input),
    sourceEmission: plan.sourceEmission
  });
}

function packageJson(plan: ProgramPlan): string {
  const entry = entrypointFor(plan.intent.shape);
  const name = slugFromParts(["generated", plan.intent.shape.target.label, plan.intent.shape.target.id.slice(0, 10)]);
  const dependencyRecord = Object.fromEntries(plan.intent.shape.target.packageHints.map(dep => [dep.name, "*"]));
  const validationFramework = observedValidationFramework(plan.intent.shape.target);
  const validationDependencyRecord = validationFramework === "vitest"
    ? { vitest: "*" }
    : validationFramework === "jest" ? { "@jest/globals": "*" } : {};
  if (hasCapability(plan.intent.shape.target, "capability:browser-render")) {
    return `${JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      private: true,
      scripts: {
        dev: "vite",
        build: "tsc -b && vite build",
        preview: "vite preview",
        test: "tsc -b"
      },
      dependencies: dependencyRecord,
      devDependencies: validationDependencyRecord
    }, null, 2)}\n`;
  }
  return `${JSON.stringify({
    name,
    version: "1.0.0",
    type: "module",
    private: true,
    exports: hasCapability(plan.intent.shape.target, "capability:pure-call") ? { ".": "./src/index.ts" } : undefined,
    bin: hasCapability(plan.intent.shape.target, "capability:command-runtime") ? { [name]: entry } : undefined,
    scripts: {
      build: `${plan.build.command} ${plan.build.args.join(" ")}`,
      test: `${plan.test.command} ${plan.test.args.join(" ")}`
    },
    dependencies: dependencyRecord,
    devDependencies: validationDependencyRecord
  }, null, 2)}\n`;
}

function tsconfigJson(plan: ProgramPlan): string {
  if (hasCapability(plan.intent.shape.target, "capability:browser-render")) {
    return `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        allowJs: false,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: true,
        forceConsistentCasingInFileNames: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx"
      },
      include: ["src"],
      references: []
    }, null, 2)}\n`;
  }
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts"]
  }, null, 2)}\n`;
}

function webIndexHtml(plan: ProgramPlan): string {
  const title = artifactTitle(plan.intent.shape.target);
  return `<!doctype html>
<html lang="und">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function viteConfig(plan: ProgramPlan): string {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" }
});
`;
}

function webMainTsx(): string {
  return `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
}

function webAppTsx(plan: ProgramPlan, input: ProgramPlannerInput, memory: JsonValue): string {
  const model = webAppModel(plan, input);
  return `import { useMemo, useState } from "react";

const sourceMemory = ${JSON.stringify(memory, null, 2)} as const;
const appModel = ${JSON.stringify(model, null, 2)} as const;

type FilterMode = "all" | "evidence" | "interaction";

export default function App() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<FilterMode>("all");
  const [selected, setSelected] = useState(appModel.cards[0]?.id ?? "");
  const [weight, setWeight] = useState(50);

  const cards = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return appModel.cards.filter(card => {
      const modeOk = mode === "all" || card.kind === mode;
      const text = [card.title, card.detail, ...card.tags].join(" ").toLocaleLowerCase();
      return modeOk && (!normalized || text.includes(normalized));
    });
  }, [query, mode]);

  const active = cards.find(card => card.id === selected) ?? cards[0] ?? appModel.cards[0];
  const score = Math.round((appModel.confidence * 70 + weight * 0.3) * 10) / 10;

  return (
    <main className="shell">
      <section className="workspace">
        <header className="hero">
          <p>{appModel.kicker}</p>
          <h1>{appModel.title}</h1>
          <div className="metrics">
            <span>{appModel.cards.length} cards</span>
            <span>{sourceMemory.codeGraph?.signals?.length ?? 0} source signals</span>
            <span>{score}% fit</span>
          </div>
        </header>

        <nav className="toolbar" aria-label="Controls">
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter source-backed cards" />
          <button className={mode === "all" ? "active" : ""} onClick={() => setMode("all")}>All</button>
          <button className={mode === "evidence" ? "active" : ""} onClick={() => setMode("evidence")}>Evidence</button>
          <button className={mode === "interaction" ? "active" : ""} onClick={() => setMode("interaction")}>Interaction</button>
          <label>
            Weight
            <input type="range" min="0" max="100" value={weight} onChange={event => setWeight(Number(event.target.value))} />
          </label>
        </nav>

        <section className="grid">
          {cards.map(card => (
            <button key={card.id} className={card.id === active?.id ? "card selected" : "card"} onClick={() => setSelected(card.id)}>
              <strong>{card.title}</strong>
              <span>{card.detail}</span>
            </button>
          ))}
        </section>
      </section>

      <aside className="inspector">
        <h2>{active?.title ?? "No selection"}</h2>
        <p>{active?.detail ?? "No active card."}</p>
        <dl>
          <dt>Kind</dt>
          <dd>{active?.kind ?? "none"}</dd>
          <dt>Evidence</dt>
          <dd>{active?.evidenceIds.join(", ") || "none"}</dd>
          <dt>Tags</dt>
          <dd>{active?.tags.join(", ") || "none"}</dd>
        </dl>
        <pre>{JSON.stringify({ appModel, selected: active, sourceMemory: { confidence: sourceMemory.codeGraph?.confidence, dependencies: sourceMemory.codeGraph?.dependencies?.slice(0, 8) } }, null, 2)}</pre>
      </aside>
    </main>
  );
}
`;
}

function webStylesCss(): string {
  return `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #101214;
  color: #eef2f3;
}

body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input { font: inherit; }
.shell { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) 360px; }
.workspace { padding: 32px; display: flex; flex-direction: column; gap: 22px; }
.hero { display: grid; gap: 10px; }
.hero p { margin: 0; color: #8bd0d9; font-weight: 700; }
.hero h1 { margin: 0; font-size: 42px; line-height: 1.05; max-width: 880px; }
.metrics { display: flex; flex-wrap: wrap; gap: 10px; }
.metrics span { border: 1px solid #354047; border-radius: 6px; padding: 7px 10px; color: #c8d2d6; background: #171b1e; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.toolbar input[type="text"], .toolbar input:not([type]) { min-width: 240px; flex: 1; }
.toolbar input { border: 1px solid #354047; border-radius: 6px; background: #171b1e; color: #eef2f3; padding: 10px 12px; }
.toolbar button { border: 1px solid #354047; background: #1e2428; color: #eef2f3; border-radius: 6px; padding: 10px 12px; cursor: pointer; }
.toolbar button.active { border-color: #8bd0d9; color: #8bd0d9; }
.toolbar label { display: flex; gap: 8px; align-items: center; color: #c8d2d6; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.card { min-height: 132px; text-align: left; display: flex; flex-direction: column; gap: 12px; border: 1px solid #303940; border-radius: 8px; padding: 16px; color: #eef2f3; background: #171b1e; cursor: pointer; }
.card:hover, .card.selected { border-color: #8bd0d9; background: #1d2529; }
.card strong { font-size: 16px; }
.card span { color: #b8c4c9; line-height: 1.45; }
.inspector { border-left: 1px solid #303940; background: #15191c; padding: 24px; overflow: auto; }
.inspector h2 { margin-top: 0; }
.inspector dl { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 8px; }
.inspector dt { color: #8bd0d9; font-weight: 700; }
.inspector dd { margin: 0; color: #d9e1e4; overflow-wrap: anywhere; }
.inspector pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0f1214; border: 1px solid #303940; border-radius: 8px; padding: 12px; font-size: 12px; }
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .workspace { padding: 20px; }
  .hero h1 { font-size: 32px; }
  .inspector { border-left: 0; border-top: 1px solid #303940; }
}
`;
}

function libraryIndex(memory: JsonValue): string {
  return `export { evaluate, explainEvidence, type EvaluationInput, type EvaluationResult } from "./domain.js";

export const sourceEvidence = ${JSON.stringify(memory, null, 2)} as const;
`;
}

function libraryDomain(plan: ProgramPlan, memory: JsonValue): string {
  return `export interface EvaluationInput {
  records: Array<Record<string, unknown>>;
  options?: Record<string, unknown>;
}

export interface EvaluationResult {
  ok: boolean;
  recordCount: number;
  fieldCoverage: Array<{ field: string; count: number }>;
  diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; field?: string }>;
  evidence: typeof evidenceMemory;
}

const evidenceMemory = ${JSON.stringify(memory, null, 2)} as const;
const requiredFields = ${JSON.stringify(requiredFields(plan.intent.shape), null, 2)} as const;

export function evaluate(input: EvaluationInput): EvaluationResult {
  const records = Array.isArray(input.records) ? input.records : [];
  const fieldCoverage = requiredFields.map(field => ({ field, count: records.filter(record => record[field] !== undefined && record[field] !== null && record[field] !== "").length }));
  const diagnostics = fieldCoverage
    .filter(item => item.count === 0)
    .map(item => ({ severity: "warning" as const, message: "diagnostic.field.no_observed_values", field: item.field }));
  return { ok: diagnostics.every(item => item.severity !== "error"), recordCount: records.length, fieldCoverage, diagnostics, evidence: evidenceMemory };
}

export function explainEvidence() {
  return evidenceMemory.evidence.map(item => ({ evidenceId: item.evidenceId, sourceVersionId: item.sourceVersionId, status: item.status, preview: item.preview }));
}
`;
}

function transformerModule(plan: ProgramPlan, memory: JsonValue): string {
  return `#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const evidenceMemory = ${JSON.stringify(memory, null, 2)};
const mapping = ${JSON.stringify(schemaMapping(plan), null, 2)};

export function parseInput(text, mediaType = "application/json") {
  const value = String(text ?? "");
  if (mediaType.includes("csv") || value.includes(",")) return parseDelimited(value, ",");
  if (mediaType.includes("tsv") || value.includes("\\t")) return parseDelimited(value, "\\t");
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function transform(records) {
  return records.map((record, index) => {
    const out = { _index: index };
    for (const field of mapping.fields) out[field.output] = coerce(record[field.input], field.type);
    out._source = { proofId: evidenceMemory.proofId, evidence: evidenceMemory.evidence.map(item => item.evidenceId) };
    return out;
  });
}

export function validate(records) {
  const diagnostics = [];
  records.forEach((record, index) => {
    for (const field of mapping.fields.filter(item => item.required)) {
      if (record[field.input] === undefined || record[field.input] === "") diagnostics.push({ index, field: field.input, severity: "warning", message: "diagnostic.input.required_missing" });
    }
  });
  return diagnostics;
}

function parseDelimited(text, delimiter) {
  const lines = splitLines(text).filter(Boolean);
  const headers = (lines.shift() ?? "").split(delimiter).map(item => item.trim());
  return lines.map(line => Object.fromEntries(line.split(delimiter).map((value, index) => [headers[index] ?? String(index), value.trim()])));
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\n") {
      const end = i > start && text[i - 1] === "\\r" ? i - 1 : i;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

function coerce(value, type) {
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") return value === true || value === 1 || value === "1";
  return value == null ? null : String(value);
}

if (process.argv[1] && import.meta.url.endsWith(normalizePathText(process.argv[1]))) {
  const inputPath = process.argv[2];
  const raw = inputPath ? await readFile(inputPath, "utf8") : await readStdin();
  const records = parseInput(raw, inputPath?.endsWith(".csv") ? "text/csv" : "application/json");
  const diagnostics = validate(records);
  console.log(JSON.stringify({ records: transform(records), diagnostics }, null, 2));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function normalizePathText(value) {
  return String(value).split("\\\\").join("/");
}
`;
}

function logParserModule(plan: ProgramPlan, memory: JsonValue): string {
  return `const evidenceMemory = ${JSON.stringify(memory, null, 2)} as const;
const logPlan = ${JSON.stringify({ target: plan.intent.shape.target.id, fields: requiredFields(plan.intent.shape), entrypoint: entrypointFor(plan.intent.shape) }, null, 2)} as const;

export interface ParsedLogRecord {
  index: number;
  raw: string;
  timestamp?: string;
  level?: string;
  component?: string;
  status?: string;
  message: string;
  fields: Record<string, string>;
  evidenceRefs: Array<{ evidenceId: string; sourceVersionId: string }>;
}

export interface LogParseResult {
  ok: boolean;
  records: ParsedLogRecord[];
  diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; index?: number }>;
  plan: typeof logPlan;
}

export function parseLogText(text: string): LogParseResult {
  const records = splitLines(String(text ?? ""))
    .map((line, index) => parseLogLine(line, index))
    .filter((record): record is ParsedLogRecord => record !== undefined);
  const diagnostics = records.length ? [] : [{ severity: "warning" as const, message: "diagnostic.log.no_records" }];
  return { ok: diagnostics.every(item => item.severity !== "error"), records, diagnostics, plan: logPlan };
}

export function parseLogLine(line: string, index = 0): ParsedLogRecord | undefined {
  const raw = String(line ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fields = readKeyValuePairs(trimmed);
  const timestamp = readTimestamp(trimmed) ?? fields.timestamp ?? fields.time;
  const level = readLevel(trimmed) ?? fields.level;
  const component = fields.component ?? fields.service ?? readBracketed(trimmed);
  const status = fields.status ?? fields.state;
  const message = messageWithoutKnownPrefixes(trimmed, fields);
  return {
    index,
    raw,
    timestamp,
    level,
    component,
    status,
    message,
    fields,
    evidenceRefs: evidenceMemory.evidence.map(item => ({ evidenceId: String(item.evidenceId), sourceVersionId: String(item.sourceVersionId) }))
  };
}

function readTimestamp(line: string): string | undefined {
  let end = 0;
  while (end < line.length && !isSpace(line[end] ?? "")) end++;
  const candidate = line.slice(0, end);
  if (candidate.includes("-") && candidate.includes(":")) return candidate;
  return undefined;
}

function readLevel(line: string): string | undefined {
  const symbols = words(line).slice(0, 8);
  const levels = ["trace", "debug", "info", "warn", "warning", "error", "fatal"];
  return symbols.find(symbol => levels.includes(symbol.toLocaleLowerCase()));
}

function readBracketed(line: string): string | undefined {
  const start = line.indexOf("[");
  if (start < 0) return undefined;
  const end = line.indexOf("]", start + 1);
  if (end <= start + 1) return undefined;
  return line.slice(start + 1, end).trim() || undefined;
}

function readKeyValuePairs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < line.length) {
    while (i < line.length && isSpace(line[i] ?? "")) i++;
    const keyStart = i;
    while (i < line.length && isKeyChar(line[i] ?? "")) i++;
    const key = line.slice(keyStart, i);
    if (!key || line[i] !== "=") {
      i++;
      continue;
    }
    i++;
    let value = "";
    const quoted = line.charCodeAt(i);
    if (quoted === 34 || quoted === 39) {
      const quote = line[i++];
      while (i < line.length && line[i] !== quote) value += line[i++];
      if (line[i] === quote) i++;
    } else {
      while (i < line.length && !isSpace(line[i] ?? "")) value += line[i++];
    }
    out[key] = value;
  }
  return out;
}

function messageWithoutKnownPrefixes(line: string, fields: Record<string, string>): string {
  const consumed = new Set(Object.entries(fields).map(([key, value]) => key + "=" + value));
  return splitBySpaces(line).filter(part => !consumed.has(part) && !part.startsWith("[") && !part.endsWith("]")).join(" ").trim() || line;
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\n") {
      const end = i > start && text[i - 1] === "\\r" ? i - 1 : i;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

function words(text: string): string[] {
  return splitBySpaces(text).map(part => part.trim()).filter(Boolean);
}

function splitBySpaces(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (isSpace(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

function isSpace(ch: string): boolean {
  return ch.trim() === "";
}

function isKeyChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp === 95 || cp === 45 || cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && ch.trim() !== "";
}
`;
}

function apiHandlerModule(plan: ProgramPlan, memory: JsonValue): string {
  return `const evidenceMemory = ${JSON.stringify(memory, null, 2)} as const;
const programDescriptor = ${JSON.stringify({
    id: plan.id,
    entrypoint: entrypointFor(plan.intent.shape),
    files: plan.files.map(file => ({ path: file.path, role: file.role, mediaType: file.mediaType })),
    build: plan.build,
    test: plan.test
  }, null, 2)} as const;

export interface SourceRequest {
  method?: string;
  path?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface SourceResponse {
  status: number;
  headers: Record<string, string>;
  body: {
    ok: boolean;
    program: typeof programDescriptor;
    diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string }>;
    evidenceRefs: Array<{ evidenceId: string; sourceVersionId: string }>;
  };
}

export function handleRequest(request: SourceRequest): SourceResponse {
  const diagnostics = validateRequest(request);
  return {
    status: diagnostics.some(item => item.severity === "error") ? 400 : 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: {
      ok: diagnostics.every(item => item.severity !== "error"),
      program: programDescriptor,
      diagnostics,
      evidenceRefs: evidenceMemory.evidence.map(item => ({ evidenceId: String(item.evidenceId), sourceVersionId: String(item.sourceVersionId) }))
    }
  };
}

export function validateRequest(request: SourceRequest): Array<{ severity: "info" | "warning" | "error"; message: string }> {
  const diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string }> = [];
  if (!request || typeof request !== "object") diagnostics.push({ severity: "error", message: "diagnostic.request.invalid" });
  if (request.path && !request.path.startsWith("/")) diagnostics.push({ severity: "warning", message: "diagnostic.request.path_relative" });
  if (request.method && request.method.length > 16) diagnostics.push({ severity: "warning", message: "diagnostic.request.method_length" });
  return diagnostics;
}
`;
}

function generatedArtifactTest(plan: ProgramPlan): string {
  const descriptor = `const programDescriptor = ${JSON.stringify({
    planId: plan.id,
    entrypoint: entrypointFor(plan.intent.shape),
    expectedFiles: plan.sourceEmission.expectedFiles,
    artifactKinds: plan.sourceEmission.artifactKinds,
    validation: plan.sourceEmission.validation
  }, null, 2)} as const;

export function generatedArtifactSelfCheck() {
  const files = new Set(programDescriptor.expectedFiles);
  const diagnostics = [];
  if (!files.has("program.graph.json")) diagnostics.push({ severity: "error", code: "diagnostic.artifact.manifest_missing" });
  if (!files.has(programDescriptor.entrypoint)) diagnostics.push({ severity: "error", code: "diagnostic.artifact.entrypoint_missing" });
  if (!programDescriptor.artifactKinds.length) diagnostics.push({ severity: "warning", code: "diagnostic.artifact.kind_missing" });
  return {
    ok: diagnostics.every(item => item.severity !== "error"),
    diagnostics,
    program: programDescriptor
  };
}
`;
  if (!hasCapability(plan.intent.shape.target, "capability:pure-call")) return descriptor;
  const framework = observedValidationFramework(plan.intent.shape.target);
  if (framework === "vitest") return `import { expect, test } from "vitest";
import { evaluate } from "../src/domain.js";

test("evaluate returns a structured result for source-backed records", () => {
  const result = evaluate({ records: [{ value: "observed" }] });
  const invalid = evaluate({ records: null } as unknown as Parameters<typeof evaluate>[0]);
  expect(result.recordCount).toBe(1);
  expect(result.ok).toBe(true);
  expect(Array.isArray(result.fieldCoverage)).toBe(true);
  expect(invalid.recordCount).toBe(0);
});

${descriptor}`;
  if (framework === "jest") return `import { expect, test } from "@jest/globals";
import { evaluate } from "../src/domain.js";

test("evaluate returns a structured result for source-backed records", () => {
  const result = evaluate({ records: [{ value: "observed" }] });
  const invalid = evaluate({ records: null } as unknown as Parameters<typeof evaluate>[0]);
  expect(result.recordCount).toBe(1);
  expect(result.ok).toBe(true);
  expect(Array.isArray(result.fieldCoverage)).toBe(true);
  expect(invalid.recordCount).toBe(0);
});

${descriptor}`;
  if (framework === "node-test") return `import { strict as assert } from "node:assert";
import test from "node:test";
import { evaluate } from "../src/domain.js";

test("evaluate returns a structured result for source-backed records", () => {
  const result = evaluate({ records: [{ value: "observed" }] });
  const invalid = evaluate({ records: null } as unknown as Parameters<typeof evaluate>[0]);
  assert.equal(result.recordCount, 1);
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result.fieldCoverage), true);
  assert.equal(invalid.recordCount, 0);
});

${descriptor}`;
  return descriptor;
}

function observedValidationFramework(target: ProgramTargetProfile): "vitest" | "jest" | "node-test" | undefined {
  const targetEvidence = jsonRecord(target.evidence);
  const constructMetadata = jsonRecord(targetEvidence.constructMetadata);
  const validationRunner = jsonRecord(constructMetadata.validationRunner);
  const runnerEvidenceId = typeof validationRunner.evidenceSpanId === "string" ? validationRunner.evidenceSpanId : "";
  const provenanceEvidenceIds = new Set(
    Array.isArray(targetEvidence.provenanceEvidenceIds)
      ? targetEvidence.provenanceEvidenceIds.filter((id): id is string => typeof id === "string")
      : []
  );
  if (runnerEvidenceId && provenanceEvidenceIds.has(runnerEvidenceId)) {
    if (validationRunner.runnerId === "runtime.validation.vitest") return "vitest";
    if (validationRunner.runnerId === "runtime.validation.node-test") return "node-test";
  }
  for (const hint of commandHintsFromTarget(target)) {
    const tokens = (hint.command ?? "")
      .trim()
      .split(/\s+/u)
      .map(token => token.replace(/^["']|["']$/gu, "").split(/[\\/]/u).pop()!.toLocaleLowerCase().replace(/\.cmd$|\.exe$/u, ""));
    if (tokens[0] === "vitest") return "vitest";
    if (tokens[0] === "node" && tokens.slice(1).includes("--test")) return "node-test";
  }
  return undefined;
}

function reportModule(plan: ProgramPlan, memory: JsonValue): string {
  return `#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const evidenceMemory = ${JSON.stringify(memory, null, 2)};
const sections = ${JSON.stringify(reportSections(plan.intent.shape), null, 2)};

export function renderReport(input) {
  const records = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : [input];
  const lines = ["# report.title", "", ...sections.flatMap(section => renderSection(section, records)), "", "## report.evidence", ...evidenceMemory.evidence.map(item => \`- \${item.evidenceId} / \${item.sourceVersionId}: \${singleLine(item.preview)}\`)];
  return lines.join("\\n");
}

function renderSection(section, records) {
  if (section.kind === "summary") return [\`## \${section.title}\`, "", \`Records: \${records.length}\`, ""];
  if (section.kind === "table") return [\`## \${section.title}\`, "", table(records, section.fields), ""];
  return [\`## \${section.title}\`, "", ...records.slice(0, 12).map((record, index) => \`- \${index + 1}: \${JSON.stringify(record)}\`), ""];
}

function table(records, fields) {
  const header = \`| \${fields.join(" | ")} |\`;
  const rule = \`| \${fields.map(() => "---").join(" | ")} |\`;
  const rows = records.map(record => \`| \${fields.map(field => escapeCell(record?.[field])).join(" | ")} |\`);
  return [header, rule, ...rows].join("\\n");
}

function escapeCell(value) {
  let out = "";
  for (const ch of String(value ?? "")) {
    if (ch === "|") out += "\\\\|";
    else if (ch === "\\r" || ch === "\\n") out += " ";
    else out += ch;
  }
  return out;
}

function singleLine(value) {
  let out = "";
  for (const ch of String(value ?? "")) out += ch === "\\r" || ch === "\\n" ? " " : ch;
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(normalizePathText(process.argv[1]))) {
  const raw = process.argv[2] ? await readFile(process.argv[2], "utf8") : await readStdin();
  console.log(renderReport(JSON.parse(raw)));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function normalizePathText(value) {
  return String(value).split("\\\\").join("/");
}
`;
}

function cliModule(plan: ProgramPlan, memory: JsonValue): string {
  return `#!/usr/bin/env node
import { runCommand } from "./command.js";

const evidenceMemory = ${JSON.stringify(memory, null, 2)};

const result = await runCommand({ argv: process.argv.slice(2), stdin: await readStdin(), evidence: evidenceMemory });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
`;
}

function commandModule(plan: ProgramPlan, memory: JsonValue): string {
  return `export async function runCommand(input) {
  const args = Array.isArray(input.argv) ? input.argv : [];
  const stdin = String(input.stdin ?? "");
  const evidence = input.evidence ?? ${JSON.stringify(memory, null, 2)};
  const flags = parseFlags(args);
  const payload = flags.json ? safeJson(stdin || flags.value || "{}") : { value: flags.value ?? stdin.trim() };
  const diagnostics = [];
  if (payload.error) diagnostics.push({ severity: "error", message: payload.error });
  return {
    ok: diagnostics.every(item => item.severity !== "error"),
    command: ${JSON.stringify(plan.intent.shape.target.id)},
    target: ${JSON.stringify(plan.intent.shape.target.label)},
    payload: payload.error ? null : payload,
    diagnostics,
    evidenceRefs: evidence.evidence?.map(item => ({ evidenceId: item.evidenceId, sourceVersionId: item.sourceVersionId })) ?? []
  };
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--value") out.value = args[++i] ?? "";
    else if (!out.value) out.value = arg;
  }
  return out;
}

function safeJson(text) {
  try { return JSON.parse(text); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
`;
}

function sourceProgramContract(plan: ProgramPlan, input: ProgramPlannerInput): JsonValue {
  return toJsonValue({
    target: plan.intent.shape.target,
    requestHash: hashText(input.requestText),
    learnedLanguages: plan.codeGraph.languages,
    learnedIdioms: plan.codeGraph.idioms.slice(0, 32),
    learnedDependencies: plan.codeGraph.dependencies.slice(0, 32),
    repositoryShape: plan.codeGraph.repositoryShape,
    ownerBehaviorAuthority: plan.ownerBehaviorRequirements.map(requirement => ({
      id: requirement.id,
      callableId: requirement.callableId,
      verificationRole: requirement.verificationRole
    })),
    ownerStatefulBehaviorAuthority: plan.ownerStatefulBehaviorRequirements.map(requirement => ({
      id: requirement.id,
      invocations: requirement.invocations.map(invocation => ({
        callableId: invocation.callableId,
        arguments: invocation.arguments
      })),
      expectedResult: requirement.expectedResult,
      verificationRole: requirement.verificationRole
    })),
    ownerBehaviorImplementationPhase: plan.ownerBehaviorImplementationPhase,
    ownerBehaviorTransformationCandidates: plan.ownerBehaviorTransformationCandidates,
    selectedOwnerBehaviorTransformationIds: plan.selectedOwnerBehaviorTransformationIds,
    ownerStatefulBehaviorTransformationCandidates: plan.ownerStatefulBehaviorTransformationCandidates,
    selectedOwnerStatefulBehaviorTransformationIds: plan.selectedOwnerStatefulBehaviorTransformationIds,
    statefulCallContracts: declaredStatefulCallContractsFromRequirements(plan.ownerStatefulBehaviorRequirements),
    sourceOperations: plan.blueprint.operations,
    build: plan.build,
    test: plan.test,
    admission: {
      proofId: input.entailment.proof.id,
      semanticVerdict: input.entailment.semanticVerdict,
      sourceCoupling: plan.blueprint.sourceCoupling,
      unbackedSynthesisRisk: plan.blueprint.unbackedSynthesisRisk
    }
  });
}

interface DeclaredCallContract {
  name: string;
  parameters: Array<{ name: string; type: string }>;
  returnType: string;
  /** Arguments matching every declared parameter type, or undefined when some type is not one the runtime can construct. */
  sample?: JsonValue[];
}

interface DeclaredStatefulCallContract {
  name: string;
  parameters: Array<{ name: string; type: string }>;
  /** Invocation examples are retained so the generated contract can be executed by a verifier. */
  samples: JsonValue[][];
}

/**
 * Turn admitted owner behavior into the same executable contract consumed by the
 * emitted program and test.  This is deliberately structural: callable identity,
 * arity, argument shapes, and result shape are carried by the validated requirement
 * graph rather than recovered from natural-language punctuation.
 */
function declaredCallContractsFromRequirements(requirements: readonly ProgramBehaviorRequirement[]): DeclaredCallContract[] {
  const byCallable = new Map<string, ProgramBehaviorRequirement[]>();
  for (const requirement of requirements) {
    const group = byCallable.get(requirement.callableId);
    if (group) group.push(requirement);
    else byCallable.set(requirement.callableId, [requirement]);
  }
  return [...byCallable.entries()].map(([name, group]) => {
    const exemplar = group[0]!;
    const arity = exemplar.arguments.length;
    const parameterTypes = Array.from({ length: arity }, (_, index) => {
      const observed = group
        .filter(requirement => requirement.arguments.length === arity)
        .map(requirement => runtimeShapeForJson(requirement.arguments[index]!));
      return observed.every(shape => shape === observed[0]) ? observed[0] ?? "" : "";
    });
    const resultShapes = group.map(requirement => runtimeShapeForJson(requirement.expectedResult));
    const returnType = resultShapes.every(shape => shape === resultShapes[0]) ? resultShapes[0] ?? "" : "";
    return {
      name,
      parameters: parameterTypes.map((type, index) => ({ name: `arg${index}`, type })),
      returnType,
      sample: exemplar.arguments
    };
  });
}

/**
 * Derive the stateful API surface from admitted invocation records. Operation
 * names, arity, and argument shapes come from callable IDs and values already
 * bound to the requirement graph; no request text or operation vocabulary is
 * consulted here.
 */
function declaredStatefulCallContractsFromRequirements(
  requirements: readonly ProgramStatefulBehaviorRequirement[]
): DeclaredStatefulCallContract[] {
  const byCallable = new Map<string, JsonValue[][]>();
  for (const requirement of requirements) {
    for (const invocation of requirement.invocations) {
      const samples = byCallable.get(invocation.callableId);
      const args = invocation.arguments.map(value => toJsonValue(value));
      if (samples) samples.push(args);
      else byCallable.set(invocation.callableId, [args]);
    }
  }
  return [...byCallable.entries()].map(([name, samples]) => {
    const arity = samples[0]?.length ?? 0;
    const parameters = Array.from({ length: arity }, (_, index) => {
      const shapes = samples
        .filter(args => args.length === arity)
        .map(args => runtimeShapeForJson(args[index]!));
      return {
        name: `arg${index}`,
        type: shapes.length && shapes.every(shape => shape === shapes[0]) ? shapes[0]! : ""
      };
    });
    return { name, parameters, samples };
  });
}

/** Matches the emitted runtime's describeShape() surface for every JSON value. */
function runtimeShapeForJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const shapes = [...new Set(value.map(runtimeShapeForJson))];
    return shapes.length === 1 ? `${shapes[0]}[]` : `${shapes.join("|")}[]`;
  }
  if (value === null) return "null";
  return typeof value;
}

/**
 * Call contracts the request declares in its own text: an identifier bound to a balanced parameter list, with the
 * type terms written beside the names. Punctuation decides -- nothing here reads a word.
 */
function declaredCallContracts(requestText: string, scanBytes = 8192, limit = 16): DeclaredCallContract[] {
  // Cost bound: the balanced scan is quadratic on pathological nesting, so it reads a bounded prefix and keeps a bounded count.
  const text = requestText.slice(0, scanBytes);
  const out: DeclaredCallContract[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < text.length && out.length < limit) {
    const identifier = readIdentifierRun(text, cursor);
    if (!identifier) {
      cursor += 1;
      continue;
    }
    cursor = identifier.end;
    if (text[cursor] !== "(") continue;
    const group = readBalanced(text, cursor, "(", ")");
    if (!group) continue;
    cursor = group.end;
    const parameters = declaredParameters(group.inner);
    if (!parameters) continue;
    const afterGroup = skipSpacesFrom(text, group.end);
    const returnType = text[afterGroup] === ":" ? readTypeTerm(text, skipSpacesFrom(text, afterGroup + 1)) : "";
    const declaresTypes = returnType.length > 0 || parameters.some(parameter => parameter.type.length > 0);
    if (!declaresTypes || seen.has(identifier.value)) continue;
    seen.add(identifier.value);
    const sample = sampleArguments(parameters);
    out.push({ name: identifier.value, parameters, returnType, ...(sample ? { sample } : {}) });
  }
  return out;
}

/** A parameter list is only a declaration when every entry is an identifier, optionally carrying a type term. */
function declaredParameters(inner: string): Array<{ name: string; type: string }> | undefined {
  const trimmed = inner.trim();
  if (!trimmed) return [];
  const parts = splitTopLevel(inner, ",");
  const parameters: Array<{ name: string; type: string }> = [];
  for (const part of parts) {
    const start = skipSpacesFrom(part, 0);
    const identifier = readIdentifierRun(part, start);
    if (!identifier) return undefined;
    const afterName = skipSpacesFrom(part, identifier.end);
    if (afterName >= part.length) {
      parameters.push({ name: identifier.value, type: "" });
      continue;
    }
    if (part[afterName] !== ":") return undefined;
    const typeStart = skipSpacesFrom(part, afterName + 1);
    const type = readTypeTerm(part, typeStart);
    if (!type || skipSpacesFrom(part, typeStart + type.length) < part.length) return undefined;
    parameters.push({ name: identifier.value, type });
  }
  return parameters;
}

/** A type term: an identifier run, then any balanced generic argument list, then any number of collection markers. */
function readTypeTerm(text: string, start: number): string {
  if (start < 0 || start >= text.length) return "";
  const identifier = readIdentifierRun(text, start);
  if (!identifier) return "";
  let end = identifier.end;
  const generic = text[end] === "<" ? readBalanced(text, end, "<", ">") : undefined;
  if (generic) end = generic.end;
  while (text[end] === "[" && text[end + 1] === "]") end += 2;
  return text.slice(start, end);
}

/**
 * A value of the declared type, built only from terms the emitted runtime itself names. A type the runtime cannot
 * construct yields nothing, and the emitted test then checks only that the contract was carried, never a guess.
 */
function sampleArguments(parameters: ReadonlyArray<{ name: string; type: string }>): JsonValue[] | undefined {
  const samples: JsonValue[] = [];
  for (const parameter of parameters) {
    const sample = sampleForType(parameter.type);
    if (sample === undefined) return undefined;
    samples.push(sample);
  }
  return samples;
}

function sampleForType(type: string): JsonValue | undefined {
  if (type.endsWith("[]")) {
    const element = sampleForType(type.slice(0, -2));
    return element === undefined ? undefined : [element];
  }
  if (type === "string") return "observed";
  if (type === "number") return 1;
  if (type === "boolean") return true;
  return undefined;
}

function readIdentifierRun(text: string, start: number): { value: string; end: number } | undefined {
  if (start >= text.length || !isIdentifierStart(text[start]!)) return undefined;
  let end = start + 1;
  while (end < text.length && isIdentifierLike(text[end]!)) end += 1;
  return { value: text.slice(start, end), end };
}

function readBalanced(text: string, start: number, open: string, close: string): { inner: string; end: number } | undefined {
  if (text[start] !== open) return undefined;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return undefined;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "(" || char === "[" || char === "{" || char === "<") depth += 1;
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function skipSpacesFrom(text: string, start: number): number {
  let index = start;
  while (index < text.length && text[index]!.trim() === "") index += 1;
  return index;
}

/**
 * The emitted program: the contracts the request declared, the inputs the plan requires, and the operations the
 * blueprint planned, in the module syntax of the runtime that is about to check and run it.
 */
function executableProgramModule(
  plan: ProgramPlan,
  contracts: readonly DeclaredCallContract[],
  statefulContracts: readonly DeclaredStatefulCallContract[] = []
): string {
  const manifest = executableProgramManifest(plan, contracts, statefulContracts);
  return `// Emitted for this request: the call contracts its text declares, over the fields the plan requires.
export const programContract = ${JSON.stringify(manifest, null, 2)};

export function describeShape(value) {
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const elements = [...new Set(value.map(item => describeShape(item)))];
    return elements.length === 1 ? \`\${elements[0]}[]\` : \`\${elements.join("|")}[]\`;
  }
  if (value === null) return "null";
  return typeof value;
}

// An empty collection carries no element type, so it conforms to any declared collection.
export function shapeSatisfies(shape, declared) {
  if (!declared) return true;
  return shape === declared || shape === "[]" && declared.endsWith("[]");
}

export function declaredContract(name) {
  return programContract.contracts.find(contract => contract.name === name);
}

export function declaredStatefulContract(name) {
  return programContract.statefulContracts.find(contract => contract.name === name);
}

export function checkDeclaredCall(name, args) {
  const contract = declaredContract(name);
  if (!contract) return { ok: false, name, diagnostics: [{ code: "program.contract.undeclared", name }] };
  const received = Array.isArray(args) ? args : [];
  const diagnostics = [];
  if (received.length !== contract.parameters.length) diagnostics.push({ code: "program.contract.arity", expected: contract.parameters.length, received: received.length });
  for (const [index, parameter] of contract.parameters.entries()) {
    const shape = describeShape(received[index]);
    if (index < received.length && !shapeSatisfies(shape, parameter.type)) diagnostics.push({ code: "program.contract.parameter_shape", parameter: parameter.name, declared: parameter.type, received: shape });
  }
  return { ok: diagnostics.length === 0, name, declared: contract, diagnostics };
}

export function checkStatefulCall(name, args) {
  const contract = declaredStatefulContract(name);
  if (!contract) return { ok: false, name, diagnostics: [{ code: "program.stateful_contract.undeclared", name }] };
  const received = Array.isArray(args) ? args : [];
  const diagnostics = [];
  if (received.length !== contract.parameters.length) diagnostics.push({ code: "program.stateful_contract.arity", expected: contract.parameters.length, received: received.length });
  for (const [index, parameter] of contract.parameters.entries()) {
    const shape = describeShape(received[index]);
    if (index < received.length && !shapeSatisfies(shape, parameter.type)) diagnostics.push({ code: "program.stateful_contract.parameter_shape", parameter: parameter.name, declared: parameter.type, received: shape });
  }
  return { ok: diagnostics.length === 0, name, declared: contract, diagnostics };
}

${plan.ownerBehaviorRequirements.length
  ? [...new Set(plan.ownerBehaviorRequirements.map(requirement => requirement.callableId))]
    .map(callableId => plan.ownerBehaviorImplementationPhase === "selected"
      ? executableBehaviorTransformationFunction(
        callableId,
        plan.ownerBehaviorTransformationCandidates,
        plan.selectedOwnerBehaviorTransformationIds
      )
      : `export function ${callableId}(...args) { return args.length === 1 ? args[0] : args; }`)
    .join("\n")
  : ""}

${plan.ownerStatefulBehaviorRequirements.length
  ? plan.ownerBehaviorImplementationPhase === "selected"
    ? executableStatefulBehaviorFactory(plan.ownerStatefulBehaviorTransformationCandidates, plan.selectedOwnerStatefulBehaviorTransformationIds)
    : `export function createStatefulProgram() { return Object.freeze({}); }`
  : ""}

export function run(input) {
  const records = Array.isArray(input && input.records) ? input.records : [];
  const fieldCoverage = programContract.requiredFields.map(field => ({
    field,
    count: records.filter(record => record && record[field] !== undefined && record[field] !== null && record[field] !== "").length
  }));
  const diagnostics = fieldCoverage
    .filter(item => item.count === 0)
    .map(item => ({ code: "program.field.no_observed_values", field: item.field }));
  return {
    ok: records.length > 0 && diagnostics.length === 0,
    recordCount: records.length,
    fieldCoverage,
    diagnostics,
    contracts: programContract.contracts.map(contract => contract.name)
  };
}
`;
}

function executableProgramManifest(
  plan: ProgramPlan,
  contracts: readonly DeclaredCallContract[],
  statefulContracts: readonly DeclaredStatefulCallContract[]
): Record<string, unknown> {
  return {
    planId: plan.id,
    entrypoint: emittedRuntimeForShape(plan.intent.shape).sourcePath,
    target: plan.intent.shape.target.label,
    expectedFiles: plan.sourceEmission.expectedFiles,
    artifactKinds: plan.sourceEmission.artifactKinds,
    contracts: contracts.map(contract => ({ name: contract.name, parameters: contract.parameters, returnType: contract.returnType })),
    probes: contracts.filter(contract => contract.sample).map(contract => ({ name: contract.name, arguments: contract.sample })),
    statefulContracts: statefulContracts.map(contract => ({
      name: contract.name,
      parameters: contract.parameters,
      samples: contract.samples
    })),
    // Owner expected results are validation-only. The source receives only
    // operation signatures and the selected transition construction, so it
    // cannot satisfy a held-out trace by inspecting its expected value.
    ownerBehaviorImplementationPhase: plan.ownerBehaviorImplementationPhase,
    selectedOwnerBehaviorTransformations: plan.ownerBehaviorTransformationCandidates
      .filter(candidate => plan.selectedOwnerBehaviorTransformationIds.includes(candidate.id))
      .map(candidate => ({ id: candidate.id, callableId: candidate.callableId, producedIr: candidate.producedIr })),
    selectedOwnerStatefulBehaviorTransformations: plan.ownerStatefulBehaviorTransformationCandidates
      .filter(candidate => plan.selectedOwnerStatefulBehaviorTransformationIds.includes(candidate.id))
      .map(candidate => ({ id: candidate.id, transitionIr: candidate.transitionIr, operatorAssignments: candidate.operatorAssignments })),
    requiredInputs: plan.intent.shape.requiredInputs,
    requiredOutputs: plan.intent.shape.requiredOutputs,
    requiredFields: requiredFields(plan.intent.shape),
    operations: plan.blueprint.operations.map(operation => ({ id: operation.id, kind: operation.kind, path: operation.path, intent: operation.intent }))
  };
}

function executablePythonProgramModule(
  plan: ProgramPlan,
  contracts: readonly DeclaredCallContract[],
  statefulContracts: readonly DeclaredStatefulCallContract[] = []
): string {
  const manifest = executableProgramManifest(plan, contracts, statefulContracts);
  const callables = plan.ownerBehaviorRequirements.length
    ? [...new Set(plan.ownerBehaviorRequirements.map(requirement => requirement.callableId))]
      .map((callableId, index) => pythonBehaviorTransformationBinding(
        callableId,
        index,
        plan.ownerBehaviorImplementationPhase,
        plan.ownerBehaviorTransformationCandidates,
        plan.selectedOwnerBehaviorTransformationIds
      ))
      .join("\n\n")
    : "";
  const stateful = plan.ownerStatefulBehaviorRequirements.length
    ? plan.ownerBehaviorImplementationPhase === "selected"
      ? executablePythonStatefulBehaviorFactory(plan.ownerStatefulBehaviorTransformationCandidates, plan.selectedOwnerStatefulBehaviorTransformationIds)
      : "def createStatefulProgram():\n    return {}\n"
    : "";
  return `# Generated from the selected source-neutral ProgramGraph transformation.
import json
import math

programContract = json.loads(${JSON.stringify(JSON.stringify(manifest))})

${callables}

${stateful}

def run(input_value):
    records = input_value.get("records", []) if isinstance(input_value, dict) else []
    coverage = []
    for field in programContract.get("requiredFields", []):
        count = sum(1 for record in records if isinstance(record, dict) and record.get(field) not in (None, ""))
        coverage.append({"field": field, "count": count})
    diagnostics = [{"code": "program.field.no_observed_values", "field": item["field"]} for item in coverage if item["count"] == 0]
    return {
        "ok": bool(records) and not diagnostics,
        "recordCount": len(records),
        "fieldCoverage": coverage,
        "diagnostics": diagnostics,
        "contracts": [contract["name"] for contract in programContract.get("contracts", [])],
    }
`;
}

function pythonBehaviorTransformationBinding(
  callableId: string,
  index: number,
  phase: "probe" | "selected",
  candidates: readonly ProgramTransformationCandidate[],
  selectedIds: readonly string[]
): string {
  const safeLocal = `_program_callable_${index}`;
  if (phase === "probe") {
    return `def ${safeLocal}(*args):
    return args[0] if len(args) == 1 else list(args)

globals()[${JSON.stringify(callableId)}] = ${safeLocal}`;
  }
  const candidate = candidates.find(item => item.callableId === callableId && selectedIds.includes(item.id));
  if (!candidate) throw new Error(`selected owner behavior has no transformation for callable: ${callableId}`);
  const argumentCount = candidate.preconditions.find(precondition => precondition.kind === "argument_count")?.count;
  if (!argumentCount || argumentCount > 3) throw new Error(`selected owner behavior has invalid arity: ${callableId}`);
  const numericArgumentIndexes = candidate.preconditions
    .filter(precondition => precondition.kind === "finite_numeric_argument")
    .map(precondition => precondition.kind === "finite_numeric_argument" ? precondition.index : -1);
  const numericGuard = numericArgumentIndexes.length
    ? ` or not all(isinstance(args[index], (int, float)) and not isinstance(args[index], bool) and math.isfinite(args[index]) for index in ${JSON.stringify(numericArgumentIndexes)})`
    : "";
  return `def ${safeLocal}(*args):
    if len(args) != ${argumentCount}${numericGuard}:
        raise TypeError(${JSON.stringify(`program.argument_contract:${callableId}:${argumentCount}`)})
    return ${renderPythonProgramExpression(candidate.producedIr)}

globals()[${JSON.stringify(callableId)}] = ${safeLocal}`;
}

function executablePythonStatefulBehaviorFactory(
  candidates: readonly StateTransitionCandidate[],
  selectedIds: readonly string[]
): string {
  const candidate = candidates.find(item => selectedIds.includes(item.id));
  if (!candidate) throw new Error("selected stateful owner behavior has no transition transformation");
  const operations = candidate.transitionIr.map((instruction, index) => {
    const local = `_stateful_operation_${index}`;
    if (instruction.kind === "associate") return `    def ${local}(*args):
        if len(args) <= ${instruction.valueArgumentIndex}:
            raise TypeError(${JSON.stringify(`program.stateful_argument_contract:${instruction.operationId}`)})
        state[_stateful_key(args[${instruction.keyArgumentIndex}])] = args[${instruction.valueArgumentIndex}]
        return None`;
    if (instruction.kind === "lookup") return `    def ${local}(*args):
        key = _stateful_key(args[${instruction.keyArgumentIndex}])
        return state[key] if key in state else ${pythonJsonLiteral(candidate.absentValue)}`;
    if (instruction.kind === "dissociate") return `    def ${local}(*args):
        return state.pop(_stateful_key(args[${instruction.keyArgumentIndex}]), None)`;
    return `    def ${local}(*args):
        return None`;
  }).join("\n");
  const bindings = candidate.transitionIr.map((instruction, index) => `${JSON.stringify(instruction.operationId)}: _stateful_operation_${index}`).join(", ");
  return `def _stateful_key(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))

def createStatefulProgram():
    state = {}
${operations}
    return {${bindings}}
`;
}

function renderPythonProgramExpression(expression: ProgramExpression, elementBinding = "_program_element_0", depth = 0, accumulatorBinding = "_program_accumulator_0"): string {
  if (expression.kind === "argument") return `args[${expression.index}]`;
  if (expression.kind === "element") return elementBinding;
  if (expression.kind === "accumulator") return accumulatorBinding;
  if (expression.kind === "literal") return String(expression.value);
  if (expression.kind === "value") return pythonJsonLiteral(expression.value);
  if (expression.kind === "member") return `${renderPythonProgramExpression(expression.subject, elementBinding, depth, accumulatorBinding)}[${JSON.stringify(expression.key)}]`;
  if (expression.kind === "sequence") return `[${expression.items.map(item => renderPythonProgramExpression(item, elementBinding, depth, accumulatorBinding)).join(", ")}]`;
  if (expression.kind === "mapping") return `{${expression.entries.map(entry => `${JSON.stringify(entry.key)}: ${renderPythonProgramExpression(entry.value, elementBinding, depth, accumulatorBinding)}`).join(", ")}}`;
  if (expression.kind === "cardinality") return `len(${renderPythonProgramExpression(expression.operand, elementBinding, depth, accumulatorBinding)})`;
  if (expression.kind === "equivalent") return `(${renderPythonProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)} == ${renderPythonProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
  if (expression.kind === "map_sequence") {
    const nextBinding = `_program_element_${depth + 1}`;
    return `[${renderPythonProgramExpression(expression.projection, nextBinding, depth + 1, accumulatorBinding)} for ${nextBinding} in ${renderPythonProgramExpression(expression.source, elementBinding, depth, accumulatorBinding)}]`;
  }
  if (expression.kind === "filter_sequence") {
    const nextBinding = `_program_element_${depth + 1}`;
    return `[${nextBinding} for ${nextBinding} in ${renderPythonProgramExpression(expression.source, elementBinding, depth, accumulatorBinding)} if ${renderPythonProgramExpression(expression.predicate, nextBinding, depth + 1, accumulatorBinding)}]`;
  }
  if (expression.kind === "fold_sequence") {
    const nextElement = `_program_element_${depth + 1}`;
    const nextAccumulator = `_program_accumulator_${depth + 1}`;
    return `__import__("functools").reduce(lambda ${nextAccumulator}, ${nextElement}: ${renderPythonProgramExpression(expression.reducer, nextElement, depth + 1, nextAccumulator)}, ${renderPythonProgramExpression(expression.source, elementBinding, depth, accumulatorBinding)}, ${renderPythonProgramExpression(expression.initial, elementBinding, depth, accumulatorBinding)})`;
  }
  if (expression.kind === "conditional") return `(${renderPythonProgramExpression(expression.whenTrue, elementBinding, depth, accumulatorBinding)} if ${renderPythonProgramExpression(expression.condition, elementBinding, depth, accumulatorBinding)} else ${renderPythonProgramExpression(expression.whenFalse, elementBinding, depth, accumulatorBinding)})`;
  if (expression.kind === "unary") return `(-${renderPythonProgramExpression(expression.operand, elementBinding, depth, accumulatorBinding)})`;
  if (expression.operator === "minimum") return `min(${renderPythonProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)}, ${renderPythonProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
  if (expression.operator === "maximum") return `max(${renderPythonProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)}, ${renderPythonProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
  const operator = expression.operator === "add" ? "+"
    : expression.operator === "subtract" ? "-"
      : expression.operator === "multiply" ? "*" : "/";
  return `(${renderPythonProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)} ${operator} ${renderPythonProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
}

function pythonJsonLiteral(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "None" : `json.loads(${JSON.stringify(serialized)})`;
}

function executablePythonProgramTest(plan: ProgramPlan): string {
  return `import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "src"))
import program as owner_program

OWNER_BEHAVIOR_REQUIREMENTS = json.loads(${JSON.stringify(JSON.stringify(plan.ownerBehaviorRequirements))})
OWNER_STATEFUL_REQUIREMENTS = json.loads(${JSON.stringify(JSON.stringify(plan.ownerStatefulBehaviorRequirements))})

class GeneratedProgramTest(unittest.TestCase):
    def test_program_contract(self):
        self.assertEqual(owner_program.programContract["planId"], ${JSON.stringify(plan.id)})
        self.assertIn(owner_program.programContract["entrypoint"], owner_program.programContract["expectedFiles"])
        self.assertEqual(owner_program.run(None)["recordCount"], 0)

    def test_owner_behavior(self):
        for requirement in OWNER_BEHAVIOR_REQUIREMENTS:
            callable_value = getattr(owner_program, requirement["callableId"], None)
            self.assertTrue(callable(callable_value), "owner-required callable was not emitted")
            self.assertEqual(callable_value(*requirement["arguments"]), requirement["expectedResult"], "owner requirement was not satisfied")

    def test_owner_stateful_behavior(self):
        for requirement in OWNER_STATEFUL_REQUIREMENTS:
            stateful_program = owner_program.createStatefulProgram()
            result = None
            for invocation in requirement["invocations"]:
                operation = stateful_program.get(invocation["callableId"])
                self.assertTrue(callable(operation), "stateful owner operation was not emitted")
                result = operation(*invocation["arguments"])
            self.assertEqual(result, requirement["expectedResult"], "stateful owner requirement was not satisfied")

if __name__ == "__main__":
    unittest.main()
`;
}

function executableBehaviorTransformationFunction(
  callableId: string,
  candidates: readonly ProgramTransformationCandidate[],
  selectedIds: readonly string[]
): string {
  const candidate = candidates.find(item => item.callableId === callableId && selectedIds.includes(item.id));
  if (!candidate) throw new Error(`selected owner behavior has no transformation for callable: ${callableId}`);
  const argumentCount = candidate.preconditions.find(precondition => precondition.kind === "argument_count")?.count;
  if (!argumentCount || argumentCount > 3) throw new Error(`selected owner behavior has invalid arity: ${callableId}`);
  const numericArgumentIndexes = candidate.preconditions
    .filter((precondition): precondition is Extract<typeof precondition, { kind: "finite_numeric_argument" }> => precondition.kind === "finite_numeric_argument")
    .map(precondition => precondition.index);
  const numericGuard = numericArgumentIndexes.length
    ? ` || ![${numericArgumentIndexes.map(index => `args[${index}]`).join(", ")}].every(value => typeof value === "number" && Number.isFinite(value))`
    : "";
  return `export function ${callableId}(...args) {
  if (args.length !== ${argumentCount}${numericGuard}) throw new TypeError(${JSON.stringify(`program.argument_contract:${callableId}:${argumentCount}`)});
  return ${renderProgramExpression(candidate.producedIr)};
}`;
}

function executableStatefulBehaviorFactory(
  candidates: readonly StateTransitionCandidate[],
  selectedIds: readonly string[]
): string {
  const candidate = candidates.find(item => selectedIds.includes(item.id));
  if (!candidate) throw new Error("selected stateful owner behavior has no transition transformation");
  const operations = candidate.transitionIr.map(instruction => {
    const name = JSON.stringify(instruction.operationId);
    if (instruction.kind === "associate") return `${name}: (...args) => {
  if (args.length <= ${instruction.valueArgumentIndex}) throw new TypeError(${JSON.stringify(`${instruction.operationId} requires a key and value`)});
  state.set(statefulKey(args[${instruction.keyArgumentIndex}]), args[${instruction.valueArgumentIndex}]);
  return undefined;
}`;
    if (instruction.kind === "lookup") return `${name}: (...args) => state.has(statefulKey(args[${instruction.keyArgumentIndex}])) ? state.get(statefulKey(args[${instruction.keyArgumentIndex}])) : ${renderStatefulLiteral(candidate.absentValue)}`;
    if (instruction.kind === "dissociate") return `${name}: (...args) => {
  const prior = state.get(statefulKey(args[${instruction.keyArgumentIndex}]));
  state.delete(statefulKey(args[${instruction.keyArgumentIndex}]));
  return prior;
}`;
    return `${name}: () => undefined`;
  }).join(",\n");
  return `function statefulKey(value) { return JSON.stringify(value); }
export function createStatefulProgram() {
  const state = new Map();
  return Object.freeze({
${operations}
  });
}`;
}

function renderStatefulLiteral(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? "undefined" : rendered;
}

function renderProgramExpression(expression: ProgramExpression, elementBinding = "_programElement0", depth = 0, accumulatorBinding = "_programAccumulator0"): string {
  if (expression.kind === "argument") return `args[${expression.index}]`;
  if (expression.kind === "element") return elementBinding;
  if (expression.kind === "accumulator") return accumulatorBinding;
  if (expression.kind === "literal") return JSON.stringify(expression.value);
  if (expression.kind === "value") return JSON.stringify(expression.value);
  if (expression.kind === "member") return `${renderProgramExpression(expression.subject, elementBinding, depth, accumulatorBinding)}[${JSON.stringify(expression.key)}]`;
  if (expression.kind === "sequence") return `[${expression.items.map(item => renderProgramExpression(item, elementBinding, depth, accumulatorBinding)).join(", ")}]`;
  if (expression.kind === "mapping") return `Object.fromEntries([${expression.entries.map(entry => `[${JSON.stringify(entry.key)}, ${renderProgramExpression(entry.value, elementBinding, depth, accumulatorBinding)}]`).join(", ")}])`;
  if (expression.kind === "cardinality") return `${renderProgramExpression(expression.operand, elementBinding, depth, accumulatorBinding)}.length`;
  if (expression.kind === "equivalent") return `JSON.stringify(${renderProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)}) === JSON.stringify(${renderProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
  if (expression.kind === "map_sequence") {
    const nextBinding = `_programElement${depth + 1}`;
    return `${renderProgramExpression(expression.source, elementBinding, depth, accumulatorBinding)}.map((${nextBinding}) => ${renderProgramExpression(expression.projection, nextBinding, depth + 1, accumulatorBinding)})`;
  }
  if (expression.kind === "filter_sequence") {
    const nextBinding = `_programElement${depth + 1}`;
    return `${renderProgramExpression(expression.source, elementBinding, depth, accumulatorBinding)}.filter((${nextBinding}) => ${renderProgramExpression(expression.predicate, nextBinding, depth + 1, accumulatorBinding)})`;
  }
  if (expression.kind === "fold_sequence") {
    const nextElement = `_programElement${depth + 1}`;
    const nextAccumulator = `_programAccumulator${depth + 1}`;
    return `${renderProgramExpression(expression.source, elementBinding, depth, accumulatorBinding)}.reduce((${nextAccumulator}, ${nextElement}) => ${renderProgramExpression(expression.reducer, nextElement, depth + 1, nextAccumulator)}, ${renderProgramExpression(expression.initial, elementBinding, depth, accumulatorBinding)})`;
  }
  if (expression.kind === "conditional") return `(${renderProgramExpression(expression.condition, elementBinding, depth, accumulatorBinding)} ? ${renderProgramExpression(expression.whenTrue, elementBinding, depth, accumulatorBinding)} : ${renderProgramExpression(expression.whenFalse, elementBinding, depth, accumulatorBinding)})`;
  if (expression.kind === "unary") return `(-${renderProgramExpression(expression.operand, elementBinding, depth, accumulatorBinding)})`;
  const operator = expression.operator === "add" ? "+"
    : expression.operator === "subtract" ? "-"
      : expression.operator === "multiply" ? "*"
        : expression.operator === "divide" ? "/" : undefined;
  if (expression.operator === "minimum") return `Math.min(${renderProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)}, ${renderProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
  if (expression.operator === "maximum") return `Math.max(${renderProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)}, ${renderProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
  return `(${renderProgramExpression(expression.left, elementBinding, depth, accumulatorBinding)} ${operator} ${renderProgramExpression(expression.right, elementBinding, depth, accumulatorBinding)})`;
}

/** The emitted test: every property the emitter must keep, exercised against the emitted program by running it. */
function executableProgramTest(plan: ProgramPlan, contracts: readonly DeclaredCallContract[]): string {
  const fields = requiredFields(plan.intent.shape);
  const populated = Object.fromEntries(fields.map(field => [field, "observed"]));
  return `import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as ownerProgram from "../${EMITTED_PROGRAM_RUNTIME.sourcePath}";
import { checkDeclaredCall, checkStatefulCall, describeShape, programContract, run, shapeSatisfies } from "../${EMITTED_PROGRAM_RUNTIME.sourcePath}";

const ownerBehaviorRequirements = ${JSON.stringify(plan.ownerBehaviorRequirements, null, 2)};
const ownerStatefulBehaviorRequirements = ${JSON.stringify(plan.ownerStatefulBehaviorRequirements, null, 2)};

test("emitted program satisfies its executable contract", () => {
assert.equal(programContract.planId, ${JSON.stringify(plan.id)}, "emitted program lost its plan identity");
assert.ok(programContract.expectedFiles.includes(programContract.entrypoint), "entrypoint is not one of the emitted files");
assert.equal(programContract.contracts.length, ${contracts.length}, "emitted program lost a declared call contract");

for (const requirement of ownerBehaviorRequirements) {
  const callable = ownerProgram[requirement.callableId];
  assert.equal(typeof callable, "function", "owner-required callable " + requirement.callableId + " was not emitted");
  assert.deepEqual(ownerProgram[requirement.callableId](...requirement.arguments), requirement.expectedResult, "owner requirement " + requirement.id + " was not satisfied");
}

for (const requirement of ownerStatefulBehaviorRequirements) {
  const statefulProgram = ownerProgram.createStatefulProgram();
  assert.equal(typeof statefulProgram, "object", "stateful owner program was not emitted");
  let result;
  for (const invocation of requirement.invocations) {
    const operation = statefulProgram[invocation.callableId];
    assert.equal(typeof operation, "function", "stateful owner operation " + invocation.callableId + " was not emitted");
    result = operation(...invocation.arguments);
  }
  assert.deepEqual(result, requirement.expectedResult, "stateful owner requirement " + requirement.id + " was not satisfied");
}

for (const contract of programContract.statefulContracts) {
  const statefulProgram = ownerProgram.createStatefulProgram();
  assert.equal(typeof statefulProgram[contract.name], "function", "stateful contract operation " + contract.name + " was not emitted");
  for (const sample of contract.samples) {
    const accepted = checkStatefulCall(contract.name, sample);
    assert.ok(accepted.ok, \`stateful call \${contract.name} rejected its own declared shapes: \${JSON.stringify(accepted.diagnostics)}\`);
    const wrongArity = checkStatefulCall(contract.name, [...sample, null]);
    assert.equal(wrongArity.ok, false, \`stateful call \${contract.name} accepted the wrong number of arguments\`);
  }
}

assert.equal(describeShape([]), "[]");
assert.equal(describeShape(["a"]), "string[]");
assert.equal(shapeSatisfies("[]", "string[]"), true);
assert.equal(shapeSatisfies("number[]", "string[]"), false);

for (const probe of programContract.probes) {
  const accepted = checkDeclaredCall(probe.name, probe.arguments);
  assert.ok(accepted.ok, \`declared call \${probe.name} rejected its own declared shapes: \${JSON.stringify(accepted.diagnostics)}\`);
  const wrongArity = checkDeclaredCall(probe.name, [...probe.arguments, null]);
  assert.equal(wrongArity.ok, false, \`declared call \${probe.name} accepted the wrong number of arguments\`);
}
assert.equal(checkDeclaredCall("", []).ok, false, "an undeclared call was accepted");

const empty = run({ records: [] });
assert.equal(empty.recordCount, 0);
assert.equal(empty.ok, false, "an empty input reported coverage it does not have");
assert.equal(run(null).recordCount, 0, "run is not total on absent input");

const populated = run({ records: [${JSON.stringify(populated)}] });
assert.equal(populated.recordCount, 1);
assert.ok(populated.fieldCoverage.every(item => typeof item.count === "number"), "field coverage is not counted");
assert.equal(populated.diagnostics.length, 0, \`observed fields still reported missing: \${JSON.stringify(populated.diagnostics)}\`);

console.log(JSON.stringify({ ok: true, planId: programContract.planId, contracts: programContract.contracts.length, probes: programContract.probes.length, fields: programContract.requiredFields.length }));
});
`;
}

function validatedOwnerBehaviorRequirements(requirements: readonly ProgramBehaviorRequirement[]): ProgramBehaviorRequirement[] {
  const out: ProgramBehaviorRequirement[] = [];
  const ids = new Set<string>();
  const calls = new Map<string, string>();
  for (const requirement of requirements) {
    if (!requirement.id || !/^sha256:[0-9a-f]{64}$/u.test(requirement.requestHash)) {
      throw new Error("owner behavior requirement identity is invalid");
    }
    if (!isJavaScriptBindingIdentifier(requirement.callableId)) {
      throw new Error(`owner behavior callable is not an executable module binding: ${requirement.callableId}`);
    }
    if (!requirement.relationSurface || requirement.sourceSpan.charStart < 0 || requirement.sourceSpan.charEnd <= requirement.sourceSpan.charStart) {
      throw new Error(`owner behavior requirement source binding is invalid: ${requirement.id}`);
    }
    if (requirement.verificationRole !== "fit" && requirement.verificationRole !== "held_out") {
      throw new Error(`owner behavior requirement verification role is invalid: ${requirement.id}`);
    }
    if (ids.has(requirement.id)) throw new Error(`duplicate owner behavior requirement: ${requirement.id}`);
    ids.add(requirement.id);
    const callKey = canonicalStringify({ callableId: requirement.callableId, arguments: requirement.arguments });
    const expected = canonicalStringify(requirement.expectedResult);
    const prior = calls.get(callKey);
    if (prior !== undefined && prior !== expected) throw new Error(`contradictory owner behavior requirement: ${requirement.callableId}`);
    calls.set(callKey, expected);
    out.push({
      ...requirement,
      arguments: requirement.arguments.map(value => toJsonValue(value)),
      expectedResult: toJsonValue(requirement.expectedResult),
      sourceSpan: { ...requirement.sourceSpan }
    });
  }
  return out;
}

function validatedOwnerBehaviorTransformations(
  requirements: readonly ProgramBehaviorRequirement[],
  phase: "probe" | "selected",
  suppliedCandidates: readonly ProgramTransformationCandidate[],
  suppliedSelectedIds: readonly string[]
): { candidates: ProgramTransformationCandidate[]; selectedIds: string[] } {
  if (phase === "probe") {
    if (suppliedCandidates.length || suppliedSelectedIds.length) {
      throw new Error("probe owner behavior cannot carry selected transformations");
    }
    return { candidates: [], selectedIds: [] };
  }
  if (!requirements.length) {
    if (suppliedCandidates.length || suppliedSelectedIds.length) {
      throw new Error("owner behavior transformations require owner behavior requirements");
    }
    return { candidates: [], selectedIds: [] };
  }
  const searched = searchProgramTransformations(requirements);
  const expectedSelectedIds = searched.selected.map(candidate => candidate.id);
  if (canonicalStringify(suppliedCandidates) !== canonicalStringify(searched.candidates)
    || canonicalStringify(suppliedSelectedIds) !== canonicalStringify(expectedSelectedIds)) {
    throw new Error("selected owner behavior transformations do not match bounded fit-role search");
  }
  const requiredCallables = [...new Set(requirements.map(requirement => requirement.callableId))].sort(compareText);
  const selectedCallables = searched.selected.map(candidate => candidate.callableId).sort(compareText);
  if (canonicalStringify(requiredCallables) !== canonicalStringify(selectedCallables)) {
    throw new Error("selected owner behavior has no admissible transformation for every callable");
  }
  for (const selected of searched.selected) {
    const fitIds = requirements
      .filter(requirement => requirement.callableId === selected.callableId && requirement.verificationRole === "fit")
      .map(requirement => requirement.id)
      .sort(compareText);
    if (selected.fitMeanSquaredError > 1e-12
      || canonicalStringify(selected.predictedFitObligationIds) !== canonicalStringify(fitIds)) {
      throw new Error(`selected owner behavior transformation does not satisfy its fit obligations: ${selected.callableId}`);
    }
  }
  return {
    candidates: searched.candidates.map(candidate => ({ ...candidate })),
    selectedIds: expectedSelectedIds
  };
}

function validatedOwnerStatefulBehaviorRequirements(requirements: readonly ProgramStatefulBehaviorRequirement[]): ProgramStatefulBehaviorRequirement[] {
  const ids = new Set<string>();
  const out: ProgramStatefulBehaviorRequirement[] = [];
  for (const requirement of requirements) {
    if (!requirement.id || !/^sha256:[0-9a-f]{64}$/u.test(requirement.requestHash)) throw new Error("owner stateful behavior requirement identity is invalid");
    if (!requirement.relationSurface || requirement.sourceSpan.charStart < 0 || requirement.sourceSpan.charEnd <= requirement.sourceSpan.charStart) {
      throw new Error(`owner stateful behavior requirement source binding is invalid: ${requirement.id}`);
    }
    if (requirement.verificationRole !== "fit" && requirement.verificationRole !== "held_out") throw new Error(`owner stateful behavior verification role is invalid: ${requirement.id}`);
    if (ids.has(requirement.id)) throw new Error(`duplicate owner stateful behavior requirement: ${requirement.id}`);
    if (!requirement.invocations.length) throw new Error(`owner stateful behavior has no ordered invocations: ${requirement.id}`);
    for (const invocation of requirement.invocations) {
      if (!isJavaScriptPropertyIdentifier(invocation.callableId) || invocation.sourceSpan.charStart < 0 || invocation.sourceSpan.charEnd <= invocation.sourceSpan.charStart) {
        throw new Error(`owner stateful behavior invocation is invalid: ${requirement.id}`);
      }
    }
    ids.add(requirement.id);
    out.push({
      ...requirement,
      invocations: requirement.invocations.map(invocation => ({ ...invocation, arguments: invocation.arguments.map(value => toJsonValue(value)), sourceSpan: { ...invocation.sourceSpan } })),
      expectedResult: toJsonValue(requirement.expectedResult),
      sourceSpan: { ...requirement.sourceSpan }
    });
  }
  return out;
}

function statefulTransitionScenarios(requirements: readonly ProgramStatefulBehaviorRequirement[]) {
  return requirements.map(requirement => ({
    id: requirement.id,
    invocations: requirement.invocations.map(invocation => ({ operationId: invocation.callableId, arguments: invocation.arguments })),
    expectedResult: requirement.expectedResult,
    verificationRole: requirement.verificationRole
  }));
}

function validatedOwnerStatefulBehaviorTransformations(
  requirements: readonly ProgramStatefulBehaviorRequirement[],
  phase: "probe" | "selected",
  suppliedCandidates: readonly StateTransitionCandidate[],
  suppliedSelectedIds: readonly string[]
): { candidates: StateTransitionCandidate[]; selectedIds: string[] } {
  if (phase === "probe") {
    if (suppliedCandidates.length || suppliedSelectedIds.length) throw new Error("probe stateful owner behavior cannot carry selected transformations");
    return { candidates: [], selectedIds: [] };
  }
  if (!requirements.length) {
    if (suppliedCandidates.length || suppliedSelectedIds.length) throw new Error("stateful owner behavior transformations require stateful requirements");
    return { candidates: [], selectedIds: [] };
  }
  const searched = searchStateTransitions(statefulTransitionScenarios(requirements));
  const expectedSelectedIds = searched.selected.map(candidate => candidate.id);
  if (canonicalStringify(suppliedCandidates) !== canonicalStringify(searched.candidates)
    || canonicalStringify(suppliedSelectedIds) !== canonicalStringify(expectedSelectedIds)) {
    throw new Error("selected stateful owner behavior transformations do not match bounded fit-role search");
  }
  const selected = searched.selected[0];
  const fitIds = requirements.filter(requirement => requirement.verificationRole === "fit").map(requirement => requirement.id).sort(compareText);
  if (!selected || selected.fitError > 0 || canonicalStringify(selected.predictedFitIds) !== canonicalStringify(fitIds)) {
    throw new Error("selected stateful owner behavior transformation does not satisfy fit obligations");
  }
  return { candidates: searched.candidates.map(candidate => ({ ...candidate })), selectedIds: expectedSelectedIds };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const JAVASCRIPT_BINDING_RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "let", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield"
]);

function isJavaScriptBindingIdentifier(value: string): boolean {
  return /^[$_A-Za-z][$_A-Za-z0-9]*$/u.test(value) && !JAVASCRIPT_BINDING_RESERVED.has(value);
}

function isJavaScriptPropertyIdentifier(value: string): boolean {
  return /^[$_A-Za-z][$_A-Za-z0-9]*$/u.test(value);
}

function buildNotes(plan: ProgramPlan): string {
  return `# Source-Derived Build Notes

Target: ${plan.intent.shape.target.label}

Language: ${plan.intent.shape.target.language}

Runtime: ${plan.intent.shape.runtimeTarget}

Build command: \`${plan.build.command} ${plan.build.args.join(" ")}\`

Validation command: \`${plan.test.command} ${plan.test.args.join(" ")}\`

The target's language, package manager, capabilities, dependencies, and operations come from the learned code graph and source program contract rather than a closed artifact menu. Because no package toolchain was observed for that target, the emitted program is written for the runtime executing this engine, and the commands above are that runtime checking and running it.
`;
}

function schemaMapping(plan: ProgramPlan): JsonValue {
  const fields = requiredFields(plan.intent.shape).map(field => ({ input: field, output: normalizeField(field), type: numericFieldHint(field) ? "number" : "string", required: false }));
  return toJsonValue({
    version: 1,
    target: plan.intent.shape.target,
    fields: fields.length ? fields : [{ input: "value", output: "value", type: "string", required: false }],
    missingValuePolicy: "emit-null-and-diagnostic"
  });
}

function reportTemplate(plan: ProgramPlan): string {
  return `# report.template

Sections are data-driven by \`src/report.ts\`.

Target: ${plan.intent.shape.target.label}
Validation: \`${plan.test.command} ${plan.test.args.join(" ")}\`
`;
}

function readme(plan: ProgramPlan, input: ProgramPlannerInput): string {
  return `# ${artifactTitle(plan.intent.shape.target)}

Episode: ${input.episodeId}

Plan: ${plan.id}

Target: ${plan.intent.shape.target.label}

Runtime: ${plan.intent.shape.runtimeTarget}

Language: ${plan.intent.shape.target.language}

Validation command: \`${plan.test.command} ${plan.test.args.join(" ")}\`

This artifact is generated from the local ProgramGraph. It includes the selected shape, energy terms, evidence refs, source-version refs, and validation path. Build and execution results must be inspected in the runtime event ledger after running validation.
`;
}

function artifactTitle(target: ProgramTargetProfile): string {
  return target.label || target.id;
}

function domainModels(shape: ProgramShape): JsonValue {
  return toJsonValue([
    { id: "InputRecord", fields: shape.requiredInputs.map(input => ({ name: input.id, mediaType: input.mediaType, required: input.required })) },
    { id: "OutputRecord", fields: shape.requiredOutputs.map(output => ({ name: output.id, mediaType: output.mediaType, required: output.required })) },
    { id: "Diagnostic", fields: ["severity", "message", "field", "evidenceRef"] }
  ]);
}

function operationsFor(shape: ProgramShape): JsonValue {
  const base = [
    { id: "parse-input", inputs: shape.requiredInputs.map(item => item.id), outputs: ["parsed-records"], sideEffects: [] },
    { id: "validate-records", inputs: ["parsed-records"], outputs: ["diagnostics"], sideEffects: [] }
  ];
  if (hasCapability(shape.target, "capability:validated-transform")) base.push({ id: "transform-records", inputs: ["parsed-records"], outputs: ["transformed-json"], sideEffects: [] });
  if (hasCapability(shape.target, "capability:prose-report")) base.push({ id: "render-report", inputs: ["parsed-records"], outputs: ["markdown"], sideEffects: [] });
  if (hasCapability(shape.target, "capability:browser-render")) base.push({ id: "render-interactive-surface", inputs: ["browser-interaction"], outputs: ["interactive-surface"], sideEffects: ["dom-render"] as unknown as never[] });
  if (hasCapability(shape.target, "capability:command-runtime")) base.push({ id: "run-command", inputs: ["argv", "stdin"], outputs: ["command-result"], sideEffects: ["stdout"] as unknown as never[] });
  if (hasCapability(shape.target, "capability:pure-call")) base.push({ id: "evaluate", inputs: ["library-call"], outputs: ["return-value"], sideEffects: [] });
  return toJsonValue(base);
}

function interfacesFor(shape: ProgramShape): JsonValue {
  return toJsonValue([
    { id: "runtime", target: shape.runtimeTarget },
    { id: "entrypoint", path: entrypointFor(shape) },
    ...shape.requiredInputs.map(input => ({ id: `input:${input.id}`, source: input.source, mediaType: input.mediaType })),
    ...shape.requiredOutputs.map(output => ({ id: `output:${output.id}`, target: output.target, mediaType: output.mediaType }))
  ]);
}

function dependenciesFor(shape: ProgramShape, codeGraph: CodeKnowledgeGraph): JsonValue {
  const runtimeDependency = shape.target.packageManager && shape.target.packageManager !== "source-derived" && shape.target.packageManager !== "source.unresolved"
    ? [{ name: shape.target.packageManager, version: "*", reason: "source-observed package command surface", required: true }]
    : [];
  return toJsonValue([
    ...runtimeDependency,
    ...codeGraph.dependencies.slice(0, 16).map(dep => ({ name: dep.packageName, version: "*", reason: dep.purpose, support: dep.support, required: false }))
  ]);
}

function requiredFields(shape: ProgramShape): string[] {
  const fromFields = shape.requestedStructures
    .filter(item => item.startsWith("field:"))
    .map(item => item.slice("field:".length))
    .filter((item): item is string => Boolean(item));
  if (fromFields.length) return [...new Set(fromFields)].slice(0, 12);
  const fromStructures = shape.requestedStructures
    .filter(item => item.startsWith("symbol:"))
    .map(item => symbolRoot(item.slice("symbol:".length)))
    .filter((item): item is string => Boolean(item));
  if (fromStructures.length) return [...new Set(fromStructures)].slice(0, 12);
  if (hasCapability(shape.target, "capability:validated-transform")) return ["id", "value", "type"];
  if (hasCapability(shape.target, "capability:prose-report")) return ["title", "value", "status"];
  return ["value"];
}

function reportSections(shape: ProgramShape): JsonValue {
  return toJsonValue([
    { kind: "summary", title: "report.section.summary" },
    { kind: "table", title: "report.section.records", fields: requiredFields(shape).slice(0, 6) },
    { kind: "details", title: "report.section.details" }
  ]);
}

function webAppModel(plan: ProgramPlan, input: ProgramPlannerInput): JsonValue {
  const signalCards = plan.codeGraph.signals.slice(0, 12).map((signal, index) => ({
    id: `signal-${index}`,
    kind: "evidence",
    title: signal.kind,
    detail: signal.text,
    tags: [signal.language, `confidence:${signal.confidence.toFixed(2)}`],
    evidenceIds: [String(signal.evidenceId)]
  }));
  const interactionCards = plan.intent.shape.requestedStructures.slice(0, 12).map((item, index) => ({
    id: `interaction-${index}`,
    kind: "interaction",
    title: item,
    detail: "request-derived interaction primitive",
    tags: ["request", plan.intent.shape.target.id],
    evidenceIds: input.entailment.evidenceIds.slice(0, 4).map(String)
  }));
  const evidenceCards = input.evidence.slice(0, 8).map((span, index) => ({
    id: `evidence-${index}`,
    kind: "evidence",
    title: String(span.sourceVersionId),
    detail: span.textPreview,
    tags: [`alpha:${span.alpha.toFixed(2)}`, span.status],
    evidenceIds: [String(span.id)]
  }));
  const cards = [...signalCards, ...interactionCards, ...evidenceCards].slice(0, 32);
  return toJsonValue({
    title: titleFromRequest(input.requestText, plan),
    kicker: "source-backed interactive app",
    confidence: plan.codeGraph.confidence,
    cards: cards.length ? cards : [{
      id: "empty",
      kind: "interaction",
      title: "empty-state",
      detail: "no source-backed cards were available",
      tags: ["empty"],
      evidenceIds: []
    }]
  });
}

function buildCommand(shape: ProgramShape, files: readonly ProgramFilePlan[]): { command: string; args: string[]; cwd: string } {
  const observed = commandFromHints(shape, ["script.build", "script.validation"]);
  if (observed) return observed;
  const source = emittedRuntimeFile(files, "source");
  if (!source) return { command: "source-derived", args: ["op.build", shape.target.entrypoint], cwd: "." };
  const runtime = emittedRuntimeForShape(shape);
  return { command: runtime.commandName, args: [...runtime.syntaxCheckArgs, source], cwd: "." };
}

function testCommand(shape: ProgramShape, files: readonly ProgramFilePlan[]): { command: string; args: string[]; cwd: string } {
  const observed = commandFromHints(shape, ["script.validation", "script.build"]);
  if (observed) return observed;
  const test = emittedRuntimeFile(files, "test");
  if (!test) return { command: "source-derived", args: ["op.validate", shape.target.entrypoint], cwd: "." };
  return { command: emittedRuntimeForShape(shape).commandName, args: [test], cwd: "." };
}

/** The planned artifact the emitted runtime can load, which is what its own command has to name. */
function emittedRuntimeFile(files: readonly ProgramFilePlan[], role: ProgramFilePlan["role"]): string | undefined {
  return files.find(file => file.role === role && [".mjs", ".py"].some(extension => file.path.endsWith(extension)))?.path;
}

function commandFromHints(shape: ProgramShape, preferredKinds: readonly string[]): { command: string; args: string[]; cwd: string } | undefined {
  const hints = commandHintsFromTarget(shape.target);
  const selected = preferredCommandHint(hints, preferredKinds) ?? hints[0];
  const manager = shape.target.packageManager;
  if (selected && manager && manager !== "source-derived" && manager !== "source.unresolved" && manager !== "source-script") {
    return { command: manager, args: ["run", selected.name], cwd: "." };
  }
  if (selected?.command && manager === "source-script") {
    return { command: "source-script", args: [selected.name, selected.command], cwd: "." };
  }
  return undefined;
}

function preferredCommandHint(hints: readonly CommandHint[], preferredKinds: readonly string[]): CommandHint | undefined {
  for (const kind of preferredKinds) {
    const selected = hints.filter(hint => hint.kind === kind).sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))[0];
    if (selected) return selected;
  }
  return undefined;
}

function entrypointFor(shape: ProgramShape): string {
  if (nodeRuntimeForShape(shape)) {
    if (hasCapability(shape.target, "capability:browser-render")) return "src/main.tsx";
    if (hasCapability(shape.target, "capability:command-runtime")) return "src/cli.ts";
    if (hasCapability(shape.target, "capability:log-parse")) return "src/log-parser.ts";
    if (hasCapability(shape.target, "capability:validated-transform")) return "src/transform.ts";
    if (hasCapability(shape.target, "capability:interface-runtime")) return "src/api-handler.ts";
    if (hasCapability(shape.target, "capability:pure-call")) return "src/index.ts";
    return shape.target.entrypoint || "src/main.txt";
  }
  // No package toolchain was observed, so the entrypoint is the artifact this plan actually emits and runs.
  return emittedRuntimeForShape(shape).sourcePath;
}

function emittedRuntimeForShape(shape: ProgramShape): EmittedProgramRuntime {
  return emittedProgramRuntimeForLanguage(shape.target.language);
}

function nodeRuntimeForShape(shape: ProgramShape): boolean {
  if (shape.runtimeTarget === "runtime.browser" || shape.runtimeTarget === "runtime.node") return true;
  if (!shape.runtimeTarget.startsWith("runtime.package:")) return false;
  const manager = packageManagerCommandName(shape.target.packageManager);
  return manager === "pnpm" || manager === "npm" || manager === "yarn" || manager === "bun";
}

function mediaTypeForCodeFile(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".md")) return "text/markdown";
  const ext = extensionFromPath(filePath);
  if (ext) return `text/x-source-${safeIdentifier(ext.slice(1))}`;
  return "text/plain";
}

function artifact(path: string, mediaType: string, content: string, role: FileArtifact["role"], idFactory: IdFactory, hasher: Hasher): FileArtifact {
  const hash = `sha256_${hasher.digestHex(content)}` as ContentHash;
  return { artifactId: idFactory.artifactId({ path, hash, role }), path, mediaType: mediaType || mediaTypeForCodeFile(path), content, contentHash: hash, role };
}

function normalizeField(value: string): string {
  const out: string[] = [];
  let previousUnderscore = false;
  for (const char of value.normalize("NFKC")) {
    if (isIdentifierLike(char)) {
      out.push(char.toLocaleLowerCase());
      previousUnderscore = false;
    } else if (!previousUnderscore && out.length) {
      out.push("_");
      previousUnderscore = true;
    }
  }
  while (out[out.length - 1] === "_") out.pop();
  return out.join("") || "value";
}

function numericFieldHint(value: string): boolean {
  const symbols = wordsFromText(value).map(item => item.toLocaleLowerCase());
  const hints = new Set(["count", "total", "amount", "score", "value", "number", "qty", "quantity"]);
  return symbols.some(symbol => hints.has(symbol));
}

function isIdentifierLike(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp === 95 || cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && char.trim() !== "";
}

function isIdentifierStart(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp === 95 || cp === 36 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && char.trim() !== "";
}

function hasCapability(target: ProgramTargetProfile, capability: string): boolean {
  return target.capabilities.includes(capability);
}

function hasAnyCapability(target: ProgramTargetProfile, capabilities: readonly string[]): boolean {
  return capabilities.some(capability => hasCapability(target, capability));
}

function slugFromParts(parts: readonly string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    let current = "";
    for (const char of part.normalize("NFKC").toLocaleLowerCase()) {
      if (isAsciiSlugChar(char)) current += char;
      else if (current) {
        out.push(current);
        current = "";
      }
    }
    if (current) out.push(current);
  }
  return out.slice(0, 8).join("-") || "generated-program";
}

function isAsciiSlugChar(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp >= 48 && cp <= 57 || cp >= 97 && cp <= 122;
}

function safeIdentifier(value: string): string {
  const out: string[] = [];
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    if (isAsciiSlugChar(char)) out.push(char);
    else if (char === "." || char === "-" || char === "_") out.push("_");
  }
  const joined = out.join("");
  return joined || "source";
}

function extensionFromPath(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf(".");
  return dot > 0 && dot < file.length - 1 ? file.slice(dot).toLocaleLowerCase() : undefined;
}

function scoreBool(value: boolean): number {
  return value ? 1 : 0;
}

function learnedDependency(codeGraph: CodeKnowledgeGraph, names: readonly string[]): number {
  let score = 0;
  for (const name of names) {
    const lower = name.toLocaleLowerCase();
    const dep = codeGraph.dependencies.find(item => item.packageName.toLocaleLowerCase() === lower);
    if (dep) score += dep.support;
    if (codeGraph.signals.some(signal => signal.normalized === lower || signal.normalized.includes(lower))) score += 0.18;
  }
  return clamp01(score / Math.max(1, names.length));
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

function titleFromRequest(text: string, plan: ProgramPlan): string {
  const words = wordsFromText(text);
  const title = words.slice(0, 6).map(capitalize).join(" ");
  return title || artifactTitle(plan.intent.shape.target);
}

function wordsFromText(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text.normalize("NFKC")) {
    const cp = char.codePointAt(0) ?? 0;
    const letterOrDigit = cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && char.trim() !== "";
    if (letterOrDigit) current += char;
    else if (current) {
      out.push(current);
      current = "";
    }
    if (out.length >= 24) break;
  }
  if (current) out.push(current);
  return out;
}

function capitalize(value: string): string {
  return value ? `${value.slice(0, 1).toLocaleUpperCase()}${value.slice(1)}` : value;
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
