import nlp from "compromise";

import {
  induceLearnedConstructions,
  type AlignedSurfaceExample,
  type LearnedConstruction,
  type LearnedFormClass
} from "./language-construction.js";
import { canonicalStringify } from "./primitives.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceSpan, Hasher, JsonValue } from "./types.js";

export const LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA = "scce.language_construction_pattern.v1" as const;
export const LEGACY_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2 = "scce.creative_event_construction_pattern.v2" as const;
export const CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA = "scce.creative_event_construction_pattern.v3" as const;
export const CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA = "scce.creative_event_argument_frame.v1" as const;
export const ENGLISH_CREATIVE_EVENT_COMPILER_ID = "surface.compiler.en.compromise.v4" as const;

export const LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS = {
  input: "surface.construction_memory.reject.input",
  ownership: "surface.construction_memory.reject.ownership",
  evidence: "surface.construction_memory.reject.evidence",
  coordinates: "surface.construction_memory.reject.coordinates",
  induction: "surface.construction_memory.reject.induction",
  identity: "surface.construction_memory.reject.identity",
  digest: "surface.construction_memory.reject.digest",
  member: "surface.construction_memory.reject.member",
  duplicate: "surface.construction_memory.reject.duplicate",
  legacyCreativeV2: "surface.construction_memory.reject.legacy_creative_v2"
} as const;

export type LanguageConstructionMemoryRejectionId =
  typeof LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS[keyof typeof LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS];

/**
 * A role alignment supplied by a typed corpus extractor. Coordinates are
 * Unicode code-point offsets relative to the example surface.
 */
export interface SourceBoundConstructionRoleSpan {
  slotIndex: number;
  occurrenceIndex?: number;
  startCodePoint: number;
  endCodePoint: number;
}

export interface SourceBoundConstructionNullRole {
  slotIndex: number;
  occurrenceIndex?: number;
}

/**
 * A source-bound corpus observation. Raw text alone is deliberately
 * insufficient: a typed upstream extractor must provide the semantic slot
 * alignment and exact evidence range.
 */
export interface SourceBoundConstructionObservation {
  sourceVersionId: string;
  evidenceId: string;
  surfaceStartCodePoint: number;
  surfaceEndCodePoint: number;
  roles: readonly SourceBoundConstructionRoleSpan[];
  nullRoles?: readonly SourceBoundConstructionNullRole[];
}

export interface SourceBoundLanguageConstructionTrainingSet {
  bindingId: string;
  observations: readonly SourceBoundConstructionObservation[];
}

export interface DurableSourceConstructionExample {
  id: string;
  bindingId: string;
  sourceProfileId: string;
  targetProfileId: string;
  sourceVersionId: string;
  evidenceId: string;
  evidenceContentHash: string;
  evidenceCharStart: number;
  evidenceCharEnd: number;
  surfaceStartCodePoint: number;
  surfaceEndCodePoint: number;
  surface: string;
  surfaceDigest: string;
  roles: Array<{
    slotIndex: number;
    occurrenceIndex: number;
    roleId: string;
    occurrenceId: string;
    startCodePoint: number;
    endCodePoint: number;
    surface: string;
  }>;
  nullRoles: Array<{
    slotIndex: number;
    occurrenceIndex: number;
    roleId: string;
    occurrenceId: string;
  }>;
}

export interface DurableLanguageConstructionBundleContent {
  schema: typeof LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA;
  bindingId: string;
  sourceProfileId: string;
  targetProfileId: string;
  sourceVersionIds: string[];
  evidenceIds: string[];
  evidenceContentHashes: string[];
  sourceExamples: DurableSourceConstructionExample[];
  constructions: LearnedConstruction[];
  formClasses: LearnedFormClass[];
  creativeEvents?: DurableCreativeEventConstruction[];
}

export interface DurableLanguageConstructionBundle extends DurableLanguageConstructionBundleContent {
  id: string;
  contentDigest: string;
}

export interface DurableCreativeEventConstruction {
  id: string;
  compilerId: string;
  constructionId: string;
  profileId: string;
  sourceVersionId: string;
  evidenceId: string;
  evidenceContentHash: string;
  evidenceCharStart: number;
  evidenceCharEnd: number;
  labelStartCodePoint: number;
  labelEndCodePoint: number;
  sourceOrdinal: number;
  relationId: string;
  sourceLabel: string;
  sourceLabelDigest: string;
  tenseId: "scce.tense.past" | "scce.tense.present" | "scce.tense.future" | "scce.tense.unknown";
  valencyId: "scce.valency.agent" | "scce.valency.agent_patient";
  roleIds: string[];
  argumentFrame: DurableCreativeEventArgumentFrame;
  forms: {
    infinitive: string;
    past: string;
    present: string;
    gerund: string;
    participle: string;
  };
}

export interface DurableCreativeEventArgumentFrame {
  id: string;
  schema: typeof CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA;
  compilerId: typeof ENGLISH_CREATIVE_EVENT_COMPILER_ID;
  sourceSentenceStartCodePoint: number;
  sourceSentenceEndCodePoint: number;
  roleIds: string[];
  bindings: DurableCreativeEventArgumentBinding[];
}

export interface DurableCreativeEventArgumentBinding {
  roleId: "scce.role.patient" | "scce.role.complement";
  surface: string;
  surfaceDigest: string;
  startCodePoint: number;
  endCodePoint: number;
  connector?: DurableCreativeEventClosedClassConnector;
}

export interface DurableCreativeEventClosedClassConnector {
  surface: string;
  surfaceDigest: string;
  startCodePoint: number;
  endCodePoint: number;
}

export interface LanguageConstructionMemoryIssue {
  code: LanguageConstructionMemoryRejectionId;
  patternId?: string;
  profileId?: string;
  evidenceId?: string;
  sourceVersionId?: string;
}

export type LanguageConstructionPatternCompilation =
  | {
      status: "compiled";
      pattern: LanguagePatternRecord;
      bundle: DurableLanguageConstructionBundle;
    }
  | {
      status: "rejected";
      issues: readonly LanguageConstructionMemoryIssue[];
    };

export interface CreativeEventConstructionCompilerInput {
  profileId: string;
  evidence: readonly EvidenceSpan[];
  hasher: Hasher;
  updatedAt: number;
  maxEvents?: number;
}

/**
 * Corpus adapters select a source-language compiler from source metadata. The
 * cognitive/storage contract remains profile- and role-ID based; a language
 * name is never used as an internal relation or ontology identifier.
 */
export interface CreativeEventConstructionCompiler {
  id: string;
  compile(input: CreativeEventConstructionCompilerInput): LanguageConstructionPatternCompilation;
}

export function createEnglishCreativeEventConstructionCompiler(): CreativeEventConstructionCompiler {
  return {
    id: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    compile: compileEnglishCreativeEventConstructionPattern
  };
}

