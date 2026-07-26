import { clamp01, symbolizeData, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

export interface KneserNeyModel {
  order: number;
  discount: number;
  observedSymbolCount: number;
  vocabularySize: number;
  counts: Record<string, number>;
  contextCounts: Record<string, number>;
  continuationCounts: Record<string, number>;
  contextContinuationTypes: Record<string, number>;
  totalContinuationTypes: number;
  unigramCounts: Record<string, number>;
  totalUnigramCount: number;
  vocabulary: string[];
  /**
   * Observed next-symbol sets per context key, for every context length
   * from `order-1` down to 1, built once during training. Lets
   * predictKneserNey score only symbols actually observed to follow this
   * context (or a shorter backoff context) -- typically tens of
   * candidates -- instead of the full vocabulary (up to `vocabularyLimit`,
   * default 20000). Optional so models trained before this field existed
   * still deserialize; predictKneserNey falls back to a small top-frequency
   * slice for those.
   */
  contextSuccessorSymbols?: Record<string, string[]>;
}

export interface KneserNeyPrediction {
  symbol: string;
  probability: number;
  logProbability: number;
}

export interface KneserNeyDiagnostics {
  order: number;
  discount: number;
  observedSymbolCount: number;
  vocabularySize: number;
  orderSummary: Array<{ order: number; grams: number; contexts: number }>;
  perplexity: number;
  entropyRate: number;
  topContinuations: KneserNeyPrediction[];
}

export interface BoundedProseContinuation {
  symbols: string[];
  text: string;
  logProbability: number;
  averageLogProbability: number;
  stoppedBy: "eos" | "generationExtent" | "probabilityFloor";
  trace: KneserNeyPrediction[];
}

export function trainKneserNey(text: string | readonly string[], options: { order?: number; discount?: number; vocabularyLimit?: number } = {}): KneserNeyModel {
  const order = Math.max(1, Math.min(6, Math.floor(options.order ?? 3)));
  const discount = clamp01(options.discount ?? 0.75);
  const symbols = normalizeSymbols(text);
  const vocabulary = topVocabulary(symbols, options.vocabularyLimit ?? 20000);
  const vocabSet = new Set(vocabulary);
  const normalized = symbols.map(symbol => vocabSet.has(symbol) ? symbol : "<unk>");
  const padded = [...Array(order - 1).fill("<s>"), ...normalized, "</s>"];
  const counts = new Map<string, number>();
  const contextCounts = new Map<string, number>();
  const continuationContexts = new Map<string, Set<string>>();
  const contextContinuationTypes = new Map<string, Set<string>>();
  const unigramCounts = new Map<string, number>();
  for (const symbol of [...normalized, "</s>"]) unigramCounts.set(symbol, (unigramCounts.get(symbol) ?? 0) + 1);
  for (let n = 1; n <= order; n++) {
    for (let i = 0; i <= padded.length - n; i++) {
      const gram = padded.slice(i, i + n);
      const key = gramKey(gram);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (n > 1) {
        const context = gramKey(gram.slice(0, -1));
        const symbol = gram[gram.length - 1]!;
        contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1);
        if (!continuationContexts.has(symbol)) continuationContexts.set(symbol, new Set());
        continuationContexts.get(symbol)!.add(context);
        if (!contextContinuationTypes.has(context)) contextContinuationTypes.set(context, new Set());
        contextContinuationTypes.get(context)!.add(symbol);
      }
    }
  }
  const continuationCounts = new Map<string, number>();
  for (const [symbol, contexts] of continuationContexts) continuationCounts.set(symbol, contexts.size);
  const totalContinuationTypes = [...continuationContexts.values()].reduce((sum, contexts) => sum + contexts.size, 0);
  return {
    order,
    discount,
    observedSymbolCount: normalized.length,
    vocabularySize: vocabulary.length,
    counts: Object.fromEntries(counts),
    contextCounts: Object.fromEntries(contextCounts),
    continuationCounts: Object.fromEntries(continuationCounts),
    contextContinuationTypes: Object.fromEntries([...contextContinuationTypes.entries()].map(([key, set]) => [key, set.size])),
    totalContinuationTypes,
    unigramCounts: Object.fromEntries(unigramCounts),
    totalUnigramCount: [...unigramCounts.values()].reduce((sum, count) => sum + count, 0),
    vocabulary,
    contextSuccessorSymbols: Object.fromEntries([...contextContinuationTypes.entries()].map(([key, set]) => [key, [...set]]))
  };
}

