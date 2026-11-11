// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { attachCognitiveProposal, attachInventionConstruct } from "./candidate-construct-binding.js";
import type { CognitiveProposal } from "./cognitive-planner.js";
import { attachLearnedGraphPriorConstruct } from "./learned-graph-prior-runtime.js";
import {
  attachLocalEvidenceAnswerConstruct,
  attachSourceBoundAnswerConstruct,
  localEvidenceAnswerClaimSurface
} from "./local-evidence-runtime.js";
import type { InventionConstruct } from "./prediction.js";
import {
  attachRuntimeDiagnosticConstruct,
  attachRuntimeMotionConstruct,
  type RuntimeReplanMotion
} from "./runtime-motion.js";
import type { SemanticAnswerConstructFact } from "./semantic-answer-construct.js";
import type {
  ConstructGraph,
  EvidenceSpan,
  GraphSnapshot,
  Hasher,
  JsonValue,
  TurnResult
} from "./types.js";

export type TurnLocalEvidenceAnswer = Parameters<typeof localEvidenceAnswerClaimSurface>[0];

export interface TurnConstructAssemblyInput {
  baseConstruct: ConstructGraph;
  requestText: string;
  brainMarker: JsonValue;
  hasher: Hasher;
  closedClassWords?: ReadonlySet<string>;
  localEvidenceAnswer?: TurnLocalEvidenceAnswer;
  boundFact?: SemanticAnswerConstructFact;
  boundFactEvidence: readonly EvidenceSpan[];
  boundFactIdentitySeed?: string;
  learnedPrior: {
    graph: GraphSnapshot;
    field: TurnResult["field"];
    selectedEvidence: readonly EvidenceSpan[];
  };
  proposal?: CognitiveProposal;
  invention?: InventionConstruct;
  runtimeDiagnostic: {
    enabled: boolean;
    locale?: string;
  };
  runtimeMotion?: {
    motion: RuntimeReplanMotion;
    answerSurface?: string;
  };
}

export interface TurnConstructAssemblyResult {
  construct: ConstructGraph;
}

/**
 * Applies the turn's already-activated construct attachments in production order.
 * This boundary is pure: every language, evidence, graph and runtime-motion input
 * was selected before entry, and no storage or corpus access is available here.
 */
export function assembleTurnConstruct(input: TurnConstructAssemblyInput): TurnConstructAssemblyResult {
  const localSourceContent = input.localEvidenceAnswer
    ? localEvidenceAnswerClaimSurface(input.localEvidenceAnswer)
    : "";
  const localAnswerConstruct = input.runtimeDiagnostic.enabled
    ? input.baseConstruct
    : input.localEvidenceAnswer
      ? attachLocalEvidenceAnswerConstruct({
        construct: input.baseConstruct,
        plan: input.localEvidenceAnswer.plan,
        requestText: input.requestText,
        brainMarker: input.brainMarker,
        hasher: input.hasher,
        closedClassWords: input.closedClassWords,
        selectedAnswer: {
          text: localSourceContent,
          claimText: localSourceContent,
          evidenceIds: input.localEvidenceAnswer.evidence.map(span => String(span.id))
        },
        additionalFacts: input.boundFact ? [input.boundFact] : undefined,
        additionalEvidence: input.boundFact ? input.boundFactEvidence : undefined
      })
      : input.boundFact
        ? attachSourceBoundAnswerConstruct({
          construct: input.baseConstruct,
          requestText: input.requestText,
          brainMarker: input.brainMarker,
          hasher: input.hasher,
          facts: [input.boundFact],
          evidence: input.boundFactEvidence,
          identitySeed: input.boundFactIdentitySeed
        })
        : input.baseConstruct;

  // A diagnostic turn deliberately bypasses source-answer and learned-prior attachments.
  const priorConstruct = input.runtimeDiagnostic.enabled
    ? localAnswerConstruct
    : attachLearnedGraphPriorConstruct({
      construct: localAnswerConstruct,
      requestText: input.requestText,
      graph: input.learnedPrior.graph,
      field: input.learnedPrior.field,
      selectedEvidence: input.learnedPrior.selectedEvidence,
      brainMarker: input.brainMarker,
      hasher: input.hasher
    });
  const proposalConstruct = attachCognitiveProposal({
    construct: priorConstruct,
    proposal: input.proposal
  });
  const inventionConstruct = input.invention
    ? attachInventionConstruct({ construct: proposalConstruct, invention: input.invention })
    : proposalConstruct;
  const diagnosticConstruct = attachRuntimeDiagnosticConstruct({
    construct: inventionConstruct,
    enabled: input.runtimeDiagnostic.enabled,
    requestText: input.requestText,
    brainMarker: input.brainMarker,
    hasher: input.hasher,
    locale: input.runtimeDiagnostic.locale
  });
  const construct = attachRuntimeMotionConstruct({
    construct: diagnosticConstruct,
    requestText: input.requestText,
    motion: input.runtimeMotion?.motion,
    answerSurface: input.runtimeMotion?.answerSurface,
    hasher: input.hasher
  });
  return { construct };
}