export interface HydratedLanguageConstructions {
  bundles: DurableLanguageConstructionBundle[];
  constructions: LearnedConstruction[];
  formClasses: LearnedFormClass[];
  rejected: LanguageConstructionMemoryIssue[];
}

export function languageConstructionRoleId(
  hasher: Hasher,
  bindingId: string,
  slotIndex: number
): string {
  return stableId(hasher, "surface.construction.role", [bindingId, checkedIndex(slotIndex)]);
}

export function languageConstructionOccurrenceId(
  hasher: Hasher,
  bindingId: string,
  slotIndex: number,
  occurrenceIndex = 0
): string {
  return stableId(hasher, "surface.construction.occurrence", [
    bindingId,
    checkedIndex(slotIndex),
    checkedIndex(occurrenceIndex)
  ]);
}

export function compileLanguageConstructionPattern(input: {
  bindingId: string;
  profileId: string;
  observations: readonly SourceBoundConstructionObservation[];
  evidence: readonly EvidenceSpan[];
  hasher: Hasher;
  updatedAt: number;
}): LanguageConstructionPatternCompilation {
  if (!nonempty(input.bindingId)
    || !nonempty(input.profileId)
    || !Number.isFinite(input.updatedAt)
    || input.observations.length === 0
    || input.observations.length > 256) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }

  const evidenceById = uniqueEvidenceById(input.evidence);
  if (!evidenceById || evidenceById.size === 0) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
  }

  const durableExamples: DurableSourceConstructionExample[] = [];
  const alignedExamples: AlignedSurfaceExample[] = [];
  for (const observation of input.observations) {
    const prepared = prepareObservation({ ...input, observation, evidenceById });
    if ("issue" in prepared) return { status: "rejected", issues: [prepared.issue] };
    durableExamples.push(prepared.durable);
    alignedExamples.push(prepared.aligned);
  }

  const duplicateExampleId = firstDuplicate(durableExamples.map(example => example.id));
  if (duplicateExampleId) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate);

  const induction = induceLearnedConstructions({ examples: alignedExamples, hasher: input.hasher });
  if (induction.rejected.length > 0 || induction.constructions.length === 0) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);
  }
  if (induction.constructions.some(item => item.profileKey !== input.profileId)
    || induction.formClasses.some(item => item.profileKey !== input.profileId)) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  }

  const sourceExamples = durableExamples.sort(compareDurableExamples);
  const evidenceIds = uniqueSorted(sourceExamples.map(item => item.evidenceId));
  const sourceVersionIds = uniqueSorted(sourceExamples.map(item => item.sourceVersionId));
  const evidenceContentHashes = uniqueSorted(sourceExamples.map(item => item.evidenceContentHash));
  const content: DurableLanguageConstructionBundleContent = {
    schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
    bindingId: input.bindingId,
    sourceProfileId: input.profileId,
    targetProfileId: input.profileId,
    sourceVersionIds,
    evidenceIds,
    evidenceContentHashes,
    sourceExamples,
    constructions: [...induction.constructions],
    formClasses: [...induction.formClasses]
  };
  const contentDigest = input.hasher.digestHex(canonicalStringify(content));
  const id = `surface.construction.bundle.${contentDigest}`;
  const bundle: DurableLanguageConstructionBundle = { id, contentDigest, ...content };
  const support = minimumSupport(bundle.constructions.map(item => item.support));
  const pattern: LanguagePatternRecord = {
    id,
    profileId: input.profileId,
    patternKind: "semantic_role",
    support,
    entropy: 0,
    patternJson: {
      schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
      contentDigest,
      bundle: bundle as unknown as JsonValue
    },
    evidenceIds: evidenceIds as EvidenceSpan["id"][],
    updatedAt: input.updatedAt
  };
  return { status: "compiled", pattern, bundle };
}

export function compileEnglishCreativeEventConstructionPattern(
  input: CreativeEventConstructionCompilerInput
): LanguageConstructionPatternCompilation {
  if (!nonempty(input.profileId) || !Number.isFinite(input.updatedAt)) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }
  const promotedEvidence = input.evidence
    .filter(span => span.status === "promoted")
    .sort((left, right) => left.charStart - right.charStart || compareText(String(left.id), String(right.id)));
  if (!promotedEvidence.length) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
  const maxEvents = Math.max(1, Math.min(2048, Math.floor(input.maxEvents ?? 768)));
  const events: DurableCreativeEventConstruction[] = [];
  for (const evidence of promotedEvidence) {
    if (events.length >= maxEvents) break;
    for (const range of sourceSentenceRanges(evidence.text)) {
      if (events.length >= maxEvents) break;
      const compiled = compileCreativeEvent({
        profileId: input.profileId,
        evidence,
        range,
        hasher: input.hasher
      });
      if (compiled) events.push(compiled);
    }
  }
  if (events.length < 4) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);
  const orderedEvents = events.sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal || compareText(left.id, right.id)
  );
  const sourceVersionIds = uniqueSorted(orderedEvents.map(event => event.sourceVersionId));
  const evidenceIds = uniqueSorted(orderedEvents.map(event => event.evidenceId));
  const evidenceContentHashes = uniqueSorted(orderedEvents.map(event => event.evidenceContentHash));
  const persistedContent = {
    schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
    compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    profileId: input.profileId,
    sourceVersionIds,
    evidenceIds,
    evidenceContentHashes,
    events: orderedEvents
  };
  const contentDigest = input.hasher.digestHex(canonicalStringify(persistedContent));
  const id = `surface.creative_event.bundle.${contentDigest}`;
  const bundle: DurableLanguageConstructionBundle = {
    id,
    contentDigest,
    schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
    bindingId: `surface.creative_event.binding.${input.hasher.digestHex(input.profileId)}`,
    sourceProfileId: input.profileId,
    targetProfileId: input.profileId,
    sourceVersionIds,
    evidenceIds,
    evidenceContentHashes,
    sourceExamples: [],
    constructions: [],
    formClasses: [],
    creativeEvents: orderedEvents
  };
  const pattern: LanguagePatternRecord = {
    id,
    profileId: input.profileId,
    patternKind: "semantic_role",
    support: orderedEvents.length,
    entropy: 0,
    patternJson: {
      schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
      contentDigest,
      bundle: persistedContent as unknown as JsonValue
    },
    evidenceIds: evidenceIds as EvidenceSpan["id"][],
    updatedAt: input.updatedAt
  };
  return { status: "compiled", pattern, bundle };
}

interface SourceSentenceRange {
  surface: string;
  startCodePoint: number;
  endCodePoint: number;
}

interface CreativeSourceTerm {
  text: string;
  tags: string[];
  chunk?: string;
  termIndex: number;
  startCodePoint: number;
  endCodePoint: number;
}

