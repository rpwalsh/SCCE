import { type CandidateField, type CandidateSurface } from "./candidate.js";
import { type DialogueState } from "./dialogue-pragmatics.js";
import { jsonRecord, kernelNumber, kernelString, kernelStringArray, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { cognitiveTopicForRequest } from "./learned-graph-prior-runtime.js";
import { type InventionConstruct } from "./prediction.js";
import { redactSecrets, sourceTextSurface, toJsonValue } from "./primitives.js";
import { graphNodePriorClass, isLearnedPriorClass } from "./proof-boundary.js";
import { collapseSurfaceWhitespace, ensureSurfaceSentence as ensureUnicodeSurfaceSentence, surfaceWords } from "./surface-linguistics.js";
import {
  type TurnRequirementField
} from "./turn-requirements.js";
import type {
  ConstructGraph,
  EvidenceSpan,
  FieldState,
  GraphSlice,
  JsonValue,
  RequestedAuthority
} from "./types.js";



export type RuntimeReplanTrigger = "authority_family_unavailable" | "coherence_support_failure";


export interface RuntimeReplanMotion {
  schema: "scce.runtime_motion.learn_hydrate_replan.v1";
  motionId: "motion.learn_hydrate_replan";
  guardId: string;
  attempt: 1;
  trigger: RuntimeReplanTrigger;
  requestedAuthority: RequestedAuthority;
  parentEpisodeId: string;
  queryHash: string;
  connectorConfigured: boolean;
  status: "hydrated" | "empty" | "unavailable" | "failed";
  searchResultCount: number;
  fetchedSourceCount: number;
  ingestedSourceCount: number;
  ingestedEvidenceCount: number;
  sourceUris: string[];
  sourceSurfaces: string[];
  failures: string[];
}


export const RUNTIME_TERMINAL_INVENTION_POLICY_ID = "policy.runtime_motion.prior_invention_after_exhausted_acquisition.v1";


export function attachRuntimeDiagnosticConstruct(input: {
  construct: ConstructGraph;
  enabled: boolean;
  requestText: string;
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
  locale?: string;
}): ConstructGraph {
  if (!input.enabled) return input.construct;
  const marker = jsonRecord(input.brainMarker);
  const graphPriorCount = kernelNumber(marker.importedGraphPriorCount);
  const languagePriorCount = kernelNumber(marker.importedLanguagePriorCount);
  const programPriorCount = kernelNumber(marker.importedProgramPriorCount);
  const nodeId = `construct:runtime-diagnostic:${input.hasher.digestHex(input.requestText).slice(0, 20)}`;
  const semanticFacts = runtimeDiagnosticSemanticFacts({ graphPriorCount, languagePriorCount, programPriorCount });
  return {
    ...input.construct,
    nodes: [
      ...input.construct.nodes.filter(node => node.kind !== "construct:runtime_diagnostic"),
      {
        id: nodeId,
        kind: "construct:runtime_diagnostic",
        label: "construct.runtime_diagnostic",
        metadata: toJsonValue({
           schema: "scce.runtime_diagnostic_construct.v1",
           semanticFacts,
           forceId: "output.force.import_bound",
          priorCounts: {
            graphPriorCount,
            languagePriorCount,
            programPriorCount
          },
          runtimeBoundary: "learned_priors_are_speakable_not_certifying",
          requestedCorrection: "do_not_bind_system_questions_to_world_graph_subjects"
        })
      }
    ],
    edges: [
      ...input.construct.edges,
      { source: nodeId, target: input.construct.nodes[0]?.id ?? "request", relation: "explains_runtime_boundary", weight: 0.86 }
    ]
  };
}


export function attachRuntimeMotionConstruct(input: {
  construct: ConstructGraph;
  requestText: string;
  motion?: RuntimeReplanMotion;
  answerSurface?: string;
  hasher: { digestHex(input: string | Uint8Array): string };
}): ConstructGraph {
  if (!input.motion) return input.construct;
  const answerSurface = input.answerSurface?.trim() || runtimeMotionFocusSurface(input.requestText);
  const nodeId = `construct:runtime-motion:${input.hasher.digestHex(`${input.motion.guardId}\u001f${answerSurface}`).slice(0, 20)}`;
  const removedNodeIds = new Set(input.construct.nodes.filter(node => node.kind === "construct:runtime_diagnostic").map(node => node.id));
  const semanticFacts = [
    {
      subjectId: `request:${input.motion.queryHash}`,
      relationId: "motion.requires_resolution",
      objectId: `focus:${input.hasher.digestHex(answerSurface).slice(0, 20)}`,
      sourceLabel: answerSurface
    },
    {
      subjectId: input.motion.motionId,
      relationId: "motion.acquisition_status",
      objectId: `state.acquisition.${input.motion.status}.v1`
    },
    {
      subjectId: input.motion.motionId,
      relationId: "motion.requested_authority",
      objectId: `authority.${input.motion.requestedAuthority}`
    }
  ];
  return {
    ...input.construct,
    nodes: [
      ...input.construct.nodes.filter(node => !removedNodeIds.has(node.id)),
      {
        id: nodeId,
        // The existing Mouth recognizes this construct boundary; the schema
        // distinguishes a continuation motion from a runtime diagnostic.
        kind: "construct:runtime_diagnostic",
        label: input.motion.motionId,
        metadata: toJsonValue({
          schema: "scce.runtime_motion_construct.v1",
          motionId: input.motion.motionId,
          answerSurface,
          semanticFacts,
          semanticFrame: {
            frameId: "semantic.runtime.motion.clarification.v1",
            roleBindings: {
              focusId: semanticFacts[0]?.objectId ?? null,
              authorityId: `authority.${input.motion.requestedAuthority}`,
              acquisitionStateId: `state.acquisition.${input.motion.status}.v1`
            },
            stateIds: ["state.dialogue.slot_resolution.pending.v1"]
          },
          forceId: "output.force.non_assertive_clarification",
          runtimeBoundary: "motion.learn_hydrate_replan.exhausted",
          evidenceIds: [],
          fakeEvidenceForbidden: true,
          motion: input.motion
        })
      }
    ],
    edges: [
      ...input.construct.edges.filter(edge => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target)),
      { source: nodeId, target: input.construct.nodes.find(node => !removedNodeIds.has(node.id))?.id ?? "request", relation: "realizes_runtime_motion", weight: 1 }
    ]
  };
}


