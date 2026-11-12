// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { constructionSourceExampleStorageJson as exactJson } from "./construction-source-example-storage.js";
import { validateSemanticInductionFactors, type SemanticInductionFactors } from "./semantic-induction-factors.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import type { EvidenceId, Hasher } from "./types.js";

/** Experimental, explicit opt-in. No production registration or persistence side effects. */
export const SEMANTIC_RELATION_REPLAY_V2 = "scce.semantic_relation_replay.v2" as const;
export const SEMANTIC_RELATION_COMPILER_V2 = "kernel.semantic_relation.context_counts.v3" as const;
export const SEMANTIC_RELATION_REDUCER_V2 = "kernel.semantic_relation.punctuation_components.v3" as const;
export const SEMANTIC_RELATION_LIMITS_V2 = Object.freeze({
  maxSentences: 50_000, maxSymbolsPerSentence: 512, maxSymbolsTotal: 1_000_000, maxUtf16: 8_000_000,
  maxLexicalMembers: 100_000, maxMetadataEntries: 200_000, maxRelations: 50_000, maxRoleSymbols: 8, maxAlternatives: 8
});
export type SemanticRelationReplayLimits = { [K in keyof typeof SEMANTIC_RELATION_LIMITS_V2]: number };
export interface SemanticRelationReplayStatistic {
  surface: string; occurrences: number; sentenceSupport: number; sourceSupport: number;
  leftSubstitutions: number; rightSubstitutions: number;
  repeatedWithinSentence: boolean; score: number;
}
export interface SemanticRelationReplayPlanV2 {
  schema: typeof SEMANTIC_RELATION_REPLAY_V2;
  compiler: typeof SEMANTIC_RELATION_COMPILER_V2;
  reducer: typeof SEMANTIC_RELATION_REDUCER_V2;
  factorsDigest: string; limits: SemanticRelationReplayLimits;
  statistics: SemanticRelationReplayStatistic[]; fingerprint: string;
}
export interface SemanticRelationReplaySpanV2 {
  /** Offsets in the retained sentence, never invented offsets in the original document. */
  sentenceStartUtf16: number; sentenceEndUtf16: number;
  symbolStart: number; symbolEnd: number; surface: string; symbols: string[];
}
export interface SourceBoundSemanticRelationV2 {
  id: string; documentId: string; sourceId: string; sentenceIndex: number;
  sentence: string; evidenceIds: EvidenceId[]; trust: number;
  /** Original owning window only; v1 factors do not retain exact original sentence offsets. */
  sourceWindow?: SemanticInductionFactors["documents"][number]["sourceWindow"];
  predicate: SemanticRelationReplaySpanV2 & { semanticRole: "predicate"; lexicalClassIds: string[] };
  roles: Array<SemanticRelationReplaySpanV2 & {
    roleType: "participant_candidate"; semanticRole: "entity";
    surfacePosition: "before" | "after"; lexicalClassIds: string[];
  }>;
  alternatives: Array<{ symbolIndex: number; surface: string; score: number }>;
  /** Normalized ranking weight among this sentence's candidates, not calibrated truth confidence. */
  confidence: number;
  /** These are observational candidates, never entailments of agent, patient or ownership. */
  status: "source_bound_candidate";
}
export interface SemanticRelationReplayResultV2 {
  schema: typeof SEMANTIC_RELATION_REPLAY_V2;
  compiler: typeof SEMANTIC_RELATION_COMPILER_V2;
  reducer: typeof SEMANTIC_RELATION_REDUCER_V2;
  factorsDigest: string; planFingerprint: string;
  relations: SourceBoundSemanticRelationV2[];
  abstainedSentenceIndices: number[];
  fingerprint: string;
}
const fail = (): never => { throw Error("invalid semantic relation replay v2"); };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const copy = <T>(value: T): T => JSON.parse(exactJson(value)) as T;
const digest = (value: unknown, hasher: Hasher): string => hasher.digestHex(exactJson(value));
// Unicode character classes are token shape constraints, not a language vocabulary.
const lexical = (value: string): boolean => /\p{Letter}/u.test(value)
  && /^[\p{Letter}\p{Mark}\p{Number}'’]+$/u.test(value);

function limitsFor(value: Partial<SemanticRelationReplayLimits> = {}): SemanticRelationReplayLimits {
  if (Object.keys(value).some(key => !Object.hasOwn(SEMANTIC_RELATION_LIMITS_V2, key))) return fail();
  const limits = { ...SEMANTIC_RELATION_LIMITS_V2, ...value };
  for (const key of Object.keys(limits) as Array<keyof SemanticRelationReplayLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > SEMANTIC_RELATION_LIMITS_V2[key]) return fail();
  }
  return limits;
}
function boundedFactors(value: unknown, limits: SemanticRelationReplayLimits, hasher: Hasher): SemanticInductionFactors {
  // Bound before snapshotting/resegmenting; fail rather than silently sample or truncate the corpus.
  if (!value || typeof value !== "object") return fail();
  const raw = value as SemanticInductionFactors;
  if (!Array.isArray(raw.sentences) || raw.sentences.length > limits.maxSentences
    || !Array.isArray(raw.documents) || raw.documents.length > limits.maxSentences
    || !Array.isArray(raw.lexicalClasses) || raw.lexicalClasses.length > limits.maxLexicalMembers) return fail();
  let utf16 = 0, members = 0, symbols = 0, metadata = 0;
  const text = (value: unknown): void => {
    if (typeof value !== "string") return fail();
    utf16 += value.length;
    if (utf16 > limits.maxUtf16) return fail();
  };
  const entries = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) return fail();
    metadata += value.length;
    if (metadata > limits.maxMetadataEntries) return fail();
    return value;
  };
  text(raw.schema); text(raw.digest);
  for (const doc of raw.documents) {
    if (!doc) return fail();
    text(doc.id); text(doc.sourceId);
    for (const id of entries(doc.evidenceIds)) text(id);
    if (doc.sourceWindow) text(doc.sourceWindow.ownerDocumentId);
  }
  for (const row of raw.sentences) {
    if (!row || typeof row.sentence !== "string" || !Array.isArray(row.symbols)
      || row.symbols.length > limits.maxSymbolsPerSentence || !Array.isArray(row.hypotheses)
      || row.hypotheses.length > limits.maxSymbolsPerSentence) return fail();
    text(row.sentence);
    symbols += row.symbols.length;
    if (symbols > limits.maxSymbolsTotal) return fail();
    for (const symbol of row.symbols) text(symbol);
  }
  for (const row of raw.lexicalClasses) {
    if (!row || !Array.isArray(row.members)) return fail();
    members += row.members.length;
    if (members > limits.maxLexicalMembers) return fail();
    text(row.id);
    for (const member of row.members) {
      if (!member) return fail();
      text(member.symbol); text(member.scriptId);
    }
    for (const context of entries(row.exampleContexts)) text(context);
  }
  return validateSemanticInductionFactors(value, hasher);
}
function tokensFor(row: SemanticInductionFactors["sentences"][number], hasher: Hasher): LexicalSegment[] {
  const tokens = segmentUnicodeSurfaceV2(row.sentence, hasher).lexicalSegments
    .filter(token => ![...token.normalized].every(char => /\p{Punctuation}/u.test(char)));
  // Explicitly reject segmentation drift. Never shift a retained symbol to a different occurrence.
  if (exactJson(tokens.map(token => token.normalized)) !== exactJson(row.symbols)) return fail();
  return tokens;
}
function connected(sentence: string, a: LexicalSegment, b: LexicalSegment): boolean {
  return /^\s*$/u.test(sentence.slice(a.utf16End, b.utf16Start));
}
interface Counts { occurrences: number; repeatedSentences: number; sentences: Set<number>; sources: Set<string>; left: Set<string>; right: Set<string> }