function compileCreativeEvent(input: {
  profileId: string;
  evidence: EvidenceSpan;
  range: SourceSentenceRange;
  hasher: Hasher;
}): DurableCreativeEventConstruction | undefined {
  const surface = input.range.surface;
  const subject = surface.match(/^(?:i|he|she)\b/iu)?.[0];
  if (!subject) return undefined;
  const words = surface.match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
  if (words.length < 4 || words.length > 38) return undefined;
  if (/["“”‘’]/u.test(surface)
    || /\b(?:we|us|our|ours|you|your|yours)\b/iu.test(surface)
    || /\b\p{Lu}\p{Ll}{2,}\b/u.test(surface.slice(subject.length))) return undefined;
  const document = nlp(surface);
  const sentenceRow = recordUnknown(arrayUnknown(document.sentences().json())[0]);
  const parsed = recordUnknown(sentenceRow.sentence);
  const predicate = stringUnknown(parsed.predicate);
  if (!predicate) return undefined;
  const rawVerb = recordUnknown(arrayUnknown(document.verbs().json({ terms: { tags: true } }))[0]);
  const verb = recordUnknown(rawVerb.verb);
  if (verb.negative === true) return undefined;
  const lexicalTerm = arrayUnknown(rawVerb.terms)
    .map(recordUnknown)
    .filter(term => {
      const tags = arrayUnknown(term.tags).map(String);
      return tags.includes("Verb") && !tags.includes("Auxiliary") && !tags.includes("Modal");
    })
    .at(-1);
  if (!lexicalTerm) return undefined;
  const lexicalConfidence = numberUnknown(lexicalTerm.confidence);
  if (lexicalConfidence !== undefined && lexicalConfidence < 0.5) return undefined;
  const lexicalTags = arrayUnknown(lexicalTerm.tags).map(String);
  if (lexicalTags.includes("Participle") && !lexicalTags.includes("PastTense")) return undefined;
  const verbSurface = stringUnknown(lexicalTerm.text);
  const lexicalTermIndex = termIndexUnknown(lexicalTerm.index);
  const infinitive = stringUnknown(verb.infinitive) || verbSurface;
  if (!verbSurface || lexicalTermIndex === undefined
    || !infinitive || normalizeMemorySurface(infinitive) === "be") return undefined;
  if (!singleLexicalWord(verbSurface) || !singleLexicalWord(infinitive)) return undefined;
  const localVerbUtf16 = surface.toLocaleLowerCase().indexOf(verbSurface.toLocaleLowerCase());
  if (localVerbUtf16 < 0) return undefined;
  const labelStartCodePoint = input.range.startCodePoint + codePointOffsetAtUtf16(surface, localVerbUtf16);
  const labelEndCodePoint = labelStartCodePoint + [...verbSurface].length;
  const forms = creativeVerbForms(infinitive, verbSurface, lexicalTags);
  if (!forms || !Object.values(forms).every(singleLexicalWord)) return undefined;
  const tense = stringUnknown(recordUnknown(verb.grammar).tense);
  const tenseId = creativeTenseId(tense);
  const relationId = stableId(input.hasher, "language.source_relation", [
    input.profileId,
    normalizeMemorySurface(infinitive)
  ]);
  const argumentFrame = compileCreativeArgumentFrame({
    profileId: input.profileId,
    relationId,
    range: input.range,
    sentenceRow,
    lexicalTermIndex,
    hasher: input.hasher
  });
  if (!argumentFrame) return undefined;
  const valencyId = argumentFrame.bindings.length
    ? "scce.valency.agent_patient"
    : "scce.valency.agent";
  const constructionId = stableId(input.hasher, "surface.creative_event.construction", [
    ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    input.profileId,
    tenseId,
    valencyId
  ]);
  const sourceVersionId = String(input.evidence.sourceVersionId);
  const evidenceId = String(input.evidence.id);
  const evidenceContentHash = String(input.evidence.contentHash);
  const sourceLabelDigest = input.hasher.digestHex(verbSurface);
  const id = stableId(input.hasher, "surface.creative_event", [
    ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    constructionId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    labelStartCodePoint,
    labelEndCodePoint,
    relationId,
    sourceLabelDigest,
    argumentFrame,
    forms
  ]);
  return {
    id,
    compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    constructionId,
    profileId: input.profileId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    evidenceCharStart: input.evidence.charStart,
    evidenceCharEnd: input.evidence.charEnd,
    labelStartCodePoint,
    labelEndCodePoint,
    sourceOrdinal: input.evidence.charStart + input.range.startCodePoint,
    relationId,
    sourceLabel: verbSurface,
    sourceLabelDigest,
    tenseId,
    valencyId,
    roleIds: [...argumentFrame.roleIds],
    argumentFrame,
    forms
  };
}

function compileCreativeArgumentFrame(input: {
  profileId: string;
  relationId: string;
  range: SourceSentenceRange;
  sentenceRow: Record<string, unknown>;
  lexicalTermIndex: number;
  hasher: Hasher;
}): DurableCreativeEventArgumentFrame | undefined {
  const terms = creativeSourceTerms(input.sentenceRow, input.range.surface);
  if (!terms.length || !terms.some(term => term.termIndex === input.lexicalTermIndex)) return undefined;
  const rawNounHeads = terms
    .filter(term => term.termIndex > input.lexicalTermIndex)
    .filter(term => term.tags.includes("Noun"))
    .filter(term => !term.tags.includes("Pronoun") && !term.tags.includes("ProperNoun"));
  const nounHeads = rawNounHeads
    .filter(term => term.tags.includes("Singular") || term.tags.includes("Plural"))
    .filter(term => !term.tags.some(tag => [
      "Possessive",
      "Determiner",
      "Adjective",
      "Adverb",
      "Verb",
      "Auxiliary",
      "Modal",
      "Preposition",
      "Particle",
      "Conjunction",
      "Value"
    ].includes(tag)))
    .filter(term => singleLexicalWord(term.text))
    .slice(0, 3);
  if (rawNounHeads.length > 0 && nounHeads.length === 0) return undefined;
  const bindings: DurableCreativeEventArgumentBinding[] = [];
  let previousHeadIndex = input.lexicalTermIndex;
  for (const head of nounHeads) {
    const connectorTerm = terms
      .filter(term => term.termIndex > previousHeadIndex && term.termIndex < head.termIndex)
      .filter(isClosedClassConnectorTerm)
      .at(-1);
    const roleId: DurableCreativeEventArgumentBinding["roleId"] =
      connectorTerm ? "scce.role.complement" : "scce.role.patient";
    previousHeadIndex = head.termIndex;
    if (bindings.some(binding => binding.roleId === roleId)) continue;
    const connector = connectorTerm
      ? creativeClosedClassConnector(input.range, connectorTerm, input.hasher)
      : undefined;
    bindings.push({
      roleId,
      surface: head.text,
      surfaceDigest: input.hasher.digestHex(head.text),
      startCodePoint: input.range.startCodePoint + head.startCodePoint,
      endCodePoint: input.range.startCodePoint + head.endCodePoint,
      ...(connector ? { connector } : {})
    });
    if (bindings.length >= 2) break;
  }
  const roleIds = [
    "scce.role.agent",
    ...bindings.map(binding => binding.roleId)
  ];
  const id = stableId(input.hasher, "surface.creative_event.argument_frame", [
    ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    input.profileId,
    input.relationId,
    roleIds,
    bindings.map(binding => ({
      roleId: binding.roleId,
      connector: binding.connector
        ? normalizeMemorySurface(binding.connector.surface)
        : null
    }))
  ]);
  return {
    id,
    schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
    compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    sourceSentenceStartCodePoint: input.range.startCodePoint,
    sourceSentenceEndCodePoint: input.range.endCodePoint,
    roleIds,
    bindings
  };
}

function creativeSourceTerms(
  sentenceRow: Record<string, unknown>,
  surface: string
): CreativeSourceTerm[] {
  const rawTerms = arrayUnknown(sentenceRow.terms);
  const out: CreativeSourceTerm[] = [];
  let cursorUtf16 = 0;
  for (const raw of rawTerms) {
    const term = recordUnknown(raw);
    const text = stringUnknown(term.text);
    const termIndex = termIndexUnknown(term.index);
    if (!text || termIndex === undefined) return [];
    const startUtf16 = surface.indexOf(text, cursorUtf16);
    if (startUtf16 < 0) return [];
    const endUtf16 = startUtf16 + text.length;
    out.push({
      text,
      tags: arrayUnknown(term.tags).map(String),
      ...(stringUnknown(term.chunk) ? { chunk: stringUnknown(term.chunk) } : {}),
      termIndex,
      startCodePoint: codePointOffsetAtUtf16(surface, startUtf16),
      endCodePoint: codePointOffsetAtUtf16(surface, endUtf16)
    });
    cursorUtf16 = endUtf16;
  }
  return out;
}

function isClosedClassConnectorTerm(term: CreativeSourceTerm): boolean {
  return term.tags.includes("Preposition") || term.tags.includes("Particle");
}

function creativeClosedClassConnector(
  range: SourceSentenceRange,
  term: CreativeSourceTerm,
  hasher: Hasher
): DurableCreativeEventClosedClassConnector | undefined {
  if (!singleLexicalWord(term.text)) return undefined;
  return {
    surface: term.text,
    surfaceDigest: hasher.digestHex(term.text),
    startCodePoint: range.startCodePoint + term.startCodePoint,
    endCodePoint: range.startCodePoint + term.endCodePoint
  };
}

function sourceSentenceRanges(text: string): SourceSentenceRange[] {
  const rows: SourceSentenceRange[] = [];
  const expression = /[^.!?]+[.!?]+/gu;
  for (const match of text.matchAll(expression)) {
    const raw = match[0];
    const leading = raw.match(/^\s*/u)?.[0] ?? "";
    const trailing = raw.match(/\s*$/u)?.[0] ?? "";
    const surface = raw.slice(leading.length, raw.length - trailing.length).normalize("NFC");
    if (!surface) continue;
    const startUtf16 = (match.index ?? 0) + leading.length;
    const endUtf16 = startUtf16 + surface.length;
    rows.push({
      surface,
      startCodePoint: codePointOffsetAtUtf16(text, startUtf16),
      endCodePoint: codePointOffsetAtUtf16(text, endUtf16)
    });
  }
  return rows;
}

function creativeVerbForms(
  infinitive: string,
  sourceSurface: string,
  sourceTags: readonly string[]
): DurableCreativeEventConstruction["forms"] | undefined {
  const document = nlp(infinitive);
  document.match(infinitive).tag("Verb");
  const row = recordUnknown(arrayUnknown(document.verbs().conjugate())[0]);
  // The sentence parser already supplied the source-bound lemma. Re-running
  // infinitive discovery on a detached token can truncate valid lemmas
  // ("own" -> "ow", "encompass" -> "encompas"), which breaks relation
  // identity and persisted-event verification.
  const root = infinitive;
  if (!root) return undefined;
  const sourcePast = sourceTags.includes("PastTense") && !sourceTags.includes("Participle")
    ? sourceSurface
    : "";
  return {
    infinitive: root,
    past: sourcePast || stringUnknown(row.PastTense) || root,
    present: stringUnknown(row.PresentTense) || root,
    gerund: stringUnknown(row.Gerund) || root,
    participle: stringUnknown(row.Participle) || stringUnknown(row.PastTense) || root
  };
}

function creativeTenseId(
  tense: string
): DurableCreativeEventConstruction["tenseId"] {
  const normalized = normalizeMemorySurface(tense);
  if (normalized.includes("past")) return "scce.tense.past";
  if (normalized.includes("present")) return "scce.tense.present";
  if (normalized.includes("future")) return "scce.tense.future";
  return "scce.tense.unknown";
}

export function hydrateLanguageConstructionPatterns(input: {
  patterns: readonly LanguagePatternRecord[];
  evidence: readonly EvidenceSpan[];
  hasher?: Hasher;
}): HydratedLanguageConstructions {
  const constructionPatterns = input.patterns
    .filter(isLanguageConstructionPattern)
    .sort((left, right) => compareText(left.id, right.id));
  const rejectedIssues: LanguageConstructionMemoryIssue[] = [];
  if (!input.hasher) {
    return {
      bundles: [],
      constructions: [],
      formClasses: [],
      rejected: constructionPatterns.map(pattern => ({
        code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest,
        patternId: pattern.id,
        profileId: pattern.profileId
      }))
    };
  }

  const duplicatePatternIds = duplicateValues(constructionPatterns.map(pattern => pattern.id));
  const evidenceById = uniqueEvidenceById(input.evidence);
  const bundles: DurableLanguageConstructionBundle[] = [];
  for (const pattern of constructionPatterns) {
    if (duplicatePatternIds.has(pattern.id)) {
      rejectedIssues.push({ code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate, patternId: pattern.id, profileId: pattern.profileId });
      continue;
    }
    if (!evidenceById) {
      rejectedIssues.push({ code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence, patternId: pattern.id, profileId: pattern.profileId });
      continue;
    }
    const verified = isCreativeEventConstructionPattern(pattern)
      ? verifyCreativeEventPattern(pattern, evidenceById, input.hasher)
      : isLegacyCreativeEventConstructionPatternV2(pattern)
        ? issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.legacyCreativeV2)
        : verifyPersistedPattern(pattern, evidenceById, input.hasher);
    if ("issue" in verified) rejectedIssues.push(verified.issue);
    else bundles.push(verified.bundle);
  }

  const uniqueBundles = bundles.sort((left, right) => compareText(left.id, right.id));
  return {
    bundles: uniqueBundles,
    constructions: uniqueBundles.flatMap(bundle => bundle.constructions),
    formClasses: uniqueBundles.flatMap(bundle => bundle.formClasses),
    rejected: rejectedIssues.sort(compareIssues)
  };
}