export function explicitRuntimeDiagnosticRequest(metadata: JsonValue | undefined): boolean {
  const record = jsonRecord(metadata);
  const control = jsonRecord(record.control);
  return record.runtimeDiagnostic === true || control.runtimeDiagnostic === true;
}


export function fastRuntimeBudgetRequested(metadata: JsonValue | undefined): boolean {
  const record = jsonRecord(metadata);
  const runtime = jsonRecord(record.runtime);
  return record.fastLocalEvidenceAnswer === true || runtime.fastLocalEvidenceAnswer === true;
}


export function previousDialogueStateFromMetadata(metadata: JsonValue | undefined): DialogueState | undefined {
  const record = jsonRecord(metadata);
  const dialogue = jsonRecord(record.dialogue);
  const state = jsonRecord(dialogue.previousState ?? record.previousDialogueState);
  const profile = jsonRecord(state.userStyleProfile);
  if (
    typeof state.conversationId !== "string"
    || typeof state.turnId !== "string"
    || typeof state.currentIntentId !== "string"
    || !Array.isArray(state.unresolvedSlots)
    || !Array.isArray(state.establishedFacts)
    || !Array.isArray(state.rejectedAssumptions)
    || !Array.isArray(state.interactionFeatures)
    || !Array.isArray(state.interactionSignals)
    || !Array.isArray(state.continuityLinks)
    || profile.schema !== "scce.dialogue.policy_profile.v1"
  ) return undefined;
  return state as unknown as DialogueState;
}


 function runtimeDiagnosticSemanticFacts(input: { graphPriorCount: number; languagePriorCount: number; programPriorCount: number }) {
  return [
    { subjectId: "runtime.scce", relationId: "runtime.routes_through", objectId: "component.kernel", ordinal: 1 },
    { subjectId: "runtime.scce", relationId: "runtime.routes_through", objectId: "component.graph_memory", ordinal: 2 },
    { subjectId: "runtime.scce", relationId: "runtime.routes_through", objectId: "component.mouth", ordinal: 3 },
    { subjectId: "runtime.scce", relationId: "runtime.prior_count", objectId: "prior.graph", value: input.graphPriorCount },
    { subjectId: "runtime.scce", relationId: "runtime.prior_count", objectId: "prior.language", value: input.languagePriorCount },
    { subjectId: "runtime.scce", relationId: "runtime.prior_count", objectId: "prior.program", value: input.programPriorCount }
  ];
}