function compile(factors: SemanticInductionFactors, limits: SemanticRelationReplayLimits, hasher: Hasher): SemanticRelationReplayPlanV2 {
  const counts = new Map<string, Counts>();
  for (const [sentenceIndex, row] of factors.sentences.entries()) {
    const seen = new Map<string, number>();
    for (const surface of row.symbols.filter(lexical)) seen.set(surface, (seen.get(surface) ?? 0) + 1);
    for (const [surface, occurrences] of seen) {
      const count = counts.get(surface) ?? { occurrences: 0, repeatedSentences: 0, sentences: new Set(), sources: new Set(), left: new Set(), right: new Set() };
      count.occurrences += occurrences;
      if (occurrences > 1) count.repeatedSentences++;
      count.sentences.add(sentenceIndex);
      count.sources.add(factors.documents[row.documentIndex]!.sourceId);
      counts.set(surface, count);
    }
  }
  // A repeated surface is empirically structural only when repeated within sentences in multiple
  // observations. No stopword list, script, length or preferred sentence position is consulted.
  const repeated = (surface: string): boolean => {
    const count = counts.get(surface);
    return Boolean(count && count.repeatedSentences >= 2);
  };
  for (const row of factors.sentences) {
    const tokens = tokensFor(row, hasher);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!, count = counts.get(token.normalized);
      if (!count) continue;
      for (const direction of [-1, 1] as const) {
        let previous = index;
        // A bounded local walk across only empirically repeated separators. These are scoring
        // contexts, not role bags. Roles below retain their original contiguous surface.
        for (let step = 1; step <= limits.maxRoleSymbols; step++) {
          const next = index + direction * step, neighbor = tokens[next];
          if (!neighbor || !lexical(neighbor.normalized)) break;
          const a = tokens[Math.min(previous, next)]!, b = tokens[Math.max(previous, next)]!;
          if (!connected(row.sentence, a, b)) break;
          if (!repeated(neighbor.normalized)) {
            (direction === -1 ? count.left : count.right).add(neighbor.normalized);
            break;
          }
          previous = next;
        }
      }
    }
  }
  const statistics = [...counts].sort(([a], [b]) => compare(a, b)).map(([surface, count]) => {
    const left = count.left.size, right = count.right.size;
    const repetitionPenalty = count.sentences.size / count.occurrences;
    const specificity = 1 + Math.log((factors.sentences.length + 1) / (count.sentences.size + 1));
    // Additive smoothing keeps corpus-supported predicates at a sentence boundary eligible
    // (SOV/VSO included) while remaining invariant when left and right are exchanged.
    // A surface with no observed substitutions on either side still receives zero mass.
    const contextDiversity = Math.sqrt((left + 1) * (right + 1)) - 1;
    const score = contextDiversity * Math.log1p(count.sources.size) * specificity
      * repetitionPenalty;
    return { surface, occurrences: count.occurrences, sentenceSupport: count.sentences.size,
      sourceSupport: count.sources.size, leftSubstitutions: left, rightSubstitutions: right,
      repeatedWithinSentence: repeated(surface), score };
  });
  const body = { schema: SEMANTIC_RELATION_REPLAY_V2, compiler: SEMANTIC_RELATION_COMPILER_V2,
    reducer: SEMANTIC_RELATION_REDUCER_V2, factorsDigest: factors.digest, limits, statistics };
  return { ...body, fingerprint: digest(body, hasher) };
}