export function isLanguageConstructionPattern(pattern: LanguagePatternRecord): boolean {
  const row = recordOf(pattern.patternJson);
  return row.schema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA
    || row.schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA
    || (typeof row.schema === "string" && row.schema.startsWith("scce.creative_event_construction_pattern."));
}

export function isCreativeEventConstructionPattern(pattern: LanguagePatternRecord): boolean {
  return recordOf(pattern.patternJson).schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA;
}

function isLegacyCreativeEventConstructionPatternV2(pattern: LanguagePatternRecord): boolean {
  return recordOf(pattern.patternJson).schema === LEGACY_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2;
}

function prepareObservation(input: {
  bindingId: string;
  profileId: string;
  observation: SourceBoundConstructionObservation;
  evidenceById: ReadonlyMap<string, EvidenceSpan>;
  hasher: Hasher;
}): { durable: DurableSourceConstructionExample; aligned: AlignedSurfaceExample } | { issue: LanguageConstructionMemoryIssue } {
  const observation = input.observation;
  if (!nonempty(observation.sourceVersionId)
    || !nonempty(observation.evidenceId)
    || observation.roles.length + (observation.nullRoles?.length ?? 0) === 0
    || observation.roles.length > 64
    || (observation.nullRoles?.length ?? 0) > 64) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input } };
  }
  const evidence = input.evidenceById.get(observation.evidenceId);
  if (!evidence || evidence.status !== "promoted") {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence, evidenceId: observation.evidenceId } };
  }
  if (String(evidence.sourceVersionId) !== observation.sourceVersionId) {
    return {
      issue: {
        code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership,
        evidenceId: observation.evidenceId,
        sourceVersionId: observation.sourceVersionId
      }
    };
  }
  const evidencePoints = [...evidence.text];
  if (!validRange(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint, evidencePoints.length)
    || evidence.charEnd - evidence.charStart !== evidencePoints.length) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
  }
  const surface = evidencePoints
    .slice(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint)
    .join("");
  if (!surface || surface !== surface.normalize("NFC")) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
  }
  const surfacePoints = [...surface];
  const roleKeys = new Set<string>();
  const durableRoles: DurableSourceConstructionExample["roles"] = [];
  for (const role of observation.roles) {
    const occurrenceIndex = role.occurrenceIndex ?? 0;
    if (!validIndex(role.slotIndex)
      || !validIndex(occurrenceIndex)
      || !validRange(role.startCodePoint, role.endCodePoint, surfacePoints.length)
      || role.startCodePoint === role.endCodePoint) {
      return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
    }
    const key = `${role.slotIndex}\u0001${occurrenceIndex}`;
    if (roleKeys.has(key)) return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate, evidenceId: observation.evidenceId } };
    roleKeys.add(key);
    durableRoles.push({
      slotIndex: role.slotIndex,
      occurrenceIndex,
      roleId: languageConstructionRoleId(input.hasher, input.bindingId, role.slotIndex),
      occurrenceId: languageConstructionOccurrenceId(input.hasher, input.bindingId, role.slotIndex, occurrenceIndex),
      startCodePoint: role.startCodePoint,
      endCodePoint: role.endCodePoint,
      surface: surfacePoints.slice(role.startCodePoint, role.endCodePoint).join("")
    });
  }
  const durableNullRoles: DurableSourceConstructionExample["nullRoles"] = [];
  for (const role of observation.nullRoles ?? []) {
    const occurrenceIndex = role.occurrenceIndex ?? 0;
    if (!validIndex(role.slotIndex) || !validIndex(occurrenceIndex)) {
      return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
    }
    const key = `${role.slotIndex}\u0001${occurrenceIndex}`;
    if (roleKeys.has(key)) return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate, evidenceId: observation.evidenceId } };
    roleKeys.add(key);
    durableNullRoles.push({
      slotIndex: role.slotIndex,
      occurrenceIndex,
      roleId: languageConstructionRoleId(input.hasher, input.bindingId, role.slotIndex),
      occurrenceId: languageConstructionOccurrenceId(input.hasher, input.bindingId, role.slotIndex, occurrenceIndex)
    });
  }
  durableRoles.sort(compareDurableRoles);
  durableNullRoles.sort(compareDurableNullRoles);
  const sourceVersionId = String(evidence.sourceVersionId);
  const evidenceId = String(evidence.id);
  const evidenceContentHash = String(evidence.contentHash);
  const surfaceDigest = input.hasher.digestHex(surface);
  const id = stableId(input.hasher, "surface.construction.example", [
    input.bindingId,
    input.profileId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    evidence.charStart,
    evidence.charEnd,
    observation.surfaceStartCodePoint,
    observation.surfaceEndCodePoint,
    surfaceDigest,
    durableRoles,
    durableNullRoles
  ]);
  const durable: DurableSourceConstructionExample = {
    id,
    bindingId: input.bindingId,
    sourceProfileId: input.profileId,
    targetProfileId: input.profileId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    evidenceCharStart: evidence.charStart,
    evidenceCharEnd: evidence.charEnd,
    surfaceStartCodePoint: observation.surfaceStartCodePoint,
    surfaceEndCodePoint: observation.surfaceEndCodePoint,
    surface,
    surfaceDigest,
    roles: durableRoles,
    nullRoles: durableNullRoles
  };
  const aligned: AlignedSurfaceExample = {
    id,
    profileKey: input.profileId,
    surface,
    evidenceIds: [evidenceId],
    roleSpans: durableRoles.map(role => ({
      roleId: role.roleId,
      occurrenceId: role.occurrenceId,
      start: utf16OffsetAtCodePoint(surface, role.startCodePoint),
      end: utf16OffsetAtCodePoint(surface, role.endCodePoint),
      surface: role.surface,
      evidenceIds: [evidenceId]
    })),
    nullRoleOccurrences: durableNullRoles.map(role => ({
      roleId: role.roleId,
      occurrenceId: role.occurrenceId,
      evidenceIds: [evidenceId]
    }))
  };
  return { durable, aligned };
}