const vocabularySetCache = new WeakMap<KneserNeyModel, Set<string>>();

function vocabularySet(model: KneserNeyModel): Set<string> {
  let set = vocabularySetCache.get(model);
  if (!set) {
    set = new Set(model.vocabulary);
    vocabularySetCache.set(model, set);
  }
  return set;
}

export function kneserNeyProbability(model: KneserNeyModel, context: readonly string[], symbol: string): number {
  const normalizedSymbol = vocabularySet(model).has(symbol) || symbol === "</s>" ? symbol : "<unk>";
  return recursiveProbability(model, context.slice(-(model.order - 1)), normalizedSymbol, model.order);
}

/** Small top-frequency fallback pool used only when no context (at any backoff length) has any observed successor recorded -- e.g. a genuinely unseen context, or a model persisted before contextSuccessorSymbols existed. model.vocabulary is already frequency-sorted (topVocabulary), so a short prefix slice is the top-frequency symbols, not an arbitrary subset. */
const FALLBACK_CANDIDATE_LIMIT = 64;

/**
 * Bounded candidate symbols for one prediction step: the union of symbols
 * actually observed to follow `context` at its full backoff length down to
 * length 1 (typically tens of symbols, per KneserNeyModel.contextSuccessorSymbols),
 * plus "</s>". Falls back to a small top-frequency slice only when no
 * backoff context has any recorded successor at all. Replaces scoring the
 * entire vocabulary (up to 5000 candidates) per generated symbol.
 */
function boundedCandidateSymbols(model: KneserNeyModel, context: readonly string[]): string[] {
  const candidates = new Set<string>(["</s>"]);
  if (model.contextSuccessorSymbols) {
    for (let length = context.length; length >= 1; length--) {
      const key = gramKey(context.slice(context.length - length));
      const successors = model.contextSuccessorSymbols[key];
      if (successors) for (const symbol of successors) candidates.add(symbol);
    }
  }
  if (candidates.size <= 1) {
    for (const symbol of model.vocabulary.slice(0, FALLBACK_CANDIDATE_LIMIT)) candidates.add(symbol);
  }
  return [...candidates];
}

