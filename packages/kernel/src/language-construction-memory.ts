// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { buildConstructionGrammarMdlState, currentConstructionGrammarMdlScore } from "./construction-grammar-mdl-incremental.js";
import type { ConstructionGrammarMdlScore } from "./construction-grammar-mdl.js";
import {
  induceLearnedConstructions,
  type AlignedSurfaceExample,
  type LearnedConstruction,
  type LearnedFormClass
} from "./language-construction.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import { type GraphBoundConstruction } from "./language-induction.js";
import { preparedLanguageInductionProducts, type PreparedConstructionInduction } from "./graph-surface-alignment.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { ContextualQaSupervision } from "./source-owned-contextual-qa.js";
import type { SemanticRole } from "./semantic-graph.js";
import type { EvidenceSpan, Hasher, JsonValue } from "./types.js";

export const LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA = "scce.language_construction_pattern.v1" as const;
export const SOURCE_EXAMPLE_CONSTRUCTION_STORAGE = "scce.language_construction.source_examples.v1" as const;
export const SOURCE_CONSTRUCTION_BINDINGS_COMPONENT_RECIPE_ID = "kernel.source_construction_graph_bindings.v1" as const;
export const LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID = "kernel.language_construction_active_projection.v1" as const;
export const SOURCE_CONSTRUCTION_PREDICATE_SLOT_INDEX = 1 as const;
export const OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2 = "scce.creative_event_construction_pattern.v2" as const;
export const CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA = "scce.creative_event_construction_pattern.v3" as const;
export const CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA = "scce.creative_event_argument_frame.v1" as const;
/**
 * Corpus-induced, zero-hardcoded-language compiler (Part B step 7). Builds
 * `DurableCreativeEventConstruction`s from `language-induction.ts`'s
 * `GraphBoundConstruction`s (steps 4-6) using the same universal induction
 * path for every script/corpus.
 */
export const UNIVERSAL_CREATIVE_EVENT_COMPILER_ID = "surface.compiler.universal.induced.v1" as const;
export const UNIVERSAL_CREATIVE_EVENT_COVERAGE_RECIPE_ID = "kernel.creative_event_source_pages.v1" as const;

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
  obsoleteCreativeV2: "surface.construction_memory.reject.obsolete_creative_v2"
} as const;

export type LanguageConstructionMemoryRejectionId =
  typeof LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS[keyof typeof LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS];

/**
 * A role alignment supplied by a typed corpus extractor. Coordinates are
 * Unicode code-point offsets relative to the example surface.
 */
export interface SourceConstructionGraphBinding {
  relationId: string;
  roleId: string;
  valueKind: string;
  semanticRole?: SemanticRole;
  qualifiers?: JsonValue;
  modality?: JsonValue;
  temporalScope?: JsonValue;
}

export interface SourceBoundConstructionRoleSpan {
  slotIndex: number;
  occurrenceIndex?: number;
  startCodePoint: number;
  endCodePoint: number;
  graphBinding?: SourceConstructionGraphBinding;
}

export interface SourceBoundConstructionNullRole {
  slotIndex: number;
  occurrenceIndex?: number;
  graphBinding?: SourceConstructionGraphBinding;
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
  /** Preceding source turn, in code points relative to this observation's evidence. */
  antecedent?: { startCodePoint: number; endCodePoint: number };
  contextualQaSupervision?: ContextualQaSupervision;
}

export interface SourceBoundLanguageConstructionTrainingSet {
  bindingId: string;
  observations: readonly SourceBoundConstructionObservation[];
  alignmentSummary?: JsonValue;
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
  antecedent?: { startCodePoint: number; endCodePoint: number; surface: string; surfaceDigest: string };
  contextualQaSupervision?: ContextualQaSupervision;
  roles: Array<{
    slotIndex: number;
    occurrenceIndex: number;
    roleId: string;
    occurrenceId: string;
    startCodePoint: number;
    endCodePoint: number;
    surface: string;
    graphBinding?: SourceConstructionGraphBinding;
  }>;
  nullRoles: Array<{
    slotIndex: number;
    occurrenceIndex: number;
    roleId: string;
    occurrenceId: string;
    graphBinding?: SourceConstructionGraphBinding;
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
  acquisitionStatus?: "source_observed" | "document_heldout_qualified";
}

export interface DurableLanguageConstructionBundle extends DurableLanguageConstructionBundleContent {
  id: string;
  contentDigest: string;
  qualificationStatus?: "document_heldout_qualified" | "unqualified";
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
  /** Universal compiler id for the corpus-derived construction source. */
  compilerId: string;
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
      mdl?: ConstructionGrammarMdlScore;
      patterns?: LanguagePatternRecord[];
      bundles?: DurableLanguageConstructionBundle[];
      coverage?: JsonValue;
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
  preparedInduction?: PreparedConstructionInduction;
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

interface LanguageConstructionPatternInput {
  bindingId: string;
  profileId: string;
  observations: readonly SourceBoundConstructionObservation[];
  evidence: readonly EvidenceSpan[];
  hasher: Hasher;
  updatedAt: number;
  acquisitionStatus?: DurableLanguageConstructionBundleContent["acquisitionStatus"];
  storageEncoding?: typeof SOURCE_EXAMPLE_CONSTRUCTION_STORAGE;
}

export function compileLanguageConstructionPattern(input: LanguageConstructionPatternInput): LanguageConstructionPatternCompilation {
  return compileConstructionPattern(input, uniqueEvidenceById(input.evidence), new Map());
}

export function* compileLanguageConstructionPatterns(input: Omit<LanguageConstructionPatternInput, "bindingId" | "observations" | "acquisitionStatus"> & {
  sets: readonly Pick<LanguageConstructionPatternInput, "bindingId" | "observations" | "acquisitionStatus">[];
}): IterableIterator<LanguageConstructionPatternCompilation> {
  const evidenceById = uniqueEvidenceById(input.evidence.map(span => ({ ...span })));
  const evidencePointsById = new Map<string, string[]>();
  for (const set of input.sets) yield compileConstructionPattern({ ...input, ...set }, evidenceById, evidencePointsById);
}

function compileConstructionPattern(
  input: LanguageConstructionPatternInput,
  evidenceById: ReadonlyMap<string, EvidenceSpan> | undefined,
  evidencePointsById: Map<string, string[]>
): LanguageConstructionPatternCompilation {
  if (!nonempty(input.bindingId)
    || !nonempty(input.profileId)
    || !Number.isFinite(input.updatedAt)
    || input.observations.length === 0
    || input.observations.length > 256
    || (input.storageEncoding !== undefined && input.storageEncoding !== SOURCE_EXAMPLE_CONSTRUCTION_STORAGE)
    || (input.acquisitionStatus !== undefined
      && input.acquisitionStatus !== "source_observed"
      && input.acquisitionStatus !== "document_heldout_qualified")) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }

  if (!evidenceById || evidenceById.size === 0) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
  }

  const durableExamples: DurableSourceConstructionExample[] = [];
  const alignedExamples: AlignedSurfaceExample[] = [];
  for (const observation of input.observations) {
    const prepared = prepareObservation({ ...input, observation, evidenceById, evidencePointsById });
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
  // MDL score travels with the compiled grammar as an audit signal; short-example grammars legitimately cost more bits than their literal text, so it never rejects.
  const mdl = currentConstructionGrammarMdlScore(buildConstructionGrammarMdlState({ constructions: induction.constructions, formClasses: induction.formClasses }));
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
    formClasses: [...induction.formClasses],
    ...(input.acquisitionStatus ? { acquisitionStatus: input.acquisitionStatus } : {})
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
      bundle: (input.storageEncoding === SOURCE_EXAMPLE_CONSTRUCTION_STORAGE ? sourceExampleStorageBundle(bundle) : bundle) as unknown as JsonValue,
      ...(input.storageEncoding ? { storageEncoding: input.storageEncoding } : {})
    },
    evidenceIds: evidenceIds as EvidenceSpan["id"][],
    updatedAt: input.updatedAt
  };
  return { status: "compiled", pattern, bundle, mdl };
}

function sourceExampleStorageBundle(bundle: DurableLanguageConstructionBundle): Record<string, unknown> {
  const { constructions: _programs, formClasses: _variants, sourceExamples, qualificationStatus: _annotation, ...header } = bundle;
  return { ...header, sourceExamples: sourceExamples.map(example => ({
    evidenceIndex: bundle.evidenceIds.indexOf(example.evidenceId),
    surfaceStartCodePoint: example.surfaceStartCodePoint,
    surfaceEndCodePoint: example.surfaceEndCodePoint,
    roles: example.roles.map(role => ({ slotIndex: role.slotIndex, occurrenceIndex: role.occurrenceIndex,
      startCodePoint: role.startCodePoint, endCodePoint: role.endCodePoint, ...(role.graphBinding ? { graphBinding: role.graphBinding } : {}) })),
    ...(example.nullRoles.length ? { nullRoles: example.nullRoles.map(role => ({ slotIndex: role.slotIndex, occurrenceIndex: role.occurrenceIndex,
      ...(role.graphBinding ? { graphBinding: role.graphBinding } : {}) })) } : {}),
    ...(example.antecedent ? { antecedent: { startCodePoint: example.antecedent.startCodePoint, endCodePoint: example.antecedent.endCodePoint } } : {}),
    ...(example.contextualQaSupervision ? { contextualQaSupervision: example.contextualQaSupervision } : {})
  })) };
}

export function createUniversalCreativeEventConstructionCompiler(): CreativeEventConstructionCompiler {
  return {
    id: UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
    compile: input => compileUniversalCreativeEventPatterns(input, true)
  };
}

/**
 * Zero-hardcoded-language creative-event compiler (Part B step 7). Builds
 * `DurableCreativeEventConstruction`s directly from `language-induction.ts`'s
 * `induce()` output (steps 4-6: real word-level segmentation, distributional
 * lexical classes, graph-bound predicate/argument constructions). There is no
 * verb list, pronoun list, language-specific POS tagger, or word-order switch.
 * A structural initiator slot records that the predicate had a real
 * left-context unit at this occurrence without storing that surface as a
 * universal grammar category; a patient binding is recorded only when a
 * construction's arg1 slot has a real filler at this specific occurrence,
 * with the actual character span of that occurrence. Form fields remain
 * conservative: without a verified transformation signal, all form entries
 * carry the one real observed predicate surface rather than fabricated
 * inflection.
 */
export function compileUniversalCreativeEventConstructionPattern(
  input: CreativeEventConstructionCompilerInput
): LanguageConstructionPatternCompilation {
  return compileUniversalCreativeEventPatterns(input, false);
}

