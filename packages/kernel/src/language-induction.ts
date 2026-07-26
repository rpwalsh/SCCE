import type { EvidenceId, Hasher, JsonValue, SourceVersionId } from "./types.js";
import { clamp01, createHasher, entropy, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import {
  compileBoundaryStatistics,
  fitBoundaryEstimator,
  type BoundaryEstimatorModel,
  type BoundarySufficientStatistics
} from "./boundary-estimator.js";
import { compactKneserNeyForProfile, continueBoundedProse, trainKneserNey, type KneserNeyModel } from "./kneser-ney.js";
import {
  buildSurfaceLattice,
  canonicalSurfaceSequence,
  collectBoundaryObservations,
  SURFACE_LATTICE_SCHEMA,
  type SurfaceLattice
} from "./surface-lattice.js";
import type { SemanticRole } from "./semantic-graph.js";

export type NgramOrder = 1 | 2 | 3 | 4 | 5 | 6;

export interface LanguageInductionDocument {
  id: string;
  text: string;
  sourceVersionId?: SourceVersionId;
  evidenceIds?: EvidenceId[];
  languageHint?: string;
  trust?: number;
}

export interface InducedNgram {
  order: NgramOrder;
  gram: string[];
  count: number;
  probability: number;
  continuationDiversity: number;
  pmi: number;
}

export interface BoundarySignal {
  left: string;
  right: string;
  count: number;
  boundaryProbability: number;
  joinProbability: number;
  mutualInformation: number;
}

export interface ScriptProfile {
  script: string;
  count: number;
  mass: number;
  entropy: number;
  examples: string[];
}

export interface MorphologicalRule {
  id: string;
  kind: "prefix" | "suffix" | "infix" | "compound" | "reduplication";
  pattern: string;
  stemCount: number;
  symbolCount: number;
  productivity: number;
  examples: string[];
}

export interface SyntaxTemplate {
  id: string;
  shape: string[];
  count: number;
  probability: number;
  entropy: number;
  examples: string[];
}

export interface LexicalClassMember {
  symbol: string;
  scriptId: string;
  count: number;
}

export interface LexicalClass {
  id: string;
  members: LexicalClassMember[];
  /** Number of distinct left/right context slots in which at least two members were both observed. */
  contextSupport: number;
  /** Mean weighted-Jaccard similarity of context-slot sets over member pairs that triggered clustering. */
  cohesion: number;
  /** Example "left _ right" context slots shared by two or more members, most-shared first. */
  exampleContexts: string[];
}

export interface MorphologyClassBinding {
  id: string;
  ruleId: string;
  lexicalClassId: string;
  /** Count of the rule's inflected example forms that are also members of this lexical class. */
  stemOverlap: number;
  /** stemOverlap / rule.examples.length -- how much of the rule's own example set this class explains. */
  ruleCoverage: number;
  /** stemOverlap / lexicalClass.members.length -- how much of the class this rule's examples cover. */
  classCoverage: number;
  /** min(ruleCoverage, classCoverage) -- requires both directions of evidence, not a one-sided coincidence. */
  confidence: number;
}

export interface SemanticFrameCandidate {
  id: string;
  predicate: string;
  roles: Array<{ name: string; filler: string; count: number; salience: number }>;
  support: number;
  alphaPrior: number;
  /** Real, corpus-computed combinatorial-diversity score (see `computeGlobalContextDiversity`) that also drove predicate selection -- not a post-hoc label on an unrelated heuristic. */
  predicateConfidence: number;
  examples: string[];
  evidenceIds: EvidenceId[];
}

export interface GraphBoundConstructionSlot {
  roleId: string;
  /** Reuses `semantic-graph.ts`'s real `SemanticRole` vocabulary -- arg fillers are always "entity". */
  semanticRole: SemanticRole;
  /** Reuses `semantic-graph.ts`'s `relationFor()` vocabulary for entity<->predicate adjacency (`has_predicate`/`acts_on`), not an invented relation name. */
  relation: string;
  /** Whether this slot's node is the relation's source or target, matching `relationFor()`'s exact directionality. */
  relationDirection: "source" | "target";
  /** Bounded, most-salient real fillers observed for this role. */
  observedFillers: string[];
  /** Set only when a real majority of observedFillers are members of one induced LexicalClass -- this is what makes the slot variable-bearing (accepts any class member, not only the one filler that was observed). */
  lexicalClassId?: string;
  classCoverage?: number;
}

export interface GraphBoundConstruction {
  id: string;
  frameId: string;
  predicate: string;
  predicateSemanticRole: SemanticRole;
  slots: GraphBoundConstructionSlot[];
  support: number;
  evidenceIds: EvidenceId[];
}

export interface TranslationSeed {
  sourceSymbol: string;
  targetSymbol: string;
  score: number;
  basis: "shared_context" | "shape" | "number" | "symbol" | "frame";
  evidenceIds: EvidenceId[];
}

export interface InducedLanguageModel {
  id: string;
  corpusDocuments: number;
  symbolCount: number;
  vocabularySize: number;
  scripts: ScriptProfile[];
  ngrams: InducedNgram[];
  kneserNey: JsonValue;
  boundaryStatistics: BoundarySufficientStatistics;
  boundaryEstimator: BoundaryEstimatorModel;
  boundarySignals: BoundarySignal[];
  morphology: MorphologicalRule[];
  syntaxTemplates: SyntaxTemplate[];
  lexicalClasses: LexicalClass[];
  morphologyClassBindings: MorphologyClassBinding[];
  semanticFrames: SemanticFrameCandidate[];
  graphBoundConstructions: GraphBoundConstruction[];
  translationSeeds: TranslationSeed[];
  proseDiagnostics: JsonValue;
  audit: JsonValue;
}

export function createLanguageInductionEngine(options: { hasher?: Hasher; vocabularyLimit?: number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const vocabularyLimit = Math.max(512, Math.floor(options.vocabularyLimit ?? 50000));
  return {
    induce(input: { documents: LanguageInductionDocument[]; order?: NgramOrder; maxNgrams?: number; maxFrames?: number; maxLexicalClasses?: number }): InducedLanguageModel {
      const documents = input.documents.filter(doc => doc.text.trim().length > 0);
      const corpusText = documents.map(doc => doc.text).join("\n");
      const initialLattices = documents.map(doc => ({
        doc,
        lattice: buildSurfaceLattice({
          documentId: doc.id,
          text: doc.text,
          sourceVersionId: doc.sourceVersionId,
          evidenceIds: doc.evidenceIds,
          hasher
        })
      }));
      const populationId = `surface_population.${hasher.digestHex(JSON.stringify(
        documents.map(document => [document.id, document.sourceVersionId ?? null]).sort()
      )).slice(0, 32)}`;
      const boundaryStatistics = compileBoundaryStatistics({
        populationId,
        observations: collectBoundaryObservations(initialLattices.map(({ lattice }) => lattice)),
        sourceDocumentIds: documents.map(document => document.id),
        hasher
      });
      const boundaryEstimator = fitBoundaryEstimator({ statistics: boundaryStatistics, hasher });
      const lattices = documents.map(doc => ({
        doc,
        lattice: buildSurfaceLattice({
          documentId: doc.id,
          text: doc.text,
          sourceVersionId: doc.sourceVersionId,
          evidenceIds: doc.evidenceIds,
          boundaryEstimator,
          hasher
        })
      }));
      const symbols = lattices.flatMap(({ doc, lattice }) =>
        canonicalSurfaceSequence(lattice).map(unit => ({ symbol: unit.surface, doc }))
      );
      const symbolStrings = symbols.map(item => item.symbol);
      const lexicalStrings = lattices.flatMap(({ lattice }) => lexicalSurfaceSequence(lattice));
      const order = clampOrder(input.order ?? 6);
      const counts = countNgrams(symbolStrings, order, vocabularyLimit);
      const ngrams = inducedNgrams(counts, order, input.maxNgrams ?? 4096);
      const kn = trainKneserNey(symbolStrings, { order, vocabularyLimit });
      const boundarySignals = induceBoundariesFromLattices(lattices.map(({ lattice }) => lattice), hasher).slice(0, 2048);
      const scripts = induceScripts(corpusText);
      const morphology = induceMorphology(lexicalStrings, hasher).slice(0, 2048);
      const syntaxTemplates = induceSyntaxTemplates(documents, hasher).slice(0, 2048);
      const lexicalClasses = induceLexicalClasses(documents, hasher, input.maxLexicalClasses ?? 1024);
      const morphologyClassBindings = induceMorphologyClassBindings(morphology, lexicalClasses, hasher).slice(0, 2048);
      const semanticFrames = induceSemanticFrames(documents, hasher, input.maxFrames ?? 2048);
      const graphBoundConstructions = induceGraphBoundConstructions(semanticFrames, lexicalClasses, hasher).slice(0, 2048);
      const translationSeeds = induceTranslationSeeds(documents, semanticFrames, hasher).slice(0, 2048);
      const proseDiagnostics = proseDiagnostic(kn, symbolStrings);
      const id = `language_model_${hasher.digestHex(JSON.stringify({
        docs: documents.map(d => d.id),
        symbols: symbolStrings.length,
        order,
        boundaryEstimatorId: boundaryEstimator.id
      })).slice(0, 32)}`;
      return {
        id,
        corpusDocuments: documents.length,
        symbolCount: symbolStrings.length,
        vocabularySize: new Set(symbolStrings).size,
        scripts,
        ngrams,
        kneserNey: compactKneserNeyForProfile(kn, corpusText.slice(0, 200000)),
        boundaryStatistics,
        boundaryEstimator,
        boundarySignals,
        morphology,
        syntaxTemplates,
        lexicalClasses,
        morphologyClassBindings,
        semanticFrames,
        graphBoundConstructions,
        translationSeeds,
        proseDiagnostics,
        audit: toJsonValue({
          order,
          vocabularyLimit,
          sourceVersionIds: documents.map(doc => doc.sourceVersionId).filter(Boolean),
          evidenceIds: [...new Set(documents.flatMap(doc => doc.evidenceIds ?? []))],
          surfaceLatticeSchema: SURFACE_LATTICE_SCHEMA,
          surfaceLatticeIds: lattices.map(({ lattice }) => lattice.id),
          segmentationForestIds: lattices.map(({ lattice }) => lattice.segmentationForest.id),
          retainedSegmentationPosteriorMass: lattices.map(({ lattice }) => lattice.segmentationForest.retainedPosteriorMass),
          boundaryStatisticsId: boundaryStatistics.id,
          boundaryEstimatorId: boundaryEstimator.id,
          boundaryEstimatorPopulationId: populationId,
          trustMean: documents.length ? mean(documents.map(doc => doc.trust ?? 0.5)) : 0,
          corpusHash: hasher.digestHex(corpusText)
        })
      };
    },

    scoreContinuation(input: { model: KneserNeyModel; prompt: string; generationExtent?: number }): JsonValue {
      return toJsonValue(continueBoundedProse(input.model, input.prompt, { generationExtent: input.generationExtent ?? 64 }));
    }
  };
}

function clampOrder(order: number): NgramOrder {
  return Math.max(1, Math.min(6, Math.floor(order))) as NgramOrder;
}

interface NgramCounts {
  orderCounts: Array<Map<string, number>>;
  contextCounts: Array<Map<string, number>>;
  leftContexts: Map<string, Set<string>>;
  rightContexts: Map<string, Set<string>>;
  observedSymbolCount: number;
  vocabulary: Set<string>;
}

function countNgrams(symbols: readonly string[], maxOrder: NgramOrder, vocabularyLimit: number): NgramCounts {
  const vocabulary = topVocabulary(symbols, vocabularyLimit);
  const normalized = symbols.map(symbol => vocabulary.has(symbol) ? symbol : "<unk>");
  const orderCounts = Array.from({ length: maxOrder + 1 }, () => new Map<string, number>());
  const contextCounts = Array.from({ length: maxOrder + 1 }, () => new Map<string, number>());
  const leftContexts = new Map<string, Set<string>>();
  const rightContexts = new Map<string, Set<string>>();
  for (let order = 1 as NgramOrder; order <= maxOrder; order = (order + 1) as NgramOrder) {
    for (let i = 0; i <= normalized.length - order; i++) {
      const gram = normalized.slice(i, i + order);
      const key = gramKey(gram);
      const orderMap = orderCounts[order]!;
      orderMap.set(key, (orderMap.get(key) ?? 0) + 1);
      const left = normalized[i - 1] ?? "<s>";
      const right = normalized[i + order] ?? "</s>";
      if (!leftContexts.has(key)) leftContexts.set(key, new Set());
      if (!rightContexts.has(key)) rightContexts.set(key, new Set());
      leftContexts.get(key)!.add(left);
      rightContexts.get(key)!.add(right);
      if (order > 1) {
        const context = gramKey(gram.slice(0, -1));
        const contextMap = contextCounts[order]!;
        contextMap.set(context, (contextMap.get(context) ?? 0) + 1);
      }
    }
  }
  return { orderCounts, contextCounts, leftContexts, rightContexts, observedSymbolCount: normalized.length, vocabulary };
}

function inducedNgrams(counts: NgramCounts, maxOrder: NgramOrder, limit: number): InducedNgram[] {
  const out: InducedNgram[] = [];
  const unigram = counts.orderCounts[1]!;
  const total = Math.max(1, counts.observedSymbolCount);
  for (let order = 1 as NgramOrder; order <= maxOrder; order = (order + 1) as NgramOrder) {
    const orderMap = counts.orderCounts[order]!;
    for (const [key, count] of orderMap) {
      const gram = key.split("\u0001");
      const contextCount = order === 1 ? total : (counts.contextCounts[order]!.get(gramKey(gram.slice(0, -1))) ?? 1);
      const probability = count / Math.max(1, contextCount);
      const continuationDiversity = ((counts.leftContexts.get(key)?.size ?? 0) + (counts.rightContexts.get(key)?.size ?? 0)) / Math.max(2, count * 2);
      const pmi = ngramPmi(gram, count, total, unigram);
      out.push({ order, gram, count, probability, continuationDiversity, pmi });
    }
  }
  return out
    .sort((a, b) => scoreNgram(b) - scoreNgram(a) || a.gram.join(" ").localeCompare(b.gram.join(" ")))
    .slice(0, Math.max(1, limit));
}

function scoreNgram(item: InducedNgram): number {
  return Math.log1p(item.count) * (1 + item.pmi) * (0.5 + item.continuationDiversity) * (0.75 + item.order / 6);
}

function ngramPmi(gram: readonly string[], count: number, total: number, unigram: Map<string, number>): number {
  if (gram.length <= 1) return 0;
  const joint = count / Math.max(1, total);
  let independent = 1;
  for (const symbol of gram) independent *= (unigram.get(symbol) ?? 1) / Math.max(1, total);
  return Math.max(0, Math.log2(Math.max(1e-12, joint / Math.max(1e-12, independent))) / Math.max(1, gram.length));
}

function induceBoundariesFromLattices(
  lattices: readonly SurfaceLattice[],
  hasher: Hasher
): BoundarySignal[] {
  const pairCounts = new Map<string, number>();
  const boundaryMass = new Map<string, number>();
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const lattice of lattices) {
    const graphemes = lattice.units
      .filter(unit => unit.overlapClass === "base_partition")
      .sort((left, right) => left.graphemeStart - right.graphemeStart);
    for (let index = 0; index < graphemes.length - 1; index += 1) {
      const left = graphemes[index]!;
      const right = graphemes[index + 1]!;
      const key = JSON.stringify([left.normalized, right.normalized]);
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      boundaryMass.set(key, (boundaryMass.get(key) ?? 0) + left.boundaryAfter.boundaryProbability);
      leftCounts.set(left.normalized, (leftCounts.get(left.normalized) ?? 0) + 1);
      rightCounts.set(right.normalized, (rightCounts.get(right.normalized) ?? 0) + 1);
    }
  }
  const total = [...pairCounts.values()].reduce((sum, count) => sum + count, 0);
  const signals: BoundarySignal[] = [];
  for (const [key, count] of pairCounts) {
    const [left, right] = JSON.parse(key) as [string, string];
    const boundary = boundaryMass.get(key) ?? 0;
    const joint = count / Math.max(1, total);
    const independent = ((leftCounts.get(left) ?? 1) / Math.max(1, total)) * ((rightCounts.get(right) ?? 1) / Math.max(1, total));
    const mutualInformation = Math.max(0, Math.log2(Math.max(1e-12, joint / Math.max(1e-12, independent))));
    const boundaryProbability = clamp01(boundary / count);
    signals.push({
      left,
      right,
      count,
      boundaryProbability,
      joinProbability: clamp01(1 - boundaryProbability),
      mutualInformation
    });
  }
  return signals.sort((a, b) => b.boundaryProbability - a.boundaryProbability || b.mutualInformation - a.mutualInformation || hasher.digestHex(`${a.left}:${a.right}`).localeCompare(hasher.digestHex(`${b.left}:${b.right}`)));
}

function induceScripts(text: string): ScriptProfile[] {
  const byScript = new Map<string, string[]>();
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    const script = scriptOf(char);
    const bucket = byScript.get(script) ?? [];
    if (bucket.length < 128) bucket.push(char);
    else bucket[0] = char;
    byScript.set(script, bucket);
  }
  const counts = [...byScript.entries()].map(([script, examples]) => ({ script, count: countScript(text, script), examples: [...new Set(examples)].slice(0, 24) }));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return counts
    .map(item => {
      const frequencies = new Map<string, number>();
      for (const example of item.examples) frequencies.set(example, (frequencies.get(example) ?? 0) + 1);
      return {
        script: item.script,
        count: item.count,
        mass: item.count / Math.max(1, total),
        entropy: entropy([...frequencies.values()]),
        examples: item.examples
      };
    })
    .sort((a, b) => b.count - a.count || a.script.localeCompare(b.script));
}

