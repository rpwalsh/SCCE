// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { hasSourceBoundSemanticRelation } from "./source-bound-semantic-fact.js";
import type { SpeakInput } from "./mouth-contracts.js";
import {
  collapseWhitespace,
  containsSurface,
  isDigitChar,
  isLetterChar,
  isLikelySentenceBoundary
} from "./mouth-surface-text.js";
import type { ConstructGraph, EvidenceSpan, JsonValue } from "./types.js";
import { clamp01 } from "./primitives.js";
import { hasUncasedNonLatinLetter, hasUppercaseLetter } from "./surface-linguistics.js";
import { factualRoundTripGate } from "./semantic-round-trip.js";

export interface SemanticAnswerFact {
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
  contradiction?: number;
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

interface SemanticAnswerSlot {
  id: string;
  relationIds: string[];
  factKeys: string[];
  support: number;
  activation: number;
}

export interface SemanticAnswerConstructState {
  schema: "scce.semantic_answer_construct.v1";
  questionShapeId: string;
  selectedSubject: string;
  selectedFacts: SemanticAnswerFact[];
  answerSlots: SemanticAnswerSlot[];
  selectedRelations: string[];
  activatedNeighborhood: SemanticAnswerFact[];
  rejectedCandidates: Array<{ relationId: string; sourceNodeId: string; targetNodeId: string; reasonId: string; score: number }>;
  supportIds: string[];
  forceId: string;
  boundaryId: string;
  activeBrainVersion: string;
  activeImportRunIds: string[];
  alphaRhetoricalPlan?: JsonValue;
  cognitiveFabric?: JsonValue;
  questionSlotPlan?: JsonValue;
  certificationBoundary: {
    directEvidenceCount: number;
    evidenceSpanIds: string[];
    sourceVersionIds: string[];
    externalFactCertification: boolean;
  };
}

/** Resolve a fact's exact, current promoted source owners without relying on a proof-stage annotation. */
export function currentSourceBoundFactEvidenceOwners(
  state: SemanticAnswerConstructState,
  fact: SemanticAnswerFact,
  evidence: readonly EvidenceSpan[]
): EvidenceSpan[] {
  const ids = [...new Set((fact.evidenceIds ?? []).filter(Boolean))];
  const sourceVersionId = fact.sourceVersionId;
  const boundary = state.certificationBoundary;
  if (!ids.length || !sourceVersionId
    || ids.some(id => !state.supportIds.includes(id) || !boundary.evidenceSpanIds.includes(id))
    || !boundary.sourceVersionIds.includes(sourceVersionId)) return [];
  const owners = evidence.filter(span => span.status === "promoted"
    && ids.includes(String(span.id))
    && String(span.sourceVersionId) === sourceVersionId);
  return owners.length === ids.length ? owners : [];
}

export interface InsufficientSupportConstructState {
  schema: "scce.insufficient_support_construct.v1";
  questionShapeId: string;
  selectedMainSubject: string;
  requestedFocuses: string[];
  closestSubjectCandidates: string[];
  relevanceGate: JsonValue;
  explanatoryAnswerContract: JsonValue;
  activeBrainVersion: string;
  activeImportRunIds: string[];
  certificationBoundary: {
    directEvidenceCount: number;
    externalFactCertification: boolean;
  };
}

export function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

export function semanticFactFromRealizationConstraints(value: JsonValue): SemanticAnswerFact | undefined {
  const fact = jsonRecord(jsonRecord(value).semanticAnswerFact);
  return semanticAnswerFactFromJson(fact);
}

export function exactFactSurface(value: string): boolean {
  return value.length > 0 && value === value.normalize("NFC") && value === value.trim();
}

// A composite answer built from several quoted sentences (e.g. a two-sentence Wikipedia lead) produces one
// answerSlot per sentence, all under the same generic quote relation -- state.answerSlots.length was required to
// be exactly 1, so this coverage check failed before singleCoreFact (mouth.ts, chosen by the callers of this
// function) ever got to pick its one representative fact, and generation could never engage for any multi-sentence
// local-evidence answer. selectedRelations staying singular is what actually distinguishes "one cohesive relation,
// several candidate facts for it" from a genuinely composite answer (a source-conflict answer carries a distinct
// forceId and is already excluded by every caller before this runs; a collection/member answer's per-member
// subject never equals state.selectedSubject, so it is excluded by the very next check). Coverage now asks only
// whether SOME slot matches the specific fact singleCoreFact already chose.
export function completeLearnedFactCoverage(state: SemanticAnswerConstructState, fact: SemanticAnswerFact): boolean {
  if (state.selectedRelations.length !== 1) return false;
  if (state.selectedRelations[0] !== fact.relationId || state.selectedSubject !== fact.subject) return false;
  const factKeys = learnedFactSurfaceKeys(fact);
  const slot = state.answerSlots.find(candidate =>
    candidate.relationIds.length === 1
    && candidate.relationIds[0] === fact.relationId
    && candidate.factKeys.length === 1
    && factKeys.has(candidate.factKeys[0]!));
  if (!slot) return false;
  return finiteUnitSignal(slot.support) && finiteUnitSignal(slot.activation);
}

function learnedFactSurfaceKeys(fact: SemanticAnswerFact): Set<string> {
  const surfaces = [fact.subject, fact.predicate, fact.object, fact.relationId];
  return new Set([
    surfaces.join("\u0001").toLocaleLowerCase().replace(/\s+/gu, " ").trim(),
    surfaces.map(surface => surface.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim()).join("\u0001")
  ]);
}

export function learnedFactRouteAdmissible(fact: SemanticAnswerFact): boolean {
  if (fact.forceClass !== "direct_evidence" || fact.answerGrade !== true) return false;
  if (!Number.isFinite(fact.finalQuestionFit) || (fact.finalQuestionFit ?? 0) < 0.44) return false;
  return [
    fact.support,
    fact.activation,
    fact.score,
    fact.overlap,
    fact.certificationPower,
    fact.semanticQuality,
    fact.questionSlotScore
  ].every(finiteUnitSignal);
}

export function learnedFactRouteAdmissibility(fact: SemanticAnswerFact, span: EvidenceSpan): number {
  if (!learnedFactRouteAdmissible(fact) || !finiteUnitSignal(span.alpha)) return 0;
  const factors = [
    fact.support,
    fact.activation,
    fact.score,
    fact.overlap,
    fact.finalQuestionFit!,
    fact.certificationPower!,
    fact.semanticQuality!,
    fact.questionSlotScore!,
    span.alpha
  ];
  return clamp01(factors.reduce((product, value) => product * clamp01(value), 1));
}

function finiteUnitSignal(value: number | undefined): boolean {
  return Number.isFinite(value) && (value ?? 0) > 0 && (value ?? 0) <= 1;
}

export function semanticFactImportanceRank(value: string | undefined): number {
  if (value === "core") return 0;
  if (value === "secondary") return 1;
  return 2;
}

export function semanticAnswerFactKey(fact: Pick<SemanticAnswerFact, "sourceNodeId" | "relationId" | "targetNodeId">): string {
  return `${fact.sourceNodeId}\u0001${fact.relationId}\u0001${fact.targetNodeId}`;
}

export function stringArrayFromJson(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function arrayRecords(value: JsonValue | undefined): Array<Record<string, JsonValue>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

export function stringFromJson(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function numberFromJson(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberFromJson(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Realizer surfaces enter the pool ONLY carrying facts the evidence layer
 * already licensed, and only when the wording keeps every argument intact
 * and the surface is structurally complete -- the same bar the composed
 * direct-evidence join meets. A realizer can therefore lose on quality,
 * never smuggle a claim.
 */
/**
 * The grounded sentence this turn already settled on, expressed as a fact the realizer can speak. Its subject
 * is the source's own title, so nothing outside the cited span enters the wording. Pure.
 */
/** Below this there is no sentence to reword, only a fragment. */
const EXCERPT_PARAPHRASE_FLOOR = 24;

/**
 * Faithfulness as meaning rather than vocabulary: the draft is put back through this turn's own entailment
 * against the same evidence, and the invariants a rewording must never move (numbers, and the names the facts
 * assert) have to survive it. A paraphrase that says the same thing in different words passes; one that drops
 * a number, renames a subject, or contradicts the source does not. Falls back to the caller's own judgement
 * only when no verifier was supplied.
 */
/** Case is not evidence. A digit- or symbol-bearing unit is the same unit in every script, so that is what a
 *  wording may not invent; whether a name belongs is settled by entailment, not by how it is written. Pure. */
function fabricationCheckable(symbol: { kind: "number" | "symbol" | "entity" }): boolean {
  return symbol.kind !== "entity";
}

/** Comparison folds case where a script has it and is unchanged where it does not. Pure. */
function foldedContains(haystack: string, needle: string): boolean {
  return containsSurface(haystack.toLocaleLowerCase(), needle.toLocaleLowerCase());
}

/** Only a passage-length surface is a recitation; a short factual span is simply the answer. */
const VERBATIM_RECITATION_FLOOR = 160;

/** Punctuation and spacing are cleaned on the way out, so recitation is recognised by letters and digits alone. Pure. */
function recitationKey(text: string): string {
  let out = "";
  for (const char of text.toLocaleLowerCase().normalize("NFKC")) {
    if (isLetterChar(char) || isDigitChar(char)) out += char;
  }
  return out;
}

/** A surface carrying a source passage whole is the source speaking, not the answer. Pure. */
export function surfaceIsVerbatimSource(text: string, input: SpeakInput): boolean {
  const key = recitationKey(text);
  if (collapseWhitespace(text).length < VERBATIM_RECITATION_FLOOR) return false;
  const sources = [
    String(input.selectedCandidate?.answer ?? ""),
    ...input.evidence.filter(span => span.status === "promoted").map(span => String(span.text || span.textPreview || ""))
  ];
  return sources.some(source => {
    const sourceKey = recitationKey(source);
    return sourceKey.length > 0 && (sourceKey.includes(key) || key.includes(sourceKey));
  });
}

export function meaningSurvives(surface: string, facts: readonly SemanticAnswerFact[], input: SpeakInput): boolean {
  const verifier = input.meaningVerifier;
  if (!verifier) return true;
  // Interpret the wording back into atoms: anything it asserts that the source never did rejects it outright.
  const intendedText = facts.map(fact => fact.object ?? "").filter(Boolean).join(" ");
  if (intendedText && !factualRoundTripGate({ intendedText, realizedText: surface }).accepted) return false;
  // Leaving a date out is not a falsehood; putting in one the evidence never carried is. So a wording is
  // checked for symbols it invents, not for symbols it declines to repeat.
  const licensed = new Set(
    facts.flatMap(fact => invariantSymbols([fact.subject, fact.object].filter(Boolean).join(" ")).map(symbol => symbol.text))
  );
  for (const symbol of invariantSymbols(surface).filter(fabricationCheckable)) {
    if (![...licensed].some(text => foldedContains(text, symbol.text) || foldedContains(symbol.text, text))) return false;
  }
  const verdict = verifier(surface);
  return verdict.contradiction < MEANING_CONTRADICTION_CEILING && verdict.support >= MEANING_SUPPORT_FLOOR;
}

const MEANING_SUPPORT_FLOOR = 0.3;

const MEANING_CONTRADICTION_CEILING = 0.45;

export function sourceExcerptFacts(input: SpeakInput): SemanticAnswerFact[] {
  const candidate = input.selectedCandidate;
  const excerpt = String(candidate?.answer ?? "").trim();
  if (!candidate || !excerpt || !candidate.evidenceIds.length) return [];
  // A short excerpt has nothing to shorten; a long one can be restated within its own vocabulary.
  if (excerpt.length < EXCERPT_PARAPHRASE_FLOOR) return [];
  const span = input.evidence.find(item => candidate.evidenceIds.map(String).includes(String(item.id)));
  if (!span || span.status !== "promoted") return [];
  const provenance = jsonRecord(span.provenance);
  const metadata = jsonRecord(provenance.metadata);
  const subject = stringFromJson(provenance.title) || stringFromJson(metadata.title) || "";
  if (!subject) return [];
  return [{
    subject,
    predicate: "states",
    object: excerpt.slice(0, 1200),
    evidenceIds: candidate.evidenceIds.map(String)
  } as SemanticAnswerFact];
}

export function semanticAnswerConstructState(construct: ConstructGraph): SemanticAnswerConstructState | undefined {
  const rows = construct.nodes.map(node => ({ node, metadata: jsonRecord(node.metadata) }));
  const row = rows.find(item => item.node.kind === "construct:semantic_answer" || item.metadata.schema === "scce.semantic_answer_construct.v1")
    ?? rows.find(item => item.node.kind === "construct:prior_bound_answer" || item.metadata.schema === "scce.prior_bound_answer_construct.v1");
  if (!row) return undefined;
  const facts = arrayRecords(row.metadata.selectedFacts)
    .map(semanticAnswerFactFromJson)
    .filter((fact): fact is SemanticAnswerFact => Boolean(fact));
  if (!facts.length) return undefined;
  const boundary = jsonRecord(row.metadata.certificationBoundary);
  return {
    schema: "scce.semantic_answer_construct.v1",
    questionShapeId: stringFromJson(row.metadata.questionShapeId),
    selectedSubject: stringFromJson(row.metadata.selectedSubject) || facts[0]?.subject || row.node.label,
    selectedFacts: facts,
    answerSlots: arrayRecords(row.metadata.answerSlots).map(semanticAnswerSlotFromJson),
    selectedRelations: stringArrayFromJson(row.metadata.selectedRelations),
    activatedNeighborhood: arrayRecords(row.metadata.activatedNeighborhood).map(semanticAnswerFactFromJson).filter((fact): fact is SemanticAnswerFact => Boolean(fact)),
    rejectedCandidates: arrayRecords(row.metadata.rejectedCandidates).map(row => ({
      relationId: stringFromJson(row.relationId),
      sourceNodeId: stringFromJson(row.sourceNodeId),
      targetNodeId: stringFromJson(row.targetNodeId),
      reasonId: stringFromJson(row.reasonId),
      score: numberFromJson(row.score)
    })),
    supportIds: stringArrayFromJson(row.metadata.supportIds),
    forceId: stringFromJson(row.metadata.forceId) || "output.force.learned_concept_prior_answer",
    boundaryId: stringFromJson(row.metadata.boundaryId) || "output.force.import_bound",
    activeBrainVersion: stringFromJson(row.metadata.activeBrainVersion),
    activeImportRunIds: stringArrayFromJson(row.metadata.activeImportRunIds),
    alphaRhetoricalPlan: row.metadata.alphaRhetoricalPlan,
    cognitiveFabric: row.metadata.cognitiveFabric,
    questionSlotPlan: row.metadata.questionSlotPlan,
    certificationBoundary: {
      directEvidenceCount: numberFromJson(boundary.directEvidenceCount),
      evidenceSpanIds: stringArrayFromJson(boundary.evidenceSpanIds),
      sourceVersionIds: stringArrayFromJson(boundary.sourceVersionIds),
      externalFactCertification: boundary.externalFactCertification === true
    }
  };
}

function semanticAnswerSlotFromJson(value: Record<string, JsonValue>): SemanticAnswerSlot {
  return {
    id: stringFromJson(value.id),
    relationIds: stringArrayFromJson(value.relationIds),
    factKeys: stringArrayFromJson(value.factKeys),
    support: numberFromJson(value.support),
    activation: numberFromJson(value.activation)
  };
}

export function insufficientSupportConstructState(construct: ConstructGraph): InsufficientSupportConstructState | undefined {
  const row = construct.nodes
    .map(node => ({ node, metadata: jsonRecord(node.metadata) }))
    .find(item => item.node.kind === "construct:insufficient_support" || item.metadata.schema === "scce.insufficient_support_construct.v1");
  if (!row) return undefined;
  return {
    schema: "scce.insufficient_support_construct.v1",
    questionShapeId: stringFromJson(row.metadata.questionShapeId),
    selectedMainSubject: stringFromJson(row.metadata.selectedMainSubject) || row.node.label,
    requestedFocuses: stringArrayFromJson(row.metadata.requestedFocuses),
    closestSubjectCandidates: stringArrayFromJson(row.metadata.closestSubjectCandidates),
    relevanceGate: row.metadata.relevanceGate ?? null,
    explanatoryAnswerContract: row.metadata.explanatoryAnswerContract ?? null,
    activeBrainVersion: stringFromJson(row.metadata.activeBrainVersion),
    activeImportRunIds: stringArrayFromJson(row.metadata.activeImportRunIds),
    certificationBoundary: {
      directEvidenceCount: numberFromJson(jsonRecord(row.metadata.certificationBoundary).directEvidenceCount),
      externalFactCertification: Boolean(jsonRecord(row.metadata.certificationBoundary).externalFactCertification)
    }
  };
}

function semanticAnswerFactFromJson(value: Record<string, JsonValue>): SemanticAnswerFact | undefined {
  const subject = stringFromJson(value.subject);
  const predicate = stringFromJson(value.predicate);
  const object = stringFromJson(value.object);
  if (!subject || !object || !hasSourceBoundSemanticRelation({ ...value, predicate })) return undefined;
  return {
    subject,
    predicate,
    object,
    sourceNodeId: stringFromJson(value.sourceNodeId),
    targetNodeId: stringFromJson(value.targetNodeId),
    relationId: stringFromJson(value.relationId),
    forceClass: stringFromJson(value.forceClass),
    score: numberFromJson(value.score),
    activation: numberFromJson(value.activation),
    overlap: numberFromJson(value.overlap),
    support: numberFromJson(value.support),
    contradiction: optionalNumberFromJson(value.contradiction),
    sourceVersionId: stringFromJson(value.sourceVersionId) || undefined,
    evidenceIds: stringArrayFromJson(value.evidenceIds),
    roleId: stringFromJson(value.roleId) || undefined,
    alphaRhetoricalCentrality: optionalNumberFromJson(value.alphaRhetoricalCentrality),
    pathScore: optionalNumberFromJson(value.pathScore),
    roleScore: optionalNumberFromJson(value.roleScore),
    bridgeValue: optionalNumberFromJson(value.bridgeValue),
    backgroundPenalty: optionalNumberFromJson(value.backgroundPenalty),
    forceMeaning: optionalNumberFromJson(value.forceMeaning),
    certificationPower: optionalNumberFromJson(value.certificationPower),
    semanticQuality: optionalNumberFromJson(value.semanticQuality),
    graphQualityClassId: stringFromJson(value.graphQualityClassId) || undefined,
    answerGrade: typeof value.answerGrade === "boolean" ? value.answerGrade : undefined,
    cognitiveEdgeId: stringFromJson(value.cognitiveEdgeId) || undefined,
    requestedSlotId: stringFromJson(value.requestedSlotId) || undefined,
    relationRoleId: stringFromJson(value.relationRoleId) || undefined,
    topicSenseId: stringFromJson(value.topicSenseId) || undefined,
    finalQuestionFit: optionalNumberFromJson(value.finalQuestionFit),
    questionSlotId: stringFromJson(value.questionSlotId) || undefined,
    questionSlotImportance: stringFromJson(value.questionSlotImportance) || undefined,
    questionSlotScore: optionalNumberFromJson(value.questionSlotScore),
    questionSlotReasonIds: stringArrayFromJson(value.questionSlotReasonIds)
  };
}

export function semanticFactKey(fact: Pick<SemanticAnswerFact, "subject" | "predicate" | "object" | "relationId">): string {
  return [fact.subject, fact.predicate, fact.object, fact.relationId]
    .map(part => collapseWhitespace(part.normalize("NFKC").toLocaleLowerCase()))
    .join("\u0001");
}

export function invariantSymbols(text: string): Array<{ text: string; kind: "number" | "symbol" | "entity" }> {
  const out: Array<{ text: string; kind: "number" | "symbol" | "entity" }> = [];
  let symbol = "";
  const flush = () => {
    let value = symbol.trim();
    symbol = "";
    if (!value) return;
    if (invariantKind(value) === "number") {
      while (value && isLikelySentenceBoundary(value[value.length - 1]!)) value = value.slice(0, -1);
    }
    const kind = invariantKind(value);
    if (kind) out.push({ text: value, kind });
  };
  for (const char of text.normalize("NFKC")) {
    if (isInvariantSymbolChar(char)) {
      symbol += char;
    } else {
      flush();
    }
  }
  flush();
  return out.slice(0, 128);
}

function invariantKind(value: string): "number" | "symbol" | "entity" | undefined {
  let digits = 0;
  let letters = 0;
  let symbols = 0;
  let dottedLetterOnly = true;
  for (const char of value) {
    if (isDigitChar(char)) {
      digits++;
      dottedLetterOnly = false;
    } else if (isLetterChar(char)) {
      letters++;
    } else {
      symbols++;
      if (char !== ".") dottedLetterOnly = false;
    }
  }
  if (digits > 0 && letters === 0) return "number";
  if (digits === 0 && letters > 0 && symbols > 0 && dottedLetterOnly) return undefined;
  if (symbols > 0 && value.length > 1) return "symbol";
  if (digits > 0 && letters > 0) return "symbol";
  if (letters > 0 && value.length >= 2 && hasCaseSignal(value)) return "entity";
  return undefined;
}

function isInvariantSymbolChar(char: string): boolean {
  return isLetterChar(char) || isDigitChar(char) || char === "." || char === ":" || char === "_" || char === "-" || char === "/" || char === "#" || char === "@" || char === "$" || char === "%";
}

function hasCaseSignal(value: string): boolean {
  return hasUppercaseLetter(value) || hasUncasedNonLatinLetter(value);
}
