// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ConstructGraph, EvidenceId, Hasher, JsonValue } from "./types.js";
import type { SemanticAtom } from "./semantic-proof-types.js";
import { atomizeText } from "./semantic-proof-system.js";
import { SEMANTIC_SOURCE } from "./semantic-codes.js";
import { jsonRecord, namedSubjectAnchors, normalizePriorKey, splitPriorUnits } from "./kernel-answer-primitives.js";
import { requestContentEvidenceUnits, requestUnitSharesStem } from "./local-evidence-runtime.js";
import { factualRoundTripGate } from "./semantic-round-trip.js";
import { surfaceWords } from "./surface-linguistics.js";

export interface SemanticAnswerConstructFact {
  subject: string;
  predicate: string;
  object: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationId: string;
  forceClass: string;
  score: number;
  activation: number;
  overlap: number;
  support: number;
  sourceVersionId?: string;
  evidenceIds?: string[];
  roleId?: string;
  alphaRhetoricalCentrality?: number;
  pathScore?: number;
  roleScore?: number;
  bridgeValue?: number;
  backgroundPenalty?: number;
  forceMeaning?: number;
  certificationPower?: number;
  semanticQuality?: number;
  graphQualityClassId?: string;
  answerGrade?: boolean;
  cognitiveEdgeId?: string;
  requestedSlotId?: string;
  relationRoleId?: string;
  topicSenseId?: string;
  finalQuestionFit?: number;
  questionSlotId?: string;
  questionSlotImportance?: string;
  questionSlotScore?: number;
  questionSlotReasonIds?: string[];
}

/** Certification signal a proof stage attaches to a fact: never a bare boolean guess. */
export interface RealizationCertificationBoundary {
  certified?: boolean;
  externallyFactual?: boolean;
}

export type RealizationEpistemicForce = "observed" | "certified" | "inferred";

/**
 * A contract between cognition and language: what a given utterance is REQUIRED to preserve, not another
 * copy of the answer fact. Two independent checks, not one: `requiredAtoms` (the fact's own real, well-formed
 * text, atomized) catches hallucination -- a realized surface asserting something the fact never said.
 * `requiredRelationUnits` (the REQUEST's own obligation, the same units `answerCoversRequest` in
 * local-evidence-runtime.ts already derives for extraction-time gating) catches the OTHER failure:
 * "Apollo 11 was the first spaceflight to land humans on the Moon" fully preserves the fact's own atoms
 * while never answering "When did Apollo 11 land?" -- fabrication-free is not the same as answering the
 * question, and only checking preserved atoms from the fact's own sentence can't tell the two apart. Kept as
 * a plain lexical stem-carried check (not atomized): the request's relation words are often ungrammatical as
 * a standalone fragment once the subject is stripped out, and the atomizer is a real syntactic parser that
 * mis-shapes broken fragments -- exactly the failure mode that made an earlier version of this function
 * reject a genuinely correct answer.
 */
export interface SemanticRealizationContract {
  sourceFact: SemanticAnswerConstructFact;
  requestedSlotId?: string;
  requiredAtoms: SemanticAtom[];
  requiredRelationUnits: string[];
  boundValues: Record<string, string>;
  evidenceIds: string[];
  epistemicForce: RealizationEpistemicForce;
}

/** The request's relation units, with its subject anchors removed: the same subject/relation split answerCoversRequest already makes, reused rather than re-derived. Pure. */
export function requestRelationUnits(requestText: string, closedClassWords?: ReadonlySet<string>): string[] {
  if (!requestText) return [];
  const subjectUnits = new Set(namedSubjectAnchors(requestText)
    .flatMap(anchor => splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean)));
  // The learned request scaffolding ("when", "did") is not a relation an answer restates.
  return requestContentEvidenceUnits(requestText).filter(unit => !subjectUnits.has(unit) && !closedClassWords?.has(unit));
}

function epistemicForceFromFact(fact: SemanticAnswerConstructFact, certificationBoundary?: RealizationCertificationBoundary): RealizationEpistemicForce {
  if (certificationBoundary?.certified && fact.forceClass === "direct_evidence") return "certified";
  if (certificationBoundary?.certified || certificationBoundary?.externallyFactual) return "observed";
  return "inferred";
}

/**
 * Compiles a SemanticRealizationContract from the request that asked the question and the fact that answers
 * it. `requiredAtoms` comes from the fact's own real subject+predicate+object text (well-formed, so the real
 * atomizer parses it the same way it would parse a realized candidate saying the same thing) -- this is the
 * hallucination check. `requiredRelationUnits` comes from the request, independently -- this is the
 * answerhood check. Falls back to the fact's own predicate units when the request yields no relation units
 * (e.g. a session-bound assertion, not a question).
 */