/** Compile solely from retained factors; measured v1 posteriors are preserved but not reused. */
export function compileSemanticRelationReplayV2(input: {
  factors: unknown; hasher: Hasher; limits?: Partial<SemanticRelationReplayLimits>
}): SemanticRelationReplayPlanV2 {
  const limits = limitsFor(input.limits);
  return compile(boundedFactors(input.factors, limits, input.hasher), limits, input.hasher);
}

function reduce(factors: SemanticInductionFactors, plan: SemanticRelationReplayPlanV2, hasher: Hasher): SemanticRelationReplayResultV2 {
  const statistics = new Map(plan.statistics.map(row => [row.surface, row]));
  const classSets = new Map<string, Set<string>>();
  for (const row of factors.lexicalClasses) for (const member of row.members) {
    const ids = classSets.get(member.symbol) ?? new Set<string>();
    ids.add(row.id);
    classSets.set(member.symbol, ids);
  }
  const classes = new Map([...classSets].map(([symbol, ids]) => [symbol, [...ids].sort(compare)]));
  const relations: SourceBoundSemanticRelationV2[] = [], abstainedSentenceIndices: number[] = [];
  for (const [sentenceIndex, row] of factors.sentences.entries()) {
    const tokens = tokensFor(row, hasher), doc = factors.documents[row.documentIndex]!;
    const span = (start: number, end: number): SemanticRelationReplaySpanV2 => ({
      sentenceStartUtf16: tokens[start]!.utf16Start, sentenceEndUtf16: tokens[end - 1]!.utf16End,
      symbolStart: start, symbolEnd: end,
      surface: row.sentence.slice(tokens[start]!.utf16Start, tokens[end - 1]!.utf16End),
      symbols: row.symbols.slice(start, end)
    });
    let retained = false;
    const components: Array<{ start: number; end: number }> = [];
    for (let start = 0; start < tokens.length;) {
      let end = start + 1;
      while (end < tokens.length && connected(row.sentence, tokens[end - 1]!, tokens[end]!)) end++;
      components.push({ start, end });
      start = end;
    }
    for (const component of components) {
      const candidates = tokens.slice(component.start, component.end).flatMap((token, offset) => {
        const statistic = statistics.get(token.normalized);
        // A surface empirically repeated within the same source sentence behaves as a local
        // structural separator. It can inform context walks but cannot itself become a relation.
        const score = statistic && !statistic.repeatedWithinSentence ? statistic.score : 0;
        return score > 0 ? [{ symbolIndex: component.start + offset, surface: token.normalized, score }] : [];
      }).sort((a, b) => b.score - a.score || a.symbolIndex - b.symbolIndex);
      const winner = candidates[0];
      if (!winner) continue;
      // Equal structural evidence for different surfaces is underdetermined. Lexical spelling
      // never breaks the tie, so arbitrary vocabulary renaming cannot change the decision.
      if (candidates.some(candidate => candidate.score === winner.score && candidate.surface !== winner.surface)) continue;
      // Repeated predicates are separate source occurrences, never an aggregated left/right union.
      for (const selected of candidates.filter(candidate => candidate.surface === winner.surface)) {
      const roles: SourceBoundSemanticRelationV2["roles"] = [];
      for (const direction of [-1, 1] as const) {
        let end = selected.symbolIndex;
        for (let step = 1; step <= plan.limits.maxRoleSymbols; step++) {
          const next = selected.symbolIndex + direction * step, token = tokens[next];
          if (!token || !lexical(token.normalized) || token.normalized === selected.surface) break;
          if (!connected(row.sentence, tokens[Math.min(end, next)]!, tokens[Math.max(end, next)]!)) break;
          end = next;
        }
        if (end === selected.symbolIndex) continue;
        const start = direction === -1 ? end : selected.symbolIndex + 1;
        const stop = direction === -1 ? selected.symbolIndex : end + 1;
        const value = span(start, stop);
        roles.push({ ...value, roleType: "participant_candidate", semanticRole: "entity",
          surfacePosition: direction === -1 ? "before" : "after",
          lexicalClassIds: stop - start === 1 ? [...(classes.get(value.symbols[0]!) ?? [])] : [] });
      }
      if (!roles.length) continue;
      if (relations.length >= plan.limits.maxRelations) return fail();
      const material = { documentId: doc.id, sourceId: doc.sourceId, sentenceIndex, sentence: row.sentence,
        evidenceIds: [...doc.evidenceIds], trust: doc.trust,
        ...(doc.sourceWindow ? { sourceWindow: { ...doc.sourceWindow } } : {}),
        predicate: { ...span(selected.symbolIndex, selected.symbolIndex + 1), semanticRole: "predicate" as const,
          lexicalClassIds: [...(classes.get(selected.surface) ?? [])] }, roles,
        alternatives: candidates.slice(0, plan.limits.maxAlternatives),
        confidence: selected.score / candidates.reduce((sum, candidate) => sum + candidate.score, 0),
        status: "source_bound_candidate" as const };
      relations.push({ id: `semantic_relation_v2.${digest({ factorsDigest: factors.digest, ...material }, hasher)}`, ...material });
      retained = true;
      }
    }
    if (!retained) abstainedSentenceIndices.push(sentenceIndex);
  }
  const body = { schema: SEMANTIC_RELATION_REPLAY_V2, compiler: SEMANTIC_RELATION_COMPILER_V2,
    reducer: SEMANTIC_RELATION_REDUCER_V2, factorsDigest: factors.digest, planFingerprint: plan.fingerprint,
    relations, abstainedSentenceIndices };
  return { ...body, fingerprint: digest(body, hasher) };
}

