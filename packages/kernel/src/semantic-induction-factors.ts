// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { clamp01, toJsonValue } from './primitives.js';
import { compileRelationHypothesisModel, inferRelationHypotheses } from './relation-hypothesis.js';
import { segmentUnicodeSurfaceV2 } from './unicode-segmentation-v2.js';
import { constructionSourceExampleStorageJson as exactJson } from './construction-source-example-storage.js';
import type { GraphBoundConstruction, GraphBoundConstructionSlot, LanguageInductionDocument, LexicalClass, SemanticFrameCandidate } from './language-induction.js';
import type { EvidenceId, Hasher } from './types.js';
import type { RelationHypothesisModel } from './relation-hypothesis.js';
import { SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK } from './unicode-segmentation.js';

export const SEMANTIC_INDUCTION_FACTORS_SCHEMA = "scce.semantic_induction_factors.v1" as const;
export const SEMANTIC_INDUCTION_PROJECTION_SCHEMA = "scce.semantic_induction_projection.v1" as const;
export interface SemanticInductionFactors {
  schema: typeof SEMANTIC_INDUCTION_FACTORS_SCHEMA;
  maxFrames: number;
  trackSourceWindows: boolean;
  lexicalClasses: LexicalClass[];
  documents: Array<{ id: string; sourceId: string; evidenceIds: EvidenceId[]; trust: number;
    sourceWindow?: { ownerDocumentId: string; startUtf16: number; endUtf16: number } }>;
  sentences: Array<{ documentIndex: number; sentence: string; symbols: string[]; hypotheses: Array<[number, number, number]> }>;
  digest: string;
}
export interface SemanticInductionProjection {
  schema: typeof SEMANTIC_INDUCTION_PROJECTION_SCHEMA;
  factors: SemanticInductionFactors;
  frameIds: string[];
  graphIds: string[];
  lexicalClassIds: string[];
  expectedDerivedDigest: string;
}
export interface ReplayedSemanticInduction {
  semanticFrames: SemanticFrameCandidate[];
  graphBoundConstructions: GraphBoundConstruction[];
  lexicalClasses: LexicalClass[];
  relationHypothesisModel: RelationHypothesisModel;
}
const invalid = (): never => { throw Error("invalid semantic induction factors"); };
const snapshot = <T>(value: T): T => { try { return JSON.parse(exactJson(value)) as T; } catch { return invalid(); } };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeIndex = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(member => typeof member === "string");

/** Capture each measured posterior once; replay never invokes a learner or rounds its floats. */
export function compileSemanticInductionFactors(input: { documents: readonly LanguageInductionDocument[]; relationModel: RelationHypothesisModel;
  lexicalClasses: readonly LexicalClass[]; maxFrames: number; hasher: Hasher }): SemanticInductionFactors {
  const trackSourceWindows = input.documents.some(document => document.sourceWindow !== undefined);
  const documents = input.documents.map(doc => ({ id: doc.id, sourceId: doc.sourceFamilyId ?? doc.id,
    evidenceIds: [...(doc.evidenceIds ?? [])], trust: clamp01(doc.trust ?? 0.5),
    ...(trackSourceWindows ? { sourceWindow: { ...(doc.sourceWindow ?? { ownerDocumentId: doc.id, startUtf16: 0, endUtf16: doc.text.length }) } } : {}) }));
  const sentences = input.documents.flatMap((doc, documentIndex) => sentenceSegments(doc.text, input.hasher).map((sourceSentence, sentenceIndex) => {
    const sentence = sourceSentence.replaceAll(SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK, "");
    const symbols = lexicalSurfaceSymbols(sentence, `${doc.id}.frame.${sentenceIndex}`, input.hasher)
      .filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char)));
    const hypotheses: Array<[number, number, number]> = symbols.length < 2 ? [] : inferRelationHypotheses({ symbols, model: input.relationModel,
      candidate: symbol => [...symbol].some(char => /\p{Letter}|\p{Symbol}/u.test(char)) }).map(row => [row.index, row.posterior, row.energy]);
    return { documentIndex, sentence, symbols, hypotheses };
  }));
  const material = { schema: SEMANTIC_INDUCTION_FACTORS_SCHEMA, maxFrames: input.maxFrames, trackSourceWindows,
    lexicalClasses: snapshot([...input.lexicalClasses]), documents, sentences };
  return snapshot({ ...material, digest: input.hasher.digestHex(exactJson(material)) });
}