export function compileRealizationContract(
  requestText: string,
  fact: SemanticAnswerConstructFact,
  certificationBoundary?: RealizationCertificationBoundary,
  closedClassWords?: ReadonlySet<string>
): SemanticRealizationContract {
  const evidenceIds = fact.evidenceIds ?? [];
  const factText = [fact.subject, fact.predicate, fact.object].filter(Boolean).join(" ").trim();
  const requiredAtoms = factText
    ? atomizeText({ text: factText, source: SEMANTIC_SOURCE.CLAIM, evidenceIds: evidenceIds as EvidenceId[] })
    : [];
  const relationUnits = requestRelationUnits(requestText, closedClassWords);
  const requiredRelationUnits = relationUnits.length ? relationUnits : requestContentEvidenceUnits(fact.predicate);
  const requestedSlotId = fact.requestedSlotId ?? fact.questionSlotId;
  return {
    sourceFact: fact,
    requestedSlotId,
    requiredAtoms,
    requiredRelationUnits,
    boundValues: { [requestedSlotId ?? "value"]: fact.object },
    evidenceIds,
    epistemicForce: epistemicForceFromFact(fact, certificationBoundary)
  };
}

export interface RealizationSurvivalResult {
  survives: boolean;
  reason?: string;
  requiredAtomCount: number;
  addedUnsupportedAtomCount: number;
  requiredRelationUnitCount: number;
  missingRelationUnitCount: number;
  requestedSlotSatisfied: boolean;
}

/** Every surface unit of a candidate answer, lowercased: the same tokenization surfaceWords already gives every other caller comparing surface text against request units. Pure. */
function candidateSurfaceUnits(candidateText: string): string[] {
  return surfaceWords(candidateText).map(word => word.toLocaleLowerCase());
}

/**
 * The two-step contract check: (1) no fabrication -- the realized surface must assert nothing beyond the
 * fact's own real, well-formed subject/predicate/object text (factualRoundTripGate's existing added-atom
 * rule, applied against real sentence text so the atomizer's genuine syntactic parse is comparable on both
 * sides); (2) no missing answerhood -- every unit of the REQUEST's own relation must have a stem-tolerant
 * match in the candidate (requestUnitSharesStem, the same tolerance answerCoversRequest already grants:
 * commanded/commander, land/landed), and the fact's bound value must actually appear in the candidate. A
 * candidate that merely restates the fact's own sentence without the request's relation, or without its
 * value, fails step 2 even though it would pass step 1 alone -- exactly why this is a second, independent
 * check rather than folded into the atom comparison.
 */
export function candidateSurvivesRealizationContract(
  candidateText: string,
  contract: SemanticRealizationContract,
  hasher?: Hasher
): RealizationSurvivalResult {
  const fact = contract.sourceFact;
  const factText = [fact.subject, fact.predicate, fact.object].filter(Boolean).join(" ").trim();
  const fabricationCheck = factualRoundTripGate({ intendedText: factText, realizedText: candidateText, ...(hasher ? { hasher } : {}) });
  const requiredRelationUnitCount = contract.requiredRelationUnits.length;
  if (!fabricationCheck.accepted) {
    return {
      survives: false,
      reason: fabricationCheck.reason,
      requiredAtomCount: contract.requiredAtoms.length,
      addedUnsupportedAtomCount: fabricationCheck.cycleTrace.distance.added.length,
      requiredRelationUnitCount,
      missingRelationUnitCount: requiredRelationUnitCount,
      requestedSlotSatisfied: false
    };
  }
  const surfaceUnits = candidateSurfaceUnits(candidateText);
  const missingRelationUnits = contract.requiredRelationUnits.filter(unit =>
    !surfaceUnits.some(surfaceUnit => requestUnitSharesStem(unit, surfaceUnit)));
  const boundValues = Object.values(contract.boundValues).filter(Boolean);
  const candidateNormalized = candidateText.toLocaleLowerCase();
  const requestedSlotSatisfied = boundValues.every(value => candidateNormalized.includes(value.toLocaleLowerCase()));
  const survives = missingRelationUnits.length === 0 && requestedSlotSatisfied;
  return {
    survives,
    reason: survives ? undefined : missingRelationUnits.length
      ? `realized text is missing ${missingRelationUnits.length} of the request's required relation unit(s): ${missingRelationUnits.join(", ")}`
      : "realized text does not carry the fact's bound value",
    requiredAtomCount: contract.requiredAtoms.length,
    addedUnsupportedAtomCount: fabricationCheck.cycleTrace.distance.added.length,
    requiredRelationUnitCount,
    missingRelationUnitCount: missingRelationUnits.length,
    requestedSlotSatisfied
  };
}