/** Verify the entire recipe against its factors; no trusted cached score or source association. */
export function reduceSemanticRelationReplayV2(input: { factors: unknown; plan: unknown; hasher: Hasher }): SemanticRelationReplayResultV2 {
  if (!input.plan || typeof input.plan !== "object") return fail();
  const plan = input.plan as SemanticRelationReplayPlanV2;
  if (plan.schema !== SEMANTIC_RELATION_REPLAY_V2 || plan.compiler !== SEMANTIC_RELATION_COMPILER_V2
    || plan.reducer !== SEMANTIC_RELATION_REDUCER_V2) return fail();
  const limits = limitsFor(plan.limits), factors = boundedFactors(input.factors, limits, input.hasher);
  const expected = compile(factors, limits, input.hasher);
  if (exactJson(plan) !== exactJson(expected)) return fail();
  return reduce(factors, expected, input.hasher);
}

export function replaySemanticRelationsV2(input: {
  factors: unknown; hasher: Hasher; limits?: Partial<SemanticRelationReplayLimits>
}): SemanticRelationReplayResultV2 {
  const limits = limitsFor(input.limits), factors = boundedFactors(input.factors, limits, input.hasher);
  return reduce(factors, compile(factors, limits, input.hasher), input.hasher);
}

/**
 * Apply a corpus-compiled relation plan to separately retained target factors. Both sides are
 * independently validated and bounded; no target token contributes to its own ranking model.
 */