function validatedFactors(value: unknown, hasher: Hasher): SemanticInductionFactors {
  const factors = snapshot(value);
  if (!isRecord(factors) || Object.keys(factors).sort().join(",") !== "digest,documents,lexicalClasses,maxFrames,schema,sentences,trackSourceWindows"
    || factors.schema !== SEMANTIC_INDUCTION_FACTORS_SCHEMA || typeof factors.maxFrames !== "number" || !Number.isFinite(factors.maxFrames)
    || typeof factors.trackSourceWindows !== "boolean" || !Array.isArray(factors.documents) || !Array.isArray(factors.sentences)
    || !Array.isArray(factors.lexicalClasses) || typeof factors.digest !== "string") return invalid();
  const { digest, ...material } = factors;
  if (hasher.digestHex(exactJson(material)) !== digest) return invalid();
  for (const lexical of factors.lexicalClasses) {
    if (!isRecord(lexical) || Object.keys(lexical).sort().join(",") !== "cohesion,contextSupport,exampleContexts,id,members"
      || typeof lexical.id !== "string" || !Array.isArray(lexical.members) || !strings(lexical.exampleContexts)
      || typeof lexical.contextSupport !== "number" || !Number.isFinite(lexical.contextSupport)
      || typeof lexical.cohesion !== "number" || !Number.isFinite(lexical.cohesion)) return invalid();
    for (const member of lexical.members) {
      if (!isRecord(member) || Object.keys(member).sort().join(",") !== "count,scriptId,symbol" || typeof member.symbol !== "string"
        || typeof member.scriptId !== "string" || typeof member.count !== "number" || !Number.isFinite(member.count)) return invalid();
    }
  }
  for (const doc of factors.documents) {
    if (!isRecord(doc) || typeof doc.id !== "string" || typeof doc.sourceId !== "string" || !strings(doc.evidenceIds)
      || typeof doc.trust !== "number" || !Number.isFinite(doc.trust) || doc.trust < 0 || doc.trust > 1
      || Object.keys(doc).sort().join(",") !== (factors.trackSourceWindows ? "evidenceIds,id,sourceId,sourceWindow,trust" : "evidenceIds,id,sourceId,trust")) return invalid();
    if (factors.trackSourceWindows) {
      const window = doc.sourceWindow;
      if (!isRecord(window) || Object.keys(window).sort().join(",") !== "endUtf16,ownerDocumentId,startUtf16" || typeof window.ownerDocumentId !== "string"
        || !safeIndex(window.startUtf16) || !safeIndex(window.endUtf16) || window.endUtf16 < window.startUtf16) return invalid();
    }
  }
  let previous = -1;
  for (const row of factors.sentences) {
    if (!isRecord(row) || Object.keys(row).sort().join(",") !== "documentIndex,hypotheses,sentence,symbols" || !safeIndex(row.documentIndex)
      || row.documentIndex >= factors.documents.length || row.documentIndex < previous || typeof row.sentence !== "string"
      || !strings(row.symbols) || !Array.isArray(row.hypotheses)) return invalid();
    if (row.symbols.length < 2 && row.hypotheses.length !== 0) return invalid();
    previous = row.documentIndex;
    const indices = new Set<number>();
    for (const hypothesis of row.hypotheses) {
      if (!Array.isArray(hypothesis) || hypothesis.length !== 3 || !safeIndex(hypothesis[0]) || hypothesis[0] >= row.symbols.length
        || typeof hypothesis[1] !== "number" || !Number.isFinite(hypothesis[1]) || hypothesis[1] < 0 || hypothesis[1] > 1
        || typeof hypothesis[2] !== "number" || !Number.isFinite(hypothesis[2]) || indices.has(hypothesis[0])) return invalid();
      indices.add(hypothesis[0]);
    }
  }
  return factors as unknown as SemanticInductionFactors;
}