function verifyCreativeEventPattern(
  pattern: LanguagePatternRecord,
  evidenceById: ReadonlyMap<string, EvidenceSpan>,
  hasher: Hasher
): { bundle: DurableLanguageConstructionBundle } | { issue: LanguageConstructionMemoryIssue } {
  const row = recordOf(pattern.patternJson);
  const rawBundle = recordOf(row.bundle);
  if (row.schema !== CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA
    || rawBundle.schema !== CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA
    || stringOf(rawBundle.compilerId) !== ENGLISH_CREATIVE_EVENT_COMPILER_ID
    || stringOf(rawBundle.profileId) !== pattern.profileId) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  }
  const rawEvents = arrayOfRecords(rawBundle.events);
  if (rawEvents.length < 4 || rawEvents.length > 2048) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  }
  const events: DurableCreativeEventConstruction[] = [];
  for (const rawEvent of rawEvents) {
    const parsed = creativeEventFromPersisted(rawEvent, pattern.profileId, evidenceById, hasher);
    if (!parsed) return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
    events.push(parsed);
  }
  const orderedEvents = events.sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal || compareText(left.id, right.id)
  );
  const sourceVersionIds = uniqueSorted(orderedEvents.map(event => event.sourceVersionId));
  const evidenceIds = uniqueSorted(orderedEvents.map(event => event.evidenceId));
  const evidenceContentHashes = uniqueSorted(orderedEvents.map(event => event.evidenceContentHash));
  const persistedContent = {
    schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
    compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    profileId: pattern.profileId,
    sourceVersionIds,
    evidenceIds,
    evidenceContentHashes,
    events: orderedEvents
  };
  const contentDigest = hasher.digestHex(canonicalStringify(persistedContent));
  const id = `surface.creative_event.bundle.${contentDigest}`;
  if (stringOf(row.contentDigest) !== contentDigest
    || pattern.id !== id
    || pattern.patternKind !== "semantic_role"
    || pattern.support !== orderedEvents.length
    || pattern.entropy !== 0
    || !sameStrings(pattern.evidenceIds.map(String), evidenceIds)
    || canonicalStringify(rawBundle) !== canonicalStringify(persistedContent)) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest);
  }
  return {
    bundle: {
      id,
      contentDigest,
      schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
      bindingId: `surface.creative_event.binding.${hasher.digestHex(pattern.profileId)}`,
      sourceProfileId: pattern.profileId,
      targetProfileId: pattern.profileId,
      sourceVersionIds,
      evidenceIds,
      evidenceContentHashes,
      sourceExamples: [],
      constructions: [],
      formClasses: [],
      creativeEvents: orderedEvents
    }
  };
}

