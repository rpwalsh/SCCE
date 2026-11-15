// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord } from "./kernel-answer-primitives.js";
import { requestLanguageFormScopeValue, setRequestLanguageFormScopeValue } from "./request-language-form-scope.js";
import { corpusIdentityUnits } from "./corpus-identity.js";
import { canonicalStringify } from "./primitives.js";
import { informationLabelAllowsRead, normalizeInformationLabel } from "./information-flow.js";
import { learnedAnswerUnitFormVerdict, learnedAnswerUnitSharedBaseWitnesses } from "./learned-answer-unit-forms.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceSpan, Hasher, InformationAccessContext, SourceVersion } from "./types.js";

export const LEXICAL_SENSE_SCHEMA = "scce.lexical_sense.v1" as const;
export const LEXICAL_SENSE_RECIPE = "kernel.source_lexical_senses.v1" as const;

const verifiedRecord = Symbol("source-owned-lexical-pattern");
const verifiedRecords = new WeakSet<object>();
export interface VerifiedSourceOwnedLexicalPattern {
  readonly [verifiedRecord]: true;
  readonly pattern: LanguagePatternRecord;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly sourceContentHash: string;
}
export type SourceLexicalPatternInput = LanguagePatternRecord | VerifiedSourceOwnedLexicalPattern;

/** Canonical readers supply current projection owners; this checks every consumed source port. */
export function verifySourceOwnedLexicalPattern(input: { pattern: LanguagePatternRecord; source: SourceVersion;
  evidenceOwners: readonly SourceVersion[]; evidence: readonly EvidenceSpan[] }, options: { hasher: Hasher; informationAccess: InformationAccessContext }): VerifiedSourceOwnedLexicalPattern | undefined {
  try {
    const { pattern, source } = input, metadata = jsonRecord(pattern.patternJson), sourceMetadata = jsonRecord(source.metadata);
    if (!pattern.id || !pattern.profileId || pattern.patternKind !== "semantic_role"
      || !pattern.evidenceIds.length || new Set(pattern.evidenceIds).size !== pattern.evidenceIds.length
      || metadata.sourceId !== source.sourceId || metadata.sourceVersionId !== source.sourceVersionId
      || metadata.sourceContentHash !== source.contentHash || metadata.profileId !== pattern.profileId
      || typeof metadata.lexiconId !== "string" || !metadata.lexiconId || metadata.lexiconId !== sourceMetadata.lexiconId
      || typeof metadata.language !== "string" || !metadata.language || metadata.language !== sourceMetadata.language
      || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0
      || !/^sha256[_:][a-f0-9]{64}$/u.test(String(source.contentHash))) return undefined;
    const annotationOwners = input.evidenceOwners.filter(owner => owner.sourceVersionId === metadata.annotationSourceVersionId);
    if (annotationOwners.length !== 1) return undefined;
    const annotationOwner = annotationOwners[0]!;
    if (metadata.annotationSourceContentHash !== annotationOwner.contentHash
      || source.role !== "evidence-derivative" || source.derivation?.kind !== "extracted-text"
      || !source.derivation.transformId || source.derivation.derivedFromSourceVersionId !== annotationOwner.sourceVersionId
      || !Number.isSafeInteger(annotationOwner.byteLength) || annotationOwner.byteLength < 0
      || !/^sha256[_:][a-f0-9]{64}$/u.test(String(annotationOwner.contentHash))) return undefined;
    const label = (value: typeof source.informationLabel) => {
      if (!value || !["public", "internal", "confidential", "restricted"].includes(value.exportClass)
        || !["same_owner", "explicit", "isolated"].includes(value.mergePolicy)) return undefined;
      const normalized = normalizeInformationLabel(value);
      return informationLabelAllowsRead(normalized, options.informationAccess) ? canonicalStringify(normalized) : undefined;
    };
    const ownerLabel = label(source.informationLabel);
    if (!ownerLabel || label(pattern.informationLabel) !== ownerLabel || label(annotationOwner.informationLabel) !== ownerLabel) return undefined;
    const evidence = new Map(input.evidence.map(span => [String(span.id), span]));
    if (evidence.size !== input.evidence.length) return undefined;
    for (const id of pattern.evidenceIds) {
      const span = evidence.get(String(id));
      if (!span || span.status !== "promoted" || span.sourceId !== annotationOwner.sourceId || span.sourceVersionId !== annotationOwner.sourceVersionId
        || label(span.informationLabel) !== ownerLabel || ![span.byteStart, span.byteEnd, span.charStart, span.charEnd].every(Number.isSafeInteger)
        || span.byteStart < 0 || span.byteEnd <= span.byteStart || span.byteEnd > annotationOwner.byteLength
        || span.charStart < 0 || span.charEnd <= span.charStart || span.charStart > span.byteStart || span.charEnd > span.byteEnd
        || new TextEncoder().encode(span.text).length !== span.byteEnd - span.byteStart
        || [...span.text].length !== span.charEnd - span.charStart
        || String(span.contentHash) !== `sha256_${options.hasher.digestHex(span.text)}`) return undefined;
    }
    const result = freezeLexicalRecord({ [verifiedRecord]: true as const, pattern: structuredClone(pattern),
      sourceId: String(source.sourceId), sourceVersionId: String(source.sourceVersionId), sourceContentHash: String(source.contentHash) });
    verifiedRecords.add(result);
    return result;
  } catch { return undefined; }
}