/** The same ordered reducer used during induction. No pair cache or alternative matrix is persisted. */
export function replaySemanticInductionFactors(input: { factors: unknown; hasher: Hasher }): ReplayedSemanticInduction {
  const factors = validatedFactors(input.factors, input.hasher);
  const observed = factors.trackSourceWindows ? new Map<string, Set<number>>() : undefined;
  const semanticFrames = induceSemanticFrames(factors, input.hasher, factors.maxFrames, observed);
  const graphBoundConstructions = induceGraphBoundConstructions(semanticFrames, factors.lexicalClasses, input.hasher).slice(0, 2048).map(construction => {
    const documents = observed?.get(construction.predicate);
    return documents ? { ...construction, sourceWindows: [...documents].map(index => ({ ...factors.documents[index]!.sourceWindow! })) } : construction;
  });
  const relationHypothesisModel = compileRelationHypothesisModel({ observations: factors.sentences.map(row => ({
    sourceId: factors.documents[row.documentIndex]!.sourceId, symbols: row.symbols, evidenceIds: factors.documents[row.documentIndex]!.evidenceIds })), hasher: input.hasher });
  return { semanticFrames, graphBoundConstructions, relationHypothesisModel, lexicalClasses: snapshot(factors.lexicalClasses) };
}

export function semanticInductionProjection(input: ReplayedSemanticInduction & { factors: SemanticInductionFactors; hasher: Hasher }): SemanticInductionProjection {
  const derived = { semanticFrames: input.semanticFrames, graphBoundConstructions: input.graphBoundConstructions,
    relationHypothesisModel: input.relationHypothesisModel, lexicalClasses: input.lexicalClasses };
  return { schema: SEMANTIC_INDUCTION_PROJECTION_SCHEMA, factors: input.factors, frameIds: input.semanticFrames.map(frame => frame.id),
    graphIds: input.graphBoundConstructions.map(graph => graph.id), lexicalClassIds: input.lexicalClasses.map(lexical => lexical.id),
    expectedDerivedDigest: input.hasher.digestHex(exactJson(toJsonValue(derived))) };
}

/** Restore exactly the projector's selected IDs/order; reject changed tapes and reducer drift. */
export function replaySemanticInductionProjection(input: { projection: unknown; hasher: Hasher }): ReplayedSemanticInduction {
  const projection = snapshot(input.projection);
  if (!isRecord(projection) || Object.keys(projection).sort().join(",") !== "expectedDerivedDigest,factors,frameIds,graphIds,lexicalClassIds,schema"
    || projection.schema !== SEMANTIC_INDUCTION_PROJECTION_SCHEMA || !strings(projection.frameIds) || !strings(projection.graphIds)
    || !strings(projection.lexicalClassIds) || typeof projection.expectedDerivedDigest !== "string") return invalid();
  const replayed = replaySemanticInductionFactors({ factors: projection.factors, hasher: input.hasher });
  const selected = <T extends { id: string }>(values: T[], ids: string[]): T[] => {
    if (new Set(ids).size !== ids.length) return invalid();
    const rows = new Map(values.map(value => [value.id, value]));
    return ids.map(id => rows.get(id) ?? invalid());
  };
  const result = { semanticFrames: selected(replayed.semanticFrames, projection.frameIds), graphBoundConstructions: selected(replayed.graphBoundConstructions, projection.graphIds),
    lexicalClasses: selected(replayed.lexicalClasses, projection.lexicalClassIds), relationHypothesisModel: replayed.relationHypothesisModel };
  const logical = toJsonValue(result) as unknown as ReplayedSemanticInduction;
  if (input.hasher.digestHex(exactJson(logical)) !== projection.expectedDerivedDigest) return invalid();
  return logical;
}