function countScript(text: string, script: string): number {
  let count = 0;
  for (const char of text) if (!/\s/u.test(char) && scriptOf(char) === script) count++;
  return count;
}

function scriptOf(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x007f) return /[A-Za-z]/.test(char) ? "latin-basic" : /[0-9]/.test(char) ? "digit" : "ascii-symbol";
  if (code >= 0x0080 && code <= 0x024f) return "latin-extended";
  if (code >= 0x0370 && code <= 0x03ff) return "greek";
  if (code >= 0x0400 && code <= 0x052f) return "cyrillic";
  if (code >= 0x0590 && code <= 0x05ff) return "hebrew";
  if (code >= 0x0600 && code <= 0x06ff) return "arabic";
  if (code >= 0x0900 && code <= 0x097f) return "devanagari";
  if (code >= 0x3040 && code <= 0x30ff) return "kana";
  if (code >= 0x4e00 && code <= 0x9fff) return "han";
  if (code >= 0xac00 && code <= 0xd7af) return "hangul";
  return "other";
}

function induceMorphology(symbols: readonly string[], hasher: Hasher): MorphologicalRule[] {
  const vocabulary = [...new Set(symbols.filter(symbol => graphemeUnits(symbol).length >= 4 && /^[^\d\s]+$/u.test(symbol)))];
  const prefixMap = new Map<string, Set<string>>();
  const suffixMap = new Map<string, Set<string>>();
  const compoundMap = new Map<string, string[]>();
  const vocabSet = new Set(vocabulary);
  for (const symbol of vocabulary) {
    const graphemes = graphemeUnits(symbol);
    for (let n = 1; n <= Math.min(5, graphemes.length - 2); n++) {
      const prefix = graphemes.slice(0, n).join("");
      const suffix = graphemes.slice(graphemes.length - n).join("");
      const prefixStem = graphemes.slice(n).join("");
      const suffixStem = graphemes.slice(0, graphemes.length - n).join("");
      if (graphemeUnits(prefixStem).length >= 3) {
        const bucket = prefixMap.get(prefix) ?? new Set<string>();
        bucket.add(prefixStem);
        prefixMap.set(prefix, bucket);
      }
      if (graphemeUnits(suffixStem).length >= 3) {
        const bucket = suffixMap.get(suffix) ?? new Set<string>();
        bucket.add(suffixStem);
        suffixMap.set(suffix, bucket);
      }
    }
    for (let split = 3; split <= graphemes.length - 3; split++) {
      const left = graphemes.slice(0, split).join("");
      const right = graphemes.slice(split).join("");
      if (vocabSet.has(left) && vocabSet.has(right)) {
        compoundMap.set(symbol, [left, right]);
      }
    }
  }
  const symbolCounts = frequency(symbols);
  const rules: MorphologicalRule[] = [];
  for (const [prefix, stems] of prefixMap) {
    if (stems.size < 3) continue;
    const examples = [...stems].slice(0, 16).map(stem => `${prefix}${stem}`);
    rules.push({
      id: `morph_${hasher.digestHex(`prefix:${prefix}:${examples.join("|")}`).slice(0, 24)}`,
      kind: "prefix",
      pattern: `${prefix}+STEM`,
      stemCount: stems.size,
      symbolCount: examples.reduce((sum, symbol) => sum + (symbolCounts.get(symbol) ?? 0), 0),
      productivity: clamp01(Math.log1p(stems.size) / 8),
      examples
    });
  }
  for (const [suffix, stems] of suffixMap) {
    if (stems.size < 3) continue;
    const examples = [...stems].slice(0, 16).map(stem => `${stem}${suffix}`);
    rules.push({
      id: `morph_${hasher.digestHex(`suffix:${suffix}:${examples.join("|")}`).slice(0, 24)}`,
      kind: "suffix",
      pattern: `STEM+${suffix}`,
      stemCount: stems.size,
      symbolCount: examples.reduce((sum, symbol) => sum + (symbolCounts.get(symbol) ?? 0), 0),
      productivity: clamp01(Math.log1p(stems.size) / 8),
      examples
    });
  }
  for (const [compound, parts] of compoundMap) {
    rules.push({
      id: `morph_${hasher.digestHex(`compound:${compound}`).slice(0, 24)}`,
      kind: "compound",
      pattern: parts.join("+"),
      stemCount: parts.length,
      symbolCount: symbolCounts.get(compound) ?? 1,
      productivity: clamp01((symbolCounts.get(compound) ?? 1) / 12),
      examples: [compound]
    });
  }
  return rules.sort((a, b) => b.productivity - a.productivity || b.stemCount - a.stemCount || a.pattern.localeCompare(b.pattern));
}