function freezeLexicalRecord<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeLexicalRecord(child, seen);
    Object.freeze(value);
  }
  return value;
}

export function sourceOwnedLexicalPattern(input: SourceLexicalPatternInput): LanguagePatternRecord | undefined {
  return verifiedRecords.has(input) ? (input as VerifiedSourceOwnedLexicalPattern).pattern : undefined;
}

export function lexicalLookupUnits(text: string): string[] {
  return [...new Set(corpusIdentityUnits(text.normalize("NFKC")))];
}

export function normalizedLexicalSurface(text: string): string { return corpusIdentityUnits(text.normalize("NFKC")).join(" "); }

export interface LexicalSense {
  id: string;
  lexiconId: string;
  language: string;
  partOfSpeech: string;
  ili?: string;
  entries: Array<{ lemma: string; forms: string[] }>;
  definitions: string[];
  examples: string[];
  relations: Array<{ type: string; target: string }>;
}

interface LexicalMemory {
  senses: Map<string, LexicalSense>;
  bySurface: Map<string, LexicalSense[]>;
  owners: Map<string, { patternIds: string[]; evidenceIds: string[] }>;
}

const SCOPE_KEY = "source-lexical-semantics.v1";
let resident: LexicalMemory = { senses: new Map(), bySurface: new Map(), owners: new Map() };
const normalized = normalizedLexicalSurface;
export const lexicalSenseIdentity = (sense: Pick<LexicalSense, "lexiconId" | "language" | "id">): string =>
  canonicalStringify([sense.lexiconId, sense.language, sense.id]);

export function lexicalSenseFromPattern(input: SourceLexicalPatternInput): LexicalSense | undefined {
  const pattern = sourceOwnedLexicalPattern(input);
  if (!pattern) return undefined;
  const value = jsonRecord(pattern.patternJson);
  if (value.schema !== LEXICAL_SENSE_SCHEMA || value.componentRecipe !== LEXICAL_SENSE_RECIPE
    || !pattern.evidenceIds.length || typeof value.senseId !== "string" || typeof value.lexiconId !== "string"
    || typeof value.language !== "string" || typeof value.partOfSpeech !== "string"
    || !Array.isArray(value.entries) || !Array.isArray(value.definitions) || !Array.isArray(value.examples)
    || !Array.isArray(value.relations) || !value.senseId || !value.lexiconId || !value.language || !value.partOfSpeech
    || !value.definitions.every(item => typeof item === "string") || !value.examples.every(item => typeof item === "string")) return undefined;
  const entries = value.entries.flatMap(raw => {
    const entry = jsonRecord(raw);
    return typeof entry.lemma === "string" && normalized(entry.lemma) && Array.isArray(entry.forms)
      && entry.forms.every(form => typeof form === "string" && normalized(form))
      ? [{ lemma: entry.lemma, forms: entry.forms as string[] }] : [];
  });
  if (!entries.length || entries.length !== value.entries.length || value.relations.some(raw => {
    const relation = jsonRecord(raw);
    return typeof relation.type !== "string" || !relation.type || typeof relation.target !== "string" || !relation.target;
  })) return undefined;
  return { id: value.senseId, lexiconId: value.lexiconId, language: value.language,
    partOfSpeech: value.partOfSpeech, ...(typeof value.ili === "string" ? { ili: value.ili } : {}), entries,
    definitions: value.definitions.filter((item): item is string => typeof item === "string"),
    examples: value.examples.filter((item): item is string => typeof item === "string"),
    relations: value.relations.flatMap(raw => {
      const relation = jsonRecord(raw);
      return typeof relation.type === "string" && typeof relation.target === "string"
        ? [{ type: relation.type, target: relation.target }] : [];
    }) };
}