function induceSemanticFrames(
  factors: SemanticInductionFactors,
  hasher: Hasher,
  maxFrames: number,
  observedDocuments?: Map<string, Set<number>>
): SemanticFrameCandidate[] {
  const frames = new Map<string, {
    predicate: string;
    left: Map<string, number>;
    right: Map<string, number>;
    examples: string[];
    evidenceIds: Set<EvidenceId>;
    alpha: number;
    posteriorMass: number;
    hypothesisCount: number;
    alternatives: Map<string, { posteriorMass: number; energyMass: number }>;
  }>();
  for (const [documentIndex, doc] of factors.documents.entries()) {
    const trust = doc.trust;
    for (const observation of factors.sentences) {
      if (observation.documentIndex !== documentIndex) continue;
      const { sentence, symbols } = observation;
      const hypotheses = observation.hypotheses.map(([index, posterior, energy]) => ({ index, posterior, energy, surface: symbols[index]! }));
      for (const predicate of hypotheses) {
        const left = symbols.slice(Math.max(0, predicate.index - 6), predicate.index);
        const right = symbols.slice(predicate.index + 1, Math.min(symbols.length, predicate.index + 7));
        const key = predicate.surface;
        if (observedDocuments) {
          const indices = observedDocuments.get(key) ?? new Set<number>();
          indices.add(documentIndex);
          observedDocuments.set(key, indices);
        }
        const bucket = frames.get(key) ?? {
          predicate: key,
          left: new Map<string, number>(),
          right: new Map<string, number>(),
          examples: [],
          evidenceIds: new Set<EvidenceId>(),
          alpha: 0,
          posteriorMass: 0,
          hypothesisCount: 0,
          alternatives: new Map<string, { posteriorMass: number; energyMass: number }>()
        };
        for (const symbol of left) {
          bucket.left.set(symbol, (bucket.left.get(symbol) ?? 0) + predicate.posterior);
        }
        for (const symbol of right) {
          bucket.right.set(symbol, (bucket.right.get(symbol) ?? 0) + predicate.posterior);
        }
        if (bucket.examples.length < 12 && !bucket.examples.includes(sentence)) {
          bucket.examples.push(sentence);
        }
        for (const id of doc.evidenceIds ?? []) bucket.evidenceIds.add(id);
        bucket.alpha += trust * predicate.posterior;
        bucket.posteriorMass += predicate.posterior;
        bucket.hypothesisCount += 1;
        for (const alternative of hypotheses) {
          const row = bucket.alternatives.get(alternative.surface) ?? {
            posteriorMass: 0,
            energyMass: 0
          };
          row.posteriorMass += alternative.posterior * predicate.posterior;
          row.energyMass += alternative.energy * predicate.posterior;
          bucket.alternatives.set(alternative.surface, row);
        }
        frames.set(key, bucket);
      }
    }
  }
  return [...frames.values()]
    .map(frame => {
      const leftRoles = topEntries(frame.left, 12).map(([filler, count]) => ({ name: "arg0", filler, count, salience: clamp01(count / Math.max(1, frame.alpha)) }));
      const rightRoles = topEntries(frame.right, 12).map(([filler, count]) => ({ name: "arg1", filler, count, salience: clamp01(count / Math.max(1, frame.alpha)) }));
      const roles = [...leftRoles, ...rightRoles].sort((a, b) => b.salience - a.salience || b.count - a.count);
      const support = clamp01(Math.log1p(frame.alpha) / 6 + Math.min(0.3, roles.length / 40));
      return {
        id: `frame_${hasher.digestHex(`${frame.predicate}:${roles.map(r => `${r.name}:${r.filler}`).join("|")}`).slice(0, 24)}`,
        predicate: frame.predicate,
        roles,
        support,
        alphaPrior: clamp01(frame.alpha / Math.max(1, frame.examples.length)),
        predicateConfidence: clamp01(frame.posteriorMass / Math.max(1, frame.hypothesisCount)),
        predicatePosteriorMass: frame.posteriorMass,
        predicateAlternatives: [...frame.alternatives.entries()]
          .map(([surface, row]) => ({
            surface,
            posterior: row.posteriorMass / Math.max(Number.EPSILON, frame.posteriorMass),
            energy: row.energyMass / Math.max(Number.EPSILON, frame.posteriorMass)
          }))
          .sort((left, right) =>
            right.posterior - left.posterior
            || left.energy - right.energy
            || left.surface.localeCompare(right.surface))
          .slice(0, 16),
        examples: frame.examples,
        evidenceIds: [...frame.evidenceIds]
      };
    })
    .filter(frame => frame.roles.length > 0)
    .sort((a, b) => b.support - a.support || b.alphaPrior - a.alphaPrior || a.predicate.localeCompare(b.predicate))
    .slice(0, Math.max(1, maxFrames));
}