/**
 * A narrower, separate check for a BARE VALUE candidate (a date/time/name, not a sentence): the required-
 * relation-unit check in candidateSurvivesRealizationContract above is right for a generated sentence -- it
 * must restate the relation in words -- but a bare value structurally cannot restate "land" inside "20:17",
 * and it doesn't need to: the value's own answerhood was already verified when it was extracted (near the
 * request's subject, not a citation date -- see extractTemporalAnswerFromEvidence). Real bug, confirmed live:
 * the judge-selected, correct answer "20:17" to "When did Apollo 11 land on the Moon?" failed the sentence-
 * shaped check and was discarded for an unrelated evidence excerpt. Scoped tightly -- the candidate must equal
 * the fact's own bound object exactly, so this can never validate an arbitrary sentence, only the specific
 * bare-value case. No separate atomizer fabrication check: the atomizer parses a bare fragment differently in
 * isolation than embedded in a full sentence (confirmed live -- it false-positived "20:17" against its own
 * source sentence), and is redundant here anyway -- an exact match against the fact's own already-attested
 * object cannot assert anything beyond that fact by construction.
 */
export function candidateIsVerifiedBoundValue(candidateText: string, contract: SemanticRealizationContract): boolean {
  const trimmed = candidateText.trim();
  const object = contract.sourceFact.object.trim();
  return Boolean(trimmed && object && trimmed === object);
}

function stringField(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: JsonValue | undefined): number {
  return typeof value === "number" ? value : 0;
}

function stringArrayField(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Parses one selectedFacts row -- the same scce.semantic_answer_construct.v1 schema mouth.ts's own reader
 *  parses, kept as an independent minimal reader here rather than importing mouth.ts (a large module with
 *  its own private helpers) for the handful of fields compileRealizationContract actually needs. Pure. */
function factFromJson(value: JsonValue): SemanticAnswerConstructFact | undefined {
  const record = jsonRecord(value);
  const subject = stringField(record.subject);
  const predicate = stringField(record.predicate);
  const object = stringField(record.object);
  if (!subject || !predicate || !object) return undefined;
  return {
    subject,
    predicate,
    object,
    sourceNodeId: stringField(record.sourceNodeId),
    targetNodeId: stringField(record.targetNodeId),
    relationId: stringField(record.relationId),
    forceClass: stringField(record.forceClass),
    score: numberField(record.score),
    activation: numberField(record.activation),
    overlap: numberField(record.overlap),
    support: numberField(record.support),
    sourceVersionId: record.sourceVersionId ? stringField(record.sourceVersionId) : undefined,
    evidenceIds: record.evidenceIds ? stringArrayField(record.evidenceIds) : undefined,
    requestedSlotId: record.requestedSlotId ? stringField(record.requestedSlotId) : undefined,
    questionSlotId: record.questionSlotId ? stringField(record.questionSlotId) : undefined,
    questionSlotImportance: record.questionSlotImportance ? stringField(record.questionSlotImportance) : undefined
  };
}

export interface SemanticAnswerConstructFacts {
  facts: SemanticAnswerConstructFact[];
  certificationBoundary: RealizationCertificationBoundary;
}

/**
 * Reads the facts a proof stage already bound onto the construct graph -- the same
 * scce.semantic_answer_construct.v1 / scce.prior_bound_answer_construct.v1 node mouth.ts's own
 * semanticAnswerConstructState reads, kept as an independent minimal reader (see factFromJson) so
 * production-turn-runtime.ts and cognitive-planner.ts can compile a realization contract without importing
 * mouth.ts. Pure.
 */
export function semanticAnswerConstructFacts(construct: ConstructGraph | undefined): SemanticAnswerConstructFacts | undefined {
  if (!construct) return undefined;
  const rows = construct.nodes.map(node => ({ node, metadata: jsonRecord(node.metadata) }));
  const row = rows.find(item => item.node.kind === "construct:semantic_answer" || item.metadata.schema === "scce.semantic_answer_construct.v1")
    ?? rows.find(item => item.node.kind === "construct:prior_bound_answer" || item.metadata.schema === "scce.prior_bound_answer_construct.v1");
  if (!row) return undefined;
  const rawFacts = row.metadata.selectedFacts;
  const facts = (Array.isArray(rawFacts) ? rawFacts : [])
    .map(factFromJson)
    .filter((fact): fact is SemanticAnswerConstructFact => Boolean(fact));
  if (!facts.length) return undefined;
  const boundary = jsonRecord(row.metadata.certificationBoundary);
  return {
    facts,
    certificationBoundary: {
      certified: boundary.directEvidenceCount ? numberField(boundary.directEvidenceCount) > 0 : undefined,
      externallyFactual: boundary.externalFactCertification === true
    }
  };
}