export function primeLexicalSemanticMemory(patterns: readonly SourceLexicalPatternInput[]): number {
  const memory: LexicalMemory = { senses: new Map(), bySurface: new Map(), owners: new Map() };
  const conflicted = new Set<string>();
  for (const pattern of patterns) {
    const sense = lexicalSenseFromPattern(pattern);
    if (!sense) continue;
    const record = sourceOwnedLexicalPattern(pattern)!;
    const identity = lexicalSenseIdentity(sense), prior = memory.senses.get(identity);
    if (prior && canonicalStringify(prior) !== canonicalStringify(sense)) conflicted.add(identity);
    else memory.senses.set(identity, sense);
    const owners = memory.owners.get(identity) ?? { patternIds: [], evidenceIds: [] };
    owners.patternIds.push(record.id); owners.evidenceIds.push(...record.evidenceIds.map(String));
    memory.owners.set(identity, owners);
  }
  for (const identity of conflicted) memory.senses.delete(identity);
  for (const sense of memory.senses.values()) {
    for (const surface of new Set(sense.entries.flatMap(entry => [entry.lemma, ...entry.forms]).map(normalized))) {
      const senses = memory.bySurface.get(surface) ?? [];
      senses.push(sense);
      memory.bySurface.set(surface, senses);
    }
  }
  if (!setRequestLanguageFormScopeValue(SCOPE_KEY, memory)) resident = memory;
  return memory.senses.size;
}

function currentMemory(): LexicalMemory {
  const scoped = requestLanguageFormScopeValue<LexicalMemory>(SCOPE_KEY);
  return scoped.active ? scoped.value ?? { senses: new Map(), bySurface: new Map(), owners: new Map() } : resident;
}

export function lexicalSensesForSurface(surface: string): readonly LexicalSense[] {
  return currentMemory().bySurface.get(normalized(surface)) ?? [];
}

export function lexicalAlternativesForSurface(surface: string): string[] {
  return [...new Set(lexicalSensesForSurface(surface).flatMap(sense => sense.entries
    .flatMap(entry => [entry.lemma, ...entry.forms])).filter(value => normalized(value) !== normalized(surface)))];
}

export interface LexicalMembershipWitness {
  kind: "source_lexical_membership";
  usage: "retrieval_expansion";
  identity: string;
  lexiconId: string;
  language: string;
  senseId: string;
  patternIds: readonly string[];
  evidenceIds: readonly string[];
}

/** Sense membership expands candidates; it supplies no predicate argument alignment. */
export function lexicalMembershipWitnesses(left: string, right: string, context: string,
  closedClassWords: ReadonlySet<string> = new Set()): LexicalMembershipWitness[] {
  const leftSenses = lexicalSensesForSurface(left);
  const rightSenses = lexicalSensesForSurface(right);
  if (!leftSenses.length || !rightSenses.length) return [];
  const excluded = new Set([...lexicalLookupUnits(left), ...lexicalLookupUnits(right)]);
  const contextUnits = new Set(lexicalLookupUnits(context)
    .filter(unit => !closedClassWords.has(unit) && !excluded.has(unit)));
  const uniqueBest = (senses: readonly LexicalSense[]) => {
    const scores = senses.map(sense => {
      const units = new Set(lexicalLookupUnits([...sense.definitions, ...sense.examples].join(" ")));
      return { identity: lexicalSenseIdentity(sense), score: [...contextUnits].filter(unit => units.has(unit)).length };
    });
    const best = Math.max(...scores.map(item => item.score));
    const selected = scores.filter(item => item.score === best);
    return selected.length === 1 ? selected[0]!.identity : undefined;
  };
  const leftIdentity = uniqueBest(leftSenses), rightIdentity = uniqueBest(rightSenses);
  if (!leftIdentity || leftIdentity !== rightIdentity) return [];
  const sense = currentMemory().senses.get(leftIdentity)!, owners = currentMemory().owners.get(leftIdentity)!;
  return [{ kind: "source_lexical_membership", usage: "retrieval_expansion", identity: leftIdentity,
    lexiconId: sense.lexiconId, language: sense.language, senseId: sense.id,
    patternIds: [...new Set(owners.patternIds)].sort(), evidenceIds: [...new Set(owners.evidenceIds)].sort() }];
}

/** Only observed morphology preserves a relation unit; synset membership supplies no argument alignment. */
export function lexicalRelationWitnesses(left: string, right: string, context: string,
  closedClassWords: ReadonlySet<string> = new Set()): string[] {
  const direct = learnedAnswerUnitFormVerdict(left, right).witnesses.map(witness => witness.patternId);
  const shared = learnedAnswerUnitSharedBaseWitnesses(left, right).flatMap(witness => [witness.left.patternId, witness.right.patternId,
    ...(witness.corroborating ? [witness.corroborating.left.patternId, witness.corroborating.right.patternId] : [])]);
  return [...new Set([...direct, ...shared])].sort();
}

export function clearLexicalSemanticMemory(): void { primeLexicalSemanticMemory([]); }