export function predictKneserNey(model: KneserNeyModel, context: readonly string[], limit = 16): KneserNeyPrediction[] {
  const trimmedContext = context.slice(-(model.order - 1));
  const candidates = boundedCandidateSymbols(model, trimmedContext);
  // Every candidate is scored against the same context, so the
  // context-dependent (not symbol-dependent) part of backoff -- which
  // orders have an observed context, and each one's denominator/lambda --
  // is computed once here and reused for all candidates instead of once
  // per (candidate, order) pair.
  const chain = backoffChain(model, trimmedContext, model.order);
  const vocab = vocabularySet(model);
  return candidates
    .map(symbol => {
      const normalizedSymbol = vocab.has(symbol) || symbol === "</s>" ? symbol : "<unk>";
      const probability = probabilityFromChain(model, chain, normalizedSymbol);
      return { symbol, probability, logProbability: Math.log(Math.max(1e-300, probability)) };
    })
    .sort((a, b) => b.probability - a.probability || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}

export function kneserNeyPerplexity(model: KneserNeyModel, text: string | readonly string[]): number {
  const symbols = normalizeSymbols(text);
  const padded = [...Array(model.order - 1).fill("<s>"), ...symbols, "</s>"];
  let logProb = 0;
  let count = 0;
  for (let i = model.order - 1; i < padded.length; i++) {
    const context = padded.slice(Math.max(0, i - model.order + 1), i);
    const symbol = padded[i]!;
    logProb += Math.log2(Math.max(1e-300, kneserNeyProbability(model, context, symbol)));
    count++;
  }
  return Math.pow(2, -logProb / Math.max(1, count));
}

export function summarizeKneserNey(model: KneserNeyModel, sampleText?: string): KneserNeyDiagnostics {
  const sample = sampleText ? kneserNeyPerplexity(model, sampleText) : NaN;
  const topContinuations = predictKneserNey(model, ["<s>"], 24);
  const entropyRate = -topContinuations.reduce((sum, item) => sum + item.probability * Math.log2(Math.max(1e-300, item.probability)), 0);
  return {
    order: model.order,
    discount: model.discount,
    observedSymbolCount: model.observedSymbolCount,
    vocabularySize: model.vocabularySize,
    orderSummary: orderSummary(model),
    perplexity: Number.isFinite(sample) ? sample : 0,
    entropyRate,
    topContinuations
  };
}

export function continueBoundedProse(model: KneserNeyModel, prompt: string | readonly string[], options: {
  generationExtent?: number;
  probabilityFloor?: number;
  temperature?: number;
  blockedSymbols?: string[];
  deterministicChoiceSeed?: string;
  minSymbolsBeforeEos?: number;
  repetitionWindow?: number;
} = {}): BoundedProseContinuation {
  const context = normalizeSymbols(prompt);
  const generated: string[] = [];
  const trace: KneserNeyPrediction[] = [];
  let logProbability = 0;
  const blocked = new Set(options.blockedSymbols ?? []);
  const generationExtent = options.generationExtent ?? 80;
  const floor = options.probabilityFloor ?? 1e-7;
  const temperature = Math.max(0.05, options.temperature ?? 1);
  const minimumBeforeEos = Math.max(0, Math.floor(options.minSymbolsBeforeEos ?? 0));
  const repetitionWindow = Math.max(1, Math.floor(options.repetitionWindow ?? 10));
  let stoppedBy: BoundedProseContinuation["stoppedBy"] = "generationExtent";
  for (let i = 0; i < generationExtent; i++) {
    const predictions = predictKneserNey(model, [...context, ...generated].slice(-(model.order - 1)), 64)
      .filter(item => !blocked.has(item.symbol) && item.symbol !== "<s>")
      .filter(item => item.symbol !== "</s>" || generated.length >= minimumBeforeEos);
    const recent = generated.slice(-repetitionWindow);
    const adjusted = predictions.map(item => {
      const repetitionCount = recent.reduce((count, symbol) => count + Number(symbol === item.symbol), 0);
      const repetitionPenalty = repetitionCount ? Math.pow(0.18, repetitionCount) : 1;
      return { ...item, probability: Math.pow(item.probability, 1 / temperature) * repetitionPenalty };
    }).sort((left, right) => right.probability - left.probability || left.symbol.localeCompare(right.symbol));
    const total = adjusted.reduce((sum, item) => sum + item.probability, 0);
    const best = options.deterministicChoiceSeed
      ? deterministicWeightedChoice(
        adjusted.slice(0, 16),
        `${options.deterministicChoiceSeed}\u0001${i}\u0001${[...context, ...generated].slice(-(model.order - 1)).join("\u0001")}`
      )
      : adjusted.length
        ? { ...adjusted[0]!, probability: adjusted[0]!.probability / Math.max(1e-300, total) }
        : undefined;
    if (!best || best.probability < floor) {
      stoppedBy = "probabilityFloor";
      break;
    }
    if (best.symbol === "</s>") {
      stoppedBy = "eos";
      trace.push(best);
      logProbability += Math.log(Math.max(1e-300, best.probability));
      break;
    }
    generated.push(best.symbol);
    trace.push(best);
    logProbability += Math.log(Math.max(1e-300, best.probability));
  }
  return {
    symbols: generated,
    text: renderSymbols(generated),
    logProbability,
    averageLogProbability: generated.length ? logProbability / generated.length : logProbability,
    stoppedBy,
    trace
  };
}

function deterministicWeightedChoice(
  values: readonly KneserNeyPrediction[],
  seed: string
): KneserNeyPrediction | undefined {
  const total = values.reduce((sum, item) => sum + item.probability, 0);
  if (!values.length || total <= 0) return undefined;
  const threshold = stableUnitInterval(seed) * total;
  let cumulative = 0;
  for (const item of values) {
    cumulative += item.probability;
    if (cumulative >= threshold) return { ...item, probability: item.probability / total };
  }
  const last = values[values.length - 1]!;
  return { ...last, probability: last.probability / total };
}

function stableUnitInterval(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function compactKneserNeyForProfile(model: KneserNeyModel, text: string): JsonValue {
  const summary = summarizeKneserNey(model, text);
  const topContinuation = Object.entries(model.continuationCounts).sort((a, b) => b[1] - a[1]).slice(0, 128);
  const topContexts = Object.entries(model.contextContinuationTypes).sort((a, b) => b[1] - a[1]).slice(0, 128);
  return toJsonValue({ summary, topContinuation, topContexts });
}

function orderSummary(model: KneserNeyModel): Array<{ order: number; grams: number; contexts: number }> {
  const out: Array<{ order: number; grams: number; contexts: number }> = [];
  for (let n = 1; n <= model.order; n++) {
    const grams = Object.keys(model.counts).filter(key => key.split("\u0001").length === n).length;
    const contexts = n === 1 ? 1 : Object.keys(model.contextCounts).filter(key => key.split("\u0001").length === n - 1).length;
    out.push({ order: n, grams, contexts });
  }
  return out;
}

function renderSymbols(symbols: readonly string[]): string {
  let out = "";
  for (const symbol of symbols) {
    if (/^[,.;:!?)]$/.test(symbol)) out += symbol;
    else if (/^[(]$/.test(symbol)) out += `${out ? " " : ""}${symbol}`;
    else out += `${out ? " " : ""}${symbol}`;
  }
  return out;
}

function recursiveProbability(model: KneserNeyModel, rawContext: readonly string[], symbol: string, order: number): number {
  return probabilityFromChain(model, backoffChain(model, rawContext, order), symbol);
}

function baseProbability(model: KneserNeyModel, symbol: string): number {
  const continuation = model.continuationCounts[symbol] ?? (symbol === "<unk>" ? 1 : 0);
  if (model.totalContinuationTypes > 0 && continuation > 0) return Math.max(1e-12, continuation / model.totalContinuationTypes);
  const unigram = model.unigramCounts[symbol] ?? (symbol === "<unk>" ? 1 : 0);
  return Math.max(1e-12, unigram / Math.max(1, model.totalUnigramCount + (symbol === "<unk>" ? 1 : 0)));
}

interface BackoffLevel {
  context: readonly string[];
  contextCount: number;
  lambda: number;
}

/**
 * The part of Kneser-Ney backoff that depends only on the context, not on
 * the candidate symbol: which orders actually have an observed context
 * (contextCount > 0, skipping unobserved orders exactly like the original
 * recursion's early backoff) and each contributing order's denominator and
 * interpolation weight. Computed once per context and reused across every
 * candidate symbol scored against it, instead of recomputing the same
 * gramKey joins and Record lookups once per (symbol, order) pair.
 */
function backoffChain(model: KneserNeyModel, rawContext: readonly string[], order: number): BackoffLevel[] {
  const chain: BackoffLevel[] = [];
  let currentContext = rawContext;
  let currentOrder = order;
  while (currentOrder > 1 && currentContext.length > 0) {
    const context = currentContext.slice(-(currentOrder - 1));
    const contextKey = gramKey(context);
    const contextCount = model.contextCounts[contextKey] ?? 0;
    if (contextCount > 0) {
      const continuationTypes = model.contextContinuationTypes[contextKey] ?? 0;
      chain.push({ context, contextCount, lambda: (model.discount * continuationTypes) / contextCount });
    }
    currentContext = context.slice(1);
    currentOrder -= 1;
  }
  return chain;
}

/** Applies a precomputed backoff chain to one candidate symbol: only the
 * per-level `model.counts[gram]` numerator lookup differs per symbol. */
function probabilityFromChain(model: KneserNeyModel, chain: readonly BackoffLevel[], symbol: string): number {
  let probability = baseProbability(model, symbol);
  for (let i = chain.length - 1; i >= 0; i--) {
    const level = chain[i]!;
    const count = model.counts[gramKey([...level.context, symbol])] ?? 0;
    const discounted = Math.max(count - model.discount, 0) / level.contextCount;
    probability = Math.max(1e-12, discounted + level.lambda * probability);
  }
  return probability;
}

function topVocabulary(symbols: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return ["<unk>", ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(1, limit - 1)).map(([symbol]) => symbol)];
}

function gramKey(symbols: readonly string[]): string {
  return symbols.join("\u0001");
}

function normalizeSymbols(value: string | readonly string[]): string[] {
  return typeof value === "string" ? symbolizeData(value) : [...value];
}