/**
 * Bind induced constructions to SCCE's real graph semantics (Part B step 6).
 * `SemanticFrameCandidate`s were fully inert downstream before this: nothing
 * consumed them beyond diagnostic counts. Rather than inventing a fourth
 * "construction" concept, this reuses the exact role/relation vocabulary the
 * live structural-entailment pipeline already uses in `semantic-graph.ts`
 * (`SemanticRole`, and `relationFor()`'s `has_predicate`/`acts_on` for
 * entity<->predicate adjacency): a frame's predicate becomes a `"predicate"`-
 * role anchor, and each `arg0`/`arg1` role group becomes an `"entity"`-role
 * slot connected to it with the same relation direction
 * `propositionGraphFromText()` would assign to a real entity-predicate
 * sentence pair. A slot is genuinely *variable-bearing* -- not a fixed single
 * filler -- exactly when a real majority of its observed fillers are members
 * of one already-induced `LexicalClass` (step 4): that class is the slot's
 * real substitution set, discovered from actual corpus evidence, not
 * assumed. Deliberately does not construct actual `PropositionNode`/
 * `PropositionEdge`/branded `NodeId`/`RelationId` values -- those require an
 * `IdFactory`, which the induction engine does not take as a dependency
 * (matching every prior Part B step's additive, self-contained shape); this
 * is the typed binding a caller with a real `IdFactory` would use to build
 * them, not the graph objects themselves.
 */
function induceGraphBoundConstructions(
  semanticFrames: readonly SemanticFrameCandidate[],
  lexicalClasses: readonly LexicalClass[],
  hasher: Hasher
): GraphBoundConstruction[] {
  const minClassOverlap = 2;
  const maxObservedFillers = 8;
  const out: GraphBoundConstruction[] = [];
  for (const frame of semanticFrames) {
    if (frame.roles.length === 0) continue;
    const byRole = new Map<string, Array<{ filler: string; salience: number }>>();
    for (const role of frame.roles) {
      const bucket = byRole.get(role.name) ?? [];
      bucket.push({ filler: role.filler, salience: role.salience });
      byRole.set(role.name, bucket);
    }
    const slots: GraphBoundConstructionSlot[] = [];
    for (const [roleId, entries] of byRole) {
      const observedFillers = entries
        .sort((a, b) => b.salience - a.salience || a.filler.localeCompare(b.filler))
        .slice(0, maxObservedFillers)
        .map(entry => entry.filler);
      const { relation, relationDirection } = relationForFrameRole(roleId);
      const classMatch = bestLexicalClassMatch(observedFillers, lexicalClasses, minClassOverlap);
      slots.push({
        roleId,
        semanticRole: "entity",
        relation,
        relationDirection,
        observedFillers,
        ...(classMatch ? { lexicalClassId: classMatch.lexicalClassId, classCoverage: classMatch.classCoverage } : {})
      });
    }
    slots.sort((a, b) => a.roleId.localeCompare(b.roleId));
    out.push({
      id: `graphconstruct_${hasher.digestHex(frame.id).slice(0, 24)}`,
      frameId: frame.id,
      predicate: frame.predicate,
      predicateSemanticRole: "predicate",
      slots,
      support: frame.support,
      evidenceIds: frame.evidenceIds
    });
  }
  return out.sort((a, b) => b.support - a.support || a.id.localeCompare(b.id));
}

/**
 * Mirrors `semantic-graph.ts`'s `relationFor()` exactly for the
 * entity<->predicate case: an `arg0` filler is treated the way
 * `propositionGraphFromText()` treats an entity node preceding a predicate
 * node (`source: entity, target: predicate` -> `"has_predicate"`); an `arg1`
 * filler is treated the way it treats a predicate node preceding an entity
 * node (`source: predicate, target: entity` -> `"acts_on"`). Any other role
 * name falls back to `relationFor()`'s own generic fallback, `"associates"`.
 */
function relationForFrameRole(roleId: string): { relation: string; relationDirection: "source" | "target" } {
  if (roleId === "arg0") return { relation: "has_predicate", relationDirection: "source" };
  if (roleId === "arg1") return { relation: "acts_on", relationDirection: "target" };
  return { relation: "associates", relationDirection: "source" };
}