export function replaySemanticRelationsFromTrainingV2(input: {
  trainingFactors: unknown; targetFactors: unknown; hasher: Hasher;
  limits?: Partial<SemanticRelationReplayLimits>
}): SemanticRelationReplayResultV2 {
  const limits = limitsFor(input.limits);
  const training = boundedFactors(input.trainingFactors, limits, input.hasher);
  const target = boundedFactors(input.targetFactors, limits, input.hasher);
  return reduce(target, compile(training, limits, input.hasher), input.hasher);
}

/** Read-only evaluator: surface-local invariants, no storage handles or publication hooks. */
export function evaluateSemanticRelationReplayV2(input: {
  factors: unknown; hasher: Hasher; limits?: Partial<SemanticRelationReplayLimits>
}) {
  const result = replaySemanticRelationsV2(input);
  return copy({ schema: "scce.semantic_relation_replay.evaluation.v2", factorsDigest: result.factorsDigest,
    replayFingerprint: result.fingerprint, relationCount: result.relations.length,
    abstainedSentenceCount: result.abstainedSentenceIndices.length,
    predicateCounts: [...result.relations.reduce((counts, relation) => {
      const key = relation.predicate.symbols[0]!;
      counts.set(key, (counts.get(key) ?? 0) + 1); return counts;
    }, new Map<string, number>())].sort(([a], [b]) => compare(a, b)), result });
}