function creativeEventFromPersisted(
  raw: Record<string, JsonValue>,
  profileId: string,
  evidenceById: ReadonlyMap<string, EvidenceSpan>,
  hasher: Hasher
): DurableCreativeEventConstruction | undefined {
  const evidenceId = stringOf(raw.evidenceId);
  const compilerId = stringOf(raw.compilerId);
  const sourceVersionId = stringOf(raw.sourceVersionId);
  const evidenceContentHash = stringOf(raw.evidenceContentHash);
  const sourceLabel = stringOf(raw.sourceLabel);
  const relationId = stringOf(raw.relationId);
  const tenseId = stringOf(raw.tenseId);
  const valencyId = stringOf(raw.valencyId);
  const formsRaw = recordOf(raw.forms);
  if (!evidenceId || compilerId !== ENGLISH_CREATIVE_EVENT_COMPILER_ID
    || !sourceVersionId || !evidenceContentHash || !sourceLabel || !relationId
    || stringOf(raw.profileId) !== profileId
    || !["scce.tense.past", "scce.tense.present", "scce.tense.future", "scce.tense.unknown"].includes(tenseId ?? "")
    || !["scce.valency.agent", "scce.valency.agent_patient"].includes(valencyId ?? "")) return undefined;
  const evidence = evidenceById.get(evidenceId);
  const evidenceCharStart = numberOf(raw.evidenceCharStart);
  const evidenceCharEnd = numberOf(raw.evidenceCharEnd);
  const labelStartCodePoint = numberOf(raw.labelStartCodePoint);
  const labelEndCodePoint = numberOf(raw.labelEndCodePoint);
  const sourceOrdinal = numberOf(raw.sourceOrdinal);
  if (!evidence
    || evidence.status !== "promoted"
    || String(evidence.sourceVersionId) !== sourceVersionId
    || String(evidence.contentHash) !== evidenceContentHash
    || evidence.charStart !== evidenceCharStart
    || evidence.charEnd !== evidenceCharEnd
    || !validRange(labelStartCodePoint, labelEndCodePoint, [...evidence.text].length)
    || !Number.isSafeInteger(sourceOrdinal)) return undefined;
  const boundLabel = [...evidence.text].slice(labelStartCodePoint, labelEndCodePoint).join("");
  if (boundLabel !== sourceLabel || hasher.digestHex(sourceLabel) !== stringOf(raw.sourceLabelDigest)) return undefined;
  const argumentFrame = creativeArgumentFrameFromPersisted({
    raw: recordOf(raw.argumentFrame),
    evidence,
    profileId,
    relationId,
    labelStartCodePoint,
    labelEndCodePoint,
    hasher
  });
  if (!argumentFrame) return undefined;
  const forms: DurableCreativeEventConstruction["forms"] = {
    infinitive: stringOf(formsRaw.infinitive) ?? "",
    past: stringOf(formsRaw.past) ?? "",
    present: stringOf(formsRaw.present) ?? "",
    gerund: stringOf(formsRaw.gerund) ?? "",
    participle: stringOf(formsRaw.participle) ?? ""
  };
  if (Object.values(forms).some(value => !value || !singleLexicalWord(value))) return undefined;
  const expectedRelationId = stableId(hasher, "language.source_relation", [
    profileId,
    normalizeMemorySurface(forms.infinitive)
  ]);
  const expectedConstructionId = stableId(hasher, "surface.creative_event.construction", [
    ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    profileId,
    tenseId,
    valencyId
  ]);
  const expectedValencyId = argumentFrame.bindings.length
    ? "scce.valency.agent_patient"
    : "scce.valency.agent";
  if (valencyId !== expectedValencyId) return undefined;
  const expectedRoleIds = argumentFrame.roleIds;
  const roleIds = arrayOfStrings(raw.roleIds);
  const expectedId = stableId(hasher, "surface.creative_event", [
    ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    expectedConstructionId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    labelStartCodePoint,
    labelEndCodePoint,
    expectedRelationId,
    hasher.digestHex(sourceLabel),
    argumentFrame,
    forms
  ]);
  if (relationId !== expectedRelationId
    || stringOf(raw.constructionId) !== expectedConstructionId
    || stringOf(raw.id) !== expectedId
    || !sameStrings(roleIds, expectedRoleIds)) return undefined;
  return {
    id: expectedId,
    compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    constructionId: expectedConstructionId,
    profileId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    evidenceCharStart,
    evidenceCharEnd,
    labelStartCodePoint,
    labelEndCodePoint,
    sourceOrdinal,
    relationId: expectedRelationId,
    sourceLabel,
    sourceLabelDigest: hasher.digestHex(sourceLabel),
    tenseId: tenseId as DurableCreativeEventConstruction["tenseId"],
    valencyId: valencyId as DurableCreativeEventConstruction["valencyId"],
    roleIds: expectedRoleIds,
    argumentFrame,
    forms
  };
}