function bestLexicalClassMatch(
  observedFillers: readonly string[],
  lexicalClasses: readonly LexicalClass[],
  minOverlap: number
): { lexicalClassId: string; classCoverage: number } | undefined {
  if (observedFillers.length === 0) return undefined;
  const fillerSet = new Set(observedFillers);
  let best: { lexicalClassId: string; classCoverage: number; overlap: number } | undefined;
  for (const lexicalClass of lexicalClasses) {
    const overlap = lexicalClass.members.filter(member => fillerSet.has(member.symbol)).length;
    if (overlap < minOverlap) continue;
    const classCoverage = clamp01(overlap / observedFillers.length);
    if (!best || overlap > best.overlap || (overlap === best.overlap && lexicalClass.id.localeCompare(best.lexicalClassId) < 0)) {
      best = { lexicalClassId: lexicalClass.id, classCoverage, overlap };
    }
  }
  return best ? { lexicalClassId: best.lexicalClassId, classCoverage: best.classCoverage } : undefined;
}

export function sentenceSegments(text: string, hasher: Hasher): string[] {
  const cleaned = text.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]!;
    const isAsciiTerminator = char === "." || char === "!" || char === "?" || char === ";";
    if (isAsciiTerminator && (cleaned[i + 1] === " " || i === cleaned.length - 1)) {
      const sentence = cleaned.slice(start, i + 1).trim();
      if (sentence) out.push(sentence);
      start = i + 1;
      continue;
    }
    // Real Unicode sentence-terminal punctuation (e.g. CJK full-width 。！？) never
    // requires a following space, unlike the ASCII case above -- most scripts that
    // use these marks are conventionally unspaced. Not an ASCII-specific rule: any
    // script whose terminal punctuation carries this Unicode property benefits.
    if (!isAsciiTerminator && /\p{Sentence_Terminal}/u.test(char)) {
      const sentence = cleaned.slice(start, i + 1).trim();
      if (sentence) out.push(sentence);
      start = i + 1;
    }
  }
  const tail = cleaned.slice(start).trim();
  if (tail) out.push(tail);
  if (out.length) return out;
  const symbols = lexicalSurfaceSymbols(cleaned, `sentence_fallback.${hasher.digestHex(cleaned).slice(0, 24)}`, hasher);
  const chunks: string[] = [];
  for (let i = 0; i < symbols.length; i += 40) chunks.push(symbols.slice(i, i + 40).join(" "));
  return chunks;
}

// Every call site (sentence-level syntax-template shapes, relation-hypothesis
// symbol streams, semantic-frame left/right context bags, and per-document
// translation-seed frequency profiles) only consumes a flat sequence of
// word-shaped surface tokens -- none of them read lattice-fitted boundary
// probabilities or multi-hypothesis segmentation. This used to rebuild a
// full boundary-estimator-driven SurfaceLattice (buildSurfaceLattice) on
// every call, and it is invoked once per sentence in three separate
// induction stages plus once per whole document in a fourth, on top of the
// two full-corpus lattice builds induce() already performs correctly.
// Measured directly: for a single 16KB real-corpus document this made
// induce() alone exceed a 4GB heap; the identical redundant-lattice-per-
// sentence pattern was already found and fixed for compileLanguagePatterns
// in ngram-memory.ts's surfaceSymbols.
//
// A plain script-agnostic symbolizer (symbolizeData) is NOT an equivalent
// substitute here, unlike in ngram-memory.ts: buildSurfaceLattice's "lexical"
// proposal source comes directly from segmentUnicodeSurfaceV2's word-level
// segmentation, which resolves multi-character CJK words (e.g. "北京") that
// symbolizeData's simpler per-symbol segmenter shatters into single Han
// characters -- confirmed live via
// language-induction-lexical-classes.test.ts's Chinese word-clustering case.
// segmentUnicodeSurfaceV2 is the exact same segmentation model
// buildSurfaceLattice itself calls first, before any of its expensive
// candidate-generation/boundary-evidence/segmentation-forest machinery runs,
// so it reproduces the same lexical sequence at a fraction of the cost
// (measured: ~45ms for 103KB of real corpus text, vs. buildSurfaceLattice
// OOMing past 16KB before the quadratic-cost fixes above).
export function lexicalSurfaceSymbols(text: string, _documentId: string, hasher: Hasher): string[] {
  return segmentUnicodeSurfaceV2(text, hasher).lexicalSegments.map(segment => segment.normalized);
}

export function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(1, limit));
}