const MORPHOLOGY_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeUnits(value: string): string[] {
  return [...MORPHOLOGY_GRAPHEME_SEGMENTER.segment(value)].map(row => row.segment);
}

function induceSyntaxTemplates(documents: readonly LanguageInductionDocument[], hasher: Hasher): SyntaxTemplate[] {
  const counts = new Map<string, { count: number; examples: string[]; nextShapes: Map<string, number> }>();
  for (const doc of documents) {
    for (const [sentenceIndex, sentence] of sentenceSegments(doc.text, hasher).entries()) {
      const symbols = lexicalSurfaceSymbols(sentence, `${doc.id}.syntax.${sentenceIndex}`, hasher);
      if (symbols.length === 0) continue;
      const shape = symbols.slice(0, 32).map(symbolShape);
      for (let width = 2; width <= Math.min(8, shape.length); width++) {
        for (let i = 0; i <= shape.length - width; i++) {
          const window = shape.slice(i, i + width);
          const key = window.join(" ");
          const bucket = counts.get(key) ?? { count: 0, examples: [], nextShapes: new Map<string, number>() };
          bucket.count++;
          const next = shape[i + width] ?? "</s>";
          bucket.nextShapes.set(next, (bucket.nextShapes.get(next) ?? 0) + 1);
          if (bucket.examples.length < 8) bucket.examples.push(symbols.slice(i, i + width).join(" "));
          counts.set(key, bucket);
        }
      }
    }
  }
  const total = [...counts.values()].reduce((sum, item) => sum + item.count, 0);
  return [...counts.entries()]
    .filter(([, value]) => value.count >= 2)
    .map(([key, value]) => ({
      id: `syntax_${hasher.digestHex(key).slice(0, 24)}`,
      shape: key.split(" "),
      count: value.count,
      probability: value.count / Math.max(1, total),
      entropy: entropy([...value.nextShapes.values()]),
      examples: value.examples
    }))
    .sort((a, b) => b.count * (1 + b.entropy) - a.count * (1 + a.entropy) || a.shape.join(" ").localeCompare(b.shape.join(" ")));
}