function creativeArgumentFrameFromPersisted(input: {
  raw: Record<string, JsonValue>;
  evidence: EvidenceSpan;
  profileId: string;
  relationId: string;
  labelStartCodePoint: number;
  labelEndCodePoint: number;
  hasher: Hasher;
}): DurableCreativeEventArgumentFrame | undefined {
  const sourceSentenceStartCodePoint = numberOf(input.raw.sourceSentenceStartCodePoint);
  const sourceSentenceEndCodePoint = numberOf(input.raw.sourceSentenceEndCodePoint);
  const evidencePoints = [...input.evidence.text];
  if (input.raw.schema !== CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA
    || input.raw.compilerId !== ENGLISH_CREATIVE_EVENT_COMPILER_ID
    || !validRange(sourceSentenceStartCodePoint, sourceSentenceEndCodePoint, evidencePoints.length)
    || input.labelStartCodePoint < sourceSentenceStartCodePoint
    || input.labelEndCodePoint > sourceSentenceEndCodePoint) return undefined;
  const rawBindings = arrayOfRecords(input.raw.bindings);
  if (rawBindings.length > 2) return undefined;
  const bindings: DurableCreativeEventArgumentBinding[] = [];
  const seenRoles = new Set<string>();
  for (const rawBinding of rawBindings) {
    const roleId = stringOf(rawBinding.roleId);
    const surface = stringOf(rawBinding.surface);
    const startCodePoint = numberOf(rawBinding.startCodePoint);
    const endCodePoint = numberOf(rawBinding.endCodePoint);
    if ((roleId !== "scce.role.patient" && roleId !== "scce.role.complement")
      || seenRoles.has(roleId)
      || !surface
      || !singleLexicalWord(surface)
      || !validRange(startCodePoint, endCodePoint, evidencePoints.length)
      || startCodePoint < input.labelEndCodePoint
      || startCodePoint < sourceSentenceStartCodePoint
      || endCodePoint > sourceSentenceEndCodePoint
      || evidencePoints.slice(startCodePoint, endCodePoint).join("") !== surface
      || input.hasher.digestHex(surface) !== stringOf(rawBinding.surfaceDigest)) return undefined;
    const connectorRaw = recordOf(rawBinding.connector);
    const connector = Object.keys(connectorRaw).length
      ? creativeClosedClassConnectorFromPersisted({
        raw: connectorRaw,
        evidencePoints,
        sourceSentenceStartCodePoint,
        sourceSentenceEndCodePoint,
        labelEndCodePoint: input.labelEndCodePoint,
        bindingStartCodePoint: startCodePoint,
        hasher: input.hasher
      })
      : undefined;
    if (Object.keys(connectorRaw).length && !connector) return undefined;
    if (connector && roleId !== "scce.role.complement") return undefined;
    seenRoles.add(roleId);
    bindings.push({
      roleId,
      surface,
      surfaceDigest: input.hasher.digestHex(surface),
      startCodePoint,
      endCodePoint,
      ...(connector ? { connector } : {})
    });
  }
  const roleIds = ["scce.role.agent", ...bindings.map(binding => binding.roleId)];
  if (!sameStrings(arrayOfStrings(input.raw.roleIds), roleIds)) return undefined;
  const expectedId = stableId(input.hasher, "surface.creative_event.argument_frame", [
    ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    input.profileId,
    input.relationId,
    roleIds,
    bindings.map(binding => ({
      roleId: binding.roleId,
      connector: binding.connector
        ? normalizeMemorySurface(binding.connector.surface)
        : null
    }))
  ]);
  if (stringOf(input.raw.id) !== expectedId) return undefined;
  return {
    id: expectedId,
    schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
    compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    sourceSentenceStartCodePoint,
    sourceSentenceEndCodePoint,
    roleIds,
    bindings
  };
}

function creativeClosedClassConnectorFromPersisted(input: {
  raw: Record<string, JsonValue>;
  evidencePoints: string[];
  sourceSentenceStartCodePoint: number;
  sourceSentenceEndCodePoint: number;
  labelEndCodePoint: number;
  bindingStartCodePoint: number;
  hasher: Hasher;
}): DurableCreativeEventClosedClassConnector | undefined {
  const surface = stringOf(input.raw.surface);
  const startCodePoint = numberOf(input.raw.startCodePoint);
  const endCodePoint = numberOf(input.raw.endCodePoint);
  if (!surface
    || !singleLexicalWord(surface)
    || !validRange(startCodePoint, endCodePoint, input.evidencePoints.length)
    || startCodePoint < input.labelEndCodePoint
    || startCodePoint < input.sourceSentenceStartCodePoint
    || endCodePoint > input.sourceSentenceEndCodePoint
    || endCodePoint > input.bindingStartCodePoint
    || input.evidencePoints.slice(startCodePoint, endCodePoint).join("") !== surface
    || input.hasher.digestHex(surface) !== stringOf(input.raw.surfaceDigest)) return undefined;
  return {
    surface,
    surfaceDigest: input.hasher.digestHex(surface),
    startCodePoint,
    endCodePoint
  };
}

function verifyPersistedPattern(
  pattern: LanguagePatternRecord,
  evidenceById: ReadonlyMap<string, EvidenceSpan>,
  hasher: Hasher
): { bundle: DurableLanguageConstructionBundle } | { issue: LanguageConstructionMemoryIssue } {
  const row = recordOf(pattern.patternJson);
  const rawBundle = recordOf(row.bundle);
  if (row.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA
    || rawBundle.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }
  const bindingId = stringOf(rawBundle.bindingId);
  const sourceProfileId = stringOf(rawBundle.sourceProfileId);
  const targetProfileId = stringOf(rawBundle.targetProfileId);
  if (!bindingId || !sourceProfileId || !targetProfileId
    || sourceProfileId !== targetProfileId
    || pattern.profileId !== targetProfileId) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  }
  const sourceExamples = arrayOfRecords(rawBundle.sourceExamples);
  if (sourceExamples.length === 0 || sourceExamples.length > 256) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  }
  const observations: SourceBoundConstructionObservation[] = [];
  for (const raw of sourceExamples) {
    const parsed = observationFromPersistedExample(raw, {
      bindingId,
      sourceProfileId,
      targetProfileId,
      evidenceById
    });
    if ("code" in parsed) return { issue: { ...parsed, patternId: pattern.id, profileId: pattern.profileId } };
    observations.push(parsed.observation);
  }
  const evidenceIds = uniqueSorted(observations.map(item => item.evidenceId));
  const evidence = evidenceIds.map(id => evidenceById.get(id)).filter((item): item is EvidenceSpan => Boolean(item));
  if (evidence.length !== evidenceIds.length) return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
  const recompiled = compileLanguageConstructionPattern({
    bindingId,
    profileId: targetProfileId,
    observations,
    evidence,
    hasher,
    updatedAt: pattern.updatedAt
  });
  if (recompiled.status !== "compiled") return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  const expectedRow = recordOf(recompiled.pattern.patternJson);
  if (stringOf(row.contentDigest) !== recompiled.bundle.contentDigest
    || pattern.id !== recompiled.pattern.id
    || pattern.patternKind !== recompiled.pattern.patternKind
    || pattern.profileId !== recompiled.pattern.profileId
    || pattern.support !== recompiled.pattern.support
    || pattern.entropy !== recompiled.pattern.entropy
    || !sameStrings(pattern.evidenceIds.map(String), recompiled.pattern.evidenceIds.map(String))) {
    return issue(pattern, pattern.id !== recompiled.pattern.id
      ? LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.identity
      : LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest);
  }
  if (canonicalStringify(rawBundle) !== canonicalStringify(recordOf(expectedRow.bundle))) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  }
  return { bundle: recompiled.bundle };
}

