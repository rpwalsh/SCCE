import type { EvidenceId, Hasher, JsonValue, SourceVersionId } from "./types.js";
import { clamp01, createHasher, entropy, featureSet, mean, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import { compactKneserNeyForProfile, continueBoundedProse, trainKneserNey, type KneserNeyModel } from "./kneser-ney.js";

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

export interface SemanticFrameCandidate {
  id: string;
  predicate: string;
  roles: Array<{ name: string; filler: string; count: number; salience: number }>;
  support: number;
  alphaPrior: number;
  examples: string[];
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
  boundarySignals: BoundarySignal[];
  morphology: MorphologicalRule[];
  syntaxTemplates: SyntaxTemplate[];
  semanticFrames: SemanticFrameCandidate[];
  translationSeeds: TranslationSeed[];
  proseDiagnostics: JsonValue;
  audit: JsonValue;
}

export function createLanguageInductionEngine(options: { hasher?: Hasher; vocabularyLimit?: number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const vocabularyLimit = Math.max(512, Math.floor(options.vocabularyLimit ?? 50000));
  return {
    induce(input: { documents: LanguageInductionDocument[]; order?: NgramOrder; maxNgrams?: number; maxFrames?: number }): InducedLanguageModel {
      const documents = input.documents.filter(doc => doc.text.trim().length > 0);
      const corpusText = documents.map(doc => doc.text).join("\n");
      const symbols = documents.flatMap(doc => symbolizeData(doc.text).map(symbol => ({ symbol, doc })));
      const symbolStrings = symbols.map(item => item.symbol);
      const order = clampOrder(input.order ?? 6);
      const counts = countNgrams(symbolStrings, order, vocabularyLimit);
      const ngrams = inducedNgrams(counts, order, input.maxNgrams ?? 4096);
      const kn = trainKneserNey(symbolStrings, { order, vocabularyLimit });
      const boundarySignals = induceBoundaries(corpusText, hasher).slice(0, 2048);
      const scripts = induceScripts(corpusText);
      const morphology = induceMorphology(symbolStrings, hasher).slice(0, 2048);
      const syntaxTemplates = induceSyntaxTemplates(documents, hasher).slice(0, 2048);
      const semanticFrames = induceSemanticFrames(documents, hasher, input.maxFrames ?? 2048);
      const translationSeeds = induceTranslationSeeds(documents, semanticFrames, hasher).slice(0, 2048);
      const proseDiagnostics = proseDiagnostic(kn, symbolStrings);
      const id = `language_model_${hasher.digestHex(JSON.stringify({ docs: documents.map(d => d.id), symbols: symbolStrings.length, order })).slice(0, 32)}`;
      return {
        id,
        corpusDocuments: documents.length,
        symbolCount: symbolStrings.length,
        vocabularySize: new Set(symbolStrings).size,
        scripts,
        ngrams,
        kneserNey: compactKneserNeyForProfile(kn, corpusText.slice(0, 200000)),
        boundarySignals,
        morphology,
        syntaxTemplates,
        semanticFrames,
        translationSeeds,
        proseDiagnostics,
        audit: toJsonValue({
          order,
          vocabularyLimit,
          sourceVersionIds: documents.map(doc => doc.sourceVersionId).filter(Boolean),
          evidenceIds: [...new Set(documents.flatMap(doc => doc.evidenceIds ?? []))],
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

function induceBoundaries(text: string, hasher: Hasher): BoundarySignal[] {
  const cleaned = text.replace(/\u0000/g, " ");
  const pairCounts = new Map<string, number>();
  const boundaryCounts = new Map<string, number>();
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    const left = cleaned[i]!;
    const right = cleaned[i + 1]!;
    if (left === "\r" || right === "\r") continue;
    const leftKey = charClass(left);
    const rightKey = charClass(right);
    const key = `${leftKey}\u0001${rightKey}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    leftCounts.set(leftKey, (leftCounts.get(leftKey) ?? 0) + 1);
    rightCounts.set(rightKey, (rightCounts.get(rightKey) ?? 0) + 1);
    if (/\s/u.test(left) || /\s/u.test(right) || /[.,;:!?()[\]{}]/u.test(left) || /[.,;:!?()[\]{}]/u.test(right)) {
      boundaryCounts.set(key, (boundaryCounts.get(key) ?? 0) + 1);
    }
  }
  const total = [...pairCounts.values()].reduce((sum, count) => sum + count, 0);
  const signals: BoundarySignal[] = [];
  for (const [key, count] of pairCounts) {
    const [left, right] = key.split("\u0001") as [string, string];
    const boundary = boundaryCounts.get(key) ?? 0;
    const joint = count / Math.max(1, total);
    const independent = ((leftCounts.get(left) ?? 1) / Math.max(1, total)) * ((rightCounts.get(right) ?? 1) / Math.max(1, total));
    const mutualInformation = Math.max(0, Math.log2(Math.max(1e-12, joint / Math.max(1e-12, independent))));
    const boundaryProbability = boundary / count;
    signals.push({
      left,
      right,
      count,
      boundaryProbability,
      joinProbability: clamp01((1 - boundaryProbability) * mutualInformation / 8),
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
  const vocabulary = [...new Set(symbols.filter(symbol => symbol.length >= 4 && /^[^\d\s]+$/u.test(symbol)))];
  const prefixMap = new Map<string, Set<string>>();
  const suffixMap = new Map<string, Set<string>>();
  const compoundMap = new Map<string, string[]>();
  const vocabSet = new Set(vocabulary);
  for (const symbol of vocabulary) {
    for (let n = 1; n <= Math.min(5, symbol.length - 2); n++) {
      const prefix = symbol.slice(0, n);
      const suffix = symbol.slice(symbol.length - n);
      const prefixStem = symbol.slice(n);
      const suffixStem = symbol.slice(0, symbol.length - n);
      if (prefixStem.length >= 3) {
        const bucket = prefixMap.get(prefix) ?? new Set<string>();
        bucket.add(prefixStem);
        prefixMap.set(prefix, bucket);
      }
      if (suffixStem.length >= 3) {
        const bucket = suffixMap.get(suffix) ?? new Set<string>();
        bucket.add(suffixStem);
        suffixMap.set(suffix, bucket);
      }
    }
    for (let split = 3; split <= symbol.length - 3; split++) {
      const left = symbol.slice(0, split);
      const right = symbol.slice(split);
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

function induceSyntaxTemplates(documents: readonly LanguageInductionDocument[], hasher: Hasher): SyntaxTemplate[] {
  const counts = new Map<string, { count: number; examples: string[]; nextShapes: Map<string, number> }>();
  for (const doc of documents) {
    for (const sentence of sentenceSegments(doc.text)) {
      const symbols = symbolizeData(sentence);
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

function induceSemanticFrames(documents: readonly LanguageInductionDocument[], hasher: Hasher, maxFrames: number): SemanticFrameCandidate[] {
  const frames = new Map<string, { predicate: string; left: Map<string, number>; right: Map<string, number>; examples: string[]; evidenceIds: Set<EvidenceId>; alpha: number }>();
  for (const doc of documents) {
    const trust = clamp01(doc.trust ?? 0.5);
    for (const sentence of sentenceSegments(doc.text)) {
      const symbols = symbolizeData(sentence).filter(symbol => !/^[.,;:!?()[\]{}]$/.test(symbol));
      if (symbols.length < 2) continue;
      const predicate = selectFramePredicate(symbols);
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
        examples: frame.examples,
        evidenceIds: [...frame.evidenceIds]
      };
    })
    .filter(frame => frame.roles.length > 0)
    .sort((a, b) => b.support - a.support || b.alphaPrior - a.alphaPrior || a.predicate.localeCompare(b.predicate))
    .slice(0, Math.max(1, maxFrames));
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
    symbols: frequency(docs.flatMap(doc => symbolizeData(doc.text))),
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

function selectFramePredicate(symbols: readonly string[]): { symbol: string; index: number } {
  let best = { symbol: symbols[0] ?? "unit", index: 0, score: -Infinity };
  const counts = frequency(symbols);
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    const center = 1 - Math.abs(i - (symbols.length - 1) / 2) / Math.max(1, symbols.length);
    const rarity = 1 / Math.max(1, counts.get(symbol) ?? 1);
    const shape = symbolShape(symbol);
    const symbolic = shape.includes("symbol") ? 0.2 : 0;
    const score = Math.min(1, symbol.length / 16) * 0.36 + center * 0.34 + rarity * 0.2 + symbolic;
    if (score > best.score) best = { symbol, index: i, score };
  }
  return { symbol: best.symbol, index: best.index };
}

function sentenceSegments(text: string): string[] {
  const cleaned = text.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]!;
    if ((char === "." || char === "!" || char === "?" || char === ";") && (cleaned[i + 1] === " " || i === cleaned.length - 1)) {
      const sentence = cleaned.slice(start, i + 1).trim();
      if (sentence) out.push(sentence);
      start = i + 1;
    }
  }
  const tail = cleaned.slice(start).trim();
  if (tail) out.push(tail);
  if (out.length) return out;
  const symbols = symbolizeData(cleaned);
  const chunks: string[] = [];
  for (let i = 0; i < symbols.length; i += 40) chunks.push(symbols.slice(i, i + 40).join(" "));
  return chunks;
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