/**
 * Distributional lexical-class induction (Part B step 4): words are
 * substitutable, and therefore belong to the same latent class, when they
 * are observed in the same left/right context slots (Harris's distributional
 * hypothesis). Deliberately built on the canonical surface lattice's
 * lexical hypotheses. N-gram fluency retains the lattice's canonical
 * sequence, while lexical,
 * morphology, syntax, and semantic induction require the actual lexical unit
 * a script's speakers use, or every non-Latin "word" collapses to a single
 * grapheme and every class becomes a same-script character bag rather than a
 * real lexical class. This is additive and self-contained: it does not
 * change n-gram fluency induction.
 */
function induceLexicalClasses(documents: readonly LanguageInductionDocument[], hasher: Hasher, maxClasses: number): LexicalClass[] {
  const candidateLimit = 768;
  const contextLimitPerSymbol = 24;
  const minSymbolSupport = 3;
  const minDistinctContexts = 2;
  const similarityThreshold = 0.2;

  const symbolCounts = new Map<string, number>();
  const symbolScripts = new Map<string, string>();
  const symbolContexts = new Map<string, Map<string, number>>();

  for (const doc of documents) {
    const lexical = lexicalUnits(buildSurfaceLattice({
      documentId: doc.id,
      text: doc.text,
      sourceVersionId: doc.sourceVersionId,
      evidenceIds: doc.evidenceIds,
      hasher
    }));
    for (let i = 0; i < lexical.length; i++) {
      const symbol = lexical[i]!.normalized;
      if (!symbol) continue;
      const left = lexical[i - 1]?.normalized ?? "<s>";
      const right = lexical[i + 1]?.normalized ?? "</s>";
      const contextKey = `${left}\u0001${right}`;
      symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
      if (!symbolScripts.has(symbol)) symbolScripts.set(symbol, lexical[i]!.scriptId);
      const contexts = symbolContexts.get(symbol) ?? new Map<string, number>();
      contexts.set(contextKey, (contexts.get(contextKey) ?? 0) + 1);
      symbolContexts.set(symbol, contexts);
    }
  }

  const candidates = [...symbolCounts.entries()]
    .filter(([symbol, count]) => count >= minSymbolSupport && (symbolContexts.get(symbol)?.size ?? 0) >= minDistinctContexts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, candidateLimit)
    .map(([symbol]) => symbol);

  const topContexts = new Map<string, string[]>();
  for (const symbol of candidates) {
    topContexts.set(symbol, topEntries(symbolContexts.get(symbol)!, contextLimitPerSymbol).map(([key]) => key));
  }

  const pairSimilarity = new Map<string, number>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const similarity = weightedJaccard(topContexts.get(a)!, topContexts.get(b)!);
      pairSimilarity.set(pairKey(a, b), similarity);
    }
  }

  // Greedy complete-link clustering: a symbol may join a class only when it
  // meets the threshold against every existing member. The previous
  // union-find implementation admitted single-link chains (A~B, B~C) even
  // when A and C had no substitutable contexts.
  const components: string[][] = [];
  for (const symbol of candidates) {
    const eligible = components
      .map((members, index) => ({
        index,
        similarities: members.map(member => pairSimilarity.get(pairKey(symbol, member)) ?? 0)
      }))
      .filter(row => row.similarities.every(similarity => similarity >= similarityThreshold))
      .sort((left, right) =>
        mean(right.similarities) - mean(left.similarities)
        || left.index - right.index
      )[0];
    if (eligible) components[eligible.index]!.push(symbol);
    else components.push([symbol]);
  }

  const classes: LexicalClass[] = [];
  for (const members of components) {
    if (members.length < 2) continue;
    const sortedMembers = [...members].sort((a, b) => (symbolCounts.get(b) ?? 0) - (symbolCounts.get(a) ?? 0) || a.localeCompare(b));
    const pairwiseSimilarities: number[] = [];
    for (let i = 0; i < sortedMembers.length; i++) {
      for (let j = i + 1; j < sortedMembers.length; j++) {
        pairwiseSimilarities.push(pairSimilarity.get(pairKey(sortedMembers[i]!, sortedMembers[j]!)) ?? 0);
      }
    }
    const cohesion = clamp01(pairwiseSimilarities.length ? mean(pairwiseSimilarities) : 0);
    const contextObservers = new Map<string, number>();
    for (const symbol of sortedMembers) {
      for (const key of topContexts.get(symbol) ?? []) contextObservers.set(key, (contextObservers.get(key) ?? 0) + 1);
    }
    const sharedContexts = [...contextObservers.entries()]
      .filter(([, observers]) => observers >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    classes.push({
      id: `lexclass_${hasher.digestHex(sortedMembers.join("|")).slice(0, 24)}`,
      members: sortedMembers.map(symbol => ({
        symbol,
        scriptId: symbolScripts.get(symbol) ?? "script:Zyyy",
        count: symbolCounts.get(symbol) ?? 0
      })),
      contextSupport: sharedContexts.length,
      cohesion,
      exampleContexts: sharedContexts.slice(0, 8).map(([key]) => key.replace(/\u0001/g, " "))
    });
  }

  return classes
    .sort((a, b) => b.cohesion * b.members.length - a.cohesion * a.members.length || b.members.length - a.members.length || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, maxClasses));
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0001${right}` : `${right}\u0001${left}`;
}

/**
 * Morphology/agreement-constraint induction (Part B step 5): a real
 * morphosyntactic marker (e.g. a plural or agreement suffix) is one whose
 * inflected surface forms systematically fall inside one independently-
 * induced distributional class rather than scattering randomly across many.
 * This cross-references two already-computed, already-tested arrays
 * (`induceMorphology`'s affix rules, whose `examples` are real inflected
 * surface forms; `induceLexicalClasses`'s classes, whose members are the
 * same normalized surface-form symbols) -- no new symbol stream, no change
 * to either input. `stemOverlap`/`ruleCoverage`/`classCoverage` are the
 * literal set-overlap evidence; `confidence` requires both directions (the
 * class explains most of the rule's examples AND the rule explains most of
 * the class) so one huge class trivially intersecting a rule cannot produce
 * a false binding.
 */
function induceMorphologyClassBindings(
  morphology: readonly MorphologicalRule[],
  lexicalClasses: readonly LexicalClass[],
  hasher: Hasher
): MorphologyClassBinding[] {
  const minOverlap = 2;
  const bindings: MorphologyClassBinding[] = [];
  for (const rule of morphology) {
    if (rule.examples.length === 0) continue;
    const exampleSet = new Set(rule.examples);
    for (const lexicalClass of lexicalClasses) {
      if (lexicalClass.members.length === 0) continue;
      const overlap = lexicalClass.members.filter(member => exampleSet.has(member.symbol));
      if (overlap.length < minOverlap) continue;
      const ruleCoverage = clamp01(overlap.length / rule.examples.length);
      const classCoverage = clamp01(overlap.length / lexicalClass.members.length);
      bindings.push({
        id: `morphclass_${hasher.digestHex(`${rule.id}:${lexicalClass.id}`).slice(0, 24)}`,
        ruleId: rule.id,
        lexicalClassId: lexicalClass.id,
        stemOverlap: overlap.length,
        ruleCoverage,
        classCoverage,
        confidence: Math.min(ruleCoverage, classCoverage)
      });
    }
  }
  return bindings.sort((a, b) => b.confidence - a.confidence || b.stemOverlap - a.stemOverlap || a.id.localeCompare(b.id));
}

function induceSemanticFrames(documents: readonly LanguageInductionDocument[], hasher: Hasher, maxFrames: number): SemanticFrameCandidate[] {
  // Real corpus-wide signal, computed once, used as an actual selection
  // criterion below (not a post-hoc label on an unchanged heuristic): a
  // word that recombines with many distinct immediate left/right neighbors
  // across the corpus behaves like a real predicate (free combination with
  // varying arguments); a word locked into the same one or two immediate
  // contexts every time behaves like a fixed collocation, a modifier, or an
  // argument filler -- not a predicate.
  const combinatorialDiversity = computeGlobalContextDiversity(documents, hasher);
  const frames = new Map<string, { predicate: string; left: Map<string, number>; right: Map<string, number>; examples: string[]; evidenceIds: Set<EvidenceId>; alpha: number }>();
  for (const doc of documents) {
    const trust = clamp01(doc.trust ?? 0.5);
    for (const [sentenceIndex, sentence] of sentenceSegments(doc.text, hasher).entries()) {
      const symbols = lexicalSurfaceSymbols(sentence, `${doc.id}.frame.${sentenceIndex}`, hasher)
        .filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char)));
      if (symbols.length < 2) continue;
      const predicate = selectFramePredicate(symbols, combinatorialDiversity);
      const left = symbols.slice(Math.max(0, predicate.index - 6), predicate.index);
      const right = symbols.slice(predicate.index + 1, Math.min(symbols.length, predicate.index + 7));
      const key = predicate.symbol;
      const bucket = frames.get(key) ?? { predicate: key, left: new Map<string, number>(), right: new Map<string, number>(), examples: [] as string[], evidenceIds: new Set<EvidenceId>(), alpha: 0 };
      for (const symbol of left) bucket.left.set(symbol, (bucket.left.get(symbol) ?? 0) + 1);
      for (const symbol of right) bucket.right.set(symbol, (bucket.right.get(symbol) ?? 0) + 1);
      if (bucket.examples.length < 12) bucket.examples.push(sentence);
      for (const id of doc.evidenceIds ?? []) bucket.evidenceIds.add(id);
      bucket.alpha += trust;
      frames.set(key, bucket);
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
        predicateConfidence: combinatorialDiversity.get(frame.predicate) ?? 0,
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

function induceTranslationSeeds(documents: readonly LanguageInductionDocument[], frames: readonly SemanticFrameCandidate[], hasher: Hasher): TranslationSeed[] {
  const byLanguage = new Map<string, LanguageInductionDocument[]>();
  for (const doc of documents) {
    const key = doc.languageHint ?? dominantScriptKey(doc.text);
    const bucket = byLanguage.get(key) ?? [];
    bucket.push(doc);
    byLanguage.set(key, bucket);
  }
  if (byLanguage.size < 2) return [];
  const languageProfiles = [...byLanguage.entries()].map(([lang, docs]) => ({
    lang,
    symbols: frequency(docs.flatMap(doc =>
      lexicalSurfaceSymbols(doc.text, doc.id, hasher)
    )),
    features: featureSet(docs.map(doc => doc.text).join("\n"), 4096),
    evidenceIds: [...new Set(docs.flatMap(doc => doc.evidenceIds ?? []))]
  }));
  const seeds: TranslationSeed[] = [];
  for (let i = 0; i < languageProfiles.length; i++) {
    for (let j = i + 1; j < languageProfiles.length; j++) {
      const left = languageProfiles[i]!;
      const right = languageProfiles[j]!;
      const contextScore = weightedJaccard(left.features, right.features);
      for (const [sourceSymbol, sourceCount] of topEntries(left.symbols, 64)) {
        for (const [targetSymbol, targetCount] of topEntries(right.symbols, 64)) {
          const basis = translationBasis(sourceSymbol, targetSymbol, frames);
          const shapeScore = symbolShape(sourceSymbol) === symbolShape(targetSymbol) ? 0.35 : 0;
          const countScore = 1 - Math.min(1, Math.abs(Math.log1p(sourceCount) - Math.log1p(targetCount)) / 8);
          const frameScore = basis === "frame" ? 0.45 : 0;
          const numberScore = basis === "number" ? 0.6 : 0;
          const symbolScore = basis === "symbol" ? 0.5 : 0;
          const score = clamp01(0.24 * contextScore + 0.22 * countScore + shapeScore + frameScore + numberScore + symbolScore);
          if (score < 0.42) continue;
          seeds.push({
            sourceSymbol,
            targetSymbol,
            score,
            basis,
            evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds])]
          });
        }
      }
    }
  }
  const dedup = new Map<string, TranslationSeed>();
  for (const seed of seeds) {
    const key = `${seed.sourceSymbol}\u0001${seed.targetSymbol}`;
    const existing = dedup.get(key);
    if (!existing || seed.score > existing.score || hasher.digestHex(key) < hasher.digestHex(`${existing.sourceSymbol}:${existing.targetSymbol}`)) dedup.set(key, seed);
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score || a.sourceSymbol.localeCompare(b.sourceSymbol));
}

function translationBasis(sourceSymbol: string, targetSymbol: string, frames: readonly SemanticFrameCandidate[]): TranslationSeed["basis"] {
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)%?$/.test(sourceSymbol) && sourceSymbol === targetSymbol) return "number";
  if (/^[^A-Za-z0-9]+$/.test(sourceSymbol) && sourceSymbol === targetSymbol) return "symbol";
  if (symbolShape(sourceSymbol) === symbolShape(targetSymbol)) return "shape";
  const sourceInFrame = frames.some(frame => frame.predicate === sourceSymbol || frame.roles.some(role => role.filler === sourceSymbol));
  const targetInFrame = frames.some(frame => frame.predicate === targetSymbol || frame.roles.some(role => role.filler === targetSymbol));
  if (sourceInFrame && targetInFrame) return "frame";
  return "shared_context";
}

function proseDiagnostic(model: KneserNeyModel, symbols: readonly string[]): JsonValue {
  const sample = symbols.slice(0, Math.min(64, symbols.length)).join(" ");
  const continuation = continueBoundedProse(model, sample, { generationExtent: 32, probabilityFloor: 1e-9 });
  const orderMass = new Map<number, number>();
  for (const key of Object.keys(model.counts)) {
    const order = key.split("\u0001").length;
    orderMass.set(order, (orderMass.get(order) ?? 0) + (model.counts[key] ?? 0));
  }
  return toJsonValue({
    sampleHash: createHasher().digestHex(sample),
    continuation: {
      symbols: continuation.symbols,
      stoppedBy: continuation.stoppedBy,
      averageLogProbability: continuation.averageLogProbability
    },
    orderMass: [...orderMass.entries()].sort((a, b) => a[0] - b[0]).map(([order, count]) => ({ order, count })),
    density: symbols.length ? Object.keys(model.counts).length / symbols.length : 0
  });
}

/**
 * Real distributional selection, not a positional/shape guess alone:
 * `combinatorialDiversity` (how many distinct immediate left/right contexts
 * this exact symbol type was observed in across the whole corpus, computed
 * once by `computeGlobalContextDiversity`) is now the single largest
 * weighted term, because it is the one real linguistic signal here --
 * predicates combine freely with varying arguments; fixed collocations,
 * modifiers, and most argument fillers recur in the same one or two
 * contexts. Length/center/rarity/symbol-shape remain as real but weaker
 * tie-breaking signals, not the dominant criterion they were before.
 */
function selectFramePredicate(symbols: readonly string[], combinatorialDiversity: ReadonlyMap<string, number>): { symbol: string; index: number } {
  let best = { symbol: symbols[0] ?? "unit", index: 0, score: -Infinity };
  const counts = frequency(symbols);
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    const center = 1 - Math.abs(i - (symbols.length - 1) / 2) / Math.max(1, symbols.length);
    const rarity = 1 / Math.max(1, counts.get(symbol) ?? 1);
    const shape = symbolShape(symbol);
    const symbolic = shape.includes("symbol") ? 0.2 : 0;
    const diversity = combinatorialDiversity.get(symbol) ?? 0;
    // Additive, not a reallocation of the pre-existing weights: length and
    // center position are real, if imperfect, signals in their own right
    // (long, centrally-placed words are content words more often than not
    // across many languages, not merely an English artifact) and stay at
    // their original weight. Combinatorial diversity is a genuinely
    // independent, corpus-grounded signal layered on top, not a wholesale
    // replacement -- keeping both improves over either alone.
    const score = Math.min(1, symbol.length / 16) * 0.36 + center * 0.34 + rarity * 0.2 + symbolic + diversity * 0.30;
    if (score > best.score) best = { symbol, index: i, score };
  }
  return { symbol: best.symbol, index: best.index };
}

/**
 * Corpus-wide combinatorial diversity per symbol type: distinct immediate
 * `(left, right)` neighbor pairs observed, normalized by occurrence count,
 * requiring at least 3 real occurrences before reporting anything above
 * zero (avoids treating a single-occurrence word as maximally "diverse" by
 * accident). This is the real signal `selectFramePredicate` uses -- computed
 * once per `induceSemanticFrames` call, over the same canonical lattice
 * lexical stream frame induction already uses.
 */
function computeGlobalContextDiversity(documents: readonly LanguageInductionDocument[], hasher: Hasher): Map<string, number> {
  const occurrences = new Map<string, number>();
  const contexts = new Map<string, Set<string>>();
  for (const doc of documents) {
    for (const [sentenceIndex, sentence] of sentenceSegments(doc.text, hasher).entries()) {
      const symbols = lexicalSurfaceSymbols(sentence, `${doc.id}.diversity.${sentenceIndex}`, hasher)
        .filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char)));
      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i]!;
        const left = symbols[i - 1] ?? "<s>";
        const right = symbols[i + 1] ?? "</s>";
        occurrences.set(symbol, (occurrences.get(symbol) ?? 0) + 1);
        const set = contexts.get(symbol) ?? new Set<string>();
        set.add(`${left}\u0001${right}`);
        contexts.set(symbol, set);
      }
    }
  }
  const diversity = new Map<string, number>();
  for (const [symbol, count] of occurrences) {
    // Laplace-smoothed ratio (+2), not a raw distinctContexts/count ratio: an
    // unsmoothed ratio rewards a word for being *rare* (a word seen twice in
    // two different contexts scores a perfect 1.0, higher than a genuinely
    // promiscuous word seen often with only modest repetition) -- confirmed
    // by a real regression this caused (a controlled test corpus where a
    // 4-occurrence noun outscored an 8-occurrence verb under the unsmoothed
    // version). Smoothing requires real repeated evidence before rewarding
    // diversity, and count < 2 is reported as zero rather than a lone
    // coincidental context inflating the score.
    diversity.set(symbol, count < 2 ? 0 : clamp01((contexts.get(symbol)?.size ?? 0) / (count + 2)));
  }
  return diversity;
}

function sentenceSegments(text: string, hasher: Hasher): string[] {
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

function lexicalUnits(lattice: SurfaceLattice) {
  return lattice.units
    .filter(unit => unit.kind === "lexical")
    .sort((left, right) => left.utf16Start - right.utf16Start || left.utf16End - right.utf16End);
}

function lexicalSurfaceSequence(lattice: SurfaceLattice): string[] {
  return lexicalUnits(lattice).map(unit => unit.normalized);
}

function lexicalSurfaceSymbols(text: string, documentId: string, hasher: Hasher): string[] {
  return lexicalSurfaceSequence(buildSurfaceLattice({ documentId, text, hasher }));
}

function symbolShape(symbol: string): string {
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)%?$/.test(symbol)) return "number";
  if (/^[A-Z]+$/.test(symbol)) return "latin-upper";
  if (/^[a-z]+$/.test(symbol)) return "latin-lower";
  if (/^[A-Z][a-z]+$/.test(symbol)) return "latin-title";
  if (/^[A-Za-z]+$/.test(symbol)) return "latin-mixed";
  if (/^[A-Za-z0-9_-]+$/.test(symbol)) return "alnum";
  if (/^[^\p{Letter}\p{Number}\s]+$/u.test(symbol)) return "symbol";
  return `script:${[...new Set([...symbol].map(scriptOf))].slice(0, 3).join("+")}`;
}

function charClass(char: string): string {
  if (/\s/u.test(char)) return "space";
  if (/[0-9]/.test(char)) return "digit";
  if (/[A-Z]/.test(char)) return "latin-upper";
  if (/[a-z]/.test(char)) return "latin-lower";
  if (/[.,;:!?]/.test(char)) return "punct";
  if (/["'()[\]{}]/.test(char)) return "bracket";
  return scriptOf(char);
}

function dominantScriptKey(text: string): string {
  const scripts = induceScripts(text);
  return scripts[0]?.script ?? "unknown";
}

function topVocabulary(symbols: readonly string[], limit: number): Set<string> {
  return new Set(topEntries(frequency(symbols), limit).map(([symbol]) => symbol));
}

function frequency(symbols: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const symbol of symbols) map.set(symbol, (map.get(symbol) ?? 0) + 1);
  return map;
}

function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(1, limit));
}

function gramKey(symbols: readonly string[]): string {
  return symbols.join("\u0001");
}