function compileUniversalCreativeEventPatterns(input: CreativeEventConstructionCompilerInput, completeSource: boolean): LanguageConstructionPatternCompilation {
  if (!nonempty(input.profileId) || !Number.isFinite(input.updatedAt)) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }
  const promotedEvidence = input.evidence
    .filter(span => span.status === "promoted")
    .sort((left, right) => left.charStart - right.charStart || compareText(String(left.id), String(right.id)));
  if (!promotedEvidence.length) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);

  // Reuse the same bounded source-window products that feed graph and language acquisition.
  const products = preparedLanguageInductionProducts({ hasher: input.hasher, prepared: input.preparedInduction,
    documents: (input.preparedInduction ? input.evidence.filter(span => span.status === "promoted") : promotedEvidence).map(span => ({
      id: String(span.id),
      text: span.text,
      evidenceIds: [span.id],
      sourceVersionId: span.sourceVersionId
    }))
  });
  const constructions = products.models.flatMap(model => model.graphBoundConstructions);
  if (!constructions.length) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);
  const constructionsByPredicate = new Map<string, GraphBoundConstruction[]>();
  for (const construction of constructions) {
    const variants = constructionsByPredicate.get(construction.predicate) ?? [];
    variants.push(construction);
    constructionsByPredicate.set(construction.predicate, variants);
  }

  const maxEvents = Math.max(1, Math.min(2048, Math.floor(input.maxEvents ?? 768)));
  if (completeSource && maxEvents < 4) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  const events: DurableCreativeEventConstruction[] = [];
  const windowsByEvidence = new Map(promotedEvidence.map(evidence => [String(evidence.id), products.coverage.windows
    .filter(window => window.ownerDocumentId === String(evidence.id)).sort((left, right) => left.startUtf16 - right.startUtf16)]));
  const eventWindowIds = new Map<string, string>();
  // Real cross-sentence recurrence requirement: a single degenerate
  // sentence (no repeated corpus structure at all) can still spuriously
  // classify several of its own words as candidate predicates, each
  // producing one event -- enough to clear events.length alone. Tracking
  // which real sentence each event came from (advancing on genuine
  // sentence-terminal punctuation in the same lexical stream, not a
  // separate re-segmentation) lets the compiler require events to
  // actually recur across multiple real utterances, not just multiple
  // words of the same lone one.
  const eventSentenceKeys: string[] = [];
  for (const evidence of promotedEvidence) {
    if (!completeSource && events.length >= maxEvents) break;
    const lexical = segmentUnicodeSurfaceV2(evidence.text, input.hasher).lexicalSegments;
    // segmentUnicodeSurfaceV2's lexical segments are word-like units --
    // punctuation is not itself a segment, so sentence-terminal marks only
    // show up in the raw text gap between two segments' code-point ranges.
    const codePoints = [...evidence.text];
    let sentenceOrdinal = 0;
    let previousEnd = 0;
    const windows = windowsByEvidence.get(String(evidence.id)) ?? [];
    let windowIndex = 0;
    for (let index = 0; index < lexical.length && (completeSource || events.length < maxEvents); index++) {
      const segment = lexical[index]!;
      while (windowIndex < windows.length && segment.utf16Start >= windows[windowIndex]!.endUtf16) windowIndex++;
      const gap = codePoints.slice(previousEnd, segment.codePointStart).join("");
      if (containsSentenceTerminal(gap)) sentenceOrdinal += 1;
      previousEnd = segment.codePointEnd;
      for (const construction of constructionsByPredicate.get(segment.normalized) ?? []) {
        if (construction.sourceWindows?.length && !construction.sourceWindows.some(window => window.ownerDocumentId === String(evidence.id)
          && segment.utf16Start >= window.startUtf16 && segment.utf16Start < window.endUtf16)) continue;
        const compiled = compileUniversalCreativeEvent({
          profileId: input.profileId,
          evidence,
          lexical,
          index,
          construction,
          hasher: input.hasher
        });
        if (compiled) {
          events.push(compiled);
          if (windows[windowIndex]) eventWindowIds.set(compiled.id, windows[windowIndex]!.documentId);
          eventSentenceKeys.push(`${evidence.id}#${sentenceOrdinal}`);
          break;
        }
      }
    }
  }
  if (events.length < 4) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);
  if (new Set(eventSentenceKeys).size < 2) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);

  const orderedEvents = events
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal || compareText(left.id, right.id));
  if (!completeSource) return creativeEventPattern(input, orderedEvents);
  if (eventWindowIds.size !== orderedEvents.length) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  const compilationId = input.hasher.digestHex(canonicalStringify({ recipe: UNIVERSAL_CREATIVE_EVENT_COVERAGE_RECIPE_ID,
    profileId: input.profileId, sourceInputDigest: products.coverage.inputDigest, maxEvents, eventIds: orderedEvents.map(event => event.id) }));
  const pageCount = Math.ceil(orderedEvents.length / maxEvents);
  const pageSize = Math.ceil(orderedEvents.length / pageCount);
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const pageEvents = orderedEvents.slice(index * pageSize, (index + 1) * pageSize);
    const windowIds = new Set(pageEvents.map(event => eventWindowIds.get(event.id)));
    return creativeEventPattern(input, pageEvents, { recipe: UNIVERSAL_CREATIVE_EVENT_COVERAGE_RECIPE_ID, compilationId, index, pageCount,
      maxEvents, qualification: "source_observed", windows: products.coverage.windows.filter(window => windowIds.has(window.documentId)) });
  });
  const compiled = pages.filter((page): page is Extract<LanguageConstructionPatternCompilation, { status: "compiled" }> => page.status === "compiled");
  if (compiled.length !== pageCount) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);
  const counts = new Map<string, number>();
  for (const id of eventWindowIds.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
  const coverage = toJsonValue({ schema: "scce.creative_event_source_coverage.v1", recipe: UNIVERSAL_CREATIVE_EVENT_COVERAGE_RECIPE_ID,
    compilationId, sourceInduction: products.coverage, complete: true, observedEvents: orderedEvents.length,
    windows: products.coverage.windows.map(window => ({ ...window, observedEvents: counts.get(window.documentId) ?? 0 })),
    pages: compiled.map((page, index) => ({ index, id: page.pattern.id, observedEvents: page.bundle.creativeEvents?.length ?? 0 })) });
  const receipt: LanguagePatternRecord = { id: `creative.source.coverage.${compilationId}`, profileId: input.profileId, patternKind: "source_compilation",
    support: 0, entropy: 0, patternJson: coverage, evidenceIds: promotedEvidence.map(span => span.id), updatedAt: input.updatedAt };
  return { ...compiled[0]!, patterns: [...compiled.map(page => page.pattern), receipt], bundles: compiled.map(page => page.bundle), coverage };
}