function observationFromPersistedExample(
  raw: Record<string, JsonValue>,
  ownership: {
    bindingId: string;
    sourceProfileId: string;
    targetProfileId: string;
    evidenceById: ReadonlyMap<string, EvidenceSpan>;
  }
): { observation: SourceBoundConstructionObservation } | LanguageConstructionMemoryIssue {
  const evidenceId = stringOf(raw.evidenceId);
  const sourceVersionId = stringOf(raw.sourceVersionId);
  if (!evidenceId || !sourceVersionId
    || stringOf(raw.bindingId) !== ownership.bindingId
    || stringOf(raw.sourceProfileId) !== ownership.sourceProfileId
    || stringOf(raw.targetProfileId) !== ownership.targetProfileId) {
    return { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership, evidenceId, sourceVersionId };
  }
  const evidence = ownership.evidenceById.get(evidenceId);
  if (!evidence
    || String(evidence.sourceVersionId) !== sourceVersionId
    || String(evidence.contentHash) !== stringOf(raw.evidenceContentHash)
    || evidence.charStart !== numberOf(raw.evidenceCharStart)
    || evidence.charEnd !== numberOf(raw.evidenceCharEnd)) {
    return { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence, evidenceId, sourceVersionId };
  }
  const roles = arrayOfRecords(raw.roles).map(role => ({
    slotIndex: numberOf(role.slotIndex),
    occurrenceIndex: numberOf(role.occurrenceIndex),
    startCodePoint: numberOf(role.startCodePoint),
    endCodePoint: numberOf(role.endCodePoint)
  }));
  const nullRoles = arrayOfRecords(raw.nullRoles).map(role => ({
    slotIndex: numberOf(role.slotIndex),
    occurrenceIndex: numberOf(role.occurrenceIndex)
  }));
  const observation: SourceBoundConstructionObservation = {
    sourceVersionId,
    evidenceId,
    surfaceStartCodePoint: numberOf(raw.surfaceStartCodePoint),
    surfaceEndCodePoint: numberOf(raw.surfaceEndCodePoint),
    roles,
    nullRoles
  };
  const points = [...evidence.text];
  const surface = points.slice(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint).join("");
  if (surface !== stringOf(raw.surface)
    || stringOf(raw.surfaceDigest) === undefined
    || roles.some((role, index) => {
      const roleRaw = arrayOfRecords(raw.roles)[index];
      return !roleRaw
        || surface.slice(
          utf16OffsetAtCodePoint(surface, role.startCodePoint),
          utf16OffsetAtCodePoint(surface, role.endCodePoint)
        ) !== stringOf(roleRaw.surface);
    })) {
    return { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId, sourceVersionId };
  }
  return { observation };
}

function rejected(code: LanguageConstructionMemoryRejectionId): LanguageConstructionPatternCompilation {
  return { status: "rejected", issues: [{ code }] };
}

function issue(
  pattern: LanguagePatternRecord,
  code: LanguageConstructionMemoryRejectionId
): { issue: LanguageConstructionMemoryIssue } {
  return { issue: { code, patternId: pattern.id, profileId: pattern.profileId } };
}

function stableId(hasher: Hasher, prefix: string, value: unknown): string {
  return `${prefix}.${hasher.digestHex(canonicalStringify([prefix, value]))}`;
}

function checkedIndex(value: number): number {
  if (!validIndex(value)) throw new Error("invalid surface construction index");
  return value;
}

function validIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4096;
}

function validRange(start: number, end: number, length: number): boolean {
  return Number.isSafeInteger(start)
    && Number.isSafeInteger(end)
    && start >= 0
    && end >= start
    && end <= length;
}

function utf16OffsetAtCodePoint(surface: string, offset: number): number {
  return [...surface].slice(0, offset).join("").length;
}

function codePointOffsetAtUtf16(surface: string, offset: number): number {
  return [...surface.slice(0, offset)].length;
}

function uniqueEvidenceById(evidence: readonly EvidenceSpan[]): Map<string, EvidenceSpan> | undefined {
  const out = new Map<string, EvidenceSpan>();
  for (const span of evidence) {
    const id = String(span.id);
    if (out.has(id)) return undefined;
    out.set(id, span);
  }
  return out;
}

function minimumSupport(values: readonly number[]): number {
  return values.length ? Math.min(...values) : 0;
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function duplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function recordOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function arrayOfRecords(value: JsonValue | undefined): Array<Record<string, JsonValue>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, JsonValue> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function arrayOfStrings(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function arrayUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringUnknown(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function termIndexUnknown(value: unknown): number | undefined {
  const index = arrayUnknown(value).at(-1);
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
    ? index
    : undefined;
}

function singleLexicalWord(value: string): boolean {
  return /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$/u.test(value.normalize("NFC"));
}

function normalizeMemorySurface(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function stringOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function nonempty(value: string): boolean {
  return value.length > 0 && value.trim().length > 0 && !value.includes("\u0000");
}

function compareDurableExamples(left: DurableSourceConstructionExample, right: DurableSourceConstructionExample): number {
  return compareText(left.id, right.id);
}

function compareDurableRoles(
  left: DurableSourceConstructionExample["roles"][number],
  right: DurableSourceConstructionExample["roles"][number]
): number {
  return left.slotIndex - right.slotIndex
    || left.occurrenceIndex - right.occurrenceIndex
    || left.startCodePoint - right.startCodePoint
    || compareText(left.occurrenceId, right.occurrenceId);
}

function compareDurableNullRoles(
  left: DurableSourceConstructionExample["nullRoles"][number],
  right: DurableSourceConstructionExample["nullRoles"][number]
): number {
  return left.slotIndex - right.slotIndex
    || left.occurrenceIndex - right.occurrenceIndex
    || compareText(left.occurrenceId, right.occurrenceId);
}

function compareIssues(left: LanguageConstructionMemoryIssue, right: LanguageConstructionMemoryIssue): number {
  return compareText(left.patternId ?? "", right.patternId ?? "")
    || compareText(left.code, right.code)
    || compareText(left.evidenceId ?? "", right.evidenceId ?? "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