export function uniqueInventionConstructs(rows: readonly InventionConstruct[]): InventionConstruct[] {
  const byId = new Map<string, InventionConstruct>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}


export function runtimeTerminalInventionPriorContext(input: {
  graph: GraphSlice;
  field: FieldState;
  languageMemoryState: LanguageMemoryRuntimeState;
  requirementField: TurnRequirementField;
}): { graph: GraphSlice; languageMemoryState: LanguageMemoryRuntimeState; eligiblePriorIds: ReadonlySet<string> } | undefined {
  const activeNodeIds = new Set(input.field.active.map(row => String(row.nodeId)));
  const graphNodes = input.graph.nodes.filter(node => activeNodeIds.has(String(node.id)) && isLearnedPriorClass(graphNodePriorClass(node)));
  const graphNodeIds = new Set(graphNodes.map(node => String(node.id)));
  const graphEdges = input.graph.edges.filter(edge => graphNodeIds.has(String(edge.source)) && graphNodeIds.has(String(edge.target)));
  const activeLanguageIds = new Set([
    ...input.requirementField.activatedFrameIds,
    ...input.requirementField.activatedPatternIds,
    ...input.requirementField.activatedPhraseUnitIds
  ]);
  const importedUnits = input.languageMemoryState.importedUnits.filter(row => activeLanguageIds.has(row.id));
  const importedPatterns = input.languageMemoryState.importedPatterns.filter(row => activeLanguageIds.has(row.id));
  const importedSemanticFrames = input.languageMemoryState.importedSemanticFrames.filter(row => activeLanguageIds.has(row.id));
  const eligiblePriorIds = new Set([
    ...graphNodeIds,
    ...importedUnits.map(row => row.id),
    ...importedPatterns.map(row => row.id),
    ...importedSemanticFrames.map(row => row.id)
  ]);
  if (!eligiblePriorIds.size) return undefined;
  return {
    graph: {
      ...input.graph,
      nodes: graphNodes,
      edges: graphEdges,
      hyperedges: []
    },
    languageMemoryState: {
      ...input.languageMemoryState,
      importedUnits,
      importedPatterns,
      importedObservations: [],
      importedSemanticFrames,
      importedLanguagePriorCount: importedUnits.length + importedPatterns.length + importedSemanticFrames.length
    },
    eligiblePriorIds
  };
}


export function runtimeTerminalInventionIsAdmissible(input: {
  invention: InventionConstruct;
  requestText: string;
  eligiblePriorIds: ReadonlySet<string>;
}): boolean {
  if (input.invention.proofStatusId !== "proof.status.generated_not_evidence" || input.invention.basisEvidenceIds.length) return false;
  const trace = jsonRecord(input.invention.trace);
  const selectedPriorIds = [
    ...kernelStringArray(trace.selectedGraphNodeIds),
    ...kernelStringArray(trace.selectedLanguagePriorIds)
  ];
  if (!selectedPriorIds.some(id => input.eligiblePriorIds.has(id))) return false;
  if (kernelNumber(trace.unsupportedFactualAssertion) > 0 || kernelNumber(trace.risk) > 0.66) return false;
  const proposalRealization = jsonRecord(trace.proposalRealization);
  const repetitionPenalty = kernelNumber(proposalRealization.repetitionPenalty, Number.POSITIVE_INFINITY);
  if (proposalRealization.path !== "learned_continuation") return false;
  if (!kernelStringArray(proposalRealization.sourcePieceIds).length) return false;
  if (repetitionPenalty < 0 || repetitionPenalty >= 0.5) return false;
  const claimBasis = Array.isArray(trace.claimBasis) ? trace.claimBasis.map(row => jsonRecord(row)) : [];
  if (!claimBasis.some(row => row.kind === "invention" && row.force === "invented")) return false;
  if (claimBasis.some(row => row.kind === "factual_premise" || kernelStringArray(row.evidenceIds).length > 0)) return false;
  const requestUnits = new Set(surfaceWords(input.requestText).map(unit => unit.toLocaleLowerCase()));
  const proposalUnits = uniqueKernelStrings(surfaceWords(input.invention.proposalSurface).map(unit => unit.toLocaleLowerCase()));
  const novelUnits = proposalUnits.filter(unit => !requestUnits.has(unit));
  const normalizedRequest = uniqueKernelStrings([...requestUnits]).join(" ");
  const normalizedProposal = proposalUnits.join(" ");
  return proposalUnits.length >= 4 && novelUnits.length >= 2 && normalizedProposal !== normalizedRequest;
}