function creativeEventPattern(input: CreativeEventConstructionCompilerInput, orderedEvents: DurableCreativeEventConstruction[], sourcePage?: Record<string, unknown>): LanguageConstructionPatternCompilation {
  if (orderedEvents.length < 4 || orderedEvents.length > 2048) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);
  const sourceVersionIds = uniqueSorted(orderedEvents.map(event => event.sourceVersionId));
  const evidenceIds = uniqueSorted(orderedEvents.map(event => event.evidenceId));
  const evidenceContentHashes = uniqueSorted(orderedEvents.map(event => event.evidenceContentHash));
  const persistedContent = {
    schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
    compilerId: UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
    profileId: input.profileId,
    sourceVersionIds,
    evidenceIds,
    evidenceContentHashes,
    events: orderedEvents,
    ...(sourcePage ? { sourcePage } : {})
  };
  const contentDigest = input.hasher.digestHex(canonicalStringify(persistedContent));
  const id = `surface.creative_event.bundle.${contentDigest}`;
  const bundle: DurableLanguageConstructionBundle = {
    id,
    contentDigest,
    schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
    bindingId: `surface.creative_event.binding.${input.hasher.digestHex(input.profileId)}`,
    acquisitionStatus: "source_observed",
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

function compileUniversalCreativeEvent(input: {
  profileId: string;
  evidence: EvidenceSpan;
  lexical: readonly LexicalSegment[];
  index: number;
  construction: GraphBoundConstruction;
  hasher: Hasher;
}): DurableCreativeEventConstruction | undefined {
  const { evidence, lexical, index, construction, hasher } = input;
  const predicate = construction.predicate;
  const segment = lexical[index]!;
  if (!predicate || !singleLexicalWord(predicate)) return undefined;
  const arg0Slot = construction.slots.find(slot => slot.relationDirection === "source");
  const arg1Slot = construction.slots.find(slot => slot.relationDirection === "target");
  const left = lexical[index - 1];
  // Structural initiator requirement: the left context must exist in this
  // observed occurrence, but its surface is not elevated into a universal
  // language category.
  // Real-predicate requirement: induceSemanticFrames buckets every corpus
  // word into its own candidate frame (arg0 = left window, arg1 = right
  // window), so a noun that always follows the real verb (e.g. a fixed
  // direct object) gets its own spurious single-slot "construction" whose
  // source fillers are contaminated by that verb bleeding into its left
  // window. A genuine predicate's own source slot fillers are exactly its
  // real, induced argument class (classCoverage 1); a noun masquerading as
  // one scores strictly below 1 here (never exactly 1), because the actual
  // verb -- never a member of that noun's argument class -- pollutes its
  // filler set. A construction with no class match at all (classCoverage
  // undefined) gets no opinion either way here -- that is the ordinary,
  // legitimate case for a single-occurrence predicate in real prose with
  // no repeated substitutable structure to measure, not evidence of
  // contamination -- only a *measured, diluted* match is rejected.
  if (!left || !arg0Slot) return undefined;
  const contaminatedSourceSlot = arg0Slot.classCoverage !== undefined && arg0Slot.classCoverage < 1;
  if (contaminatedSourceSlot) return undefined;
  const right = lexical[index + 1];
  const arg1Fillers = arg1Slot?.observedFillers;
  const hasPatient = Boolean(right && arg1Fillers?.includes(right.normalized));

  const bindings: DurableCreativeEventArgumentBinding[] = [];
  if (hasPatient && right) {
    bindings.push({
      roleId: "scce.role.patient",
      surface: right.surface,
      surfaceDigest: hasher.digestHex(right.surface),
      startCodePoint: right.codePointStart,
      endCodePoint: right.codePointEnd
    });
  }
  const roleIds = ["scce.role.agent", ...bindings.map(binding => binding.roleId)];
  const relationId = stableId(hasher, "language.source_relation", [input.profileId, normalizeMemorySurface(predicate)]);
  const argumentFrameId = stableId(hasher, "surface.creative_event.argument_frame", [
    UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
    input.profileId,
    relationId,
    roleIds,
    bindings.map(binding => ({ roleId: binding.roleId, connector: null }))
  ]);
  const argumentFrame: DurableCreativeEventArgumentFrame = {
    id: argumentFrameId,
    schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
    compilerId: UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
    sourceSentenceStartCodePoint: left.codePointStart,
    sourceSentenceEndCodePoint: (right ?? segment).codePointEnd,
    roleIds,
    bindings
  };
  const valencyId = bindings.length ? "scce.valency.agent_patient" as const : "scce.valency.agent" as const;
  const forms = { infinitive: predicate, past: predicate, present: predicate, gerund: predicate, participle: predicate };
  const constructionId = stableId(hasher, "surface.creative_event.construction", [
    UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
    input.profileId,
    "scce.tense.unknown",
    valencyId
  ]);
  const id = stableId(hasher, "surface.creative_event", [
    UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
    constructionId,
    String(evidence.sourceVersionId),
    String(evidence.id),
    String(evidence.contentHash),
    segment.codePointStart,
    segment.codePointEnd,
    relationId,
    hasher.digestHex(predicate),
    argumentFrame,
    forms
  ]);
  return {
    id,
    compilerId: UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
    constructionId,
    profileId: input.profileId,
    sourceVersionId: String(evidence.sourceVersionId),
    evidenceId: String(evidence.id),
    evidenceContentHash: String(evidence.contentHash),
    evidenceCharStart: evidence.charStart,
    evidenceCharEnd: evidence.charEnd,
    labelStartCodePoint: segment.codePointStart,
    labelEndCodePoint: segment.codePointEnd,
    sourceOrdinal: evidence.charStart + segment.codePointStart,
    relationId,
    sourceLabel: predicate,
    sourceLabelDigest: hasher.digestHex(predicate),
    tenseId: "scce.tense.unknown",
    valencyId,
    roleIds,
    argumentFrame,
    forms
  };
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
  const evidenceById = uniqueEvidenceById(input.evidence.map(span => ({ ...span })));
  const evidencePointsById = new Map<string, string[]>();
  const evidenceUtf16OffsetsById = new Map<string, number[]>();
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
      ? verifyCreativeEventPattern(pattern, evidenceById, input.hasher, evidencePointsById, evidenceUtf16OffsetsById)
      : isObsoleteCreativeEventConstructionPatternV2(pattern)
        ? issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.obsoleteCreativeV2)
        : verifyPersistedPattern(pattern, evidenceById, input.hasher, evidencePointsById);
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

function isObsoleteCreativeEventConstructionPatternV2(pattern: LanguagePatternRecord): boolean {
  return recordOf(pattern.patternJson).schema === OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2;
}

function prepareObservation(input: {
  bindingId: string;
  profileId: string;
  observation: SourceBoundConstructionObservation;
  evidenceById: ReadonlyMap<string, EvidenceSpan>;
  evidencePointsById: Map<string, string[]>;
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
  let evidencePoints = input.evidencePointsById.get(observation.evidenceId);
  if (!evidencePoints) {
    evidencePoints = [...evidence.text];
    input.evidencePointsById.set(observation.evidenceId, evidencePoints);
  }
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
  const supervision = observation.contextualQaSupervision;
  if (supervision && (!nonempty(supervision.sourceRecordId) || !nonempty(supervision.sourceId) || !nonempty(supervision.profileId)
    || (supervision.sourceFamilyId !== undefined && !nonempty(supervision.sourceFamilyId))
    || supervision.sourceId !== String(evidence.sourceId)
    || !validRange(supervision.replyStartCodePoint, supervision.replyEndCodePoint, evidencePoints.length)
    || !validRange(supervision.contextStartCodePoint, supervision.contextEndCodePoint, evidencePoints.length)
    || supervision.replyStartCodePoint === supervision.replyEndCodePoint || supervision.contextStartCodePoint === supervision.contextEndCodePoint
    || rangesOverlap(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint, supervision.replyStartCodePoint, supervision.replyEndCodePoint)
    || rangesOverlap(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint, supervision.contextStartCodePoint, supervision.contextEndCodePoint)
    || rangesOverlap(supervision.replyStartCodePoint, supervision.replyEndCodePoint, supervision.contextStartCodePoint, supervision.contextEndCodePoint))) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
  }
  const antecedentRange = observation.antecedent;
  if (antecedentRange && (!validRange(antecedentRange.startCodePoint, antecedentRange.endCodePoint, evidencePoints.length)
    || antecedentRange.startCodePoint === antecedentRange.endCodePoint
    || antecedentRange.endCodePoint > observation.surfaceStartCodePoint)) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
  }
  const antecedentSurface = antecedentRange ? evidencePoints.slice(antecedentRange.startCodePoint, antecedentRange.endCodePoint).join("") : undefined;
  const antecedent = antecedentRange && antecedentSurface ? { ...antecedentRange, surface: antecedentSurface, surfaceDigest: input.hasher.digestHex(antecedentSurface) } : undefined;
  const surfacePoints = [...surface];
  const roleKeys = new Set<string>();
  const durableRoles: DurableSourceConstructionExample["roles"] = [];
  for (const role of observation.roles) {
    const occurrenceIndex = role.occurrenceIndex ?? 0;
    if (!validIndex(role.slotIndex)
      || !validGraphBinding(role.graphBinding)
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
      surface: surfacePoints.slice(role.startCodePoint, role.endCodePoint).join(""),
      ...(role.graphBinding ? { graphBinding: { ...role.graphBinding } } : {})
    });
  }
  const durableNullRoles: DurableSourceConstructionExample["nullRoles"] = [];
  for (const role of observation.nullRoles ?? []) {
    const occurrenceIndex = role.occurrenceIndex ?? 0;
    if (!validIndex(role.slotIndex) || !validIndex(occurrenceIndex) || !validGraphBinding(role.graphBinding)) {
      return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
    }
    const key = `${role.slotIndex}\u0001${occurrenceIndex}`;
    if (roleKeys.has(key)) return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate, evidenceId: observation.evidenceId } };
    roleKeys.add(key);
    durableNullRoles.push({
      slotIndex: role.slotIndex,
      occurrenceIndex,
      roleId: languageConstructionRoleId(input.hasher, input.bindingId, role.slotIndex),
      occurrenceId: languageConstructionOccurrenceId(input.hasher, input.bindingId, role.slotIndex, occurrenceIndex),
      ...(role.graphBinding ? { graphBinding: { ...role.graphBinding } } : {})
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
    durableNullRoles,
    ...(antecedent ? [antecedent] : [])
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
    nullRoles: durableNullRoles,
    ...(antecedent ? { antecedent } : {}),
    ...(supervision ? { contextualQaSupervision: { ...supervision } } : {})
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

const KNOWN_CREATIVE_EVENT_COMPILER_IDS: readonly string[] = [
  UNIVERSAL_CREATIVE_EVENT_COMPILER_ID
];

function verifyCreativeEventPattern(
  pattern: LanguagePatternRecord,
  evidenceById: ReadonlyMap<string, EvidenceSpan>,
  hasher: Hasher,
  evidencePointsById: Map<string, string[]>,
  evidenceUtf16OffsetsById: Map<string, number[]>
): { bundle: DurableLanguageConstructionBundle } | { issue: LanguageConstructionMemoryIssue } {
  const row = recordOf(pattern.patternJson);
  const rawBundle = recordOf(row.bundle);
  const compilerId = stringOf(rawBundle.compilerId);
  if (row.schema !== CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA
    || rawBundle.schema !== CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA
    || !compilerId || !KNOWN_CREATIVE_EVENT_COMPILER_IDS.includes(compilerId)
    || stringOf(rawBundle.profileId) !== pattern.profileId) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  }
  const rawEvents = arrayOfRecords(rawBundle.events);
  if (rawEvents.length < 4 || rawEvents.length > 2048) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  }
  const sourcePage = recordOf(rawBundle.sourcePage);
  if (rawBundle.sourcePage !== undefined && (!validCreativeSourcePage(sourcePage, rawEvents, evidenceById, hasher, evidencePointsById, evidenceUtf16OffsetsById))) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  }
  // Record integrity over the STORED bundle, independent of per-event
  // usability: one stale event must never erase 767 good ones.
  const contentDigest = hasher.digestHex(canonicalStringify(rawBundle));
  const id = `surface.creative_event.bundle.${contentDigest}`;
  if (stringOf(row.contentDigest) !== contentDigest
    || pattern.id !== id
    || pattern.patternKind !== "semantic_role"
    || pattern.support !== rawEvents.length
    || pattern.entropy !== 0) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest);
  }
  const events: DurableCreativeEventConstruction[] = [];
  for (const rawEvent of rawEvents) {
    const parsed = creativeEventFromPersisted(rawEvent, pattern.profileId, compilerId, evidenceById, hasher, evidencePointsById);
    if (parsed) events.push(parsed);
  }
  if (events.length < 4) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  }
  const orderedEvents = events.sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal || compareText(left.id, right.id)
  );
  const sourceVersionIds = uniqueSorted(orderedEvents.map(event => event.sourceVersionId));
  const evidenceIds = uniqueSorted(orderedEvents.map(event => event.evidenceId));
  const evidenceContentHashes = uniqueSorted(orderedEvents.map(event => event.evidenceContentHash));
  return {
    bundle: {
      id,
      contentDigest,
      schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
      bindingId: `surface.creative_event.binding.${hasher.digestHex(pattern.profileId)}`,
      acquisitionStatus: "source_observed",
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

function validCreativeSourcePage(page: Record<string, JsonValue>, events: readonly Record<string, JsonValue>[], evidenceById: ReadonlyMap<string, EvidenceSpan>, hasher: Hasher,
  evidencePointsById: Map<string, string[]>, offsetsByEvidence: Map<string, number[]>): boolean {
  const index = numberOf(page.index), count = numberOf(page.pageCount), bound = numberOf(page.maxEvents);
  if (page.recipe !== UNIVERSAL_CREATIVE_EVENT_COVERAGE_RECIPE_ID || page.qualification !== "source_observed" || !stringOf(page.compilationId)
    || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count || count < 1
    || !Number.isSafeInteger(bound) || bound < 4 || bound > 2048 || events.length > bound) return false;
  const windows = arrayOfRecords(page.windows);
  if (!windows.length) return false;
  for (const window of windows) {
    const ownerDocumentId = stringOf(window.ownerDocumentId);
    if (!ownerDocumentId) return false;
    const evidence = evidenceById.get(ownerDocumentId);
    const start = numberOf(window.startUtf16), end = numberOf(window.endUtf16);
    if (!evidence || evidence.status !== "promoted" || String(evidence.sourceVersionId) !== stringOf(window.sourceVersionId)
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > evidence.text.length
      || hasher.digestHex(evidence.text.slice(start, end)) !== stringOf(window.contentDigest)) return false;
    if (!offsetsByEvidence.has(String(evidence.id))) {
      const offsets = [0];
      for (const point of evidenceTextPoints(evidence, evidencePointsById)) offsets.push(offsets[offsets.length - 1]! + point.length);
      offsetsByEvidence.set(String(evidence.id), offsets);
    }
  }
  return events.every(event => {
    const eventEvidenceId = stringOf(event.evidenceId);
    if (!eventEvidenceId) return false;
    return windows.some(window => window.ownerDocumentId === eventEvidenceId && (() => {
      const start = numberOf(event.labelStartCodePoint);
      const offset = Number.isSafeInteger(start) ? offsetsByEvidence.get(eventEvidenceId)?.[start] ?? -1 : -1;
      return offset >= numberOf(window.startUtf16) && offset < numberOf(window.endUtf16);
    })());
  });
}

function creativeEventFromPersisted(
  raw: Record<string, JsonValue>,
  profileId: string,
  compilerId: string,
  evidenceById: ReadonlyMap<string, EvidenceSpan>,
  hasher: Hasher,
  evidencePointsById: Map<string, string[]>
): DurableCreativeEventConstruction | undefined {
  const evidenceId = stringOf(raw.evidenceId);
  const sourceVersionId = stringOf(raw.sourceVersionId);
  const evidenceContentHash = stringOf(raw.evidenceContentHash);
  const sourceLabel = stringOf(raw.sourceLabel);
  const relationId = stringOf(raw.relationId);
  const tenseId = stringOf(raw.tenseId);
  const valencyId = stringOf(raw.valencyId);
  const formsRaw = recordOf(raw.forms);
  if (!evidenceId || stringOf(raw.compilerId) !== compilerId
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
    || evidence.charEnd !== evidenceCharEnd) return undefined;
  const evidencePoints = evidenceTextPoints(evidence, evidencePointsById);
  if (!validRange(labelStartCodePoint, labelEndCodePoint, evidencePoints.length)
    || !Number.isSafeInteger(sourceOrdinal)) return undefined;
  const boundLabel = evidencePoints.slice(labelStartCodePoint, labelEndCodePoint).join("");
  // Compiler persists case-folded labels; the slice keeps source case.
  if (boundLabel.toLocaleLowerCase() !== sourceLabel.toLocaleLowerCase()
    || hasher.digestHex(sourceLabel) !== stringOf(raw.sourceLabelDigest)) return undefined;
  const argumentFrame = creativeArgumentFrameFromPersisted({
    raw: recordOf(raw.argumentFrame),
    evidencePoints,
    profileId,
    compilerId,
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
    compilerId,
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
    compilerId,
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
    compilerId,
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
  evidencePoints: readonly string[];
  profileId: string;
  compilerId: string;
  relationId: string;
  labelStartCodePoint: number;
  labelEndCodePoint: number;
  hasher: Hasher;
}): DurableCreativeEventArgumentFrame | undefined {
  const sourceSentenceStartCodePoint = numberOf(input.raw.sourceSentenceStartCodePoint);
  const sourceSentenceEndCodePoint = numberOf(input.raw.sourceSentenceEndCodePoint);
  const evidencePoints = input.evidencePoints;
  if (input.raw.schema !== CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA
    || input.raw.compilerId !== input.compilerId
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
    input.compilerId,
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
    compilerId: input.compilerId,
    sourceSentenceStartCodePoint,
    sourceSentenceEndCodePoint,
    roleIds,
    bindings
  };
}

function creativeClosedClassConnectorFromPersisted(input: {
  raw: Record<string, JsonValue>;
  evidencePoints: readonly string[];
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
  hasher: Hasher,
  evidencePointsById: Map<string, string[]>
): { bundle: DurableLanguageConstructionBundle } | { issue: LanguageConstructionMemoryIssue } {
  const row = recordOf(pattern.patternJson);
  const rawBundle = recordOf(row.bundle);
  if (row.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA
    || rawBundle.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }
  if (row.storageEncoding !== undefined && row.storageEncoding !== SOURCE_EXAMPLE_CONSTRUCTION_STORAGE) return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  if (row.constructionQualification !== undefined && row.constructionQualification !== "document_heldout_qualified" && row.constructionQualification !== "unqualified") return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
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
  const storedEvidenceIds = arrayOfStrings(rawBundle.evidenceIds);
  for (const raw of sourceExamples) {
    if (row.storageEncoding === SOURCE_EXAMPLE_CONSTRUCTION_STORAGE) {
      const evidenceIndex = numberOf(raw.evidenceIndex);
      const evidenceId = Number.isSafeInteger(evidenceIndex) && evidenceIndex >= 0 ? storedEvidenceIds[evidenceIndex] : undefined;
      const evidence = evidenceId ? evidenceById.get(evidenceId) : undefined;
      if (!evidence) return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
      observations.push({ sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id),
        surfaceStartCodePoint: numberOf(raw.surfaceStartCodePoint), surfaceEndCodePoint: numberOf(raw.surfaceEndCodePoint),
        roles: arrayOfRecords(raw.roles).map(role => ({ slotIndex: numberOf(role.slotIndex), occurrenceIndex: numberOf(role.occurrenceIndex),
          startCodePoint: numberOf(role.startCodePoint), endCodePoint: numberOf(role.endCodePoint),
          ...(role.graphBinding !== undefined ? { graphBinding: role.graphBinding as unknown as SourceConstructionGraphBinding } : {}) })),
        nullRoles: arrayOfRecords(raw.nullRoles).map(role => ({ slotIndex: numberOf(role.slotIndex), occurrenceIndex: numberOf(role.occurrenceIndex),
          ...(role.graphBinding !== undefined ? { graphBinding: role.graphBinding as unknown as SourceConstructionGraphBinding } : {}) })),
        ...(raw.antecedent !== undefined ? { antecedent: { startCodePoint: numberOf(recordOf(raw.antecedent).startCodePoint), endCodePoint: numberOf(recordOf(raw.antecedent).endCodePoint) } } : {}),
        ...(raw.contextualQaSupervision !== undefined ? { contextualQaSupervision: raw.contextualQaSupervision as unknown as ContextualQaSupervision } : {})
      });
      continue;
    }
    const parsed = observationFromPersistedExample(raw, {
      bindingId,
      sourceProfileId,
      targetProfileId,
      evidenceById,
      evidencePointsById
    });
    if ("code" in parsed) return { issue: { ...parsed, patternId: pattern.id, profileId: pattern.profileId } };
    observations.push(parsed.observation);
  }
  const evidenceIds = uniqueSorted(observations.map(item => item.evidenceId));
  const evidence = evidenceIds.map(id => evidenceById.get(id)).filter((item): item is EvidenceSpan => Boolean(item));
  if (evidence.length !== evidenceIds.length) return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
  const recompiled = compileConstructionPattern({
    bindingId,
    profileId: targetProfileId,
    observations,
    evidence,
    hasher,
    updatedAt: pattern.updatedAt,
    ...(row.storageEncoding === SOURCE_EXAMPLE_CONSTRUCTION_STORAGE ? { storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } : {}),
    ...(rawBundle.acquisitionStatus !== undefined
      ? { acquisitionStatus: rawBundle.acquisitionStatus as DurableLanguageConstructionBundleContent["acquisitionStatus"] }
      : {})
  }, evidenceById, evidencePointsById);
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
  return { bundle: { ...recompiled.bundle,
    ...(row.constructionQualification ? { qualificationStatus: row.constructionQualification as DurableLanguageConstructionBundle["qualificationStatus"] } : {}) } };
}

function observationFromPersistedExample(
  raw: Record<string, JsonValue>,
  ownership: {
    bindingId: string;
    sourceProfileId: string;
    targetProfileId: string;
    evidenceById: ReadonlyMap<string, EvidenceSpan>;
    evidencePointsById: Map<string, string[]>;
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
    endCodePoint: numberOf(role.endCodePoint),
    ...(role.graphBinding !== undefined ? { graphBinding: role.graphBinding as unknown as SourceConstructionGraphBinding } : {})
  }));
  const nullRoles = arrayOfRecords(raw.nullRoles).map(role => ({
    slotIndex: numberOf(role.slotIndex),
    occurrenceIndex: numberOf(role.occurrenceIndex),
    ...(role.graphBinding !== undefined ? { graphBinding: role.graphBinding as unknown as SourceConstructionGraphBinding } : {})
  }));
  const observation: SourceBoundConstructionObservation = {
    sourceVersionId,
    evidenceId,
    surfaceStartCodePoint: numberOf(raw.surfaceStartCodePoint),
    surfaceEndCodePoint: numberOf(raw.surfaceEndCodePoint),
    roles,
    nullRoles,
    ...(raw.contextualQaSupervision !== undefined ? { contextualQaSupervision: raw.contextualQaSupervision as unknown as ContextualQaSupervision } : {}),
    ...(raw.antecedent !== undefined ? { antecedent: {
      startCodePoint: numberOf(recordOf(raw.antecedent).startCodePoint),
      endCodePoint: numberOf(recordOf(raw.antecedent).endCodePoint)
    } } : {})
  };
  const points = evidenceTextPoints(evidence, ownership.evidencePointsById);
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

function evidenceTextPoints(evidence: EvidenceSpan, pointsById: Map<string, string[]>): string[] {
  const id = String(evidence.id);
  let points = pointsById.get(id);
  if (!points) { points = [...evidence.text]; pointsById.set(id, points); }
  return points;
}

function rejected(code: LanguageConstructionMemoryRejectionId): LanguageConstructionPatternCompilation {
  return { status: "rejected", issues: [{ code }] };
}

function validGraphBinding(binding: SourceConstructionGraphBinding | undefined): boolean {
  return binding === undefined || (binding !== null && typeof binding === "object"
    && typeof binding.relationId === "string" && nonempty(binding.relationId)
    && typeof binding.roleId === "string" && nonempty(binding.roleId)
    && typeof binding.valueKind === "string" && nonempty(binding.valueKind)
    && (binding.semanticRole === undefined || ["entity", "predicate", "modifier", "quantity", "time", "location", "negation", "unknown"].includes(binding.semanticRole)));
}

/** Real Unicode sentence-terminal punctuation, script-agnostic (matches ASCII ./!/? as well as CJK full-width terminators). */
function containsSentenceTerminal(gapText: string): boolean {
  return [...gapText].some(char => /\p{Sentence_Terminal}/u.test(char));
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

function rangesOverlap(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && end > otherStart;
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
