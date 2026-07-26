import { clamp01, symbolizeData, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";
import {
  renderJoinedSurface,
  type JoinProgramMixture,
  type JoinProgramTraceStep
} from "./join-program.js";

export const KNESER_NEY_SCHEMA = "scce.kneser_ney.v2" as const;
const MAX_SUCCESSORS_PER_CONTEXT = 256;
const MAX_BASE_CONTINUATIONS = 128;

export interface KneserNeyModel {
  schema: typeof KNESER_NEY_SCHEMA;
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
  successorIndex: Record<string, string[]>;
  successorOverflowCounts: Record<string, number>;
  backoffWeights: Record<string, number>;
  baseContinuations: string[];
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
  joinTrace: JoinProgramTraceStep[];
  unresolvedBoundaries: number;
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
  const successorCounts = new Map<string, Map<string, number>>();
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
        const successors = successorCounts.get(context) ?? new Map<string, number>();
        successors.set(symbol, (successors.get(symbol) ?? 0) + 1);
        successorCounts.set(context, successors);
      }
    }
  }
  const continuationCounts = new Map<string, number>();
  for (const [symbol, contexts] of continuationContexts) continuationCounts.set(symbol, contexts.size);
  const totalContinuationTypes = [...continuationContexts.values()].reduce((sum, contexts) => sum + contexts.size, 0);
  const compiled = compileSuccessorIndexes({
    successorCounts,
    continuationCounts,
    unigramCounts,
    contextCounts,
    contextContinuationTypes: new Map([...contextContinuationTypes.entries()].map(([key, set]) => [key, set.size])),
    discount
  });
  return {
    schema: KNESER_NEY_SCHEMA,
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
    ...compiled
  };
}

export function kneserNeyProbability(model: KneserNeyModel, context: readonly string[], symbol: string): number {
  assertCompiledKneserNey(model);
  const normalizedSymbol = runtimeIndex(model).vocabulary.has(symbol) || symbol === "</s>" ? symbol : "<unk>";
  return recursiveProbability(model, context.slice(-(model.order - 1)), normalizedSymbol, model.order);
}