export function runtimeCandidateReplanTrigger(
  field: CandidateField,
  authority: RequestedAuthority,
  evidence: readonly EvidenceSpan[]
): RuntimeReplanTrigger | undefined {
  if (field.candidates.length === 0) return "authority_family_unavailable";
  if (authority !== "factual" && authority !== "reasoned") return undefined;
  const hasEvidenceRoute = evidence.length > 0 || field.candidates.some(candidate => candidate.evidenceIds.length > 0);
  const hasSemanticSurface = field.candidates.some(candidate => candidate.answer.trim().length > 0);
  const support = Math.max(0, ...field.candidates.map(candidate => candidate.scores.support));
  return !hasSemanticSurface || !hasEvidenceRoute && support < 0.18
    ? "coherence_support_failure"
    : undefined;
}


export function runtimeMotionCandidateField(input: {
  base: CandidateField;
  requestText: string;
  authority: RequestedAuthority;
  motion: RuntimeReplanMotion;
  inventionCandidate?: CandidateSurface;
  unresolvedSlots?: readonly string[];
  learnedLanguageFrameIds?: readonly string[];
  hasher: { digestHex(input: string | Uint8Array): string };
}): CandidateField {
  if (input.inventionCandidate?.kind === "creative-candidate" && input.inventionCandidate.force === "invented" && input.inventionCandidate.evidenceIds.length === 0) {
    const priorAudit = jsonRecord(input.base.audit);
    const candidateAudit = jsonRecord(input.inventionCandidate.audit);
    const constructId = kernelString(candidateAudit.constructId);
    const candidate: CandidateSurface = {
      ...input.inventionCandidate,
      id: `runtime-motion:${input.motion.guardId}:${input.inventionCandidate.id}`,
      evidenceIds: [],
      constructIds: uniqueKernelStrings([...(input.inventionCandidate.constructIds ?? []), ...(constructId ? [constructId] : [])]),
      claimBases: ["invented"],
      boundaries: uniqueKernelStrings([
        ...input.inventionCandidate.boundaries,
        "runtime-motion-acquisition-exhausted",
        "runtime-motion-prior-conditioned-invention",
        "runtime-motion-no-fabricated-evidence"
      ]),
      audit: toJsonValue({
        ...candidateAudit,
        schema: "scce.runtime_motion_invention_candidate.v1",
        runtimeMotion: input.motion,
        runtimePolicyId: RUNTIME_TERMINAL_INVENTION_POLICY_ID,
        requestedAuthority: input.authority,
        claimBases: ["invented"],
        externalFactCertification: false,
        generatedMaterialUsesEvidenceAsAuthority: false,
        fakeEvidenceForbidden: true
      })
    };
    return {
      ...input.base,
      candidates: [candidate],
      surfaceMass: [{ candidateId: candidate.id, mass: 1, reason: "runtime prior-conditioned invention" }],
      scoreTrace: candidate.scoreTrace ?? [],
      audit: toJsonValue({
        ...priorAudit,
        runtimeMotion: input.motion,
        runtimeMotionCandidate: candidate.audit,
        authorityAdmission: {
          schema: "scce.requested_authority.candidate_admission.v1",
          authority: input.authority,
          authorityUnavailable: input.base.candidates.length === 0,
          admittedCandidateIds: [candidate.id],
          continuationCandidateIds: [candidate.id],
          fallbackToGeneratedField: false,
          unrelatedAuthorityFallback: false,
          inventedTerminalContinuation: true,
          runtimePolicyId: RUNTIME_TERMINAL_INVENTION_POLICY_ID
        }
      })
    };
  }
  const answer = runtimeMotionFocusSurface(
    input.requestText,
    input.unresolvedSlots,
    input.motion.sourceSurfaces,
    input.motion.sourceUris
  );
  const focusId = `focus:${input.hasher.digestHex(answer).slice(0, 20)}`;
  const unresolvedSlotIds = uniqueKernelStrings((input.unresolvedSlots ?? []).filter(Boolean)).slice(0, 12);
  const learnedLanguageFrameIds = uniqueKernelStrings((input.learnedLanguageFrameIds ?? []).filter(Boolean)).slice(0, 24);
  const candidate: CandidateSurface = {
    id: `runtime-motion:${input.motion.guardId}`,
    kind: "dialogue-continuation",
    answer,
    force: "unknown",
    evidenceIds: [],
    scores: {
      support: 0,
      contradiction: 0,
      faithfulness: 1,
      alphaPressure: 0,
      actionability: 0.48,
      evidenceCoverage: 0,
      novelty: 0,
      realizability: 1,
      usefulness: 0.68,
      risk: 0,
      unsupportedFactualAssertion: 0
    },
    constructIds: [],
    claimBases: [],
    satisfiedRequirementIds: [],
    missedRequirementIds: unresolvedSlotIds,
    boundaries: [
      "runtime-motion-non-assertive",
      "runtime-motion-acquisition-exhausted",
      "runtime-motion-no-fabricated-evidence"
    ],
    audit: toJsonValue({
      schema: "scce.runtime_motion_candidate.v1",
      source: "kernel.runtime_decision_boundary",
      motion: input.motion,
      semanticFrame: {
        frameId: "semantic.runtime.motion.clarification.v1",
        roleBindings: {
          focusId,
          requestedAuthorityId: `authority.${input.authority}`,
          unresolvedSlotIds,
          learnedLanguageFrameIds
        },
        stateIds: ["state.dialogue.slot_resolution.pending.v1"]
      },
      surfaceBasis: {
        source: "request_and_dialogue_slots",
        requestHash: input.motion.queryHash,
        unresolvedSlotIds,
        learnedLanguageFrameIds
      },
      externalFactCertification: false,
      fakeEvidenceForbidden: true
    })
  };
  const priorAudit = jsonRecord(input.base.audit);
  return {
    ...input.base,
    candidates: [candidate],
    surfaceMass: [{ candidateId: candidate.id, mass: 1, reason: "runtime motion continuation" }],
    scoreTrace: [],
    audit: toJsonValue({
      ...priorAudit,
      runtimeMotion: input.motion,
      runtimeMotionCandidate: candidate.audit,
      authorityAdmission: {
        schema: "scce.requested_authority.candidate_admission.v1",
        authority: input.authority,
        authorityUnavailable: input.base.candidates.length === 0,
        admittedCandidateIds: [],
        continuationCandidateIds: [candidate.id],
        fallbackToGeneratedField: false,
        unrelatedAuthorityFallback: false
      }
    })
  };
}


 function runtimeMotionFocusSurface(
  requestText: string,
  unresolvedSlots: readonly string[] = [],
  sourceSurfaces: readonly string[] = [],
  sourceUris: readonly string[] = []
): string {
  const normalizedTopic = cognitiveTopicForRequest(requestText);
  const topic = requestSurfaceCase(normalizedTopic, requestText);
  const slotSurfaces = unresolvedSlots
    .map(runtimeMotionSlotSurface)
    .filter(Boolean)
    .slice(0, 3);
  const detail = uniqueKernelStrings([
    ...sourceSurfaces.map(surface => sourceTextSurface(surface, 320)),
    ...slotSurfaces,
    ...sourceUris.slice(0, 2)
  ])
    .slice(0, 3);
  const boundedLead = [...topic].slice(0, 120).join("").trim();
  const boundedDetail = detail.map(value => [...value].slice(0, 80).join("").trim()).filter(Boolean);
  const semanticSurface = uniqueKernelStrings([boundedLead, ...boundedDetail]).filter(Boolean).join(": ");
  return ensureUnicodeSurfaceSentence(semanticSurface);
}


 function requestSurfaceCase(value: string, requestText: string): string {
  if (!value) return "";
  const index = requestText.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
  return index >= 0 ? requestText.slice(index, index + value.length) : value;
}


 function runtimeMotionSlotSurface(value: string): string {
  const clean = collapseSurfaceWhitespace(value).trim();
  if (!clean) return "";
  if (/^(?:slot|state|role|feat|operator|semantic|authority)[.:_-]/iu.test(clean)) return "";
  return clean;
}


export function metadataWithRuntimeReplanMotion(metadata: JsonValue | undefined, motion: RuntimeReplanMotion): JsonValue {
  const record = jsonRecord(metadata);
  return toJsonValue({
    ...record,
    ...(!metadata || typeof metadata === "object" && !Array.isArray(metadata) ? {} : { ownerMetadata: metadata }),
    runtimeMotion: motion
  });
}


export function runtimeReplanMotionFromMetadata(metadata: JsonValue | undefined, expectedQueryHash: string): RuntimeReplanMotion | undefined {
  const row = jsonRecord(jsonRecord(metadata).runtimeMotion);
  if (
    row.schema !== "scce.runtime_motion.learn_hydrate_replan.v1"
    || row.motionId !== "motion.learn_hydrate_replan"
    || row.attempt !== 1
    || row.queryHash !== expectedQueryHash
    || typeof row.guardId !== "string"
    || typeof row.parentEpisodeId !== "string"
  ) return undefined;
  const trigger = row.trigger === "authority_family_unavailable" || row.trigger === "coherence_support_failure"
    ? row.trigger
    : undefined;
  const requestedAuthority = typeof row.requestedAuthority === "string" && ["factual", "reasoned", "creative", "translation", "program", "action"].includes(row.requestedAuthority)
    ? row.requestedAuthority as RequestedAuthority
    : undefined;
  const status = row.status === "hydrated" || row.status === "empty" || row.status === "unavailable" || row.status === "failed"
    ? row.status
    : undefined;
  if (!trigger || !requestedAuthority || !status) return undefined;
  return {
    schema: "scce.runtime_motion.learn_hydrate_replan.v1",
    motionId: "motion.learn_hydrate_replan",
    guardId: row.guardId,
    attempt: 1,
    trigger,
    requestedAuthority,
    parentEpisodeId: row.parentEpisodeId,
    queryHash: expectedQueryHash,
    connectorConfigured: row.connectorConfigured === true,
    status,
    searchResultCount: kernelNumber(row.searchResultCount),
    fetchedSourceCount: kernelNumber(row.fetchedSourceCount),
    ingestedSourceCount: kernelNumber(row.ingestedSourceCount),
    ingestedEvidenceCount: kernelNumber(row.ingestedEvidenceCount),
    sourceUris: Array.isArray(row.sourceUris) ? row.sourceUris.filter((value): value is string => typeof value === "string").slice(0, 3) : [],
    sourceSurfaces: Array.isArray(row.sourceSurfaces) ? row.sourceSurfaces.filter((value): value is string => typeof value === "string").slice(0, 6) : [],
    failures: Array.isArray(row.failures) ? row.failures.filter((value): value is string => typeof value === "string").slice(0, 6) : []
  };
}


export function runtimeMotionFailure(stage: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${stage}: ${redactSecrets(message)}`.slice(0, 320);
}


 function runtimeDiagnosticCounts(value: JsonValue): { graphPriorCount: number; languagePriorCount: number; programPriorCount: number } {
  const marker = jsonRecord(value);
  return {
    graphPriorCount: kernelNumber(marker.importedGraphPriorCount),
    languagePriorCount: kernelNumber(marker.importedLanguagePriorCount),
    programPriorCount: kernelNumber(marker.importedProgramPriorCount)
  };
}