export function predictKneserNey(model: KneserNeyModel, context: readonly string[], limit = 16): KneserNeyPrediction[] {
  assertCompiledKneserNey(model);
  const boundedLimit = Math.max(1, Math.floor(limit));
  const candidates = activeSuccessors(model, context, Math.max(64, boundedLimit * 8));
  const best: KneserNeyPrediction[] = [];
  for (const symbol of candidates) {
      const probability = kneserNeyProbability(model, context, symbol);
      insertPrediction(best, {
        symbol,
        probability,
        logProbability: Math.log(Math.max(1e-300, probability))
      }, boundedLimit);
  }
  return best;
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
  joinProgram?: JoinProgramMixture;
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
  const joined = renderJoinedSurface(generated, options.joinProgram);
  return {
    symbols: generated,
    text: joined.text,
    logProbability,
    averageLogProbability: generated.length ? logProbability / generated.length : logProbability,
    stoppedBy,
    trace,
    joinTrace: joined.trace,
    unresolvedBoundaries: joined.unresolvedBoundaries
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
  return toJsonValue({
    schema: KNESER_NEY_SCHEMA,
    summary,
    topContinuation,
    topContexts,
    compiledContexts: Object.keys(model.successorIndex).length,
    maximumSuccessorsPerContext: MAX_SUCCESSORS_PER_CONTEXT,
    baseContinuations: model.baseContinuations.length
  });
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

function recursiveProbability(model: KneserNeyModel, rawContext: readonly string[], symbol: string, order: number): number {
  if (order <= 1 || rawContext.length === 0) {
    const continuation = model.continuationCounts[symbol] ?? (symbol === "<unk>" ? 1 : 0);
    if (model.totalContinuationTypes > 0 && continuation > 0) return Math.max(1e-12, continuation / model.totalContinuationTypes);
    const unigram = model.unigramCounts[symbol] ?? (symbol === "<unk>" ? 1 : 0);
    return Math.max(1e-12, unigram / Math.max(1, model.totalUnigramCount + (symbol === "<unk>" ? 1 : 0)));
  }
  const context = rawContext.slice(-(order - 1));
  const gram = gramKey([...context, symbol]);
  const contextKey = gramKey(context);
  const count = model.counts[gram] ?? 0;
  const contextCount = model.contextCounts[contextKey] ?? 0;
  const continuationTypes = model.contextContinuationTypes[contextKey] ?? 0;
  if (contextCount <= 0) return recursiveProbability(model, context.slice(1), symbol, order - 1);
  const discounted = Math.max(count - model.discount, 0) / contextCount;
  const lambda = model.backoffWeights[contextKey]
    ?? (model.discount * continuationTypes) / contextCount;
  return Math.max(1e-12, discounted + lambda * recursiveProbability(model, context.slice(1), symbol, order - 1));
}

export function compileKneserNeyRuntimeIndexes(input: {
  discount: number;
  counts: Record<string, number>;
  contextCounts: Record<string, number>;
  continuationCounts: Record<string, number>;
  contextContinuationTypes: Record<string, number>;
  unigramCounts: Record<string, number>;
}): Pick<KneserNeyModel, "schema" | "successorIndex" | "successorOverflowCounts" | "backoffWeights" | "baseContinuations"> {
  const successorCounts = new Map<string, Map<string, number>>();
  for (const [key, count] of Object.entries(input.counts)) {
    const parts = key.split("\u0001");
    if (parts.length <= 1) continue;
    const symbol = parts[parts.length - 1]!;
    const context = gramKey(parts.slice(0, -1));
    const bucket = successorCounts.get(context) ?? new Map<string, number>();
    bucket.set(symbol, (bucket.get(symbol) ?? 0) + count);
    successorCounts.set(context, bucket);
  }
  return {
    schema: KNESER_NEY_SCHEMA,
    ...compileSuccessorIndexes({
      successorCounts,
      continuationCounts: new Map(Object.entries(input.continuationCounts)),
      unigramCounts: new Map(Object.entries(input.unigramCounts)),
      contextCounts: new Map(Object.entries(input.contextCounts)),
      contextContinuationTypes: new Map(Object.entries(input.contextContinuationTypes)),
      discount: input.discount
    })
  };
}

function compileSuccessorIndexes(input: {
  successorCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  continuationCounts: ReadonlyMap<string, number>;
  unigramCounts: ReadonlyMap<string, number>;
  contextCounts: ReadonlyMap<string, number>;
  contextContinuationTypes: ReadonlyMap<string, number>;
  discount: number;
}): Pick<KneserNeyModel, "successorIndex" | "successorOverflowCounts" | "backoffWeights" | "baseContinuations"> {
  const successorIndex: Record<string, string[]> = {};
  const successorOverflowCounts: Record<string, number> = {};
  for (const [context, counts] of [...input.successorCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const ordered = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    successorIndex[context] = ordered.slice(0, MAX_SUCCESSORS_PER_CONTEXT).map(([symbol]) => symbol);
    if (ordered.length > MAX_SUCCESSORS_PER_CONTEXT) {
      successorOverflowCounts[context] = ordered.length - MAX_SUCCESSORS_PER_CONTEXT;
    }
  }
  const baseCounts = input.continuationCounts.size > 0
    ? input.continuationCounts
    : input.unigramCounts;
  const baseContinuations = [...baseCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_BASE_CONTINUATIONS)
    .map(([symbol]) => symbol);
  if (!baseContinuations.includes("</s>")) baseContinuations.push("</s>");
  const backoffWeights: Record<string, number> = {};
  for (const [context, denominator] of input.contextCounts) {
    if (denominator <= 0) continue;
    backoffWeights[context] = (input.discount * (input.contextContinuationTypes.get(context) ?? 0)) / denominator;
  }
  return { successorIndex, successorOverflowCounts, backoffWeights, baseContinuations };
}

interface KneserNeyRuntimeIndex {
  vocabulary: Set<string>;
}

const runtimeIndexes = new WeakMap<KneserNeyModel, KneserNeyRuntimeIndex>();

function runtimeIndex(model: KneserNeyModel): KneserNeyRuntimeIndex {
  const cached = runtimeIndexes.get(model);
  if (cached) return cached;
  const compiled = { vocabulary: new Set(model.vocabulary) };
  runtimeIndexes.set(model, compiled);
  return compiled;
}

function assertCompiledKneserNey(model: KneserNeyModel): void {
  if (model.schema !== KNESER_NEY_SCHEMA
    || !model.successorIndex
    || !model.backoffWeights
    || !Array.isArray(model.baseContinuations)) {
    throw new Error("Kneser-Ney model is not compiled for bounded successor-index inference");
  }
}

function activeSuccessors(model: KneserNeyModel, rawContext: readonly string[], maximum: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const context = rawContext.slice(-(model.order - 1));
  for (let start = 0; start < context.length && out.length < maximum; start += 1) {
    const key = gramKey(context.slice(start));
    for (const symbol of model.successorIndex[key] ?? []) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      out.push(symbol);
      if (out.length >= maximum) break;
    }
  }
  for (const symbol of model.baseContinuations) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
    if (out.length >= maximum) break;
  }
  if (!seen.has("</s>") && out.length < maximum) out.push("</s>");
  return out;
}

function insertPrediction(
  predictions: KneserNeyPrediction[],
  candidate: KneserNeyPrediction,
  limit: number
): void {
  let low = 0;
  let high = predictions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = predictions[middle]!;
    if (candidate.probability > current.probability
      || (candidate.probability === current.probability && candidate.symbol.localeCompare(current.symbol) < 0)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  predictions.splice(low, 0, candidate);
  if (predictions.length > limit) predictions.pop();
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
